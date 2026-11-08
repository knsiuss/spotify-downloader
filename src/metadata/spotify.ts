// Metadata Spotify TANPA login: parse halaman embed publik (open.spotify.com/embed/...).
// Halaman ini server-render JSON __NEXT_DATA__ berisi full track list.
// Fallback: oEmbed endpoint (https://open.spotify.com/oembed) kalau embed gagal.
// Catatan: playlist dirender sampai ~100 track; lebih dari itu butuh pagination.

import type { Track } from "../core/types.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface SpotifySource {
  type: "playlist" | "album" | "track";
  id: string;
  name: string;
  /** Cover playlist/album (untuk tampilan UI). */
  cover: string | null;
  tracks: Track[];
  /** True jika playlist mungkin terpotong (embed endpoint cap ~100 track). */
  truncated: boolean;
}

/** Parse URL atau URI Spotify ke {type, id}. */
export function parseSpotifyUrl(input: string): { type: SpotifySource["type"]; id: string } {
  const uri = input.includes("open.spotify.com") || input.startsWith("http")
    ? input
    : `spotify:${input}`;

  const re = /spotify:(playlist|album|track):([A-Za-z0-9]+)/;
  const urlRe = /open\.spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/;

  const urlMatch = uri.match(urlRe);
  if (urlMatch) return { type: urlMatch[1] as SpotifySource["type"], id: urlMatch[2] };

  const uriMatch = uri.match(re);
  if (uriMatch) return { type: uriMatch[1] as SpotifySource["type"], id: uriMatch[2] };

  throw new Error(
    "Link Spotify tidak dikenali. Contoh valid: https://open.spotify.com/playlist/<id>"
  );
}

/** Gabungkan signal cancel user dengan timeout keras - keduanya harus menghentikan fetch. */
function fetchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Fallback: oEmbed endpoint - hanya untuk track tunggal, return data minimal. */
async function fetchOEmbed(id: string, signal?: AbortSignal): Promise<SpotifySource> {
  const embedUrl = `https://open.spotify.com/track/${id}`;
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(embedUrl)}`, {
    headers: { "User-Agent": UA },
    signal: fetchSignal(signal, 20_000),
  });
  if (!res.ok) throw new Error(`oEmbed gagal (HTTP ${res.status})`);
  const json = (await res.json()) as {
    title?: string;
    thumbnail_url?: string;
    provider_name?: string;
  };

  // oEmbed hanya return title + thumbnail, tidak ada artist/durasi.
  // Kita parse artist dari title (format: "Title - Artist" atau "Title").
  const title = json.title ?? "Unknown";
  const parts = title.split(" - ");
  const trackTitle = parts.length > 1 ? parts.slice(0, -1).join(" - ").trim() : title;
  const artist = parts.length > 1 ? parts[parts.length - 1].trim() : "Unknown Artist";

  return {
    type: "track",
    id,
    name: title,
    cover: json.thumbnail_url ?? null,
    truncated: false,
    tracks: [
      {
        id,
        title: trackTitle,
        artists: [artist],
        album: null,
        durationSec: 0, // oEmbed tidak menyediakan durasi
        trackNumber: null,
        coverArtUrl: json.thumbnail_url ?? null,
      },
    ],
  };
}

/** Ambil metadata lengkap dari link Spotify (playlist/album/track).
 *  `signal` = cancel dari job; timeout tetap berlaku walau tanpa signal. */
export async function fetchSpotifyMetadata(input: string, signal?: AbortSignal): Promise<SpotifySource> {
  const { type, id } = parseSpotifyUrl(input);

  // 1. Coba embed endpoint dulu (data lengkap)
  try {
    return await fetchEmbed(type, id, signal);
  } catch (embedErr) {
    // Cancel/timeout bukan "coba fallback" - langsung hentikan supaya job bisa selesai sebagai cancelled.
    if (signal?.aborted) throw embedErr;
    // 2. Fallback ke oEmbed (hanya untuk track)
    if (type === "track") {
      try {
        return await fetchOEmbed(id, signal);
      } catch (oembedErr) {
        // Keduanya gagal — throw error asli embed
        throw new Error(
          `Metadata fetch gagal.\n` +
          `  Embed: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}\n` +
          `  oEmbed: ${oembedErr instanceof Error ? oembedErr.message : String(oembedErr)}`
        );
      }
    }
    throw embedErr;
  }
}

/** Fetch via embed endpoint (data lengkap untuk playlist/album/track). */
async function fetchEmbed(type: SpotifySource["type"], id: string, signal?: AbortSignal): Promise<SpotifySource> {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en" },
    signal: fetchSignal(signal, 20_000),
  });
  if (!res.ok) {
    throw new Error(`Gagal fetch embed Spotify (HTTP ${res.status})`);
  }
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Struktur halaman Spotify berubah: __NEXT_DATA__ tidak ditemukan");

  const json = JSON.parse(match[1]);
  const pageProps = json.props?.pageProps;

  // Handle error pages (e.g. invalid track ID returns status 500).
  if (pageProps?.status && pageProps.status >= 400) {
    throw new Error(`Spotify embed error: ${pageProps.title ?? "Page not available"} (HTTP ${pageProps.status})`);
  }

  const entity = pageProps?.state?.data?.entity;
  if (!entity) {
    throw new Error("Spotify embed: entity tidak ditemukan dalam __NEXT_DATA__ (struktur berubah?)");
  }

  const trackList: Array<{ title: string; subtitle?: string; duration: number; uri: string }> =
    entity.trackList ?? (entity.uri ? [entity] : []);

  if (type === "track" && !entity.trackList) {
    const artists = Array.isArray(entity.artists)
      ? entity.artists.map((a: { name?: string }) => a.name).filter(Boolean)
      : [];
    return {
      type,
      id,
      name: entity.title ?? entity.name ?? "Track",
      cover: extractCover(entity) ?? extractTrackCover(entity),
      truncated: false,
      tracks: [
        {
          id: id,
          title: entity.title ?? entity.name ?? "",
          artists: artists.length > 0 ? artists : [entity.subtitle ?? "Unknown Artist"],
          album: entity.albumTitle ?? null,
          durationSec: Math.round((entity.duration ?? 0) / 1000),
          trackNumber: null,
          coverArtUrl: extractCover(entity) ?? extractTrackCover(entity),
        },
      ],
    };
  }

  const albumCover = extractCover(entity) ?? extractTrackCover(entity);
  const tracks: Track[] = trackList.map((t, i) => ({
    id: t.uri.split(":").pop() ?? String(i),
    title: t.title,
    artists: [t.subtitle ?? "Unknown Artist"],
    album: entity.name ?? null,
    durationSec: Math.round((t.duration ?? 0) / 1000),
    trackNumber: type === "album" ? i + 1 : null,
    coverArtUrl: albumCover,
  }));

  // Embed endpoint render maks ~100 track; kalau persis 100, kemungkinan terpotong.
  const truncated = type === "playlist" && tracks.length >= 100;

  return { type, id, name: entity.name ?? entity.title ?? "Unknown", cover: albumCover, tracks, truncated };
}

function extractCover(entity: { coverArt?: { sources?: Array<{ url: string }> } }): string | null {
  return entity.coverArt?.sources?.[0]?.url ?? null;
}

function extractTrackCover(entity: {
  visualIdentity?: { image?: Array<{ url: string }> };
}): string | null {
  return entity.visualIdentity?.image?.[0]?.url ?? null;
}
