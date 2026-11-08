// Pipeline per-shot: coba semua provider secara berurutan (quality ladder).
// Kalau provider A gagal download, otomatis lanjut ke provider B.
// Satu track gagal tidak membatalkan batch; kegagalan masuk daftar report.
// Mendukung pembatalan (signal) & laporan progress per-file untuk UI live.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadResult, ErrorCategory, FileProgress, OutputFormat, Provider, Track } from "./types.js";
import { AppError } from "./types.js";
import { matchScore } from "./normalize.js";
import { assertRealWav, outputExists, probe, sanitizeFilename, transcode } from "../audio/ffmpeg.js";
import { downloadCover, embedCoverArt, writeWavId3 } from "../audio/tags.js";
import type { TrackMeta } from "../audio/tags.js";
import { fetchLyrics } from "../lyrics/lrclib.js";
import { throttledProgress } from "../providers/youtube.js";

const MATCH_THRESHOLD = 0.8;

/** Tahapan hidup satu track — dipakai UI untuk render state per baris queue. */
export type TrackStage = "searching" | "downloading" | "transcoding" | "lyrics";

export interface PipelineOptions {
  outputDir: string;
  formats: OutputFormat[];
  providers: Provider[];
  /** Kalau true, fetch & simpan lirik (.lrc/.txt) di sebelah file audio. */
  fetchLyrics?: boolean;
  /** Total track di batch — untuk tag "track N/total". */
  trackTotal?: number;
  onTrack?: (result: DownloadResult) => void;
  /** Dipanggil tiap ganti tahap (searching → downloading → transcoding). */
  onStage?: (stage: TrackStage) => void;
  /** Progress file sumber yang sedang didownload (throttled). */
  onFileProgress?: (p: FileProgress) => void;
  /** Aborted = hentikan track secepatnya dengan kategori "cancelled". */
  signal?: AbortSignal;
}

/** Urutkan provider: priority kecil (kualitas terbaik) dulu. */
function sortProviders(providers: Provider[]): Provider[] {
  return [...providers].sort((a, b) => a.priority - b.priority);
}

/** Tebak kategori error dari pesan yt-dlp/fetch supaya retry policy lebih tepat.
 *  Diekspor untuk test. */
export function classifyError(message: string): ErrorCategory {
  if (/429|rate.?limit|too many requests|blocked|not a bot/i.test(message)) return "rate-limit";
  if (/timed? ?out|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|getaddrinfo|network|unable to download webpage/i.test(message)) return "network";
  return "provider";
}

/**
 * Coba search + download dari satu provider.
 * Throw AppError kalau gagal (supaya caller bisa coba provider berikutnya).
 */
async function tryProvider(
  provider: Provider,
  track: Track,
  workDir: string,
  opts: PipelineOptions,
  relaxed = false,
): Promise<{ srcFile: string; providerName: string }> {
  // 1. Search kandidat
  let candidates;
  try {
    opts.onStage?.("searching");
    candidates = await provider.search(track, { relaxed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled") throw new AppError("cancelled", "cancelled", provider.name, false);
    throw new AppError(
      `${provider.name}: search gagal — ${msg}`,
      classifyError(msg),
      provider.name,
      true,
    );
  }

  if (!candidates || candidates.length === 0) {
    throw new AppError(
      `${provider.name}: tidak ada kandidat`,
      "no-match",
      provider.name,
      false,
    );
  }

  // 2. Cari kandidat terbaik yang match
  let bestCandidate = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = matchScore(track, c);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = c;
    }
  }

  if (!bestCandidate || bestScore < MATCH_THRESHOLD) {
    throw new AppError(
      `${provider.name}: tidak ada match di atas threshold (terbaik: ${bestScore.toFixed(2)})`,
      "no-match",
      provider.name,
      false,
    );
  }

  // 3. Download
  try {
    opts.onStage?.("downloading");
    const srcFile = await provider.download(bestCandidate, workDir, {
      signal: opts.signal,
      onProgress: throttledProgress(opts.onFileProgress),
    });
    return { srcFile, providerName: provider.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled" || opts.signal?.aborted) {
      throw new AppError("cancelled", "cancelled", provider.name, false);
    }
    throw new AppError(
      `${provider.name}: download gagal — ${msg}`,
      classifyError(msg),
      provider.name,
      true,
    );
  }
}

/** Proses satu track lengkap, return hasil. Coba semua provider sebelum gagal. */
export async function processTrack(track: Track, opts: PipelineOptions): Promise<DownloadResult> {
  const fail = (error: string, category?: DownloadResult["errorCategory"]): DownloadResult => ({
    track,
    ok: false,
    providerUsed: null,
    outputPath: null,
    error,
    errorCategory: category,
  });

  if (opts.signal?.aborted) return fail("cancelled", "cancelled");

  const baseName = sanitizeFilename(`${track.artists.join(", ")} - ${track.title}`);

  // Guard defensif: formats kosong di semua pemanggil -> SEMUA track akan
  // lapor "sudah ada" tanpa menulis file ([].every() === true).
  if (opts.formats.length === 0) return fail("Format output tidak dipilih", "format");

  // Resume: skip kalau semua format sudah ada.
  if (opts.formats.every((f) => outputExists(opts.outputDir, baseName, f))) {
    return { ...fail("sudah ada"), ok: true, outputPath: path.join(opts.outputDir, baseName) };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotfid-"));
  const ladder = sortProviders(opts.providers);

  try {
    // Ladder pass 1: query lengkap (judul + artist).
    // Pass 2 (relaxed, judul saja) hanya kalau semua provider no-match —
    // search YouTube flaky: audio resmi kadang tidak muncul di hasil gabungan.
    const runLadder = async (relaxed: boolean) => {
      const errs: string[] = [];
      let src: string | null = null;
      let used: string | null = null;
      for (const provider of ladder) {
        if (opts.signal?.aborted) break;
        try {
          const result = await tryProvider(provider, track, workDir, opts, relaxed);
          src = result.srcFile;
          used = result.providerName;
          break; // sukses — keluar dari loop
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof AppError && err.category === "cancelled") throw err;
          errs.push(msg);
          continue; // Lanjut ke provider berikutnya
        }
      }
      return { src, used, errs };
    };

    let ladderResult = await runLadder(false);
    // Pass relaxed (judul saja) hanya kalau pass pertama gagal karena TIDAK ADA MATCH
    // di semua provider. Error transient (network/rate-limit/403) tidak layak
    // memicu ladder kedua - itu cuma menggandakan request ke sumber yang sama.
    const hasNoMatch = ladderResult.errs.some((e) => e.includes("tidak ada"));
    const hasTransient = ladderResult.errs.some((e) =>
      /rate.?limit|429|timed? ?out|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|network|unable to download/i.test(e),
    );
    if (!ladderResult.src && !opts.signal?.aborted && hasNoMatch && !hasTransient) {
      ladderResult = await runLadder(true);
    }

    const { src: srcFile, used: providerUsed, errs: errors } = ladderResult;

    if (opts.signal?.aborted) return fail("cancelled", "cancelled");

    // Semua provider gagal
    if (!srcFile || !providerUsed) {
      const onlyNoMatch = errors.length > 0 && errors.every((e) => e.includes("tidak ada"));
      return fail(
        `Semua provider gagal:\n  ${errors.join("\n  ")}`,
        onlyNoMatch ? "no-match" : errors.some((e) => /rate.?limit|429/i.test(e)) ? "rate-limit" : "provider",
      );
    }

    // Transcode ke semua format
    opts.onStage?.("transcoding");

    // Lirik di-fetch SEKALI sebelum transcode supaya bisa ditanam ke tag
    // bersamaan dengan metadata (tanpa file sidecar .lrc/.txt — output bersih).
    let lyricsText: string | null = null;
    let instrumental = false;
    if (opts.fetchLyrics) {
      try {
        opts.onStage?.("lyrics");
        const artist = track.artists[0] ?? "Unknown";
        const lyrics = await fetchLyrics(artist, track.title, track.album, track.durationSec);
        if (lyrics) {
          instrumental = lyrics.instrumental;
          // Utamakan LRC tersinkron (pemutar modern menampilkan sinkron dari USLT),
          // fallback ke plain.
          lyricsText = lyrics.syncedLyrics ?? lyrics.plainLyrics ?? null;
        }
      } catch {
        // Lirik gagal = jangan gagalkan track
      }
    }

    // Metadata lengkap untuk semua format + cover didownload sekali per track.
    const meta: TrackMeta = {
      title: track.title,
      artist: track.artists.join(", "),
      albumArtist: track.artists[0] ?? null,
      album: track.album,
      trackNo: track.trackNumber,
      trackTotal: opts.trackTotal ?? null,
      lyrics: lyricsText,
    };
    const coverBytes = track.coverArtUrl ? await downloadCover(track.coverArtUrl) : null;

    const produced: string[] = [];
    for (const format of opts.formats) {
      const outNoExtAbsolute = path.join(opts.outputDir, baseName);
      if (outputExists(opts.outputDir, baseName, format)) continue;

      let outFile: string;
      try {
        outFile = await transcode(srcFile, format, outNoExtAbsolute, opts.signal, meta);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "cancelled" || opts.signal?.aborted) {
          throw new AppError("cancelled", "cancelled", providerUsed, false);
        }
        throw new AppError(
          `Transcode gagal (${format}): ${msg}`,
          "format",
          providerUsed,
          false,
        );
      }

      // Verifikasi WAV - gagal di sini = file palsu, bukan error provider,
      // jadi jangan diklasifikasikan "provider" (itu membuatnya di-retry = download ulang sia-sia).
      if (format === "wav") {
      try {
        const p = await probe(outFile);
        assertRealWav(p);
      } catch (err) {
        throw new AppError(
          err instanceof Error ? err.message : String(err),
          "format",
          providerUsed,
          false,
        );
      }
    }

      // Verifikasi file tidak kosong
      const stat = fs.statSync(outFile);
      if (stat.size === 0) {
        fs.unlinkSync(outFile);
        throw new AppError(
          `Output ${format} kosong (0 bytes)`,
          "format",
          providerUsed,
          false,
        );
      }

      // Cover art: WAV lewat chunk ID3 manual; MP3/FLAC lewat ffmpeg.
      // Kegagalan cover tidak boleh gagalkan track.
      try {
        if (format === "wav") {
          writeWavId3(outFile, meta, coverBytes);
        } else if (coverBytes) {
          await embedCoverArt(outFile, coverBytes, format);
        }
      } catch { /* cover gagal = skip */ }

      produced.push(outFile);
    }

    const result: DownloadResult = {
      track,
      ok: true,
      providerUsed,
      outputPath: produced[0] ?? null,
      error: null,
      lyricsEmbedded: Boolean(lyricsText),
      instrumental,
    };
    opts.onTrack?.(result);
    return result;
  } catch (err) {
    const isCancelled = opts.signal?.aborted || (err instanceof AppError && err.category === "cancelled");
    const category: ErrorCategory = isCancelled
      ? "cancelled"
      : err instanceof AppError
        ? err.category
        : "provider";
    const result = fail(
      err instanceof Error ? err.message : String(err),
      category,
    );
    opts.onTrack?.(result);
    return result;
  } finally {
    // Windows: file sumber bisa masih ter-lock sesaat setelah child process
    // dibunuh saat cancel — pakai retry & jangan biarkan cleanup menggagalkan hasil.
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Biarkan OS membersihkan temp dir; kegagalan cleanup bukan kegagalan track.
    }
  }
}
