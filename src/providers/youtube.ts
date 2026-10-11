// Provider YouTube via yt-dlp.
// YouTube & YouTube Music share backend audio yang sama (Opus 134k / M4A 130k).
// Search pakai ytsearch (reliable, return duration untuk matching).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { resolveBinary } from "../lib/binaries.js";
import { trackChild, killProcessTree } from "../lib/procs.js";
import type { Candidate, FileProgress, Provider, ProviderContext, Track } from "../core/types.js";

export interface RunYtDlpOptions {
  /** Timeout keseluruhan proses (default 250s). */
  timeoutMs?: number;
  /** Aborted = child process dibunuh & promise reject "cancelled". */
  signal?: AbortSignal;
  /** Callback per baris stdout — pasangan wajib flag --newline untuk progress. */
  onLine?: (line: string) => void;
}

// ---- Anti rate-limit (terpusat untuk SEMUA pemanggilan yt-dlp) ----
// Diverifikasi tersedia di yt-dlp 2026.08.19 (bin/yt-dlp.exe --help).
// Tujuan: kurangi burst request ke YouTube yang memicu 429 / "Sign in to
// confirm you're not a bot", tanpa perlu cookies/akun.
const YT_PACING_FLAGS = [
  "--sleep-requests", "0.6", // jeda antar request HTTP saat ekstraksi metadata
  "--retries", "6", // yt-dlp retry sendiri error transient
  "--retry-sleep", "http:exp=1:20", // backoff eksponensial khusus HTTP (429/503)
  "--extractor-retries", "3",
];

// Gate jeda minimum antar spawn proses yt-dlp, lintas semua worker paralel &
// provider. Tanpa ini, worker paralel bisa menembak YouTube bersamaan
// (stampede) — penyebab utama kena rate limit.
const MIN_SPAWN_GAP_MS = Math.max(0, Number(process.env.DROP_YT_MIN_GAP_MS ?? 1400));
let spawnChain: Promise<void> = Promise.resolve();
let lastSpawnAt = 0;

/** Ambil satu "slot" spawn: tunggu sampai jeda minimum + jitter terpenuhi. */
function acquireSpawnSlot(): Promise<void> {
  const run = spawnChain.then(async () => {
    const jitter = Math.random() * 400; // acak supaya request tidak berirama
    const wait = Math.max(0, MIN_SPAWN_GAP_MS + jitter - (Date.now() - lastSpawnAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSpawnAt = Date.now();
  });
  // Jaga chain tetap hidup walau satu waiter gagal.
  spawnChain = run.catch(() => {});
  return run;
}

/**
 * Jalankan yt-dlp dan kumpulkan stdout.
 * Kompatibel dengan pemanggilan lama: runYtDlp(args, timeoutMsNumber).
 */
export async function runYtDlp(args: string[], options: RunYtDlpOptions | number = {}): Promise<string> {
  const opts: RunYtDlpOptions = typeof options === "number" ? { timeoutMs: options } : options;
  // Jeda antar spawn lebih dulu supaya worker paralel tidak nembak bersamaan.
  // Kalau sudah dibatalkan, lewati gate (proses langsung dibunuh di bawah).
  if (!opts.signal?.aborted) await acquireSpawnSlot();
  const fullArgs = [...YT_PACING_FLAGS, ...args];
  return new Promise((resolve, reject) => {
    const child = trackChild(spawn(resolveBinary("yt-dlp"), fullArgs, { windowsHide: true }));
    let out = "";
    let err = "";

    const killAndReject = (message: string) => {
      // Tree kill: selain yt-dlp, ffmpeg hasil merge juga ikut mati supaya
      // tidak ada grandchild yang menulis file setelah job dinyatakan gagal.
      killProcessTree(child);
      reject(new Error(message));
    };

    const timer = setTimeout(() => killAndReject("yt-dlp timeout"), opts.timeoutMs ?? 250_000);

    const onAbort = () => killAndReject("cancelled");
    if (opts.signal) {
      if (opts.signal.aborted) { clearTimeout(timer); killAndReject("cancelled"); return; }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (opts.onLine) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        out += line + "\n";
        try { opts.onLine!(line); } catch { /* callback error jangan matikan proses */ }
      });
    } else {
      child.stdout.on("data", (d) => (out += d));
    }
    child.stderr.on("data", (d) => (err += d));

    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`yt-dlp tidak bisa dijalankan: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) { reject(new Error("cancelled")); return; }
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp exit ${code}: ${err.slice(-500)}`));
    });
  });
}

/** Error yang benar-benar tidak bisa diatasi dengan mengulang (video hilang/privat/members-only). */
const FATAL_YT_PATTERNS = [
  "video unavailable",
  "private video",
  "removed by the uploader",
  "account associated with this video has been terminated",
  "not available in your country",
  "sign in to confirm your age",
  "this video is available to this channel's members",
  "join this channel to help support it",
  "premieres in",
];

/**
 * Layak diulang dari luar yt-dlp? Timeout jaringan dan HTTP 403/429/5xx sering
 * hilang sendiri: URL media YouTube berumur pendek, jadi ekstraksi ulang
 * menghasilkan URL segar. Error fatal (video dihapus/privat) tidak.
 */
export function isRetryableYtDlpError(message: string): boolean {
  if (message === "cancelled") return false;
  const lower = message.toLowerCase();
  return !FATAL_YT_PATTERNS.some((pattern) => lower.includes(pattern));
}

const UNITS: Record<string, number> = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

function parseSize(value: string, unit: string): number {
  return parseFloat(value) * (UNITS[unit] ?? 0);
}

function parseEta(value: string): number | null {
  const parts = value.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Parse satu baris progress yt-dlp (--newline) jadi FileProgress.
 * Contoh baris: `[download]  45.3% of    3.42MiB at    1.12MiB/s ETA 00:02`
 * Return null kalau bukan baris progress.
 */
export function parseYtDlpProgress(line: string): FileProgress | null {
  const m = line.match(
    /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([0-9.]+|NA)\s*(KiB|MiB|GiB)?(?:\s+at\s+(?:Unknown B)?\s*([0-9.]+|NA)\s*(KiB|MiB|GiB)?\/s)?(?:\s+ETA\s+([0-9:]+|Unknown))?/,
  );
  if (!m) return null;

  const percent = parseFloat(m[1]);
  const totalBytes = m[2] && m[2] !== "NA" && m[3] ? parseSize(m[2], m[3]) : null;
  const speedBps = m[4] && m[4] !== "NA" ? parseSize(m[4], m[5] ?? "KiB") : null;
  const etaSec = m[6] && m[6] !== "Unknown" ? parseEta(m[6]) : null;

  return {
    percent,
    downloadedBytes: totalBytes !== null ? (percent / 100) * totalBytes : null,
    totalBytes,
    speedBps,
    etaSec,
  };
}

/** Bungkus onProgress mentah dari provider dengan throttle waktu (biar event tidak banjir). */
export function throttledProgress(fn: ((p: FileProgress) => void) | undefined, gapMs = 300) {
  if (!fn) return undefined;
  let last = 0;
  return (p: FileProgress) => {
    const now = Date.now();
    // Selalu lewatkan event 100% & yang pertama supaya UI tidak menggantung di ujung.
    if (now - last < gapMs && p.percent !== null && p.percent < 100) return;
    last = now;
    fn(p);
  };
}

export class YouTubeProvider implements Provider {
  name = "youtube";
  priority = 100;

  constructor(private options: { cookiesFile?: string } = {}) {}

  private clientArgs(): string[] {
    // FIX: jangan pakai fetch_pot=always + wpc (spam buka Chrome).
    // Pakai ejs (node) saja + android/web client — cukup untuk bestaudio/best.
    // Kalau user kena 403, bisa pakai --cookies.
    const args = [
      "--js-runtimes",
      "node",
    ];
    if (this.options.cookiesFile) {
      args.push("--cookies", this.options.cookiesFile);
    }
    return args;
  }

  async search(track: Track, opts?: { relaxed?: boolean }): Promise<Candidate[]> {
    // Pass normal: judul + artist. Pass relaxed: judul saja — sering menemukan
    // audio resmi yang tidak muncul di 5 hasil pertama query gabungan.
    const query = opts?.relaxed
      ? track.title
      : `${track.title} ${track.artists.join(" ")}`;
    const q = query.replace(/[|]/g, " ");
    const args = [
      `ytsearch5:${q}`,
      "--flat-playlist",
      "--no-download",
      "--print",
      "%(id)s\t%(title)s\t%(channel)s\t%(duration)s",
    ];
    const out = await runYtDlp(args);

    const candidates: Candidate[] = [];
    for (const line of out.split("\n")) {
      const [id, title, channel, duration] = line.split("\t");
      if (!id || !title) continue;
      candidates.push({
        id,
        title,
        artist: channel ?? "",
        durationSec: duration ? parseFloat(duration) : null,
        url: `https://www.youtube.com/watch?v=${id}`,
      });
    }
    return candidates;
  }

  async download(candidate: Candidate, workDir: string, ctx?: ProviderContext): Promise<string> {
    const outPath = path.join(workDir, `${candidate.id}.%(ext)s`);
    const args = [
      candidate.url,
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "-o",
      outPath,
      "--no-warnings",
      "--newline",
      ...this.clientArgs(),
    ];
    await runYtDlp(args, {
      signal: ctx?.signal,
      onLine: (line) => {
        const p = parseYtDlpProgress(line);
        if (p) ctx?.onProgress?.(p);
      },
    });

    const fs = await import("node:fs");
    const files = fs.readdirSync(workDir).filter((f) => f.includes(candidate.id));
    if (files.length === 0) throw new Error("yt-dlp selesai tapi file tidak ditemukan");
    return path.join(workDir, files[0]);
  }
}
