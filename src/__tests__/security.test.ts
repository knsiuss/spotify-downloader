// Unit test: perbaikan keamanan v0.3.2 (audit Q4 2026).
// - sanitizeFilename: traversal ".." / "." / reserved Windows
// - isYouTubeUrl: argument injection (flag yt-dlp)
// - buildVideoArgs: separator "--" di belakang URL
// - processTrack: formats kosong jangan lapor "sudah ada"

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { sanitizeFilename } from "../audio/ffmpeg.js";
import { isYouTubeUrl, buildVideoArgs, isYouTubePlaylistUrl } from "../video/youtube-video.js";
import { resolveTargetDir } from "../lib/index.js";

describe("sanitizeFilename", () => {
  it("tidak pernah mengembalikan '.' / '..' / kosong", () => {
    assert.equal(sanitizeFilename(".."), "untitled");
    assert.equal(sanitizeFilename("."), "untitled");
    assert.equal(sanitizeFilename("..."), "untitled");
    assert.equal(sanitizeFilename(""), "untitled");
    assert.equal(sanitizeFilename("   "), "untitled");
  });

  it("path.join(outputDir, sanitize(name)) tidak kabur ke parent", () => {
    for (const name of ["..", ".", "...", ""]) {
      const dir = path.join("C:/out", sanitizeFilename(name));
      assert.ok(!dir.endsWith("C:\\"), `bocor untuk ${JSON.stringify(name)}: ${dir}`);
      assert.notEqual(dir, "C:\\");
    }
    // resolveTargetDir: playlist '...' tidak lagi menulis ke root drive
    const r = resolveTargetDir(
      { input: "x", outputDir: "C:/out", formats: ["wav"] },
      { type: "playlist", id: "1", name: "..", cover: null, tracks: [], truncated: false },
    );
    assert.notEqual(r.dir, "C:\\");
    // Windows path.resolve/join pakai backslash — samakan dulu
    assert.ok(r.dir.replace(/\\/g, "/").startsWith("C:/out"));
  });

  it("nama reserved Windows tidak dipakai apa adanya", () => {
    assert.equal(sanitizeFilename("CON"), "CON_");
    assert.equal(sanitizeFilename("NUL"), "NUL_");
    assert.equal(sanitizeFilename("com1"), "com1_");
  });

  it("nama normal tetap utuh", () => {
    assert.equal(sanitizeFilename("Artist - Judul"), "Artist - Judul");
    assert.equal(sanitizeFilename("judul/aneh"), "judul_aneh");
  });
});

describe("isYouTubeUrl", () => {
  it("menerima URL YouTube valid", () => {
    assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
    assert.equal(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
    assert.equal(isYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), true);
    assert.equal(isYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), true);
    assert.equal(isYouTubeUrl("https://www.youtube.com/playlist?list=PLabc123"), true);
  });

  it("menolak argument injection (token diawali -) ", () => {
    for (const bad of [
      "--exec=cmd /c echo PWNED youtube.com",
      "--config-locations=evil.conf youtube.com",
      "--batch-file=evil.txt youtube.com",
      "-f best youtube.com",
      " youtube.com",
    ]) {
      assert.equal(isYouTubeUrl(bad), false, bad);
    }
  });

  it("menolak bukan-https & host palsu", () => {
    assert.equal(isYouTubeUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ"), false);
    assert.equal(isYouTubeUrl("https://evil.com/youtube.com"), false);
    assert.equal(isYouTubeUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ"), false);
    assert.equal(isYouTubeUrl("https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ"), false);
    assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ extra"), false);
  });

  it("isYouTubePlaylistUrl butuh URL YouTube valid", () => {
    assert.equal(isYouTubePlaylistUrl("https://www.youtube.com/playlist?list=PLabc123"), true);
    assert.equal(isYouTubePlaylistUrl("--list=PLabc youtube.com"), false);
    assert.equal(isYouTubePlaylistUrl("https://evil.com/playlist?list=PLabc"), false);
  });
});

describe("buildVideoArgs separator --", () => {
  it("URL berada di belakang '--' (tidak bisa jadi flag)", () => {
    const args = buildVideoArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "o.%(ext)s", "720", "mp4");
    const sep = args.indexOf("--");
    assert.ok(sep >= 0, "separator -- harus ada");
    assert.equal(args[sep + 1], "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(sep, args.length - 2, "-- harus tepat sebelum URL terakhir");
  });

  it("URL berbahaya tetap terisolasi di belakang --", () => {
    const evil = "--config-locations=evil.conf";
    const args = buildVideoArgs(evil, "o.%(ext)s", "720", "mp4");
    const sep = args.indexOf("--");
    assert.equal(args[sep + 1], evil, "evil token harus di belakang --");
    // tidak ada token flag dari variabes user sebelum separator
    const before = args.slice(0, sep);
    assert.ok(!before.some((a) => a.startsWith("--config")), "flag injeksi tidak boleh di depan --");
  });
});
