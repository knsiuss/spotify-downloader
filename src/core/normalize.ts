// Normalisasi + scoring matching. Tujuan: judul "Shape of You (Official Video)" oleh
// penyanyi lain vs "shape of you" harus tetap ketemu, tapi "Shape of You" milik artis
// yang salah harus dihukum berat. Kombinasi: containment + token Dice + Levenshtein.

import type { Track, Candidate } from "./types.js";

const NOISE_PATTERNS = [
  /\b(official\s+(music\s+)?video|official\s+audio|official\s+lyric\s+video|official\s+mv|official\s+music|official\s+audio)\b/gi,
  /\b(lyrics?|with\s+lyrics|lyric\s+video|video|mv|audio|hq|hd|4k|8k)\b/gi,
  /\b(ft\.?|feat\.?|featuring)\s+[^()[\]]+/gi,
  /[()\[\]'"“”]/g,
];

/** Bersihkan judul lagu untuk dibandingkan. */
export function normalizeTitle(raw: string): string {
  let s = ` ${raw.trim()} `;
  for (const pattern of NOISE_PATTERNS) {
    s = s.replace(pattern, " ");
  }
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Normalisasi nama artist. */
export function normalizeArtist(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Buang token artist dari judul kandidat (nama artis di judul video umum banget). */
function stripArtistFromTitle(candTitle: string, artistNorm: string): string {
  if (!artistNorm) return candTitle;
  const tokens = artistNorm.split(" ");
  let out = candTitle;
  for (const tok of tokens) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(tok)}\\b`, "g"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Skor 0..1: containment (kata pendek di dalam yang panjang). */
function containmentScore(a: string, b: string): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short) return 0;
  if (long.includes(short)) return short.length / long.length;
  return 0;
}

/** Skor 0..1: Dice coefficient atas set token kata. */
function tokenDice(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Skor 0..1: Levenshtein ratio (1 - dist/maxLen). */
function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > Math.max(m, n) * 0.7) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n + 1).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

/** Gabungkan beberapa skor: max elimuin yang lemah, min untuk yang kuat. */
function combineScores(scores: number[]): number {
  return Math.max(...scores, 0);
}

const TITLE_THRESHOLD = 0.6;
const STRONG_TITLE_THRESHOLD = 0.85;
const ARTIST_THRESHOLD = 0.4;

/**
 * Skor kecocokan 0..1 antara metadata Spotify dan kandidat provider.
 * Komposisi: judul (setelah artist distrip dari kandidat) + artist + durasi + album.
 */
export function matchScore(track: Track, candidate: Candidate): number {
  const qTitle = normalizeTitle(track.title);
  const qArtist = normalizeArtist(track.artists.join(" "));
  const cTitleRaw = normalizeTitle(candidate.title);
  const cArtist = normalizeArtist(candidate.artist);

  const cTitle = stripArtistFromTitle(cTitleRaw, qArtist);

  const titleScore = combineScores([
    containmentScore(qTitle, cTitle),
    tokenDice(qTitle, cTitle),
    levenshteinRatio(qTitle, cTitle),
  ]);
  const artistScore = combineScores([
    containmentScore(qArtist, cArtist),
    tokenDice(qArtist, cArtist),
    // Artist sering cuma ada di JUDUL kandidat (upload channel lirik/reupload
    // dengan nama channel sendiri, mis. "Katseye - Animal (Lyrics)" oleh
    // "Lost Panda"). Nama artis di judul asli kandidat = bukti match kuat.
    tokenDice(qArtist, cTitleRaw),
    containmentScore(qArtist, cTitleRaw),
  ]);

  // Judul lemah = langsung tolak, jangan biarkan artist/durasi menyelamatkan.
  if (titleScore < TITLE_THRESHOLD) return 0;

  let score = 0.55 * titleScore + 0.3 * artistScore;

  // Durasi: toleransi ketat ±3 detik; ±6 detik setengah poin.
  if (track.durationSec > 0 && candidate.durationSec != null) {
    const diff = Math.abs(track.durationSec - candidate.durationSec);
    if (diff <= 3) score += 0.15;
    else if (diff <= 6) score += 0.075;
  }

  // Album match = boost kecil (kalau data ada).
  if (track.album && candidate.title.toLowerCase().includes(track.album.toLowerCase())) {
    score += 0.05;
  }

  // Judul sangat kuat + artist kuat = penanda "official", dorong ke atas.
  if (titleScore >= STRONG_TITLE_THRESHOLD && artistScore >= STRONG_TITLE_THRESHOLD) {
    score += 0.1;
  }

  return Math.min(1, score);
}