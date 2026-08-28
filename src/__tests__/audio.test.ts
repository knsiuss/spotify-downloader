// Unit test: audio pipeline (transcode + verify).
// Buat audio sintetis → transcode ke WAV/FLAC/MP3 → verifikasi.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { transcode, probe, assertRealWav } from "../audio/ffmpeg.js";
import { buildId3Tag, writeWavId3 } from "../audio/tags.js";
import type { TrackMeta } from "../audio/tags.js";

const TMP = path.join(os.tmpdir(), "spotfid-audio-test");

describe("audio pipeline", () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    // Buat source audio sintetis (AAC 128k, 5 detik).
    execSync(
      `ffmpeg -y -f lavfi -i "sine=frequency=440:duration=5" -c:a aac -b:a 128k "${path.join(TMP, "src.m4a")}"`,
      { stdio: "ignore" }
    );
  });

  after(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("transcode ke WAV: pcm_s16le 44100 stereo", async () => {
    const out = await transcode(path.join(TMP, "src.m4a"), "wav", path.join(TMP, "out-wav"));
    const p = await probe(out);
    assert.equal(p.codecName, "pcm_s16le");
    assert.equal(p.sampleRate, 44100);
    assert.equal(p.channels, 2);
    assert.equal(p.formatName, "wav");
    assertRealWav(p); // Tidak throw = WAV asli
  });

  it("transcode ke FLAC", async () => {
    const out = await transcode(path.join(TMP, "src.m4a"), "flac", path.join(TMP, "out-flac"));
    const p = await probe(out);
    assert.equal(p.codecName, "flac");
    assert.equal(p.sampleRate, 44100);
    assert.equal(p.channels, 2);
  });

  it("transcode ke MP3 256k", async () => {
    const out = await transcode(path.join(TMP, "src.m4a"), "mp3", path.join(TMP, "out-mp3"));
    const p = await probe(out);
    assert.equal(p.codecName, "mp3");
    assert.equal(p.sampleRate, 44100);
    assert.equal(p.channels, 2);
    assert.equal(p.bitRate, 256000);
  });

  it("assertRealWav throw untuk non-WAV", () => {
    assert.throws(
      () => assertRealWav({ codecName: "mp3", sampleRate: 44100, channels: 2, bitRate: 256000, formatName: "mp3" }),
      /WAV PALSU/
    );
  });

  it("probe error untuk file tidak ada", async () => {
    await assert.rejects(() => probe(path.join(TMP, "nonexistent.wav")));
  });

  it("transcode dengan metadata: tag terbaca via ffprobe", async () => {
    const meta: TrackMeta = {
      title: "Judul Test",
      artist: "Artis A, Artis B",
      albumArtist: "Artis A",
      album: "Album Test",
      trackNo: 3,
      trackTotal: 12,
      lyrics: "Bait satu\nBait dua [00:10.00]",
    };
    const out = await transcode(path.join(TMP, "src.m4a"), "wav", path.join(TMP, "out-meta"), undefined, meta);
    const raw = execSync(
      `ffprobe -v error -show_entries format_tags -of json "${out}"`, { encoding: "utf8" }
    );
    const tags = JSON.parse(raw).format?.tags ?? {};
    assert.equal(tags.title, "Judul Test");
    assert.equal(tags.artist, "Artis A, Artis B");
    assert.equal(tags.album, "Album Test");
    assert.equal(tags.track, "3/12");
  });

  it("transcode MP3 dengan lyrics: USLT terbaca via ffprobe", async () => {
    const meta: TrackMeta = { title: "L", artist: "A", lyrics: "Bait satu\nBait dua [00:10.00]" };
    const out = await transcode(path.join(TMP, "src.m4a"), "mp3", path.join(TMP, "out-lyr"), undefined, meta);
    const raw = execSync(`ffprobe -v error -show_entries format_tags -of json "${out}"`, { encoding: "utf8" });
    const tags = JSON.parse(raw).format?.tags ?? {};
    assert.match(String(tags.lyrics ?? ""), /Bait dua/);
  });

  it("buildId3Tag: struktur header & frame valid", () => {
    const meta: TrackMeta = { title: "T", artist: "A", album: "Al", trackNo: 1, trackTotal: 2 };
    const tag = buildId3Tag(meta, null);
    assert.equal(tag.toString("latin1", 0, 3), "ID3");
    assert.equal(tag[3], 3); // versi 2.3
    // Ukuran syncsafe: 4 byte, semua bit tertinggi 0
    const size = ((tag[6] & 0x7f) << 21) | ((tag[7] & 0x7f) << 14) | ((tag[8] & 0x7f) << 7) | (tag[9] & 0x7f);
    assert.equal(size, tag.length - 10);
    const body = tag.toString("latin1", 10);
    assert.ok(body.includes("TIT2"));
    assert.ok(body.includes("TRCK"));
  });

  it("buildId3Tag dengan lyrics: frame USLT ada", () => {
    const tag = buildId3Tag({ title: "T", artist: "A", lyrics: "halo\n[00:01.00] dunia" }, null);
    assert.ok(tag.includes(Buffer.from("USLT", "latin1")));
  });

  it("writeWavId3: sisipkan chunk id3, WAV tetap valid & bisa diganti", () => {
    const wav = path.join(TMP, "out-id3.wav");
    fs.copyFileSync(path.join(TMP, "out-wav.wav"), wav);
    const meta: TrackMeta = { title: "Judul ID3", artist: "Artis", album: "Album" };

    writeWavId3(wav, meta, null);
    let buf = fs.readFileSync(wav);
    assert.equal(buf.toString("latin1", 0, 4), "RIFF");
    const riffSize = buf.readUInt32LE(4);
    assert.equal(riffSize, buf.length - 8);
    assert.ok(buf.toString("latin1", 12, 16) === "id3 ", "chunk id3 harus jadi chunk pertama");
    assert.ok(buf.includes(Buffer.from("TIT2", "latin1")));

    // Panggil ulang: id3 lama diganti, tidak menumpuk
    writeWavId3(wav, { ...meta, title: "Judul Baru" }, null);
    buf = fs.readFileSync(wav);
    const occurrences = buf.toString("latin1").split("id3 ").length - 1;
    assert.equal(occurrences, 1, "chunk id3 tidak boleh menumpuk");
    // Audio tetap bisa diprobe
    return probe(wav).then((p) => assert.equal(p.codecName, "pcm_s16le"));
  });
});