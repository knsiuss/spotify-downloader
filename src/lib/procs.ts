// Registry child process (yt-dlp/ffmpeg) + graceful shutdown.
// Masalah yang diselesaikan: server mati/crash saat download jalan ->
// child process yatim terus jalan tanpa orang tua. Semua spawn eksternal
// wajib lewat trackChild supaya bisa dibunuh massal saat shutdown.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();

export function trackChild<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once("close", () => children.delete(child));
  child.once("error", () => children.delete(child));
  return child;
}

export function trackedCount(): number {
  return children.size;
}

/**
 * Bunuh proses beserta seluruh turunannya (Windows: `taskkill /T /F`).
 * Penting untuk yt-dlp: dia menjalankan ffmpeg sebagai grandchild, dan
 * SIGKILL ke yt-dlp saja meninggalkan ffmpeg yang tetap menulis file hasil
 * merge SETELAH job dilaporkan gagal.
 */
export function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      // Tanpa listener, 'error' event dari taskkill jadi uncaught exception.
      killer.on("error", () => {});
      killer.unref();
      return;
    }
    child.kill("SIGKILL");
  } catch { /* proses sudah mati */ }
}

/** Bunuh semua child yang masih hidup (dipakai saat shutdown/crash). */
export function killAllChildren(): void {
  for (const c of children) {
    killProcessTree(c);
  }
  children.clear();
}
