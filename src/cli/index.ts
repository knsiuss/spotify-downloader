#!/usr/bin/env node
// CLI thin wrapper: parse args → panggil domain API → print output.
// Tidak ada logika bisnis di sini.

import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { download } from "../lib/index.js";
import type { OutputFormat } from "../core/types.js";
import { AppError } from "../core/types.js";
import { downloadVideo, isYouTubeUrl } from "../video/youtube-video.js";
import type { VideoResolution, VideoFormat } from "../video/youtube-video.js";

// Load .env sederhana (tanpa dependency).
function loadEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const envFile = loadEnvFile();
for (const [k, v] of Object.entries(envFile)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const { values } = parseArgs({
  options: {
    url: { type: "string", short: "u" },
    "output-dir": { type: "string", short: "o", default: "./output" },
    formats: { type: "string", short: "f", default: "wav" },
    cookies: { type: "string", short: "c" },
    limit: { type: "string", short: "n" },
    concurrency: { type: "string", short: "j" },
    retries: { type: "string", short: "r" },
    lyrics: { type: "boolean", short: "l", default: false },
    resolution: { type: "string", short: "R" },
    "video-format": { type: "string", default: "mp4" },
    help: { type: "boolean", short: "h" },
  },
  args: process.argv.slice(2),
  allowPositionals: true,
});

if (values.help || (!values.url && process.argv.slice(2).length === 0)) {
  console.log(`Spotify Downloader + YouTube Video (tanpa akun Spotify)
Usage:
  AUDIO (Spotify):
    spotfid <spotify-url> -o <dir> -f <formats> [-l] [-c cookies.txt] [-j 3]
    spotify-url : https://open.spotify.com/{playlist|album|track}/<id>
    -f, --formats    : wav,flac,mp3 (default wav) — bisa kombinasi: wav,flac
    -l, --lyrics     : download lirik (.lrc/.txt) kalau ada
    -n, --limit      : batas jumlah track
    -j, --concurrency: paralel (default 3)

  VIDEO (YouTube):
    spotfid <youtube-url> -R <res> --video-format <fmt> -o <dir>
    youtube-url: https://www.youtube.com/watch?v=... / youtu.be/... / shorts/...
    -R, --resolution   : 144,240,360,480,720,1080,1440,2160,best (default 720)
    --video-format     : mp4,webm,mkv (default mp4)

  UMUM:
    -o, --output-dir : folder output (default ./output)
    -c, --cookies    : file cookies Netscape untuk YouTube
    -r, --retries    : retry per track (default 1)

  SERVER:
    npm run server          # backend http://localhost:3001
    npm run web             # frontend http://localhost:3000
`);
  process.exit(0);
}

const input = values.url ?? process.argv[2];
const outputDir = path.resolve(values["output-dir"] ?? "./output");

// --- VIDEO MODE: deteksi YouTube URL + ada --resolution atau url youtube ---
const isVideoMode = (values.resolution !== undefined) || (input && isYouTubeUrl(input) && !input.includes("spotify.com"));

if (isVideoMode && input && isYouTubeUrl(input)) {
  const resolution = (values.resolution ?? "720") as VideoResolution;
  const videoFormat = (values["video-format"] ?? "mp4") as VideoFormat;
  const validRes = new Set(["144","240","360","480","720","1080","1440","2160","best"]);
  const validFmt = new Set(["mp4","webm","mkv"]);
  if (!validRes.has(resolution)) {
    console.error(`Resolution tidak valid: ${resolution}. Pilih: 144,240,360,480,720,1080,1440,2160,best`);
    process.exit(1);
  }
  if (!validFmt.has(videoFormat)) {
    console.error(`Video format tidak valid: ${videoFormat}. Pilih: mp4,webm,mkv`);
    process.exit(1);
  }
  console.log(`[spotify-downloader] Video mode: ${resolution}p ${videoFormat} ...`);
  const result = await downloadVideo({
    url: input,
    outputDir,
    resolution,
    format: videoFormat,
    cookiesFile: values.cookies ? path.resolve(values.cookies) : undefined,
  });
  if (result.ok) {
    if (result.error === "sudah ada") console.log(`→ ${result.info?.title ?? input} (skip: sudah ada)`);
    else console.log(`✓ ${result.info?.title ?? input} -> ${result.outputPath}`);
    if (result.outputPath) console.log(`Saved: ${result.outputPath}`);
  } else {
    console.error(`✗ ${result.info?.title ?? input}: ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

// --- AUDIO MODE (Spotify) ---
const formats = (values.formats ?? "wav")
  .split(",")
  .map((f) => f.trim().toLowerCase())
  .filter((f): f is OutputFormat => f === "wav" || f === "flac" || f === "mp3");

if (formats.length === 0) {
  console.error("Format tidak valid. Pilih dari: wav, flac, mp3");
  process.exit(1);
}

const cookiesFile = values.cookies ?? process.env.YT_COOKIES;
const concurrency = values.concurrency ? parseInt(values.concurrency, 10) : 3;
const limit = values.limit ? parseInt(values.limit, 10) : undefined;
const retries = values.retries ? parseInt(values.retries, 10) : 1;
const wantLyrics = Boolean(values.lyrics);

// -------- LOGO --------
console.log("[spotify-downloader] Mulai..." + (wantLyrics ? " (+lirik)" : ""));

let response;
try {
  response = await download(
    {
      input,
      outputDir,
      formats,
      limit,
      cookiesFile,
      env: envFile,
      concurrency,
      retries,
      fetchLyrics: wantLyrics,
    },
    {
      onTrack: (r) => {
        const lyricsTag = (r as any).lyricsEmbedded ? " +lirik" : (r as any).instrumental ? " [instrumental]" : "";
        if (r.ok && r.error === null) {
          console.log(`  ✓ ${r.track.artists[0]} - ${r.track.title} (${r.providerUsed})${lyricsTag}`);
        } else if (r.ok && r.error === "sudah ada") {
          console.log(`  → ${r.track.artists[0]} - ${r.track.title} (skip: sudah ada)${lyricsTag}`);
        } else {
          const tag = r.errorCategory ? `[${r.errorCategory}]` : "";
          console.log(`  ✗ ${r.track.artists[0]} - ${r.track.title}: ${tag} ${r.error}`);
        }
      },
      onProgress: (done, total) => {
        process.stdout.write(`\r  [${done}/${total}]`);
      },
      onWarning: (msg) => {
        console.log(`  ⚠ ${msg}`);
      },
    }
  );
} catch (err) {
  if (err instanceof AppError) {
    console.error(`\n✗ Error [${err.category}]: ${err.message}`);
  } else {
    console.error(`\n✗ Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

console.log(""); // newline setelah progress

const s = response.summary;
console.log(
  `Selesai: ${s.succeeded} berhasil, ${s.skipped} skip, ${s.failed} gagal, ` +
  `${s.total} total, ${(s.durationMs / 1000).toFixed(1)}s`
);

if (s.failed > 0) {
  console.log("\nGagal:");
  for (const r of response.results.filter((r) => !r.ok)) {
    const tag = r.errorCategory ? `[${r.errorCategory}]` : "";
    const errLines = (r.error ?? "").split("\n").map((l) => `    ${l}`).join("\n");
    console.log(`  ✗ ${r.track.artists[0]} - ${r.track.title}: ${tag}\n${errLines}`);
  }
}

if (response.reportPath) {
  console.log(`\nReport: ${response.reportPath}`);
}

if (s.failed > 0) process.exitCode = 1;
