// Persistensi settings & history ke %APPDATA%/spotify-downloader.
// Tanpa ini, semua preferensi & riwayat hilang tiap server restart.

import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "./log.js";

const dataDir = appDataDir();
const settingsFile = path.join(dataDir, "settings.json");
const historyFile = path.join(dataDir, "history.json");
const MAX_HISTORY = 50;

export interface AppSettings {
  lastOutputDir?: string;
  lastFormats?: string;
  lastLyrics?: boolean;
  lastResolution?: string;
  lastVideoFormat?: string;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}

export function loadSettings(): AppSettings {
  return readJson<AppSettings>(settingsFile, {});
}

export function saveSettings(patch: AppSettings): AppSettings {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
  } catch { /* gagal simpan = jangan crash */ }
  return next;
}

export interface HistoryEntry {
  id: string;
  kind: string;
  status: string;
  label: string;
  createdAt: number;
  finishedAt: number | null;
  summary?: Record<string, unknown>;
  error?: string;
  meta?: { name?: string; cover?: string | null; formats?: string };
}

export function loadHistory(): HistoryEntry[] {
  try {
    const arr = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function appendHistory(entry: HistoryEntry): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const all = [...loadHistory().filter((h) => h.id !== entry.id), entry]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_HISTORY);
    fs.writeFileSync(historyFile, JSON.stringify(all, null, 2));
  } catch { /* abaikan */ }
}
