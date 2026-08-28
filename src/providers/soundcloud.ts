// Provider SoundCloud via yt-dlp (sumber ketiga, berbeda dari YouTube).
// Kualitas: MP3/AAC 128-256kbps, gratis tanpa akun.
// Kadang punya versi live/remix yang tidak ada di YouTube.

import path from "node:path";
import { runYtDlp, parseYtDlpProgress } from "./youtube.js";
import type { Candidate, Provider, ProviderContext, Track } from "../core/types.js";

export class SoundCloudProvider implements Provider {
  name = "soundcloud";
  /** Dicoba setelah YouTube (lebih banyak variasi tapi kualitas mirip). */
  priority = 110;

  async search(track: Track): Promise<Candidate[]> {
    const query = `${track.title} ${track.artists.join(" ")}`.replace(/[|]/g, " ");
    const args = [
      `scsearch5:${query}`,
      "--flat-playlist",
      "--no-download",
      "--print",
      // %(url)s = permalink resmi dari yt-dlp — jangan rakit URL manual
      // (soundcloud.com/tracks/<id> bukan halaman valid -> 404 saat download).
      "%(id)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(url)s",
    ];
    const out = await runYtDlp(args);

    const candidates: Candidate[] = [];
    for (const line of out.split("\n")) {
      const [id, title, uploader, duration, url] = line.split("\t");
      if (!id || !title) continue;
      candidates.push({
        id,
        title,
        artist: uploader ?? "",
        durationSec: duration ? parseFloat(duration) : null,
        url: url || `https://soundcloud.com/tracks/${id}`,
      });
    }
    return candidates;
  }

  async download(candidate: Candidate, workDir: string, ctx?: ProviderContext): Promise<string> {
    const outPath = path.join(workDir, `${candidate.id}.%(ext)s`);
    const args = [
      candidate.url,
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "-o",
      outPath,
      "--no-warnings",
      "--newline",
    ];
    await runYtDlp(args, {
      signal: ctx?.signal,
      onLine: (line) => {
        const p = parseYtDlpProgress(line);
        if (p) ctx?.onProgress?.(p);
      },
    });

    const fs = await import("node:fs");
    const files = fs.readdirSync(workDir).filter((f) => f.includes(candidate.id));
    if (files.length === 0) throw new Error("yt-dlp selesai tapi file tidak ditemukan");
    return path.join(workDir, files[0]);
  }
}