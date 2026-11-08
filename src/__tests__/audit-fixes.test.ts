// Unit test untuk fix audit v0.3.1:
// - clampNumber: NaN/Infinity/string aneh dari body API tidak boleh lolos.
// - classifyError: "not a bot" = rate-limit (backoff panjang, bukan retry 1s).
// - isRetryable: error fatal yt-dlp (video unavailable) tidak diulang.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampNumber } from "../lib/validate.js";
import { classifyError } from "../core/pipeline.js";
import { isRetryable } from "../lib/index.js";
import type { DownloadResult } from "../core/types.js";
import type { Track } from "../core/types.js";

describe("clampNumber", () => {
  it("meneruskan angka valid", () => {
    assert.equal(clampNumber(5, 3, 1, 8), 5);
    assert.equal(clampNumber(3, 3, 1, 8), 3);
  });

  it("menerima string numerik dari body API", () => {
    assert.equal(clampNumber("4", 3, 1, 8), 4);
  });

  it("fallback untuk string non-numerik (NaN)", () => {
    assert.equal(clampNumber("abc", 3, 1, 8), 3);
    assert.equal(clampNumber("", 3, 1, 8), 3);
  });

  it("fallback untuk Infinity / -Infinity", () => {
    assert.equal(clampNumber(Number.POSITIVE_INFINITY, 3, 1, 8), 3);
    assert.equal(clampNumber(Number.NEGATIVE_INFINITY, 3, 1, 8), 3);
  });

  it("fallback untuk NaN dan tipe non-number/non-string", () => {
    assert.equal(clampNumber(Number.NaN, 3, 1, 8), 3);
    assert.equal(clampNumber(undefined, 3, 1, 8), 3);
    assert.equal(clampNumber(null, 3, 1, 8), 3);
    assert.equal(clampNumber({}, 3, 1, 8), 3);
    assert.equal(clampNumber(true, 3, 1, 8), 3);
  });

  it("di-clamp ke rentang min/max", () => {
    assert.equal(clampNumber(0, 3, 1, 8), 1);
    assert.equal(clampNumber(-5, 3, 1, 8), 1);
    assert.equal(clampNumber(999, 3, 1, 8), 8);
  });

  it("clamp tetap menerapkan min/max untuk string", () => {
    assert.equal(clampNumber("100", 3, 1, 8), 8);
    assert.equal(clampNumber("0", 3, 1, 8), 1);
  });
});

describe("classifyError", () => {
  it("'not a bot' = rate-limit (bukan provider retryable 1s)", () => {
    assert.equal(classifyError("Sign in to confirm you're not a bot"), "rate-limit");
    assert.equal(classifyError("HTTP Error 429: Too Many Requests"), "rate-limit");
    assert.equal(classifyError("rate limit exceeded"), "rate-limit");
  });

  it("error jaringan dikenali sebagai network", () => {
    assert.equal(classifyError("ETIMEDOUT"), "network");
    assert.equal(classifyError("getaddrinfo ENOTFOUND youtube.com"), "network");
    assert.equal(classifyError("socket hang up ECONNRESET"), "network");
  });

  it("error lain jatuh ke provider", () => {
    assert.equal(classifyError("video unavailable"), "provider");
    assert.equal(classifyError("kesalahan tak terduga"), "provider");
  });
});

describe("isRetryable", () => {
  const track: Track = {
    id: "1", title: "t", artists: ["a"], album: null,
    durationSec: 100, trackNumber: null, coverArtUrl: null,
  };
  const mk = (error: string | null, category: DownloadResult["errorCategory"], ok = false): DownloadResult => ({
    track, ok, providerUsed: null, outputPath: null, error, errorCategory: category,
  });

  it("rate-limit dan network layak diulang", () => {
    assert.equal(isRetryable(mk("429", "rate-limit")), true);
    assert.equal(isRetryable(mk("timeout", "network")), true);
  });

  it("error fatal yt-dlp (video unavailable) TIDAK diulang walau kategori provider", () => {
    assert.equal(isRetryable(mk("[youtube] x: Video unavailable", "provider")), false);
    assert.equal(isRetryable(mk("ERROR: [youtube] abc123: Private video", "provider")), false);
  });

  it("no-match / format / cancelled tidak diulang", () => {
    assert.equal(isRetryable(mk("tidak ada kandidat", "no-match")), false);
    assert.equal(isRetryable(mk("corrupt", "format")), false);
    assert.equal(isRetryable(mk("cancelled", "cancelled")), false);
  });

  it("sukses dan 'sudah ada' tidak diulang", () => {
    assert.equal(isRetryable(mk(null, undefined, true)), false);
    assert.equal(isRetryable(mk("sudah ada", undefined, true)), false);
  });
});
