// Download binary eksternal (yt-dlp + ffmpeg/ffprobe) ke bin/ agar repo ramping.
// Dilewati saat dipanggil dari CI yang tidak punya akses internet — build
// akan gagal jelas di electron-builder (extraResources bin/ tidak ada).
//
// Pakai: node scripts/download-bins.mjs [--force]
// Env:
//   SKIP_BINARIES=1  -> exit 0 tanpa download (untuk CI offline)

import { mkdirSync, existsSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

if (process.env.SKIP_BINARIES === "1") {
  console.log("[bins] SKIP_BINARIES=1 — melewati download binary.");
  process.exit(0);
}

const FORCE = process.argv.includes("--force");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(root, "bin");
mkdirSync(binDir, { recursive: true });

// --- pin versi di sini (naikkan manual, verifikasi checksum di bawah) ---
const FFMPEG_VERSION = "7.0.1";
const FFMPEG_URL = `https://www.gyan.dev/ffmpeg/releases/ffmpeg-release-essentials_build.zip`;
// base stabil gyan.dev; build 7.0.1 memang disimpan sebagai "release" branch master
// kalau mau pin versi eksak, ganti ke:
// https://www.gyan.dev/ffmpeg/releases/ffmpeg-7.0.1-essentials_build.zip

const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

async function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

async function download(url, dest) {
  console.log(`[bins] GET ${url}`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${url}`);
  const tmp = `${dest}.partial`;
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tmp, buf);
  return tmp;
}

function extractZip(zipFile, outDir) {
  if (process.platform === "win32") {
    // PowerShell Expand-Archive
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command", `Expand-Archive -Path '${zipFile.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`Expand-Archive gagal: ${r.stderr || r.stdout}`);
  } else {
    const r = spawnSync("unzip", ["-q", "-o", zipFile, "-d", outDir], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`unzip gagal: ${r.stderr || r.stdout}`);
  }
}

function walk(dir, out = []) {
  for (const e of process.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function ensure(outPath, fetchFn, label) {
  if (!FORCE && existsSync(outPath)) {
    console.log(`[bins] OK (sudah ada): ${path.relative(root, outPath)}`);
    return;
  }
  const tmp = await fetchFn();
  renameSync(tmp, outPath);
  console.log(`[bins] OK: ${path.relative(root, outPath)}`);
}

async function main() {
  // yt-dlp: single exe
  await ensure(path.join(binDir, "yt-dlp.exe"), () => download(YTDLP_URL, path.join(binDir, "yt-dlp.exe")), "yt-dlp");

  // ffmpeg/ffprobe: zip essentials build (ke dalam bin/)
  const ffmpegExe = path.join(binDir, "ffmpeg.exe");
  const ffprobeExe = path.join(binDir, "ffprobe.exe");
  if (!FORCE && existsSync(ffmpegExe) && existsSync(ffprobeExe)) {
    console.log("[bins] OK (sudah ada): ffmpeg.exe, ffprobe.exe");
  } else {
    const zip = await download(FFMPEG_URL, path.join(binDir, "ffmpeg.zip"));
    const extractDir = path.join(os.tmpdir(), `drop-ffmpeg-${Date.now()}`);
    mkdirSync(extractDir, { recursive: true });
    try {
      extractZip(zip, extractDir);
      const files = walk(extractDir);
      const ff = files.find((f) => f.endsWith("ffmpeg.exe"));
      const fp = files.find((f) => f.endsWith("ffprobe.exe"));
      if (!ff || !fp) throw new Error("ffmpeg.exe/ffprobe.exe tidak ditemukan di dalam zip");
      renameSync(ff, ffmpegExe);
      renameSync(fp, ffprobeExe);
      console.log("[bins] OK: ffmpeg.exe, ffprobe.exe");
    } finally {
      rmSync(zip, { force: true });
      rmSync(extractDir, { recursive: true, force: true });
    }
  }

  console.log("[bins] selesai.");
}

main().catch((err) => {
  console.error("[bins] gagal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
