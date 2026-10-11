// Unit test: resume & retry download video (yt-dlp).
// Inti perilaku: kegagalan transient diulang, panggilan yt-dlp berikutnya
// memakai args yang sama sehingga .part dilanjutkan, bukan mulai dari 0%.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildVideoArgs,
  findDownloadedFile,
  runYtDlpWithResume,
} from "../video/youtube-video.js";
import { isRetryableYtDlpError } from "../providers/youtube.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=abcdefghijk";

describe("isRetryableYtDlpError", () => {
  it("mengulang error transient (timeout, 403, koneksi putus)", () => {
    assert.equal(isRetryableYtDlpError("yt-dlp timeout"), true);
    assert.equal(isRetryableYtDlpError("yt-dlp exit 1: ERROR: unable to download video data: HTTP Error 403: Forbidden"), true);
    assert.equal(isRetryableYtDlpError("yt-dlp exit 1: ERROR: Unable to download webpage: HTTP Error 429"), true);
    assert.equal(isRetryableYtDlpError("yt-dlp exit 1: ERROR: read of 1234 bytes failed: ECONNRESET"), true);
  });

  it("tidak mengulang cancel dan video yang benar-benar hilang", () => {
    assert.equal(isRetryableYtDlpError("cancelled"), false);
    assert.equal(isRetryableYtDlpError("ERROR: Video unavailable"), false);
    assert.equal(isRetryableYtDlpError("ERROR: Private video. Sign in if you've been granted access"), false);
    assert.equal(isRetryableYtDlpError("ERROR: This video has been removed by the uploader"), false);
  });
});

describe("buildVideoArgs", () => {
  it("selalu memakai --continue supaya percobaan ulang resume .part", () => {
    const args = buildVideoArgs(VIDEO_URL, "out/%(title)s.%(ext)s", "720", "mp4");
    assert.ok(args.includes("--continue"));
    assert.ok(args.includes("--merge-output-format"));
    assert.ok(args.includes("mp4"));
    assert.ok(args.includes("bestvideo[height<=720]+bestaudio/best[height<=720]"));
    assert.ok(args.includes("-o"));
  });

  it("tambahkan --cookies hanya kalau file cookies diberikan", () => {
    assert.ok(!buildVideoArgs(VIDEO_URL, "o.%(ext)s", "1080", "mkv").includes("--cookies"));
    const withCookies = buildVideoArgs(VIDEO_URL, "o.%(ext)s", "1080", "mkv", "C:/tmp/cookies.txt");
    const cookieIndex = withCookies.indexOf("--cookies");
    assert.equal(withCookies[cookieIndex + 1], "C:/tmp/cookies.txt");
  });
});

describe("findDownloadedFile", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "drop-video-test-"));
  }

  it("mengabaikan .part/.ytdl/intermediate merge", () => {
    const dir = tmpDir();
    const base = "Kelas [720p]";
    fs.writeFileSync(path.join(dir, `${base}.f137.mp4`), "video-only");
    fs.writeFileSync(path.join(dir, `${base}.f251.webm`), "audio-only");
    fs.writeFileSync(path.join(dir, `${base}.mp4.part`), "partial");
    fs.writeFileSync(path.join(dir, `${base}.webm.ytdl`), "temp");
    fs.writeFileSync(path.join(dir, `${base}.mp4`), "final");
    assert.equal(findDownloadedFile(dir, base), path.join(dir, `${base}.mp4`));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("return null kalau baru ada sisa unduhan terputus", () => {
    const dir = tmpDir();
    const base = "Kelas [1080p]";
    fs.writeFileSync(path.join(dir, `${base}.mp4.part`), "partial");
    assert.equal(findDownloadedFile(dir, base), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("abaikan file kosong dan utamakan ekstensi yang diminta", () => {
    const dir = tmpDir();
    const base = "Kelas [720p]";
    fs.writeFileSync(path.join(dir, `${base}.mp4`), ""); // sisa kosong
    fs.writeFileSync(path.join(dir, `${base}.webm`), "old-format");
    fs.writeFileSync(path.join(dir, `${base}.mp4`), "fresh");
    assert.equal(findDownloadedFile(dir, base, "mp4"), path.join(dir, `${base}.mp4`));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runYtDlpWithResume", () => {
  /** Runner palsu: gagal untuk N percobaan pertama, lalu sukses. */
  function runnerFailingTimes(failTimes: number, error: string) {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const run = async (args: string[], options: { timeoutMs: number }) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      if (calls.length <= failTimes) throw new Error(error);
      return "";
    };
    return { run, calls };
  }

  it("sukses di percobaan kedua dan memakai args identik (resume .part)", async () => {
    const { run, calls } = runnerFailingTimes(1, "yt-dlp exit 1: ERROR: unable to download video data: HTTP Error 403: Forbidden");
    const retries: Array<{ attempt: number; maxAttempts: number }> = [];
    await runYtDlpWithResume([VIDEO_URL, "--continue"], {
      run,
      retryDelayMs: 0,
      onRetry: (info) => retries.push({ attempt: info.attempt, maxAttempts: info.maxAttempts }),
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, calls[1].args);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 2);
  });

  it("habis percobaan tetap melempar error terakhir", async () => {
    const { run, calls } = runnerFailingTimes(99, "yt-dlp timeout");
    await assert.rejects(
      () => runYtDlpWithResume([VIDEO_URL], { run, retryDelayMs: 0 }),
      /yt-dlp timeout/,
    );
    assert.equal(calls.length, 3); // DROP_VIDEO_RETRIES default = 3
  });

  it("tidak mengulang error fatal (video privat)", async () => {
    const { run, calls } = runnerFailingTimes(99, "ERROR: Private video");
    await assert.rejects(() => runYtDlpWithResume([VIDEO_URL], { run }), /Private video/);
    assert.equal(calls.length, 1);
  });

  it("cancel langsung berhenti tanpa percobaan lanjut", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, calls } = runnerFailingTimes(99, "yt-dlp timeout");
    await assert.rejects(() => runYtDlpWithResume([VIDEO_URL], { run, signal: controller.signal }), /cancelled/);
    assert.equal(calls.length, 0);
  });

  it("file sudah utung walau proses gagal = sukses (tidak retry sia-sia)", async () => {
    const { run, calls } = runnerFailingTimes(99, "yt-dlp timeout");
    const retries: number[] = [];
    await runYtDlpWithResume([VIDEO_URL], {
      run,
      retryDelayMs: 0,
      isComplete: () => true, // file final sudah ada di disk
      onRetry: () => retries.push(1),
    });
    assert.equal(calls.length, 1);
    assert.equal(retries.length, 0);
  });

  it("retry hanya kalau file benar-benar belum ada", async () => {
    const { run } = runnerFailingTimes(99, "yt-dlp timeout");
    const retries: number[] = [];
    await assert.rejects(
      () => runYtDlpWithResume([VIDEO_URL], { run, retryDelayMs: 0, isComplete: () => false, onRetry: () => retries.push(1) }),
      /yt-dlp timeout/,
    );
    assert.equal(retries.length, 2); // 3 percobaan, 2 percobaan ulang
  });
});
