// Pipeline audio: decode file sumber apa pun → mux ke format target WAV/FLAC/MP3.
// Untuk WAV: PASTI pcm_s16le 44.1kHz stereo (bukan MP3 yang dibungkus .wav).
// Verifikasi output via ffprobe — ini jaminan kualitas "WAV asli".

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveBinary } from "../lib/binaries.js";
import { trackChild } from "../lib/procs.js";
import type { AudioProbe, OutputFormat } from "../core/types.js";
import type { TrackMeta } from "./tags.js";

// -sample_fmt TIDAK di-forcing: libmp3lame (ffmpeg 8) menolak packed s16.
// Codec pcm_s16le sudah memastikan WAV = s16; FLAC/MP3 pilih format internal sendiri.
const PCM_ARGS = ["-ar", "44100", "-ac", "2"];

/** Panggil ffmpeg/ffprobe, reject kalau gagal. Signal aborted = child dibunuh. */
function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    const child = trackChild(spawn(resolveBinary(cmd), args, { windowsHide: true }));
    let out = "";
    let err = "";

    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`${cmd} tidak bisa dijalankan: ${e.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { reject(new Error("cancelled")); return; }
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} keluar dengan code ${code}: ${err.slice(-800)}`));
    });
  });
}

/** Konversi file sumber → format output. Source bisa webm/m4a/flac/apa pun.
 *  meta opsional → ditulis sebagai tag (RIFF INFO untuk WAV, ID3 untuk MP3, Vorbis untuk FLAC). */
export async function transcode(
  sourceFile: string,
  targetFormat: OutputFormat,
  outPathNoExt: string,
  signal?: AbortSignal,
  meta?: TrackMeta,
): Promise<string> {
  const outFile = `${outPathNoExt}.${targetFormat}`;
  let codecArgs: string[];

  switch (targetFormat) {
    case "wav":
      // pcm_s16le = WAV CD-standard. "ffmpeg ... -c:a pcm_s16le out.wav" sudah benar
      // dari default muxer; kita pastikan eksplisit biar tidak ambigu.
      codecArgs = ["-c:a", "pcm_s16le"];
      break;
    case "flac":
      codecArgs = ["-c:a", "flac"];
      break;
    case "mp3":
      codecArgs = ["-c:a", "libmp3lame", "-b:a", "256k"];
      break;
  }

  const metaArgs: string[] = [];
  if (meta) {
    const push = (k: string, v?: string | number | null) => {
      if (v !== null && v !== undefined && v !== "") metaArgs.push("-metadata", `${k}=${v}`);
    };
    push("title", meta.title);
    push("artist", meta.artist);
    push("album", meta.album);
    push("album_artist", meta.albumArtist);
    if (meta.trackNo) push("track", meta.trackTotal ? `${meta.trackNo}/${meta.trackTotal}` : String(meta.trackNo));
    // MP3: jadi frame USLT. FLAC: jadi komentar Vorbis LYRICS.
    push("lyrics", meta.lyrics);
  }

  await run("ffmpeg", [
    "-y",
    "-i", sourceFile,
    ...PCM_ARGS,
    ...codecArgs,
    ...metaArgs,
    "-vn",
    "-map_metadata", "-1",
    "-map", "0:a",
    outFile,
  ], signal);
  return outFile;
}

/** Baca header file audio via ffprobe → konfirmasi codec asli. */
export async function probe(filePath: string): Promise<AudioProbe> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    filePath,
  ]);
  const json = JSON.parse(out) as {
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string }>;
    format?: { format_name?: string; bit_rate?: string };
  };
  const s = json.streams?.[0];
  return {
    codecName: s?.codec_name ?? "unknown",
    sampleRate: Number(s?.sample_rate ?? 0),
    channels: Number(s?.channels ?? 0),
    bitRate: Number(s?.bit_rate ?? json.format?.bit_rate ?? 0),
    formatName: json.format?.format_name ?? "unknown",
  };
}

/** Cek output benar-benar WAV PCM s16le — bagian dari jaminan "WAV asli". */
export function assertRealWav(probe: AudioProbe): void {
  if (probe.codecName !== "pcm_s16le") {
    throw new Error(
      `WAV PALSU terdeteksi: codec=${probe.codecName} (harus pcm_s16le). File tidak disimpan.`
    );
  }
}

/**
 * Sanitasi nama file/folder dari metadata track.
 * WAJIB menutup traversal: hasil "." / ".." / kosong / hanya-dot akan di-
 * path.join() menjadi parent directory (playlist berjudul ".." => tulis
 * ke root drive). Juga tolak nama reserved Windows (CON/PRN/AUX/NUL/COM/LPT)
 * karena di Windows itu tidak bisa jadi nama file.
 */
export function sanitizeFilename(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  if (/^\.+$/.test(s)) s = "untitled"; // ".", "..", "...", dll
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `${s}_`;
  return s || "untitled";
}

/** Cari file output yang sudah ada (skip logic). */
export function outputExists(dir: string, baseName: string, format: OutputFormat): boolean {
  return fs.existsSync(path.join(dir, `${baseName}.${format}`));
}