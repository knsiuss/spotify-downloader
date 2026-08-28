// YouTube video downloader via yt-dlp dengan custom resolution.
// Support: youtube.com/watch?v=, youtu.be/, shorts/, embed, music.youtube.com

import fs from "node:fs";
import path from "node:path";
import { runYtDlp, parseYtDlpProgress } from "../providers/youtube.js";
import { sanitizeFilename } from "../audio/ffmpeg.js";
import type { FileProgress } from "../core/types.js";

export type VideoResolution = "144" | "240" | "360" | "480" | "720" | "1080" | "1440" | "2160" | "best";
export type VideoFormat = "mp4" | "webm" | "mkv";

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

export function parseYouTubeUrl(url: string): string | null {
  const m = url.match(YT_RE);
  return m ? m[1] : null;
}

export function isYouTubeUrl(url: string): boolean {
  return YT_RE.test(url) || url.includes("youtube.com") || url.includes("youtu.be");
}

/** Build yt-dlp format selector untuk resolution tertentu. */
export function buildVideoFormat(resolution: VideoResolution, format: VideoFormat): string {
  if (resolution === "best") {
    // best video+audio, prefer mp4
    if (format === "mp4") return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";
    if (format === "webm") return "bestvideo[ext=webm]+bestaudio/bestvideo+bestaudio/best";
    return "bestvideo+bestaudio/best";
  }
  const h = parseInt(resolution, 10);
  if (format === "mp4") {
    return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}][ext=mp4]/best[height<=${h}]`;
  }
  if (format === "webm") {
    return `bestvideo[height<=${h}][ext=webm]+bestaudio/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
  }
  return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
}

/** Ambil info video tanpa download. */
export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const id = parseYouTubeUrl(url);
  if (!id) throw new Error("URL YouTube tidak valid");

  const args = [
    url,
    "--no-download",
    "--print", "%(id)s\t%(title)s\t%(channel)s\t%(duration)s\t%(thumbnail)s",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android,web",
    "--js-runtimes", "node",
  ];
  const out = await runYtDlp(args, 60_000);
  const line = out.trim().split("\n")[0] ?? "";
  const [vid, title, channel, duration, thumb] = line.split("\t");
  return {
    id: vid ?? id,
    title: title ?? "Unknown",
    channel: channel ?? "Unknown",
    durationSec: duration ? parseFloat(duration) : null,
    thumbnailUrl: thumb ?? null,
  };
}

/** Download video YouTube dengan resolution custom. */
export async function downloadVideo(
  req: VideoDownloadRequest,
  opts: { signal?: AbortSignal; onProgress?: (p: FileProgress) => void } = {},
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
  const formatSel = buildVideoFormat(req.resolution, req.format);

  // File name include resolution biar 360p vs 1080p gak dianggap sama
  const fileBase = `${baseName} [${req.resolution}p]`;
  const expectedFile = path.join(req.outputDir, `${fileBase}.${req.format}`);
  if (fs.existsSync(expectedFile)) {
    return { ok: true, outputPath: expectedFile, info, error: "sudah ada" };
  }

  const outTemplate = path.join(req.outputDir, `${fileBase}.%(ext)s`);
  const args = [
    req.url,
    "-f", formatSel,
    "--merge-output-format", req.format,
    "--no-playlist",
    "-o", outTemplate,
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android,web",
    "--js-runtimes", "node",
  ];
  if (req.cookiesFile) args.push("--cookies", req.cookiesFile);

  try {
    await runYtDlp(args, {
      timeoutMs: 600_000,
      signal: opts.signal,
      onLine: (line) => {
        const p = parseYtDlpProgress(line);
        if (p) opts.onProgress?.(p);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled" || opts.signal?.aborted) {
      return { ok: false, outputPath: null, info, error: "cancelled" };
    }
    return { ok: false, outputPath: null, info, error: msg };
  }

  // Cari file hasil — pakai fileBase
  const files = fs.readdirSync(req.outputDir).filter((f) => f.startsWith(fileBase));
  if (files.length === 0) {
    return { ok: false, outputPath: null, info, error: "yt-dlp selesai tapi file tidak ditemukan" };
  }
  const sorted = files
    .map((f) => ({ name: f, stat: fs.statSync(path.join(req.outputDir, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return { ok: true, outputPath: path.join(req.outputDir, sorted[0].name), info, error: null };
}
