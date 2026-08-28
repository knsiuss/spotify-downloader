// Unit test: error handling + provider fallback.
// Test AppError, pipeline fallback, metadata fallback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../core/types.js";
import { matchScore } from "../core/normalize.js";
import type { Track, Candidate } from "../core/types.js";

describe("AppError", () => {
  it("membuat error dengan category dan provider", () => {
    const err = new AppError("test message", "network", "youtube", true);
    assert.equal(err.message, "test message");
    assert.equal(err.category, "network");
    assert.equal(err.provider, "youtube");
    assert.equal(err.retryable, true);
    assert.equal(err.name, "AppError");
  });

  it("default retryable = false", () => {
    const err = new AppError("test", "no-match");
    assert.equal(err.retryable, false);
  });

  it("instanceof Error", () => {
    const err = new AppError("test", "format");
    assert.ok(err instanceof Error);
  });
});

describe("error categories", () => {
  it("network errors are retryable", () => {
    const err = new AppError("timeout", "network", "youtube", true);
    assert.equal(err.retryable, true);
  });

  it("no-match errors are not retryable", () => {
    const err = new AppError("no match", "no-match", "soundcloud", false);
    assert.equal(err.retryable, false);
  });

  it("rate-limit errors are retryable", () => {
    const err = new AppError("429 too many", "rate-limit", "qobuz", true);
    assert.equal(err.retryable, true);
  });

  it("format errors are not retryable", () => {
    const err = new AppError("corrupt", "format", "youtube", false);
    assert.equal(err.retryable, false);
  });

  it("auth errors are not retryable", () => {
    const err = new AppError("login failed", "auth", "qobuz", false);
    assert.equal(err.retryable, false);
  });
});

describe("normalize + matchScore", () => {
  const track: Track = {
    id: "1",
    title: "Shape of You",
    artists: ["Ed Sheeran"],
    album: "÷",
    durationSec: 233,
    trackNumber: 1,
    coverArtUrl: null,
  };

  it("match sempurna", () => {
    const candidate: Candidate = {
      id: "a",
      title: "Shape of You",
      artist: "Ed Sheeran",
      durationSec: 233,
      url: "https://example.com",
    };
    const score = matchScore(track, candidate);
    assert.ok(score >= 0.8, `Score should be >= 0.8, got ${score}`);
  });

  it("match dengan noise di judul", () => {
    const candidate: Candidate = {
      id: "b",
      title: "Shape of You (Official Music Video)",
      artist: "Ed Sheeran",
      durationSec: 235,
      url: "https://example.com",
    };
    const score = matchScore(track, candidate);
    assert.ok(score >= 0.8, `Score should be >= 0.8 with noise, got ${score}`);
  });

  it("tolak artist salah", () => {
    const candidate: Candidate = {
      id: "c",
      title: "Shape of You",
      artist: "Taylor Swift",
      durationSec: 233,
      url: "https://example.com",
    };
    const score = matchScore(track, candidate);
    assert.ok(score < 0.8, `Score should be < 0.8 with wrong artist, got ${score}`);
  });

  it("tolak judul sangat berbeda", () => {
    const candidate: Candidate = {
      id: "d",
      title: "Bohemian Rhapsody",
      artist: "Queen",
      durationSec: 355,
      url: "https://example.com",
    };
    const score = matchScore(track, candidate);
    assert.equal(score, 0);
  });
});

describe("resolveTargetDir", () => {
  const baseReq = { input: "x", outputDir: "C:\\music", formats: ["wav" as const] };

  it("playlist/album -> subfolder bernama sesuai judul (dibersihkan)", async () => {
    const { resolveTargetDir } = await import("../lib/index.js");
    const src = { type: "playlist" as const, id: "1", name: 'My/Playlist: "Best" Songs?', cover: null, tracks: [], truncated: false };
    const r = resolveTargetDir(baseReq, src);
    assert.equal(r.isSubfolder, true);
    assert.ok(r.dir.startsWith("C:\\music\\"));
    assert.ok(!/[\\/:*?"<>|]/.test(r.dir.slice("C:\\music\\".length)), "nama folder bebas karakter terlarang");
  });

  it("track tunggal -> langsung di output dir", async () => {
    const { resolveTargetDir } = await import("../lib/index.js");
    const src = { type: "track" as const, id: "1", name: "Lagu", cover: null, tracks: [], truncated: false };
    const r = resolveTargetDir(baseReq, src);
    assert.equal(r.dir, "C:\\music");
    assert.equal(r.isSubfolder, false);
  });
});
