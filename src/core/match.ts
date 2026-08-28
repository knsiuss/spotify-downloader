// Matching engine: gabungkan daftar track dengan kandidat dari tiap provider.
// Memakai quality ladder — provider prioritas terbaik (Qobuz/FLAC) dicoba dulu,
// turun ke yang lebih reliable (YouTube), sampai dapat match di atas threshold.

import type { Track, Candidate, Provider } from "./types.js";
import { matchScore } from "./normalize.js";

/** Skor minimum supaya kandidat dianggap "match". */
const MATCH_THRESHOLD = 0.8;

/** Hasil matching satu track. */
export interface MatchResult {
  track: Track;
  candidate: Candidate | null;
  providerName: string | null;
  /** Semua kandidat yang pernah dilihat (untuk debugging). */
  seen: Array<{ provider: string; candidate: Candidate; score: number }>;
}

/** Urutkan provider: kualitas (priority kecil) dulu, lalu paling reliable. */
function sortProviders(providers: Provider[]): Provider[] {
  return [...providers].sort((a, b) => a.priority - b.priority);
}

/** Cari match terbaik untuk satu track melewati semua provider. */
export async function matchTrack(track: Track, providers: Provider[]): Promise<MatchResult> {
  const seen: MatchResult["seen"] = [];
  const ladder = sortProviders(providers);

  for (const provider of ladder) {
    let candidates: Candidate[];
    try {
      candidates = await provider.search(track);
    } catch (err) {
      // Provider gagal = lewati, jangan matikan seluruh batch.
      seen.push({
        provider: provider.name,
        candidate: { id: "error", title: "", artist: "", durationSec: null, url: "" },
        score: 0,
      });
      continue;
    }

    for (const candidate of candidates) {
      const score = matchScore(track, candidate);
      seen.push({ provider: provider.name, candidate, score });
      if (score >= MATCH_THRESHOLD) {
        return { track, candidate, providerName: provider.name, seen };
      }
    }
  }

  return { track, candidate: null, providerName: null, seen };
}