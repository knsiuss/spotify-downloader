// YouTube video downloader via yt-dlp dengan custom resolution.
// Support: youtube.com/watch?v=, youtu.be/, shorts/, embed, music.youtube.com

import fs from "node:fs";
import path from "node:path";
import { runYtDlp, parseYtDlpProgress, isRetryableYtDlpError } from "../providers/youtube.js";
import { sanitizeFilename } from "../audio/ffmpeg.js";
import type { FileProgress } from "../core/types.js";

export type VideoResolution = "144" | "240" | "360" | "480" | "720" | "1080" | "1440" | "2160" | "best";
export type VideoFormat = "mp4" | "webm" | "mkv";

/** Info percobaan ulang — dikirim ke UI supaya kartu tidak terlihat mati saat yt-dlp gagal sekali. */
export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  error: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

export interface VideoDownloadRequest {
  url: string;
  outputDir: string;
  resolution: VideoResolution;
  format: VideoFormat;
  cookiesFile?: string;
}

export interface VideoDownloadResult {
  ok: boolean;
  outputPath: string | null;
  info: VideoInfo | null;
  error: string | null;
}

const YT_RE =
  /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/;

const YT_PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;

export function parseYouTubeUrl(url: string): string | null {
  const m = url.match(YT_RE);
  return m ? m[1] : null;
}

/**
 * Validasi ketat: URL harus benar-benar berupa URL https YouTube.
 * Versi lama menerima string apa pun yang MENGANDUNG "youtube.com" — itu
 * membuka argument injection ke yt-dlp (token diawali "-" diparse yt-dlp
 * sebagai flag seperti --config-locations / --batch-file).
 */
export function isYouTubeUrl(url: string): boolean {
  if (typeof url !== "string" || url.startsWith("-") || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (!/^(www\.|music\.)?(youtube\.com|youtu\.be)$/.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isYouTubePlaylistUrl(url: string): boolean {
  if (!isYouTubeUrl(url)) return false;
  try {
    const u = new URL(url);
    if (u.pathname === "/playlist" && u.searchParams.has("list")) return true;
  } catch { /* jatuh ke regex */ }
  return YT_PLAYLIST_RE.test(url);
}

export function parseYouTubePlaylistId(url: string): string | null {
  const m = url.match(YT_PLAYLIST_RE);
  return m ? m[1] : null;
}

/** Build yt-dlp format selector untuk resolution tertentu.
 * Tidak memfilter codec/container — biarkan `-S` (format-sort) yang memilih
 * bitrate TERTINGGI pada resolusi target (bukan codec tertentu). */
export function buildVideoFormat(resolution: VideoResolution, format: VideoFormat): string {
  if (resolution === "best") return "bestvideo+bestaudio/best";
  const h = parseInt(resolution, 10);
  return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
}

/** Build yt-dlp `-S` format-sort: resolusi target dulu, lalu BITRATE MAKSIMAL.
 * Untuk webm, codec diurutkan dulu (VP9/AV1) supaya hasil merge tetap
 * kompatibel dengan container webm (H.264 tidak bisa di-mux ke webm). */
export function buildVideoSort(resolution: VideoResolution, format: VideoFormat): string {
  if (resolution === "best") {
    return format === "webm" ? "vcodec,br" : "res,br";
  }
  const h = parseInt(resolution, 10);
  return format === "webm" ? `res:${h},vcodec,br` : `res:${h},br`;
}

/** Jumlah percobaan per file (1 = perilaku lama tanpa retry). */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.DROP_VIDEO_RETRIES ?? 3));

/** Timeout per percobaan, bukan total: percobaan berikutnya resume dari .part,
 * jadi anggaran waktu penuh per percobaan tidak berarti mengulang dari 0%. */
const ATTEMPT_TIMEOUT_MS = Number(process.env.DROP_VIDEO_TIMEOUT_MS ?? 600_000);
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 15_000;

/** Sleep yang tetap responsif terhadap cancel. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(attempt: number): number {
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  // Jitter supaya beberapa video yang gagal barengan tidak retry serempak.
  return backoff + Math.random() * 1_000;
}

/** Bentuk eksekutor yt-dlp — disuntikkan di test supaya tidak perlu binary asli. */
export type YtDlpRunner = (
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void },
) => Promise<string>;

/**
 * yt-dlp dengan resume: kegagalan transient (timeout, HTTP 403/429/5xx,
 * koneksi putus) diulang dengan backoff. yt-dlp default `--continue` + tulis
 * ke `.part`, jadi percobaan berikutnya melanjutkan byte yang sudah turun
 * (contoh: berhenti di 43% → lanjut 44%, bukan mulai dari nol).
 */
export async function runYtDlpWithResume(
  args: string[],
  opts: {
    signal?: AbortSignal;
    onLine?: (line: string) => void;
    onRetry?: (info: RetryInfo) => void;
    run?: YtDlpRunner;
    /** Override jeda antar percobaan (dipakai test supaya cepat). */
    retryDelayMs?: number;
    /** Probe "file final sudah ada" — yt-dlp bisa selesai menulis lalu gagal exit. */
    isComplete?: () => boolean;
  } = {},
): Promise<void> {
  const run = opts.run ?? runYtDlp;
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    try {
      await run(args, {
        timeoutMs: ATTEMPT_TIMEOUT_MS,
        signal: opts.signal,
        onLine: opts.onLine,
      });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "cancelled" || opts.signal?.aborted) throw new Error("cancelled");
      // File kelar ditulis tapi proses tewas (hang di exit / post-processing
      // gagal) — itu sukses, jangan buang waktu retry.
      if (opts.isComplete?.()) return;
      const canRetry = attempt < MAX_ATTEMPTS && isRetryableYtDlpError(msg);
      if (!canRetry) throw err instanceof Error ? err : new Error(msg);
      opts.onRetry?.({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, error: msg });
      await sleepAbortable(opts.retryDelayMs ?? retryDelayMs(attempt), opts.signal);
    }
  }
}

/** Args yt-dlp untuk satu file video — dipakai single & playlist biar perilaku identik. */
export function buildVideoArgs(
  videoUrl: string,
  outTemplate: string,
  resolution: VideoResolution,
  format: VideoFormat,
  cookiesFile?: string,
): string[] {
  const args = [
    "-f", buildVideoFormat(resolution, format),
    "-S", buildVideoSort(resolution, format),
    "--merge-output-format", format,
    "--no-playlist",
    // Eksplisit walau ini default yt-dlp: percobaan ulang HARUS melanjutkan .part.
    "--continue",
    "-o", outTemplate,
    "--no-warnings",
    "--js-runtimes", "node",
  ];
  // URL terakhir, di belakang "--": yt-dlp memperlakukan semua argumen
  // SETELAH "--" sebagai positional — jadi URL minus flag orang yang
  // meng-inject sesuatu seperti "--config-locations=...". videoUrl dari
  // body API (tidak tepercaya), jadi pertahanan berlapis di sini.
  args.push("--", videoUrl);
  if (cookiesFile) args.push("--cookies", cookiesFile);
  return args;
}

/**
 * Cari file final hasil unduhan. Mengabaikan `.part`/`.ytdl` (sisa unduhan
 * terputus) dan intermediate stream merge (`.f137.mp4`) supaya unduhan yang
 * gagal di tengah tidak salah dilaporkan sukses. Kalau ada beberapa ekstensi
 * (mis. sisa unduhan format lain), utamakan `preferredExt`.
 */
export function findDownloadedFile(dir: string, fileBase: string, preferredExt?: string): string | null {
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith(fileBase))
    .filter((name) => !name.includes(".part") && !name.includes(".ytdl"))
    .filter((name) => !/\.f\d+\./.test(name))
    .filter((name) => fs.statSync(path.join(dir, name)).size > 0);
  if (files.length === 0) return null;
  const preferred = preferredExt ? files.filter((name) => name.endsWith(`.${preferredExt}`)) : [];
  const pool = preferred.length > 0 ? preferred : files;
  const newest = pool
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return path.join(dir, newest.name);
}

export interface YouTubePlaylistInfo {
  id: string;
  title: string;
  channel: string | null;
  count: number;
  videos: VideoInfo[];
  thumbnailUrl: string | null;
}

function pickThumb(thumbnails: any): string | null {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  // yt-dlp thumbnails sorted ascending resolution; pick largest
  const last = thumbnails[thumbnails.length - 1];
  return last?.url ?? thumbnails[0]?.url ?? null;
}

/** Ambil info video tanpa download. */
export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const id = parseYouTubeUrl(url);
  if (!id) throw new Error("URL YouTube tidak valid");

  // URL terakhir di belakang "--" supaya tidak bisa jadi flag (lihat buildVideoArgs).
  const args = [
    "--print", "%(id)s\t%(title)s\t%(channel)s\t%(duration)s\t%(thumbnail)s",
    "--no-download",
    "--no-warnings",
    "--js-runtimes", "node",
    "--",
    url,
  ];
  const out = await runYtDlp(args, 60_000);
  const line = out.trim().split("\n")[0] ?? "";
  const [vid, title, channel, duration, thumb] = line.split("\t");
  const parsedDuration = duration ? Number.parseFloat(duration) : Number.NaN;
  return {
    id: vid ?? id,
    title: title ?? "Unknown",
    channel: channel ?? "Unknown",
    // yt-dlp print "NA" saat durasi tidak diketahui - NaN tidak boleh lolos ke UI/JSON.
    durationSec: Number.isFinite(parsedDuration) ? parsedDuration : null,
    thumbnailUrl: thumb ?? null,
  };
}

/** Ambil info playlist YouTube (flat, tanpa download). */
export async function getYouTubePlaylistInfo(url: string): Promise<YouTubePlaylistInfo> {
  const pid = parseYouTubePlaylistId(url) ?? "playlist";
  const args = [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--js-runtimes", "node",
    "--",
    url,
  ];
  const out = await runYtDlp(args, 90_000);
  let data: any;
  try { data = JSON.parse(out.trim()); } catch { throw new Error("Gagal parse info playlist"); }
  const entries: any[] = Array.isArray(data.entries) ? data.entries : [];
  const videos: VideoInfo[] = entries.map((e: any) => ({
    id: String(e.id ?? ""),
    title: String(e.title ?? "Unknown"),
    channel: String(e.channel ?? e.uploader ?? e.channel_id ?? "Unknown"),
    durationSec: e.duration ? Number(e.duration) : null,
    thumbnailUrl: e.thumbnail ?? pickThumb(e.thumbnails) ?? data.thumbnail ?? pickThumb(data.thumbnails),
  })).filter((v: VideoInfo) => v.id);
  return {
    id: String(data.id ?? pid),
    title: String(data.title ?? "YouTube Playlist"),
    channel: data.channel ?? data.uploader ?? null,
    count: videos.length,
    videos,
    thumbnailUrl: data.thumbnail ?? pickThumb(data.thumbnails) ?? videos[0]?.thumbnailUrl ?? null,
  };
}

/** Download video YouTube dengan resolution custom. */
export async function downloadVideo(
  req: VideoDownloadRequest,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: FileProgress) => void;
    /** Dipanggil tiap kali percobaan diulang (misal timeout/403) — UI tampilkan "menyambung ulang". */
    onRetry?: (info: RetryInfo) => void;
  } = {},
): Promise<VideoDownloadResult> {
  const id = parseYouTubeUrl(req.url);
  if (!id) {
    return { ok: false, outputPath: null, info: null, error: "URL YouTube tidak valid" };
  }

  fs.mkdirSync(req.outputDir, { recursive: true });

  // Ambil info dulu untuk nama file
  let info: VideoInfo | null = null;
  try {
    info = await getVideoInfo(req.url);
  } catch {
    info = { id, title: id, channel: "Unknown", durationSec: null, thumbnailUrl: null };
  }

  const baseName = sanitizeFilename(info.title);

  // File name include resolution biar 360p vs 1080p gak dianggap sama
  const fileBase = `${baseName} [${req.resolution}p]`;
  const expectedFile = path.join(req.outputDir, `${fileBase}.${req.format}`);
  if (fs.existsSync(expectedFile)) {
    return { ok: true, outputPath: expectedFile, info, error: "sudah ada" };
  }

  const outTemplate = path.join(req.outputDir, `${fileBase}.%(ext)s`);
  const args = buildVideoArgs(req.url, outTemplate, req.resolution, req.format, req.cookiesFile);

  try {
    await runYtDlpWithResume(args, {
      signal: opts.signal,
      onLine: (line) => {
        const p = parseYtDlpProgress(line);
        if (p) opts.onProgress?.(p);
      },
      onRetry: opts.onRetry,
      isComplete: () => findDownloadedFile(req.outputDir, fileBase, req.format) !== null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled" || opts.signal?.aborted) {
      return { ok: false, outputPath: null, info, error: "cancelled" };
    }
    return { ok: false, outputPath: null, info, error: msg };
  }

  // Cari file hasil — pakai fileBase
  const downloaded = findDownloadedFile(req.outputDir, fileBase, req.format);
  if (!downloaded) {
    return { ok: false, outputPath: null, info, error: "yt-dlp selesai tapi file tidak ditemukan" };
  }
  return { ok: true, outputPath: downloaded, info, error: null };
}

export interface YouTubePlaylistDownloadRequest extends VideoDownloadRequest {}
export interface YouTubePlaylistDownloadResult {
  ok: boolean;
  outputDir: string;
  count: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error: string | null;
}

/** Download playlist YouTube — tiap video di-download berurutan dengan progress per-item. */
export async function downloadYouTubePlaylist(
  req: YouTubePlaylistDownloadRequest,
  playlist: YouTubePlaylistInfo,
  opts: {
    signal?: AbortSignal;
    onStage?: (stage: "searching" | "downloading", index: number) => void;
    onFileProgress?: (p: FileProgress, index: number) => void;
    onRetry?: (info: RetryInfo, index: number) => void;
    onTrack?: (result: { ok: boolean; error: string | null; outputPath: string | null; title: string }, index: number) => void;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<YouTubePlaylistDownloadResult> {
  const playlistDir = path.join(req.outputDir, sanitizeFilename(playlist.title));
  fs.mkdirSync(playlistDir, { recursive: true });
  let succeeded = 0, failed = 0, skipped = 0;

  for (let i = 0; i < playlist.videos.length; i++) {
    if (opts.signal?.aborted) break;
    const v = playlist.videos[i];
    opts.onStage?.("downloading", i);
    const baseName = sanitizeFilename(v.title);
    const fileBase = `${baseName} [${req.resolution}p]`;
    const expected = path.join(playlistDir, `${fileBase}.${req.format}`);
    if (fs.existsSync(expected)) {
      skipped++;
      opts.onTrack?.({ ok: true, error: "sudah ada", outputPath: expected, title: v.title }, i);
      opts.onProgress?.(i + 1, playlist.videos.length);
      continue;
    }
    // Abort-aware skip if cancelled before download
    if (opts.signal?.aborted) {
      opts.onTrack?.({ ok: false, error: "cancelled", outputPath: null, title: v.title }, i);
      break;
    }
    const outTemplate = path.join(playlistDir, `${fileBase}.%(ext)s`);
    const videoUrl = `https://www.youtube.com/watch?v=${v.id}`;
    const args = buildVideoArgs(videoUrl, outTemplate, req.resolution, req.format, req.cookiesFile);
    try {
      await runYtDlpWithResume(args, {
        signal: opts.signal,
        onLine: (line) => {
          const p = parseYtDlpProgress(line);
          if (p) opts.onFileProgress?.(p, i);
        },
        onRetry: (info) => opts.onRetry?.(info, i),
        isComplete: () => findDownloadedFile(playlistDir, fileBase, req.format) !== null,
      });
      const downloaded = findDownloadedFile(playlistDir, fileBase, req.format);
      if (!downloaded) {
        failed++;
        opts.onTrack?.({ ok: false, error: "file tidak ditemukan", outputPath: null, title: v.title }, i);
      } else {
        succeeded++;
        opts.onTrack?.({ ok: true, error: null, outputPath: downloaded, title: v.title }, i);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "cancelled" || opts.signal?.aborted) {
        opts.onTrack?.({ ok: false, error: "cancelled", outputPath: null, title: v.title }, i);
        break;
      }
      failed++;
      opts.onTrack?.({ ok: false, error: msg, outputPath: null, title: v.title }, i);
    }
    opts.onProgress?.(i + 1, playlist.videos.length);
  }

  const cancelled = opts.signal?.aborted;
  return {
    ok: !cancelled && failed === 0,
    outputDir: playlistDir,
    count: playlist.videos.length,
    succeeded, failed, skipped,
    error: cancelled ? "cancelled" : null,
  };
}
