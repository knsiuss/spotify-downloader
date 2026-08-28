// Lyrics fetcher via LRCLIB (free, no auth) + fallback lyrics.ovh
// LRCLIB: https://lrclib.net/docs
// Docs: GET https://lrclib.net/api/get?artist_name=&track_name=&album_name=&duration=
//       GET https://lrclib.net/api/search?q=...

import fs from "node:fs";
import path from "node:path";

export interface LyricsResult {
  plainLyrics: string | null;
  syncedLyrics: string | null; // LRC format
  instrumental: boolean;
  source: string;
}

interface LrcLibGetResponse {
  id: number;
  name: string;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/** Fetch dari LRCLIB /api/get (exact match by track+artist+duration). */
async function fetchLrclibGet(artist: string, track: string, album: string | null, durationSec: number): Promise<LyricsResult | null> {
  const url = new URL("https://lrclib.net/api/get");
  url.searchParams.set("artist_name", artist);
  url.searchParams.set("track_name", track);
  if (album) url.searchParams.set("album_name", album);
  if (durationSec > 0) url.searchParams.set("duration", String(durationSec));

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "spotify-downloader/1.0", "Lrclib-Client": "spotify-downloader/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as LrcLibGetResponse;
  if (!data.plainLyrics && !data.syncedLyrics) return null;
  return {
    plainLyrics: data.plainLyrics,
    syncedLyrics: data.syncedLyrics,
    instrumental: data.instrumental,
    source: "lrclib",
  };
}

/** Fallback: search LRCLIB. */
async function fetchLrclibSearch(artist: string, track: string): Promise<LyricsResult | null> {
  const q = `${track} ${artist}`;
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("q", q);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "spotify-downloader/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const items = (await res.json()) as LrcLibGetResponse[];
  if (!Array.isArray(items) || items.length === 0) return null;
  const best = items[0];
  if (!best.plainLyrics && !best.syncedLyrics) return null;
  return {
    plainLyrics: best.plainLyrics,
    syncedLyrics: best.syncedLyrics,
    instrumental: best.instrumental,
    source: "lrclib-search",
  };
}

/** Fallback kedua: lyrics.ovh (plain only). */
async function fetchLyricsOvh(artist: string, track: string): Promise<LyricsResult | null> {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { lyrics?: string; error?: string };
    if (!data.lyrics) return null;
    return {
      plainLyrics: data.lyrics,
      syncedLyrics: null,
      instrumental: false,
      source: "lyrics.ovh",
    };
  } catch {
    return null;
  }
}

/** Main: coba LRCLIB get -> search -> lyrics.ovh */
export async function fetchLyrics(
  artist: string,
  track: string,
  album: string | null,
  durationSec: number,
): Promise<LyricsResult | null> {
  // 1. LRCLIB exact
  try {
    const r = await fetchLrclibGet(artist, track, album, durationSec);
    if (r) return r;
  } catch { /* ignore */ }

  // 2. LRCLIB search
  try {
    const r = await fetchLrclibSearch(artist, track);
    if (r) return r;
  } catch { /* ignore */ }

  // 3. lyrics.ovh
  try {
    const r = await fetchLyricsOvh(artist, track);
    if (r) return r;
  } catch { /* ignore */ }

  return null;
}

/** Simpan lirik ke file .lrc dan .txt di sebelah audio file. */
export function saveLyrics(basePathNoExt: string, lyrics: LyricsResult): string[] {
  const saved: string[] = [];
  if (lyrics.syncedLyrics) {
    const lrcPath = `${basePathNoExt}.lrc`;
    fs.writeFileSync(lrcPath, lyrics.syncedLyrics, "utf8");
    saved.push(lrcPath);
  }
  if (lyrics.plainLyrics) {
    const txtPath = `${basePathNoExt}.txt`;
    // Jangan duplikat jika sudah ada .lrc dengan konten sama — tetap tulis .txt untuk plain
    // Kalau synced sudah ada, plain tetap berguna untuk quick read
    if (!lyrics.syncedLyrics || lyrics.plainLyrics !== lyrics.syncedLyrics) {
      fs.writeFileSync(txtPath, lyrics.plainLyrics, "utf8");
      saved.push(txtPath);
    } else if (!saved.includes(`${basePathNoExt}.lrc`)) {
      fs.writeFileSync(txtPath, lyrics.plainLyrics, "utf8");
      saved.push(txtPath);
    }
  }
  return saved;
}

/** Helper: cek apakah file lirik sudah ada (skip fetch). */
export function lyricsExist(basePathNoExt: string): boolean {
  return fs.existsSync(`${basePathNoExt}.lrc`) || fs.existsSync(`${basePathNoExt}.txt`);
}
