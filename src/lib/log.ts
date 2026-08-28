// File logging dengan rotasi harian + prune otomatis.
// Log ditulis ke %APPDATA%/spotify-downloader/logs/ (fallback ~/.config).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function appDataDir(): string {
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, "spotify-downloader")
    : path.join(os.homedir(), ".config", "spotify-downloader");
}

export function logsDir(): string {
  return path.join(appDataDir(), "logs");
}

function logFile(): string {
  const d = new Date();
  const name = `app-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.log`;
  return path.join(logsDir(), name);
}

function append(line: string): void {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(logFile(), line + "\n");
  } catch { /* logging tidak boleh bikin crash */ }
}

/** Prune log lebih tua dari keepDays. */
export function pruneLogs(keepDays = 7): void {
  try {
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const f of fs.readdirSync(logsDir())) {
      const p = path.join(logsDir(), f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* abaikan */ }
}

function stamp(): string {
  return new Date().toISOString();
}

/** Pasang mirror console.log/error/warn ke file. Dipanggil sekali saat server start. */
export function initLogging(): void {
  pruneLogs();
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    append(`[${stamp()}] INFO ${args.map(String).join(" ")}`);
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    append(`[${stamp()}] ERROR ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")}`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    append(`[${stamp()}] WARN ${args.map(String).join(" ")}`);
  };
}
