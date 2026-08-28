// Registry child process (yt-dlp/ffmpeg) + graceful shutdown.
// Masalah yang diselesaikan: server mati/crash saat download jalan ->
// child process yatim terus jalan tanpa orang tua. Semua spawn eksternal
// wajib lewat trackChild supaya bisa dibunuh massal saat shutdown.

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

/** Bunuh semua child yang masih hidup (dipakai saat shutdown/crash). */
export function killAllChildren(): void {
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch { /* sudah mati */ }
  }
  children.clear();
}
