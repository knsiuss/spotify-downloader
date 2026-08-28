// Backend API + penyaji UI statis — SATU proses, SATU port.
// Keamanan: bind 127.0.0.1 + validasi Origin (blok drive-by local API
// dari website jahat di browser), CORS hanya untuk origin localhost (dev mode).

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadTracks, resolveTargetDir } from "./lib/index.js";
import type { DownloadRequest } from "./lib/index.js";
import { createJob, getJob, cancelJob, appendEvent, finishJob } from "./lib/jobs.js";
import { listAllJobs } from "./lib/jobs.js";
import type { Job, JobEvent } from "./lib/jobs.js";
import { loadSettings, saveSettings } from "./lib/persist.js";
import type { AppSettings } from "./lib/persist.js";
import { allBinariesInfo } from "./lib/binaries.js";
import { serveStatic, uiIsBuilt } from "./lib/static.js";
import { initLogging, appDataDir } from "./lib/log.js";
import { killAllChildren } from "./lib/procs.js";
import { downloadVideo, getVideoInfo, isYouTubeUrl } from "./video/youtube-video.js";
import type { VideoResolution, VideoFormat } from "./video/youtube-video.js";
import { fetchLyrics } from "./lyrics/lrclib.js";
import { loadQobuzConfig } from "./providers/qobuz.js";

initLogging();

// Version dibaca sekali dari package.json di root project (bukan hardcode biar tidak drift).
const APP_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
})();

process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandledRejection:", err);
});

const PORT = Number(process.env.PORT ?? 3001);
const HOST = "127.0.0.1";

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error("Body terlalu besar")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Drive-by local API: website jahat bisa kirim POST ke localhost dari browser
 * korban. Origin header tidak bisa dipalsukan browser, jadi ini pertahanan utama.
 * Request tanpa Origin (curl/CLI/navigasi langsung) diizinkan.
 */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

const AUDIO_FORMATS = new Set(["wav", "flac", "mp3"]);
const VIDEO_RESOLUTIONS = new Set(["144", "240", "360", "480", "720", "1080", "1440", "2160", "best"]);
const VIDEO_FORMATS = new Set(["mp4", "webm", "mkv"]);

/** Runner job musik: metadata sekali scrape -> batch download dengan event live. */
async function runMusicJob(job: Job, reqObj: DownloadRequest): Promise<void> {
  const emit = (e: { type: string; [key: string]: unknown }) => appendEvent(job, e);

  let source;
  try {
    const { fetchSpotifyMetadata } = await import("./metadata/spotify.js");
    source = await fetchSpotifyMetadata(reqObj.input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishJob(job, "error", { type: "error", error: msg }, { error: msg });
    return;
  }

  const tracks = reqObj.limit
    ? source.tracks.slice(0, Math.max(1, reqObj.limit))
    : source.tracks;

  // Label & meta ramah-user untuk halaman Riwayat (nama + cover, bukan URL).
  job.label = source.name || job.label;
  job.meta = { name: source.name, cover: source.cover, formats: reqObj.formats.join(",") };

  emit({
    type: "start",
    total: tracks.length,
    name: source.name,
    sourceType: source.type,
    cover: source.cover,
    truncated: source.truncated,
    // Folder tujuan akhir (playlist/album = subfolder sendiri) — UI menampilkannya.
    folder: resolveTargetDir(reqObj, source).dir,
    // Kirim daftar track sejak awal supaya UI bisa render queue lengkap dengan cover.
    tracks: tracks.map((t) => ({
      id: t.id, title: t.title, artists: t.artists, album: t.album, durationSec: t.durationSec,
      coverArtUrl: t.coverArtUrl,
    })),
  });

  // Progress live untuk snapshot polling: hitungan track + speed agregat.
  const activeSpeeds = new Map<number, number | null>();
  let completedCount = 0;
  const sumSpeeds = () => {
    let sum = 0;
    let any = false;
    for (const v of activeSpeeds.values()) { if (v && v > 0) { sum += v; any = true; } }
    return any ? sum : null;
  };

  const result = await downloadTracks(reqObj, source, {
    signal: job.signal,
    onStage: (stage, index) => emit({ type: "track_stage", index, stage }),
    onFileProgress: (p, index) => {
      activeSpeeds.set(index, p.speedBps);
      job.progress = { ...(job.progress ?? {}), completed: completedCount, total: tracks.length, speedBps: sumSpeeds() };
      emit({
        type: "track_progress", index,
        percent: p.percent, speedBps: p.speedBps, etaSec: p.etaSec,
        downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes,
      });
    },
    onTrack: (r, index) =>
      emit({
        type: "track", index,
        title: `${r.track.artists.join(", ")} - ${r.track.title}`,
        ok: r.ok, provider: r.providerUsed, error: r.error, errorCategory: r.errorCategory ?? null,
        hasLyrics: Boolean(r.lyricsEmbedded), instrumental: Boolean(r.instrumental),
        outputPath: r.outputPath,
      }),
    onProgress: (completed, total) => emit({ type: "progress", completed, total }),
    onWarning: (message) => emit({ type: "warning", message }),
  });

  if (result.summary.cancelled) {
    finishJob(job, "cancelled", { type: "cancelled", summary: result.summary }, { summary: { ...result.summary } });
  } else {
    finishJob(
      job, "done",
      { type: "done", summary: result.summary, reportPath: result.reportPath },
      { summary: { ...result.summary, reportPath: result.reportPath } },
    );
  }
}

/** Runner job video YouTube. */
async function runVideoJob(
  job: Job,
  params: { url: string; outputDir: string; resolution: VideoResolution; format: VideoFormat; cookiesFile?: string },
): Promise<void> {
  const emit = (e: { type: string; [key: string]: unknown }) => appendEvent(job, e);

  // Info dulu supaya UI bisa menampilkan judul/thumbnail sebelum download jalan.
  let info = null;
  try { info = await getVideoInfo(params.url); } catch { /* fallback: tanpa info */ }
  emit({ type: "start", info });

  const result = await downloadVideo(params, {
    signal: job.signal,
    onProgress: (p) =>
      emit({
        type: "video_progress",
        percent: p.percent, speedBps: p.speedBps, etaSec: p.etaSec,
        downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes,
      }),
  });

  if (result.ok || result.error === "sudah ada") {
    const skipped = result.error === "sudah ada";
    finishJob(job, "done", { type: "done", outputPath: result.outputPath, skipped, info }, { summary: { outputPath: result.outputPath, skipped } });
  } else if (result.error === "cancelled" || job.signal.aborted) {
    finishJob(job, "cancelled", { type: "cancelled" });
  } else {
    const msg = result.error ?? "Download video gagal";
    finishJob(job, "error", { type: "error", error: msg }, { error: msg });
  }
}

/** Stream NDJSON: replay buffer lalu live sampai event terminal. */
function streamJobEvents(res: http.ServerResponse, job: Job): void {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const isTerminal = (e: JobEvent) =>
    e.type === "done" || e.type === "error" || e.type === "cancelled";

  const write = (e: JobEvent) => {
    try { res.write(JSON.stringify(e) + "\n"); } catch { /* koneksi tutup */ }
  };

  // Subscribe dulu, baru replay buffer — event yang muncul di dua-duanya
  // didedupe pakai identitas objek (appendEvent memakai referensi yang sama).
  const seen = new Set<JobEvent>();
  const pending: JobEvent[] = [];
  let flushing = true;
  const unsubscribe = job.subscribe((e) => {
    if (flushing) { pending.push(e); return; }
    write(e);
    if (isTerminal(e)) cleanup();
  });

  const cleanup = () => {
    unsubscribe();
    clearInterval(ping);
    try { res.end(); } catch { /* sudah tutup */ }
  };
  const ping = setInterval(() => {
    try { res.write(JSON.stringify({ type: "ping", ts: Date.now() }) + "\n"); }
    catch { cleanup(); }
  }, 15_000);

  for (const e of job.bufferedEvents()) { seen.add(e); write(e); }
  flushing = false;
  for (const e of pending) {
    if (seen.has(e)) continue;
    write(e);
    if (isTerminal(e)) { cleanup(); return; }
  }
  if (job.status !== "running") cleanup();

  res.on("close", cleanup);
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const url = req.url ?? "/";
  const segments = url.split("?")[0].split("/").filter(Boolean);

  // Keamanan: hanya API yang butuh guard Origin; file statis aman (GET saja).
  if (segments[0] === "api") {
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: "Origin tidak diizinkan" });
      return;
    }
    // CORS hanya untuk origin localhost (mode dev UI terpisah).
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin));
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url === "/api/health") {
    sendJson(res, 200, { ok: true, version: APP_VERSION, uptime: process.uptime(), ui: uiIsBuilt() });
    return;
  }

  if (req.method === "GET" && url === "/api/formats") {
    sendJson(res, 200, {
      audio: [...AUDIO_FORMATS],
      video: {
        resolutions: [...VIDEO_RESOLUTIONS],
        formats: [...VIDEO_FORMATS],
      },
    });
    return;
  }

  // GET /api/settings & PUT — preferensi user persist di disk.
  if (url === "/api/settings" && (req.method === "GET" || req.method === "PUT")) {
    if (req.method === "GET") {
      sendJson(res, 200, loadSettings());
      return;
    }
    try {
      const body = await parseBody(req);
      const patch: AppSettings = {};
      if (typeof body.lastOutputDir === "string") patch.lastOutputDir = body.lastOutputDir;
      if (typeof body.lastFormats === "string") patch.lastFormats = body.lastFormats;
      if (typeof body.lastLyrics === "boolean") patch.lastLyrics = body.lastLyrics;
      if (typeof body.lastResolution === "string") patch.lastResolution = body.lastResolution;
      if (typeof body.lastVideoFormat === "string") patch.lastVideoFormat = body.lastVideoFormat;
      sendJson(res, 200, saveSettings(patch));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /api/diagnostics — kesehatan dependency eksternal untuk UI.
  if (req.method === "GET" && url === "/api/diagnostics") {
    const bins = allBinariesInfo();
    let disk: { freeGB: number } | null = null;
    try {
      const outDir = path.resolve(process.cwd(), "output");
      fs.mkdirSync(outDir, { recursive: true });
      const s = fs.statfsSync(outDir);
      disk = { freeGB: Number(((s.bsize * s.bavail) / 1024 ** 3).toFixed(1)) };
    } catch { /* statfs tidak tersedia */ }
    sendJson(res, 200, {
      ...bins,
      disk,
      qobuzConfigured: loadQobuzConfig() !== null,
      uiBuilt: uiIsBuilt(),
      dataDir: appDataDir(),
      version: APP_VERSION,
    });
    return;
  }

  // POST /api/open-path — buka folder/file di Explorer (app lokal).
  if (req.method === "POST" && url === "/api/open-path") {
    try {
      const body = await parseBody(req);
      const target = path.resolve(String(body.path ?? ""));
      if (!fs.existsSync(target)) { sendJson(res, 400, { error: "Path tidak ada" }); return; }
      const args = fs.statSync(target).isFile()
        ? ["/select,", target]
        : [target];
      const child = spawn("explorer.exe", args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "POST" && url === "/api/lyrics") {
    try {
      const body = await parseBody(req);
      const { artist, track, album, duration } = body as Record<string, string>;
      if (!artist || !track) { sendJson(res, 400, { error: "artist & track wajib" }); return; }
      const lyrics = await fetchLyrics(String(artist), String(track), album ? String(album) : null, duration ? Number(duration) : 0);
      if (!lyrics) { sendJson(res, 200, { found: false }); return; }
      sendJson(res, 200, { found: true, ...lyrics });
    } catch (err) { sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }); }
    return;
  }

  // POST /api/download — buat job musik, balik jobId.
  if (req.method === "POST" && url === "/api/download") {
    try {
      const body = await parseBody(req);
      const { url: inputUrl, formats = "wav", outputDir, limit, fetchLyrics: wantLyrics, concurrency, retries, cookiesFile } = body as Record<string, unknown>;
      if (!inputUrl || typeof inputUrl !== "string") { sendJson(res, 400, { error: "url wajib diisi (Spotify link)" }); return; }
      const resolvedOutputDir = outputDir ? path.resolve(String(outputDir)) : path.resolve(process.cwd(), "output");
      const fmtList = String(formats).split(",").map((f) => f.trim().toLowerCase()).filter(Boolean);
      for (const f of fmtList) {
        if (!AUDIO_FORMATS.has(f)) { sendJson(res, 400, { error: `format tidak valid: ${f}. Pilih: wav, flac, mp3` }); return; }
      }

      const reqObj: DownloadRequest = {
        input: String(inputUrl),
        outputDir: resolvedOutputDir,
        formats: fmtList as DownloadRequest["formats"],
        limit: limit ? Number(limit) : undefined,
        fetchLyrics: Boolean(wantLyrics),
        concurrency: concurrency ? Number(concurrency) : undefined,
        retries: retries ? Number(retries) : undefined,
        cookiesFile: cookiesFile ? String(cookiesFile) : undefined,
      };

      const job = createJob("music", `${inputUrl} -> ${fmtList.join(",")}`);
      console.log(`[download:${job.id}] start ${inputUrl} -> ${fmtList.join(",")} lyrics=${Boolean(wantLyrics)} -> ${resolvedOutputDir}`);
      runMusicJob(job, reqObj)
        .catch((err) => {
          console.error(`[download:${job.id}] crashed:`, err);
          if (job.status === "running") {
            finishJob(job, "error", { type: "error", error: err instanceof Error ? err.message : String(err) }, { error: String(err) });
          }
        })
        .finally(() => {
          console.log(`[download:${job.id}] finished (${job.status}) in ${(Date.now() - start) / 1000}s`);
        });

      sendJson(res, 202, { jobId: job.id });
    } catch (err) {
      sendJson(res, err instanceof Error && err.message.includes("wajib") ? 400 : 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // POST /api/download/video — buat job video, balik jobId.
  if (req.method === "POST" && url === "/api/download/video") {
    try {
      const body = await parseBody(req);
      const { url: videoUrl, resolution = "720", format = "mp4", outputDir, cookiesFile } = body as Record<string, string>;
      if (!videoUrl || typeof videoUrl !== "string") { sendJson(res, 400, { error: "url wajib (YouTube link)" }); return; }
      if (!isYouTubeUrl(videoUrl)) { sendJson(res, 400, { error: "URL bukan YouTube yang valid" }); return; }
      if (!VIDEO_RESOLUTIONS.has(String(resolution))) { sendJson(res, 400, { error: `resolution tidak valid. Pilih: ${[...VIDEO_RESOLUTIONS].join(", ")}` }); return; }
      if (!VIDEO_FORMATS.has(String(format))) { sendJson(res, 400, { error: "format tidak valid: mp4, webm, mkv" }); return; }
      const resolvedOutputDir = outputDir ? path.resolve(String(outputDir)) : path.resolve(process.cwd(), "output");

      const job = createJob("video", `${videoUrl} -> ${resolution}p ${format}`);
      console.log(`[video:${job.id}] ${videoUrl} -> ${resolution}p ${format}`);
      runVideoJob(job, {
        url: String(videoUrl),
        outputDir: resolvedOutputDir,
        resolution: String(resolution) as VideoResolution,
        format: String(format) as VideoFormat,
        cookiesFile: cookiesFile ? path.resolve(String(cookiesFile)) : undefined,
      }).catch((err) => {
        console.error(`[video:${job.id}] crashed:`, err);
        if (job.status === "running") {
          finishJob(job, "error", { type: "error", error: err instanceof Error ? err.message : String(err) }, { error: String(err) });
        }
      });

      sendJson(res, 202, { jobId: job.id });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ---- /api/fs/* — dukungan folder picker untuk UI end-user ----
  if (segments[0] === "api" && segments[1] === "fs") {
    const HOME = os.homedir();

    // GET /api/fs/list            -> quick places + daftar drive
    // GET /api/fs/list?path=X     -> isi direktori (folder saja)
    if (req.method === "GET" && segments[2] === "list") {
      const parsed = new URL(url, "http://x");
      const target = parsed.searchParams.get("path");

      if (!target) {
        const drives: string[] = [];
        for (let c = 67; c <= 90; c++) { // C..Z
          const letter = `${String.fromCharCode(c)}:\\`;
          try { if (fs.existsSync(letter)) drives.push(letter); } catch { /* skip */ }
        }
        sendJson(res, 200, {
          home: HOME,
          places: [
            { name: "Desktop", path: path.join(HOME, "Desktop") },
            { name: "Documents", path: path.join(HOME, "Documents") },
            { name: "Downloads", path: path.join(HOME, "Downloads") },
            { name: "Music", path: path.join(HOME, "Music") },
          ].filter((p) => { try { return fs.existsSync(p.path); } catch { return false; } }),
          drives,
        });
        return;
      }

      const dir = path.resolve(String(target));
      let stat;
      try { stat = fs.statSync(dir); } catch { sendJson(res, 400, { error: "Folder tidak ditemukan" }); return; }
      if (!stat.isDirectory()) { sendJson(res, 400, { error: "Bukan folder" }); return; }

      let dirs: string[] = [];
      try { dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { /* permission */ }
      dirs.sort((a, b) => a.localeCompare(b, "id", { sensitivity: "base", numeric: true }));
      const parent = path.dirname(dir);
      sendJson(res, 200, {
        path: dir,
        parent: parent !== dir ? parent : null,
        dirs,
      });
      return;
    }

    // POST /api/fs/mkdir  {path, name} -> buat folder baru
    if (req.method === "POST" && segments[2] === "mkdir") {
      try {
        const body = await parseBody(req);
        const base = path.resolve(String(body.path ?? ""));
        const name = String(body.name ?? "").trim();
        if (!name || /[<>:"/\\|?*\u0000-\u001F]/.test(name)) {
          sendJson(res, 400, { error: "Nama folder tidak valid" });
          return;
        }
        const created = path.join(base, name);
        fs.mkdirSync(created, { recursive: false });
        sendJson(res, 200, { ok: true, path: created });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, msg.includes("EEXIST") ? 409 : 500, { error: msg.includes("EEXIST") ? "Folder sudah ada" : msg });
      }
      return;
    }
  }

  // ---- /api/jobs/* ----
  if (segments[0] === "api" && segments[1] === "jobs") {
    // GET /api/jobs — daftar job (live + history persist).
    if (req.method === "GET" && segments.length === 2) {
      sendJson(res, 200, { jobs: listAllJobs() });
      return;
    }
    const job = getJob(segments[2] ?? "");
    if (!job) { sendJson(res, 404, { error: "Job tidak ditemukan" }); return; }

    // GET /api/jobs/:id — snapshot status.
    if (req.method === "GET" && segments.length === 3) {
      sendJson(res, 200, job.snapshot());
      return;
    }
    // GET /api/jobs/:id/events — NDJSON replay + live.
    if (req.method === "GET" && segments[3] === "events") {
      streamJobEvents(res, job);
      return;
    }
    // DELETE /api/jobs/:id — minta pembatalan.
    if (req.method === "DELETE" && segments.length === 3) {
      const ok = cancelJob(job.id);
      sendJson(res, ok ? 200 : 409, { ok, status: job.status });
      return;
    }
  }

  // Route API tak dikenal -> 404 JSON (jangan jatuh ke fallback UI).
  if (segments[0] === "api") {
    sendJson(res, 404, {
      error: "Not found. Endpoints: /api/health, /api/formats, /api/settings, /api/diagnostics, /api/open-path, /api/download, /api/download/video, /api/lyrics, /api/jobs",
    });
    return;
  }

  // Bukan API -> coba serve UI statis (fallback SPA ke index.html).
  if (serveStatic(req, res, url.split("?")[0] ?? "/")) return;

  sendJson(res, 404, { error: "Not found" });
});

// Port dipakai proses lain -> pesan ramah, bukan stack trace.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${PORT} sudah dipakai (app lain atau instance ini dobel). Tutup itu, atau jalankan dengan PORT lain: set PORT=3002 && node dist/server.js`);
    process.exit(1);
  }
  console.error("[server] error:", err);
});

server.listen(PORT, HOST, () => {
  console.log(`Spotify Downloader v${APP_VERSION} -> http://${HOST}:${PORT}`);
  console.log(`  UI  : ${uiIsBuilt() ? "built (web/out)" : "BELUM DI-BUILD - jalankan npm run build:web"}`);
  console.log(`  API : /api/download, /api/download/video, /api/jobs, /api/settings, /api/diagnostics`);
  console.log(`  Data: ${appDataDir()}`);
});

// Graceful shutdown: batalkan semua job (child process ikut dibunuh) lalu keluar.
function shutdown(signal: string) {
  console.log(`[server] ${signal} diterima — membatalkan job & membersihkan child process...`);
  killAllChildren();
  server.close(() => process.exit(0));
  // Fallback kalau koneksi NDJSON membuat close menggantung.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
