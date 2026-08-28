// Unit test: Spotify metadata fetcher.
// Test dengan URL Spotify publik yang stabil (Today's Top Hits, Random Access Memories).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSpotifyUrl, fetchSpotifyMetadata } from "../metadata/spotify.js";

describe("parseSpotifyUrl", () => {
  it("parse URL playlist", () => {
    const r = parseSpotifyUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    assert.equal(r.type, "playlist");
    assert.equal(r.id, "37i9dQZF1DXcBWIGoYBM5M");
  });

  it("parse URL album", () => {
    const r = parseSpotifyUrl("https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa");
    assert.equal(r.type, "album");
    assert.equal(r.id, "4m2880jivSbbyEGAKfITCa");
  });

  it("parse URL track", () => {
    const r = parseSpotifyUrl("https://open.spotify.com/track/3ouNEk0tv5TTi8VWMe1xbX");
    assert.equal(r.type, "track");
  });

  it("parse URI", () => {
    const r = parseSpotifyUrl("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
    assert.equal(r.type, "playlist");
  });

  it("reject URL invalid", () => {
    assert.throws(() => parseSpotifyUrl("https://google.com"));
  });
});

describe("fetchSpotifyMetadata", () => {
  it("fetch album metadata", async () => {
    const src = await fetchSpotifyMetadata("https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa");
    assert.equal(src.type, "album");
    assert.equal(src.name, "Random Access Memories");
    assert.ok(src.tracks.length >= 10, `Expected >= 10 tracks, got ${src.tracks.length}`);
    // Cek track pertama
    const t = src.tracks[0];
    assert.ok(t.title.length > 0, "Track title harus ada");
    assert.ok(t.artists.length > 0, "Track artists harus ada");
    assert.ok(t.durationSec > 0, "Duration harus > 0");
  });

  it("fetch track metadata", async () => {
    const src = await fetchSpotifyMetadata("https://open.spotify.com/track/3ouNEk0tv5TTi8VWMe1xbX");
    assert.equal(src.type, "track");
    assert.equal(src.tracks.length, 1);
    assert.equal(src.tracks[0].title, "Animal");
    assert.ok(src.tracks[0].artists.includes("KATSEYE"), "Artist harus KATSEYE");
    assert.equal(src.tracks[0].durationSec, 158);
  });
});