// Metadata & cover art embedder.
// MP3  : ID3v2 APIC via ffmpeg.
// FLAC : METADATA_BLOCK_PICTURE via ffmpeg.
// WAV  : ffmpeg tidak bisa menulis cover (muxer menolak video stream),
//        jadi tag + cover ditulis manual sebagai chunk "id3 " di dalam RIFF —
//        format yang dibaca foobar2000/MusicBee/VLC/Windows Explorer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveBinary } from "../lib/binaries.js";
import { trackChild } from "../lib/procs.js";
import type { OutputFormat } from "../core/types.js";

/** Metadata lagu yang ditempel ke semua format output. */
export interface TrackMeta {
  title: string;
  artist: string;
  albumArtist?: string | null;
  album?: string | null;
  trackNo?: number | null;
  trackTotal?: number | null;
  /** Lirik yang ditanam ke tag (USLT/LYRICS). Isi LRC tersinkron jika ada. */
  lyrics?: string | null;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = trackChild(spawn(resolveBinary(cmd), args, { windowsHide: true }));
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${err.slice(-500)}`));
    });
  });
}

/** Download cover art, return bytes JPEG/PNG. Null kalau gagal (jangan gagalkan track).
 *  Timeout 10s - cover yang stall tidak boleh menahan worker selamanya. */
export async function downloadCover(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Embed cover art ke file audio (MP3/FLAC).
 * - MP3 : ffmpeg map cover sebagai ID3v2 APIC.
 * - FLAC: ffmpeg map cover sebagai METADATA_BLOCK_PICTURE.
 * - WAV : jangan panggil fungsi ini — pakai writeWavId3.
 */
export async function embedCoverArt(
  audioFile: string,
  coverBytes: Buffer,
  format: OutputFormat
): Promise<void> {
  if (format === "wav") return;

  // ffmpeg butuh file di disk untuk input gambar. Nama unik per panggilan -
  // Date.now() bentrok saat banyak worker embed cover di milidetik yang sama.
  const tmp = path.join(os.tmpdir(), `spotfid-cover-${randomUUID()}.jpg`);
  fs.writeFileSync(tmp, coverBytes);

  try {
    const tmpOut = audioFile + ".cover" + path.extname(audioFile);
    const args = [
      "-y",
      "-i", audioFile,
      "-i", tmp,
      "-map", "0:a",
      "-map", "1:v",
      // Audio JANGAN di-encode ulang - ini menyisipkan cover, bukan transcode lagi
      // (MP3 yang sudah 256k akan turun kualitasnya kalau lewat lame kedua kali).
      "-c:a", "copy",
      "-c:v", "mjpeg",
      "-disposition:v", "attached_pic",
    ];

    if (format === "mp3") {
      args.push("-id3v2_version", "3");
    }

    args.push(tmpOut);
    await run("ffmpeg", args);

    // Ganti file asli dengan versi + cover.
    fs.renameSync(tmpOut, audioFile);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp boleh tertinggal */ }
  }
}

// ================= ID3v2 untuk WAV (tanpa dependency) =================

/** Teks frame ID3v2.3 dengan encoding UTF-16 + BOM (aman untuk unicode). */
function id3Text(value: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x01]),               // encoding: UTF-16 with BOM
    Buffer.from([0xff, 0xfe]),         // BOM LE
    Buffer.from(value, "utf16le"),
    Buffer.from([0x00, 0x00]),         // terminator
  ]);
}

function id3Frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(payload.length, 4); // v2.3: size biasa (bukan syncsafe)
  return Buffer.concat([header, payload]);
}

function syncsafe(n: number): Buffer {
  const b = Buffer.alloc(4);
  b[0] = (n >> 21) & 0x7f;
  b[1] = (n >> 14) & 0x7f;
  b[2] = (n >> 7) & 0x7f;
  b[3] = n & 0x7f;
  return b;
}

function coverMime(bytes: Buffer): string {
  return bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : "image/jpeg";
}

/** Bangun tag ID3v2.3 lengkap (teks + APIC) dari metadata & cover. */
export function buildId3Tag(meta: TrackMeta, coverBytes?: Buffer | null): Buffer {
  const frames: Buffer[] = [];

  const pushText = (id: string, value?: string | null) => {
    if (value) frames.push(id3Frame(id, id3Text(value)));
  };
  pushText("TIT2", meta.title);
  pushText("TPE1", meta.artist);
  pushText("TALB", meta.album);
  pushText("TPE2", meta.albumArtist);
  if (meta.trackNo) {
    pushText("TRCK", meta.trackTotal ? `${meta.trackNo}/${meta.trackTotal}` : String(meta.trackNo));
  }

  // USLT — lirik tertanam (foobar2000/MusicBee/pemutar HP membaca frame ini;
  // isi LRC tersinkron tetap ditampilkan sinkron oleh banyak pemutar).
  if (meta.lyrics) {
    const payload = Buffer.concat([
      Buffer.from([0x01]),                       // encoding UTF-16
      Buffer.from("eng", "latin1"),              // bahasa
      Buffer.from([0xff, 0xfe]), Buffer.from([0x00, 0x00]), // deskripsi kosong
      Buffer.from([0xff, 0xfe]),                 // BOM
      Buffer.from(meta.lyrics, "utf16le"),
      Buffer.from([0x00, 0x00]),
    ]);
    frames.push(id3Frame("USLT", payload));
  }

  if (coverBytes && coverBytes.length > 0) {
    const mime = coverMime(coverBytes);
    const payload = Buffer.concat([
      Buffer.from([0x01]),                    // encoding UTF-16
      Buffer.from(mime, "latin1"), Buffer.from([0x00]),
      Buffer.from([0x03]),                    // picture type: front cover
      Buffer.from([0xff, 0xfe]), Buffer.from([0x00, 0x00]), // deskripsi kosong (UTF-16)
      coverBytes,
    ]);
    frames.push(id3Frame("APIC", payload));
  }

  const body = Buffer.concat(frames);
  const header = Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([0x03, 0x00, 0x00]),        // versi 2.3, flags 0
    syncsafe(body.length),
  ]);
  return Buffer.concat([header, body]);
}

/**
 * Sisipkan (atau ganti) chunk "id3 " di dalam file WAV.
 * Aman dipanggil berulang: chunk id3 lama dibuang dulu, chunk lain dipertahankan.
 * Throw kalau file bukan RIFF/WAVE valid — caller diharapkan swallow.
 */
export function writeWavId3(wavPath: string, meta: TrackMeta, coverBytes?: Buffer | null): void {
  const data = fs.readFileSync(wavPath);
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("Bukan file RIFF/WAVE valid");
  }

  // Bedah chunk lama (skip pad byte untuk chunk berukuran ganjil).
  const chunks: Array<{ id: string; payload: Buffer }> = [];
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString("latin1", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const end = Math.min(offset + 8 + size, data.length);
    if (size > data.length) break; // korup — jangan proses lebih jauh
    chunks.push({ id, payload: data.subarray(offset + 8, end) });
    offset += 8 + size + (size & 1);
  }

  // ID chunk selalu 4 karakter — "id3 " (dengan trailing space).
  const kept = chunks.filter((c) => c.id !== "id3 ");
  const tag = buildId3Tag(meta, coverBytes);
  const pad = Buffer.alloc(tag.length & 1);
  const id3Chunk = Buffer.alloc(8 + tag.length + pad.length);
  id3Chunk.write("id3 ", 0, "latin1");
  id3Chunk.writeUInt32LE(tag.length, 4);
  tag.copy(id3Chunk, 8);
  pad.copy(id3Chunk, 8 + tag.length);

  const others = kept.map((c) => {
    const head = Buffer.alloc(8);
    head.write(c.id, 0, "latin1");
    head.writeUInt32LE(c.payload.length, 4);
    const p = Buffer.concat([c.payload, Buffer.alloc(c.payload.length & 1)]);
    return Buffer.concat([head, p]);
  });

  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), id3Chunk, ...others]);
  const out = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(body.length, 0); return b; })(),
    body,
  ]);
  fs.writeFileSync(wavPath, out);
}
