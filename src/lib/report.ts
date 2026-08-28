// Report writer: tulis hasil batch ke JSON untuk debugging/audit.

import fs from "node:fs";
import type { DownloadResult, Provider } from "../core/types.js";
import type { DownloadRequest } from "./index.js";

interface ReportEntry {
  track: {
    id: string;
    title: string;
    artists: string[];
    album: string | null;
    durationSec: number;
  };
  ok: boolean;
  providerUsed: string | null;
  error: string | null;
  errorCategory: string | null;
  outputPath: string | null;
}

interface Report {
  timestamp: string;
  input: string;
  outputDir: string;
  formats: string[];
  durationMs: number;
  summary: {
    total: number;
    succeeded: number;
    skipped: number;
    failed: number;
  };
  tracks: ReportEntry[];
}

export function writeReport(
  reportPath: string,
  data: {
    source: { name: string; type: string; id: string };
    results: DownloadResult[];
    req: DownloadRequest;
    durationMs: number;
  }
): void {
  const succeeded = data.results.filter((r) => r.ok && r.error === null).length;
  const skipped = data.results.filter((r) => r.ok && r.error === "sudah ada").length;
  const failed = data.results.length - succeeded - skipped;

  const report: Report = {
    timestamp: new Date().toISOString(),
    input: `${data.source.type}:${data.source.id} (${data.source.name})`,
    outputDir: data.req.outputDir,
    formats: data.req.formats,
    durationMs: data.durationMs,
    summary: { total: data.results.length, succeeded, skipped, failed },
    tracks: data.results.map((r) => ({
      track: {
        id: r.track.id,
        title: r.track.title,
        artists: r.track.artists,
        album: r.track.album,
        durationSec: r.track.durationSec,
      },
      ok: r.ok,
      providerUsed: r.providerUsed,
      error: r.error,
      errorCategory: r.errorCategory ?? null,
      outputPath: r.outputPath,
    })),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}