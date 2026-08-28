// Unit test: normalisasi + matching engine.
// Pakai Node built-in test runner (node:test + node:assert).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle, normalizeArtist, matchScore } from "../core/normalize.js";
import type { Track, Candidate } from "../core/types.js";

describe("normalizeTitle", () => {
  it("menghapus noise patterns", () => {
    assert.equal(normalizeTitle("Shape of You (Official Video)"), "shape of you");
    assert.equal(normalizeTitle("Blinding Lights (Lyrics)"), "blinding lights");
    assert.equal(normalizeTitle("Bohemian Rhapsody - Remastered 2011"), "bohemian rhapsody remastered 2011");
  });

  it("normalisasi case dan whitespace", () => {
    assert.equal(normalizeTitle("  HELLO   WORLD  "), "hello world");
    assert.equal(normalizeTitle("CaSe MiXeD"), "case mixed");
  });

  it("mempertahankan judul bersih", () => {
    assert.equal(normalizeTitle("Shape of You"), "shape of you");
    assert.equal(normalizeTitle("Anti-Hero"), "anti hero");
  });
});

describe("normalizeArtist", () => {
  it("normalisasi artist name", () => {
    assert.equal(normalizeArtist("The Beatles"), "the beatles");
    assert.equal(normalizeArtist("Taylor Swift ft. Ed Sheeran"), "taylor swift ft ed sheeran");
  });
});

describe("matchScore", () => {
  const baseTrack: Track = {
    id: "1",
    title: "Shape of You",
    artists: ["Ed Sheeran"],
    album: "Divide",
    durationSec: 233,
    trackNumber: 1,
    coverArtUrl: null,
  };

  it("score tinggi untuk match sempurna", () => {
    const candidate: Candidate = {
      id: "v1",
      title: "Ed Sheeran - Shape of You (Official Video)",
      artist: "Ed Sheeran",
      durationSec: 233,
      url: "https://youtube.com/watch?v=v1",
    };
    const score = matchScore(baseTrack, candidate);
    assert.ok(score >= 0.8, `Score ${score} harusnya >= 0.8`);
  });

  it("score rendah untuk artist berbeda", () => {
    const candidate: Candidate = {
      id: "v2",
      title: "Shape of You (Cover)",
      artist: "Random Cover Artist",
      durationSec: 235,
      url: "https://youtube.com/watch?v=v2",
    };
    const score = matchScore(baseTrack, candidate);
    assert.ok(score < 0.8, `Score ${score} harusnya < 0.8`);
  });

  it("durasi beda jauh mengurangi skor", () => {
    const cMatch: Candidate = { id: "a", title: "Shape of You", artist: "Ed Sheeran", durationSec: 233, url: "" };
    const cFar: Candidate = { id: "b", title: "Shape of You", artist: "Ed Sheeran", durationSec: 120, url: "" };
    const sMatch = matchScore(baseTrack, cMatch);
    const sFar = matchScore(baseTrack, cFar);
    // Title+artist match sempurna tetap tinggi, tapi durasi jauh menurunkan skor.
    assert.ok(sFar < sMatch, `Durasi jauh (${sFar}) harus < durasi match (${sMatch})`);
    assert.ok(sMatch >= 0.8, "Match sempurna harus >= 0.8");
  });

  it("toleransi durasi ±3 detik", () => {
    const c1: Candidate = { id: "a", title: "Shape of You", artist: "Ed Sheeran", durationSec: 230, url: "" };
    const c2: Candidate = { id: "b", title: "Shape of You", artist: "Ed Sheeran", durationSec: 236, url: "" };
    const c3: Candidate = { id: "c", title: "Shape of You", artist: "Ed Sheeran", durationSec: 250, url: "" };
    const s1 = matchScore(baseTrack, c1);
    const s2 = matchScore(baseTrack, c2);
    const s3 = matchScore(baseTrack, c3);
    assert.ok(s1 >= 0.8, "±3 detik harus match");
    assert.ok(s2 >= 0.8, "±3 detik harus match");
    assert.ok(s3 < s1, "Durasi lebih jauh harus score lebih rendah");
  });
});