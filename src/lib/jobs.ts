// Job registry untuk backend: satu job = satu batch download yang bisa
// di-stream, di-poll, dan dibatalkan dari UI.
//
// Pola: POST /api/download -> createJob() -> runner jalan async ->
// event masuk lewat appendEvent() -> subscriber NDJSON menerima live,
// event lama di-buffer supaya client reconnect tidak kehilangan apa pun.

import { randomUUID } from "node:crypto";
import { appendHistory, loadHistory } from "./persist.js";
import type { HistoryEntry } from "./persist.js";

export type JobKind = "music" | "video";
export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface JobEvent {
  type: string;
  /** Epoch ms — UI pakai ini buat hitung ETA/elapsed tanpa sinkron jam. */
  ts?: number;
  [key: string]: unknown;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: number;
  finishedAt: number | null;
  /** Ringkasan input job (url/formats) untuk daftar history. */
  label: string;
  summary?: Record<string, unknown>;
  error?: string;
  meta?: { name?: string; cover?: string | null; formats?: string };
  progress?: { completed?: number; total?: number; percent?: number; speedBps?: number | null };
}

const MAX_BUFFERED_EVENTS = 5_000;
const MAX_FINISHED_JOBS = 30;

export class Job {
  readonly id = randomUUID();
  readonly kind: JobKind;
  readonly createdAt = Date.now();
  status: JobStatus = "running";
  finishedAt: number | null = null;
  label = "";
  summary: Record<string, unknown> | undefined;
  error: string | undefined;
  /** Info ramah-user: nama playlist/lagu, cover, format — untuk halaman Riwayat. */
  meta: { name?: string; cover?: string | null; formats?: string } = {};
  /** Progress live untuk snapshot polling (halaman Riwayat). */
  progress?: { completed?: number; total?: number; percent?: number; speedBps?: number | null };

  /** AbortController yang diteruskan sampai ke child process yt-dlp/ffmpeg. */
  readonly controller = new AbortController();

  private events: JobEvent[] = [];
  private subscribers = new Set<(e: JobEvent) => void>();

  constructor(kind: JobKind, label: string) {
    this.kind = kind;
    this.label = label;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      label: this.label,
      summary: this.summary,
      error: this.error,
      meta: { ...this.meta },
      progress: this.status === "running" ? { ...this.progress } : undefined,
    };
  }

  bufferedEvents(): JobEvent[] {
    return this.events;
  }

  /** Tambah event ke buffer + broadcast ke semua subscriber live. */
  emit(event: { type: string; [key: string]: unknown }): void {
    const e: JobEvent = { ...event, ts: Date.now() };
    if (this.events.length < MAX_BUFFERED_EVENTS) this.events.push(e);
    for (const fn of this.subscribers) {
      try { fn(e); } catch { /* subscriber error jangan ganggu job */ }
    }
  }

  subscribe(fn: (e: JobEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

const jobs = new Map<string, Job>();

/** Buat job baru + jalankan housekeeping (buang job selesai yang kelewat batas). */
export function createJob(kind: JobKind, label: string): Job {
  const job = new Job(kind, label);
  jobs.set(job.id, job);

  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => b.finishedAt! - a.finishedAt!);
  for (const old of finished.slice(MAX_FINISHED_JOBS)) jobs.delete(old.id);

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(limit = 20): JobSnapshot[] {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((j) => j.snapshot());
}

/** Tambah event ke buffer + broadcast ke semua subscriber live. */
export function appendEvent(job: Job, event: { type: string; [key: string]: unknown }): void {
  job.emit(event);
}

/**
 * Minta pembatalan. Status tetap "running" sampai runner benar-benar berhenti
 * dan menulis event terminal — UI menampilkan state "membatalkan..." di sela itu.
 */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.controller.abort();
  appendEvent(job, { type: "cancelling" });
  return true;
}

/** Tandai job selesai (status final + event terminal + persist history). */
export function finishJob(
  job: Job,
  status: Exclude<JobStatus, "running">,
  terminalEvent: { type: string; [key: string]: unknown },
  extra?: { summary?: Record<string, unknown>; error?: string },
): void {
  job.status = status;
  job.finishedAt = Date.now();
  if (extra?.summary) job.summary = extra.summary;
  if (extra?.error) job.error = extra.error;
  appendEvent(job, terminalEvent);

  // History ke disk supaya bertahan lintas restart server.
  const entry: HistoryEntry = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    label: job.label,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error: job.error,
    meta: { ...job.meta },
  };
  appendHistory(entry);
}

/** History gabungan: job hidup di memori + riwayat lama dari disk. */
export function listAllJobs(limit = 20): JobSnapshot[] {
  const live = listJobs(limit);
  const liveIds = new Set(live.map((j) => j.id));
  const persisted = loadHistory()
    .filter((h) => !liveIds.has(h.id))
    .map((h) => ({
      id: h.id, kind: h.kind as JobKind, status: h.status as JobStatus,
      createdAt: h.createdAt, finishedAt: h.finishedAt, label: h.label,
      summary: h.summary, error: h.error,
      meta: h.meta,
    }));
  return [...live, ...persisted].slice(0, limit);
}
