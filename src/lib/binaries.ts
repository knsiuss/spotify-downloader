// Resolver binary eksternal (yt-dlp/ffmpeg/ffprobe).
// Urutan: folder bundled (SPOTDLR_BINS atau <root>/bin) -> PATH sistem.
// Ini kunci packaging: app ter-bundle membawa binary sendiri, dev tetap pakai PATH.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root project — dari dist/lib naik dua level. */
export const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function bundledDir(): string {
  return process.env.SPOTDLR_BINS ?? path.join(projectRoot, "bin");
}

/** Path lengkap binary yang dipakai spawn. */
export function resolveBinary(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const bundled = path.join(bundledDir(), exe);
  if (fs.existsSync(bundled)) return bundled;
  return name; // fallback: cari di PATH
}

export interface BinaryInfo {
  found: boolean;
  version: string | null;
  /** Umur versi yt-dlp (hari sejak tanggal rilis). null kalau tidak relevan. */
  ageDays: number | null;
  /** Path yang dipakai (null kalau tidak ketemu). */
  resolvedPath: string | null;
}

function probeVersion(name: string, args: string[]): string | null {
  try {
    return execFileSync(resolveBinary(name), args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    }).trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/** Umur rilis yt-dlp dari versi kalender "YYYY.MM.DD". */
function ytDlpAgeDays(version: string | null): number | null {
  const m = version?.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor((Date.now() - released) / 86_400_000);
}

export function binaryInfo(name: string, args: string[]): BinaryInfo {
  const resolved = (() => {
    const p = resolveBinary(name);
    return p === name ? null : p;
  })();
  const version = probeVersion(name, args);
  return {
    found: version !== null,
    version,
    ageDays: name === "yt-dlp" ? ytDlpAgeDays(version) : null,
    resolvedPath: version !== null ? (resolved ?? "(PATH)") : null,
  };
}

/** Ambil info semua binary eksternal untuk /api/diagnostics. */
export function allBinariesInfo() {
  return {
    ytDlp: binaryInfo("yt-dlp", ["--version"]),
    ffmpeg: binaryInfo("ffmpeg", ["-version"]),
    ffprobe: binaryInfo("ffprobe", ["-version"]),
  };
}
