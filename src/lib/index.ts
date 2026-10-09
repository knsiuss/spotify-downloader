// Domain API: entry point untuk semua logika download.
// CLI / UI / server semuanya lewat sini — tidak ada logika bisnis di CLI atau HTTP layer.
// Provider fallback: kalau provider A gagal, otomatis coba B, dst.

import path from "node:path";
import fs from "node:fs";
import { fetchSpotifyMetadata } from "../metadata/spotify.js";
import type { SpotifySource } from "../metadata/spotify.js";
import { YouTubeProvider } from "../providers/youtube.js";
import { SoundCloudProvider } from "../providers/soundcloud.js";
import { QobuzProvider, loadQobuzConfig } from "../providers/qobuz.js";
import { processTrack } from "../core/pipeline.js";
import type { TrackStage } from "../core/pipeline.js";
import { sanitizeFilename } from "../audio/ffmpeg.js";
import { writeReport } from "./report.js";
import type { DownloadResult, OutputFormat, Provider, Track, FileProgress, ErrorCategory } from "../core/types.js";
import { AppError } from "../core/types.js";

export interface DownloadRequest {
  /** Link Spotify (URL atau URI). */
  input: string;
  /** Direktori output absolut. */
  outputDir: string;
  /** Format output. */
  formats: OutputFormat[];
  /** Batas track (undefined = semua). */
  limit?: number;
  /** File cookies Netscape untuk YouTube (opsional). */
  cookiesFile?: string;
  /** Environment variables dari .env (QOBUZ_*, YT_COOKIES). */
  env?: Record<string, string>;
  /** Konkruensi download paralel (default 3). */
  concurrency?: number;
  /** Retry count per track (default 1). */
  retries?: number;
  /** Fetch & simpan lirik (.lrc/.txt) kalau ada. */
  fetchLyrics?: boolean;
}

export interface DownloadSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
  /** True kalau batch dihentikan user sebelum selesai. */
  cancelled?: boolean;
}

export interface DownloadResponse {
  results: DownloadResult[];
  summary: DownloadSummary;
  /** Path file report JSON. */
  reportPath: string | null;
}

export interface DownloadCallbacks {
  onTrack?: (result: DownloadResult, index: number) => void;
  onProgress?: (completed: number, total: number) => void;
  onWarning?: (message: string) => void;
  /** Ganti tahap per track (index dikirim supaya UI tahu baris mana). */
  onStage?: (stage: TrackStage, index: number) => void;
  /** Progress file sumber per track (throttled oleh pipeline). */
  onFileProgress?: (p: FileProgress, index: number) => void;
  /** Aborted = seluruh batch berhenti (track yang jalan ikut dibatalkan). */
  signal?: AbortSignal;
}

/** Bangun daftar provider dari request. */
function buildProviders(req: DownloadRequest): Provider[] {
  const env = req.env ?? {};
  const cookiesFile = req.cookiesFile ?? env.YT_COOKIES;
  const providers: Provider[] = [
    new YouTubeProvider(cookiesFile ? { cookiesFile: path.resolve(cookiesFile) } : {}),
    new SoundCloudProvider(),
  ];
  const qobuzCfg = loadQobuzConfig({ ...env, QOBUZ_APP_ID: env.QOBUZ_APP_ID });
  if (qobuzCfg) {
    providers.unshift(new QobuzProvider(qobuzCfg));
  }
  return providers;
}

/** Cek apakah error layak di-retry (network errors, provider errors — bukan no-match/format). */
function isRetryable(result: DownloadResult): boolean {
  if (result.ok) return false;
  if (result.error?.includes("sudah ada")) return false;
  if (result.errorCategory === "cancelled") return false;
  // Retry hanya untuk error transient (network, rate-limit), bukan "no match" atau "format"
  return result.errorCategory === "network" || result.errorCategory === "rate-limit" || result.errorCategory === "provider";
}

// Cooldown global saat batch kena rate-limit: worker lain ikut mengendur
// supaya tidak stampede (semua retry barengan justru makin memicu 429).
let rateLimitCooldownUntil = 0;
const RATE_LIMIT_BASE_BACKOFF_MS = 15_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

/** Sleep yang bisa diputus oleh signal (dibatalkan = resolve lebih awal). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Proses satu track dengan retry. */
async function processWithRetry(
  track: Track,
  opts: {
    outputDir: string;
    formats: OutputFormat[];
    providers: Provider[];
    fetchLyrics?: boolean;
    trackTotal?: number;
    signal?: AbortSignal;
    onStage?: (stage: TrackStage) => void;
    onFileProgress?: (p: FileProgress) => void;
  },
  retries: number,
): Promise<DownloadResult> {
  let lastResult: DownloadResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await processTrack(track, opts);
    if (result.ok) return result;
    lastResult = result;
    // Jangan retry kalau user sudah membatalkan.
    if (opts.signal?.aborted) break;
    // Retry hanya untuk error transient, bukan "no match", "format", atau "cancelled"
    if (!isRetryable(result)) break;
    if (attempt < retries) {
      // Rate-limit butuh backoff jauh lebih panjang + menahan seluruh batch;
      // error transient lain cukup backoff pendek.
      if (result.errorCategory === "rate-limit") {
        rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + RATE_LIMIT_BASE_BACKOFF_MS);
      }
      const base = result.errorCategory === "rate-limit" ? RATE_LIMIT_BASE_BACKOFF_MS : 1000;
      const wait = Math.min(base * 2 ** attempt, RATE_LIMIT_MAX_BACKOFF_MS);
      await sleep(wait, opts.signal);
      if (opts.signal?.aborted) break;
    }
  }
  return lastResult!;
}

/**
 * Folder tujuan akhir: playlist/album dapat subfolder bernama sesuai judulnya,
 * track tunggal langsung di output dir. Dipakai downloadTracks & server (event start).
 */
export function resolveTargetDir(req: DownloadRequest, source: SpotifySource): { dir: string; isSubfolder: boolean } {
  if (source.type === "track") {
    return { dir: req.outputDir, isSubfolder: false };
  }
  const name = sanitizeFilename(source.name).trim();
  if (!name) return { dir: req.outputDir, isSubfolder: false };
  return { dir: path.join(req.outputDir, name), isSubfolder: true };
}

/** Pastikan folder tujuan ada dan benar-benar folder (bukan file dengan nama sama). */
function ensureTargetDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir).isDirectory()) {
    throw new AppError(`Path output sudah dipakai file, bukan folder: ${dir}`, "format", undefined, false);
  }
}

/**
 * Jalankan batch download untuk source yang sudah difetch.
 * Pemanggil (server) bisa fetch metadata sendiri dulu supaya tidak double-scrape.
 */
export async function downloadTracks(
  req: DownloadRequest,
  source: SpotifySource,
  callbacks?: DownloadCallbacks,
): Promise<DownloadResponse> {
  const started = Date.now();
  const signal = callbacks?.signal;
  const providers = buildProviders(req);
  const retries = req.retries ?? 1;

  // Playlist/album → subfolder sendiri di dalam output dir.
  const target = resolveTargetDir(req, source);
  ensureTargetDir(target.dir);

  const tracks: Track[] = req.limit
    ? source.tracks.slice(0, Math.max(1, req.limit))
    : source.tracks;

  // Warn kalau playlist terpotong.
  if (source.truncated && !req.limit) {
    callbacks?.onWarning?.(
      `Playlist "${source.name}" mungkin terpotong (embed endpoint render maks ~100 track). ` +
      `Gunakan limit, atau bagi playlist besar.`,
    );
  }

  // Proses dengan konkurensi terbatas.
  const results: DownloadResult[] = [];
  const concurrency = Math.max(1, req.concurrency ?? 3);
  let idx = 0;

  async function worker() {
    while (idx < tracks.length && !signal?.aborted) {
      // Tunda track baru selama cooldown rate-limit aktif (semua worker
      // mengendur, bukan cuma yang kena) — cegah stampede.
      const cooldown = rateLimitCooldownUntil - Date.now();
      if (cooldown > 0) await sleep(cooldown, signal);
      if (signal?.aborted) break;
      const i = idx++;
      const result = await processWithRetry(
        tracks[i],
        {
          outputDir: target.dir,
          formats: req.formats,
          providers,
          fetchLyrics: req.fetchLyrics,
          trackTotal: tracks.length,
          signal,
          onStage: (stage) => callbacks?.onStage?.(stage, i),
          onFileProgress: (p) => callbacks?.onFileProgress?.(p, i),
        },
        retries,
      );
      results.push(result);
      callbacks?.onTrack?.(result, i);
      callbacks?.onProgress?.(results.length, tracks.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tracks.length) }, () => worker());
  await Promise.all(workers);

  const cancelled = Boolean(signal?.aborted);
  const succeeded = results.filter((r) => r.ok && r.error === null).length;
  const skipped = results.filter((r) => r.ok && r.error === "sudah ada").length;
  const failed = results.length - succeeded - skipped;

  // Tulis report hanya kalau batch selesai normal (bukan dibatalkan).
  let reportPath: string | null = null;
  if (!cancelled) {
    reportPath = path.join(target.dir, "report.json");
    writeReport(reportPath, { source, results, req, durationMs: Date.now() - started });
  }

  return {
    results,
    summary: {
      total: tracks.length,
      succeeded,
      failed,
      skipped,
      durationMs: Date.now() - started,
      cancelled,
    },
    reportPath,
  };
}

/** Jalankan satu batch download lengkap (fetch metadata + proses). Dipakai CLI. */
export async function download(
  req: DownloadRequest,
  callbacks?: DownloadCallbacks,
): Promise<DownloadResponse> {
  let source: SpotifySource;
  try {
    source = await fetchSpotifyMetadata(req.input);
  } catch (err) {
    throw new AppError(
      `Metadata fetch gagal: ${err instanceof Error ? err.message : String(err)}`,
      "metadata",
      undefined,
      false,
    );
  }
  return downloadTracks(req, source, callbacks);
}
