"use client";

import { useState, useEffect, useRef, Fragment } from "react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

// ---------------- Types ----------------

type Tab = "music" | "video";
type RowState = "queued" | "searching" | "downloading" | "transcoding" | "done" | "failed" | "skipped";

interface QueueRow {
  index: number;
  title: string;
  artists: string[];
  durationSec: number | null;
  coverArtUrl: string | null;
  state: RowState;
  percent: number | null;
  speedBps: number | null;
  etaSec: number | null;
  provider: string | null;
  error: string | null;
  hasLyrics: boolean;
  instrumental: boolean;
}

interface VideoInfoLite {
  id: string;
  title: string;
  channel: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

interface HistoryItem {
  id: string;
  kind: Tab;
  status: "running" | "done" | "error" | "cancelled";
  createdAt: number;
  label: string;
  summary?: {
    total?: number;
    succeeded?: number;
    failed?: number;
    skipped?: number;
    reportPath?: string | null;
    outputPath?: string | null;
  } | null;
  error?: string;
}

interface MusicSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
  reportPath?: string | null;
}

type JobStatus = "starting" | "running" | "done" | "error" | "cancelled";

interface JobCard {
  id: string;
  kind: Tab;
  subKind: "single" | "playlist" | "music";
  status: JobStatus;
  createdAt: number;
  label: string;
  // music / playlist common
  playlistName: string;
  playlistCover: string | null;
  sourceType: "playlist" | "album" | "track";
  rows: QueueRow[];
  overall: { completed: number; total: number } | null;
  summary: MusicSummary | { total: number; succeeded: number; failed: number; skipped: number; outputPath?: string | null; reportPath?: string | null } | null;
  jobOutcome: "cancelled" | null;
  destFolder: string | null;
  queueFilter: string;
  /** Daftar video/lagu disembunyikan (collapse) biar kartu nggak mendorong kartu lain ke bawah. */
  collapsed?: boolean;
  // video single
  videoInfo: VideoInfoLite | null;
  videoProgress: { percent: number | null; speedBps: number | null; etaSec: number | null; totalBytes: number | null } | null;
  videoResult: { outputPath: string; skipped: boolean } | null;
  warnings: string[];
  errorMsg: string;
  cancelling: boolean;
  /** Percobaan ulang terakhir (yt-dlp gagal sekali, sedang menyambung dari titik berhenti). */
  retryInfo: { attempt: number; maxAttempts: number; error: string; index?: number } | null;
  /** Parameter request video — dipakai tombol "Coba lagi" untuk resume. */
  request: { url: string; resolution: string; format: string; outputDir: string } | null;
}

// ---------------- Icons ----------------

function Svg({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const IconMusic = ({ size }: { size?: number }) => <Svg size={size}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></Svg>;
const IconVideo = () => <Svg size={15}><polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none" /></Svg>;
const IconSearch = ({ spin }: { spin?: boolean }) => (
  <span className={spin ? "spin" : undefined} style={{ display: "inline-flex" }}>
    <Svg><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Svg>
  </span>
);
const IconDownload = () => <Svg><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></Svg>;
const IconCheck = () => <Svg><polyline points="20 6 9 17 4 12" /></Svg>;
const IconX = () => <Svg><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>;
const IconSkip = () => <Svg><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></Svg>;
const IconWarn = () => <Svg><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Svg>;
const IconStop = () => <Svg size={13}><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" /></Svg>;
const IconLink = () => <Svg><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Svg>;
const IconClock = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></Svg>;
const IconBars = () => <Svg><line x1="6" y1="20" x2="6" y2="12" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="9" /></Svg>;
const IconFolder = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Svg>
);
const IconSun = () => <Svg size={16}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></Svg>;
const IconMoon = () => <Svg size={16}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></Svg>;
const IconChevron = () => <Svg size={14}><polyline points="9 18 15 12 9 6" /></Svg>;
const IconChevronDown = () => <Svg size={14}><polyline points="6 9 12 15 18 9" /></Svg>;
const IconTrash = () => <Svg size={14}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Svg>;

function StatusGlyph({ state }: { state: RowState }) {
  switch (state) {
    case "searching": return <IconSearch spin />;
    case "downloading": return <span className="eq"><span /><span /><span /></span>;
    case "transcoding": return <IconBars />;
    case "done": return <IconCheck />;
    case "failed": return <IconX />;
    case "skipped": return <IconSkip />;
    default: return <IconClock />;
  }
}

// ---------------- Helpers ----------------

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
function fmtSpeed(bps: number | null | undefined): string {
  return bps && bps > 0 ? `${fmtBytes(bps)}/s` : "";
}
function fmtTime(totalSec: number | null | undefined): string {
  if (!totalSec || totalSec <= 0 || !Number.isFinite(totalSec)) return "";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hr lalu`;
}
function pathTail(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}
/** Baris terakhir error yt-dlp (mis. "ERROR: unable to download video data: HTTP Error 403"). */
function lastErrorLine(msg: string): string {
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? msg).slice(0, 120);
}

const SPOTIFY_RE = /(open\.spotify\.com\/(track|album|playlist)|spotify:(track|album|playlist):[A-Za-z0-9]+)/;
const YOUTUBE_RE = /(youtube\.com\/(watch\?v=|shorts\/|embed\/|playlist\?list=)|youtu\.be\/|music\.youtube\.com)/;
const YOUTUBE_PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;

const ALL_FORMATS = ["wav", "flac", "mp3"] as const;

// ---------------- Folder Picker ----------------

interface FsRootInfo {
  home?: string;
  places?: Array<{ name: string; path: string }>;
  drives?: string[];
}
interface FsListing {
  path?: string;
  parent?: string | null;
  dirs?: string[];
}

function FolderPicker({
  open,
  initial,
  onCancel,
  onPick,
}: {
  open: boolean;
  initial: string | null;
  onCancel: () => void;
  onPick: (path: string) => void;
}) {
  const [root, setRoot] = useState<FsRootInfo | null>(null);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState("");

  async function loadRoot(): Promise<FsRootInfo> {
    const r = await (await fetch(`${BACKEND_URL}/api/fs/list`)).json();
    setRoot(r);
    return r;
  }
  const navSeq = useRef(0);
  async function navigate(p: string) {
    const seq = ++navSeq.current;
    setLoading(true);
    setErr("");
    try {
      const r = await (await fetch(`${BACKEND_URL}/api/fs/list?path=${encodeURIComponent(p)}`)).json();
      if (seq !== navSeq.current) return; // respons lama terlambat — abaikan
      if (r.error) setErr(r.error);
      else setListing(r);
    } catch {
      if (seq === navSeq.current) setErr("Tidak bisa membaca folder");
    }
    if (seq === navSeq.current) setLoading(false);
  }

  useEffect(() => {
    if (!open) return;
    setErr(""); setCreating(false); setNewName("");
    (async () => {
      try {
        const r = await loadRoot();
        await navigate(initial ?? r.home ?? "C:\\");
      } catch {
        setErr("Tidak bisa membaca folder");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  async function createFolder() {
    if (!listing?.path || !newName.trim()) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/fs/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: listing.path, name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? "Gagal membuat folder"); return; }
      setCreating(false);
      setNewName("");
      navigate(data.path);
    } catch {
      setErr("Gagal membuat folder");
    }
  }

  const crumbs: Array<{ label: string; path: string }> = [];
  if (listing?.path) {
    const parts = listing.path.split("\\").filter(Boolean);
    let acc = "";
    parts.forEach((part, i) => {
      acc += i === 0 ? part.toUpperCase() + "\\" : part + "\\";
      crumbs.push({ label: i === 0 ? part.replace(":", "") : part, path: acc });
    });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title"><IconFolder /> Pilih folder simpan</div>
          <button className="icon-btn" onClick={onCancel} aria-label="Tutup"><IconX /></button>
        </div>

        {root?.places && root.places.length > 0 && (
          <div className="chips quick-chips">
            {root.places.map((p) => (
              <button key={p.path} className={`chip ${listing?.path === p.path ? "on" : ""}`} onClick={() => navigate(p.path)}>
                {p.name}
              </button>
            ))}
            {root.drives?.map((d) => (
              <button key={d} className={`chip ${listing?.path === d ? "on" : ""}`} onClick={() => navigate(d)}>
                {d.replace("\\", "")}
              </button>
            ))}
          </div>
        )}

        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <button className={`crumb ${i === crumbs.length - 1 ? "last" : ""}`} onClick={() => navigate(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </div>

        <div className="modal-body">
          {loading && <div className="dir-empty"><span className="spinner light" /> Memuat...</div>}
          {!loading && listing?.dirs?.length === 0 && <div className="dir-empty">Folder ini kosong</div>}
          {!loading && listing?.dirs?.map((d) => (
            <button key={d} className="dir-row" onClick={() => navigate(`${listing.path!.replace(/\\$/, "")}\\${d}`)}>
              <span className="dir-icon"><IconFolder /></span>
              <span className="dir-name">{d}</span>
              <span className="dir-go"><IconChevron /></span>
            </button>
          ))}
          {err && <div className="dir-empty err">{err}</div>}
        </div>

        <div className="modal-foot">
          {creating ? (
            <div className="newfolder-row">
              <input
                type="text"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createFolder()}
                placeholder="Nama folder baru"
              />
              <button className="btn tint" type="button" onClick={createFolder}>Buat</button>
              <button className="btn danger-ghost" type="button" onClick={() => setCreating(false)}>Batal</button>
            </div>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={() => setCreating(true)}>
                <IconFolder size={14} /> Folder baru
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn" type="button" disabled={!listing?.path} onClick={() => listing?.path && onPick(listing.path)}>
                Pilih folder ini
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- Page ----------------

export default function Home() {
  const [tab, setTab] = useState<Tab>("music");

  // Theme — default di state awal "light" (SSR-safe); nilai tersimpan diterapkan
  // lewat effect dan HANYA ditulis balik ke localStorage setelah user mengganti.
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const themeTouchedRef = useRef(false);

  // Backend health
  const [healthOk, setHealthOk] = useState<boolean | null>(null);

  // Music form
  const [url, setUrl] = useState("");
  const [formats, setFormats] = useState<Set<string>>(new Set(["wav"]));
  const [limit, setLimit] = useState("");
  const [wantLyrics, setWantLyrics] = useState(true);
  const [outputDir, setOutputDir] = useState("");

  // Video form
  const [videoUrl, setVideoUrl] = useState("");
  const [resolution, setResolution] = useState("720");
  const [videoFormat, setVideoFormat] = useState("mp4");
  const [videoOutputDir, setVideoOutputDir] = useState("");

  // Job cards — stacked tanpa batas
  const [jobs, setJobs] = useState<Map<string, JobCard>>(new Map());
  const [jobOrder, setJobOrder] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState<Tab | null>(null);
  const [, setTick] = useState(0);

  // Shared
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [navView, setNavView] = useState<"download" | "history">("download");
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Folder picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"music" | "video">("music");

  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const terminalsRef = useRef<Map<string, boolean>>(new Map());

  // Unmount: abort semua stream event supaya tidak ada fetch/reader yatim
  // yang terus berjalan dan memanggil setState di komponen yang sudah mati.
  useEffect(() => () => {
    controllersRef.current.forEach((c) => c.abort());
    controllersRef.current.clear();
  }, []);

  // Theme init + apply
  useEffect(() => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    const initial = saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Jangan timpa preferensi tersimpan saat mount (nilai default "light"
    // bisa menghapus "dark" yang tersimpan kalau ditulis sebelum init effect).
    if (themeTouchedRef.current) localStorage.setItem("theme", theme);
  }, [theme]);

  // Health poll
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch(`${BACKEND_URL}/api/health`)
        .then((r) => r.json())
        .then((d) => alive && setHealthOk(Boolean(d?.ok)))
        .catch(() => alive && setHealthOk(false));
    check();
    const t = setInterval(check, 8000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Prefill dari settings tersimpan
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/settings`).then((r) => r.json()).then((s) => {
      if (s.lastOutputDir) setOutputDir(s.lastOutputDir);
      if (s.lastFormats) setFormats(new Set(String(s.lastFormats).split(",").filter((f: string) => ALL_FORMATS.includes(f as any))));
      if (typeof s.lastLyrics === "boolean") setWantLyrics(s.lastLyrics);
      if (s.lastResolution) setResolution(String(s.lastResolution));
      if (s.lastVideoFormat) setVideoFormat(String(s.lastVideoFormat));
    }).catch(() => { /* server offline */ });
  }, []);

  // Riwayat auto-refresh selama halaman riwayat terbuka.
  useEffect(() => {
    if (navView !== "history") return;
    void refreshHistory();
    const t = setInterval(() => void refreshHistory(), 4000);
    return () => clearInterval(t);
  }, [navView]);

  // Drag & drop link
  useEffect(() => {
    function handleLink(text: string | undefined | null) {
      if (!text) return;
      const t = text.trim();
      if (SPOTIFY_RE.test(t)) { setUrl(t); setTab("music"); }
      else if (YOUTUBE_RE.test(t) || YOUTUBE_PLAYLIST_RE.test(t)) { setVideoUrl(t); setTab("video"); }
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      handleLink(e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain"));
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      handleLink(e.clipboardData?.getData("text"));
    };
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  function saveSettings() {
    fetch(`${BACKEND_URL}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lastOutputDir: outputDir || undefined,
        lastFormats: [...formats].join(","),
        lastLyrics: wantLyrics,
        lastResolution: resolution,
        lastVideoFormat: videoFormat,
      }),
    }).catch(() => {});
  }

  // Elapsed ticker untuk semua running jobs.
  // Interval dibuat sekali; cek hasRunning tiap tick supaya interval tidak
  // di-reset terus oleh event progress (yang menyebabkan elapsed macet).
  const hasRunningRef = useRef(false);
  hasRunningRef.current = [...jobs.values()].some((j) => j.status === "running" || j.status === "starting");
  useEffect(() => {
    const t = setInterval(() => {
      if (hasRunningRef.current) setTick((x) => x + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // History awal
  useEffect(() => { void refreshHistory(); }, []);
  async function refreshHistory() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/jobs`);
      const data = await res.json();
      setHistory(Array.isArray(data.jobs) ? data.jobs : []);
    } catch { /* backend offline */ }
  }

  function createJobCard(id: string, kind: Tab): JobCard {
    const isPlaylist = kind === "music" ? false : YOUTUBE_PLAYLIST_RE.test(videoUrl);
    return {
      id,
      kind,
      subKind: kind === "music" ? "music" : isPlaylist ? "playlist" : "single",
      status: "starting",
      createdAt: Date.now(),
      label: kind === "music" ? url.slice(0, 60) : videoUrl.slice(0, 60),
      playlistName: "",
      playlistCover: null,
      sourceType: "playlist",
      rows: [],
      overall: null,
      summary: null,
      jobOutcome: null,
      destFolder: null,
      queueFilter: "",
      videoInfo: null,
      videoProgress: null,
      videoResult: null,
      warnings: [],
      errorMsg: "",
      cancelling: false,
      retryInfo: null,
      request: kind === "video"
        ? { url: videoUrl.trim(), resolution, format: videoFormat, outputDir: videoOutputDir.trim() }
        : null,
    };
  }

  function updateJob(id: string, patch: Partial<JobCard> | ((j: JobCard) => JobCard)) {
    setJobs((prev) => {
      const cur = prev.get(id);
      if (!cur) return prev;
      const next = new Map(prev);
      const updated = typeof patch === "function" ? (patch as any)(cur) : { ...cur, ...patch };
      next.set(id, updated);
      return next;
    });
  }

  function patchRow(jobId: string, index: number, patch: Partial<QueueRow>) {
    setJobs((prev) => {
      const cur = prev.get(jobId);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(jobId, { ...cur, rows: cur.rows.map((r) => (r.index === index ? { ...r, ...patch } : r)) });
      return next;
    });
  }

  function applyEvent(jobId: string, msg: Record<string, any>) {
    const job = jobs.get(jobId);
    // fallback: cari dari map terbaru via setJobs updater - but we use direct state snapshot, need to handle async
    // So we use functional setJobs for each case instead of reading jobs stale
    switch (msg.type) {
      case "start": {
        // video single: {info}
        // music / video-playlist: {total, name, cover, sourceType, folder, tracks, truncated, kind}
        if (msg.info && !msg.tracks) {
          // single video
          setJobs((prev) => {
            const cur = prev.get(jobId);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(jobId, {
              ...cur,
              status: "running",
              retryInfo: null,
              videoInfo: msg.info ? { id: String(msg.info.id ?? ""), title: String(msg.info.title ?? "Video"), channel: String(msg.info.channel ?? ""), durationSec: msg.info.durationSec ?? null, thumbnailUrl: msg.info.thumbnailUrl ?? null } : cur.videoInfo,
              playlistName: msg.info?.title ?? cur.playlistName,
              playlistCover: msg.info?.thumbnailUrl ?? cur.playlistCover,
            });
            return next;
          });
        } else if (msg.tracks) {
          const isVideoPlaylist = msg.kind === "video-playlist";
          setJobs((prev) => {
            const cur = prev.get(jobId);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(jobId, {
              ...cur,
              status: "running",
              playlistName: String(msg.name ?? cur.playlistName),
              playlistCover: msg.cover ?? cur.playlistCover,
              sourceType: msg.sourceType === "album" ? "album" : msg.sourceType === "track" ? "track" : "playlist",
              destFolder: msg.folder ?? cur.destFolder,
              rows: (msg.tracks ?? []).map((t: any, i: number) => ({
                index: i,
                title: t.title,
                artists: t.artists ?? (t.channel ? [t.channel] : []),
                durationSec: t.durationSec ?? null,
                coverArtUrl: t.coverArtUrl ?? t.thumbnailUrl ?? null,
                state: "queued" as RowState,
                percent: null, speedBps: null, etaSec: null,
                provider: null, error: null,
                hasLyrics: false, instrumental: false,
              })),
              overall: { completed: 0, total: Number(msg.total ?? msg.tracks?.length ?? 0) },
              subKind: isVideoPlaylist ? "playlist" : "music",
            });
            if (msg.truncated) {
              const n = new Map(next);
              const j = n.get(jobId)!;
              n.set(jobId, { ...j, warnings: [...j.warnings, "Playlist sangat panjang — hanya 100 lagu pertama yang bisa diambil."] });
              return n;
            }
            return next;
          });
        } else {
          // generic start without tracks (music metadata loading)
          setJobs((prev) => {
            const cur = prev.get(jobId);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(jobId, { ...cur, status: "running", playlistName: String(msg.name ?? cur.playlistName), playlistCover: msg.cover ?? cur.playlistCover });
            return next;
          });
        }
        break;
      }
      case "track_stage":
        patchRow(jobId, Number(msg.index), { state: msg.state });
        break;
      case "track_progress":
        patchRow(jobId, Number(msg.index), {
          state: "downloading",
          percent: typeof msg.percent === "number" ? msg.percent : null,
          speedBps: msg.speedBps ?? null,
          etaSec: msg.etaSec ?? null,
        });
        break;
      case "track": {
        const ok = Boolean(msg.ok);
        const skipped = ok && msg.error === "sudah ada";
        patchRow(jobId, Number(msg.index), {
          state: skipped ? "skipped" : ok ? "done" : "failed",
          provider: msg.provider ?? null,
          error: !ok || skipped ? msg.error : null,
          hasLyrics: Boolean(msg.hasLyrics),
          instrumental: Boolean(msg.instrumental),
        });
        break;
      }
      case "progress":
        updateJob(jobId, (j) => ({ ...j, overall: { completed: Number(msg.completed), total: Number(msg.total) } }));
        break;
      case "video_progress":
        updateJob(jobId, (j) => ({
          ...j,
          status: "running",
          videoProgress: {
            percent: msg.percent ?? null,
            speedBps: msg.speedBps ?? null,
            etaSec: msg.etaSec ?? null,
            totalBytes: msg.totalBytes ?? null,
          },
        }));
        break;
      case "video_retry":
      case "track_retry":
        // Percobaan diulang: tampilkan catatan + dari mana dia menyambung.
        updateJob(jobId, {
          status: "running",
          retryInfo: {
            attempt: Number(msg.attempt ?? 1),
            maxAttempts: Number(msg.maxAttempts ?? 3),
            error: String(msg.error ?? ""),
            index: msg.index !== undefined ? Number(msg.index) : undefined,
          },
        });
        break;
      case "warning":
        updateJob(jobId, (j) => {
          const w = String(msg.message);
          // Dedupe: event replay (reconnect/reopen history) tidak boleh
          // menduplikasi kotak peringatan.
          return j.warnings.includes(w) ? j : { ...j, warnings: [...j.warnings, w] };
        });
        break;
      case "cancelling":
        updateJob(jobId, { cancelling: true });
        break;
      case "cancelled":
        terminalsRef.current.set(jobId, true);
        updateJob(jobId, { status: "cancelled", jobOutcome: "cancelled" });
        void refreshHistory();
        break;
      case "done":
        terminalsRef.current.set(jobId, true);
        setJobs((prev) => {
          const cur = prev.get(jobId);
          if (!cur) return prev;
          const next = new Map(prev);
          // video single vs playlist vs music
          if (cur.kind === "video" && cur.subKind === "single" && !cur.rows.length) {
            next.set(jobId, {
              ...cur,
              status: "done",
              retryInfo: null,
              videoResult: { outputPath: String(msg.outputPath ?? ""), skipped: Boolean(msg.skipped) },
              summary: { outputPath: String(msg.outputPath ?? ""), total: 1, succeeded: msg.skipped ? 0 : 1, failed: 0, skipped: msg.skipped ? 1 : 0 } as any,
            });
          } else if (msg.summary) {
            next.set(jobId, {
              ...cur,
              status: "done",
              retryInfo: null,
              summary: { ...(msg.summary as any), reportPath: (msg as any).reportPath ?? (msg.summary as any)?.reportPath ?? null },
            });
          } else {
            next.set(jobId, { ...cur, status: "done", retryInfo: null });
          }
          return next;
        });
        void refreshHistory();
        break;
      case "error":
        terminalsRef.current.set(jobId, true);
        updateJob(jobId, { status: "error", errorMsg: String(msg.error ?? "Terjadi kesalahan"), retryInfo: null });
        void refreshHistory();
        break;
      default:
        break;
    }
  }

  async function streamEvents(jobId: string, attempt = 0) {
    const ctrl = new AbortController();
    controllersRef.current.set(jobId, ctrl);
    terminalsRef.current.set(jobId, false);
    try {
      const res = await fetch(`${BACKEND_URL}/api/jobs/${jobId}/events`, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try { applyEvent(jobId, JSON.parse(line)); } catch { }
        }
      }
      if (buf.trim()) {
        try { applyEvent(jobId, JSON.parse(buf)); } catch { }
      }
      if (!terminalsRef.current.get(jobId)) {
        if (attempt < 5) {
          await new Promise((r) => setTimeout(r, 1200));
          if (!ctrl.signal.aborted) return streamEvents(jobId, attempt + 1);
        }
        // Stream tertutup bersih tanpa event terminal & retry habis —
        // jangan biarkan card menggantung "running" selamanya.
        updateJob(jobId, { status: "error", errorMsg: "Koneksi ke server terputus" });
      }
    } catch (err) {
      if (!ctrl.signal.aborted && !terminalsRef.current.get(jobId) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1200));
        return streamEvents(jobId, attempt + 1);
      }
      if (!ctrl.signal.aborted) {
        updateJob(jobId, { status: "error", errorMsg: err instanceof Error ? err.message : "Stream terputus" });
      }
    } finally {
      // Hapus controller hanya kalau masih milik invokasi ini — invokasi
      // reconnect sudah mendaftarkan controller barunya, jangan ikut terhapus.
      if (controllersRef.current.get(jobId) === ctrl) controllersRef.current.delete(jobId);
    }
  }

  async function beginJob(jobId: string, kind: Tab) {
    const card = createJobCard(jobId, kind);
    card.status = "running";
    setJobs((prev) => {
      const next = new Map(prev);
      next.set(jobId, card);
      return next;
    });
    setJobOrder((prev) => [jobId, ...prev.filter((id) => id !== jobId)]);
    saveSettings();
    void streamEvents(jobId);
    if (typeof window !== "undefined" && window.innerWidth < 920) {
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    }
  }

  async function submitMusic(e: React.FormEvent) {
    e.preventDefault();
    if (!urlValid || submitting) return;
    setSubmitting("music");
    try {
      const res = await fetch(`${BACKEND_URL}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          formats: [...formats].join(","),
          limit: limit ? Number(limit) : undefined,
          fetchLyrics: wantLyrics,
          outputDir: outputDir.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.jobId) {
        showTempError("music", data?.error ?? `HTTP ${res.status}`);
        return;
      }
      await beginJob(data.jobId, "music");
    } catch {
      showTempError("music", "Server belum jalan. Buka aplikasi lewat start.bat ya.");
    } finally {
      setSubmitting(null);
    }
  }

  function showTempError(kind: Tab, message: string) {
    const tmpId = `err-${Date.now()}`;
    const card = createJobCard(tmpId, kind);
    card.status = "error";
    card.errorMsg = message;
    setJobs((prev) => new Map(prev).set(tmpId, card));
    setJobOrder((prev) => [tmpId, ...prev]);
  }

  /** POST job video + buat kartunya. Return jobId, atau null kalau gagal. */
  async function startVideoJob(params: { url: string; resolution: string; format: string; outputDir: string }): Promise<string | null> {
    setSubmitting("video");
    try {
      const res = await fetch(`${BACKEND_URL}/api/download/video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: params.url,
          resolution: params.resolution,
          format: params.format,
          outputDir: params.outputDir.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.jobId) {
        showTempError("video", data?.error ?? `HTTP ${res.status}`);
        return null;
      }
      await beginJob(data.jobId, "video");
      return data.jobId;
    } catch {
      showTempError("video", "Server belum jalan. Buka aplikasi lewat start.bat ya.");
      return null;
    } finally {
      setSubmitting(null);
    }
  }

  async function submitVideo(e: React.FormEvent) {
    e.preventDefault();
    if (!videoUrlValid || submitting) return;
    await startVideoJob({
      url: videoUrl.trim(),
      resolution,
      format: videoFormat,
      outputDir: videoOutputDir.trim(),
    });
  }

  /**
   * Coba lagi dari kartu yang gagal. Request yang sama dikirim ulang: file yang
   * sudah turun + ".part" dilanjutkan (resume), bukan diunduh dari nol.
   */
  async function retryVideoJob(jobId: string) {
    const job = jobs.get(jobId);
    if (!job?.request || submitting) return;
    dismissJob(jobId);
    await startVideoJob(job.request);
  }

  async function cancelJob(jobId: string) {
    updateJob(jobId, { cancelling: true });
    try {
      const res = await fetch(`${BACKEND_URL}/api/jobs/${jobId}`, { method: "DELETE" });
      // Gagal cancel (server down / job sudah selesai) — reset supaya tombol
      // tidak terjebak "Membatalkan..." selamanya.
      if (!res.ok) updateJob(jobId, { cancelling: false });
    } catch {
      updateJob(jobId, { cancelling: false });
    }
  }

  function dismissJob(jobId: string) {
    controllersRef.current.get(jobId)?.abort();
    controllersRef.current.delete(jobId);
    terminalsRef.current.delete(jobId);
    setJobs((prev) => {
      const next = new Map(prev);
      next.delete(jobId);
      return next;
    });
    setJobOrder((prev) => prev.filter((id) => id !== jobId));
  }

  async function openFolder(p: string | null) {
    if (!p) return;
    try { await fetch(`${BACKEND_URL}/api/open-path`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    }); } catch { }
  }

  async function openHistory(item: HistoryItem) {
    // buka sebagai card replay
    const tmpCard: JobCard = {
      id: item.id,
      kind: item.kind as Tab,
      subKind: item.kind === "music" ? "music" : "single",
      status: item.status === "running" ? "running" : item.status === "done" ? "done" : item.status as any,
      createdAt: item.createdAt,
      label: item.label,
      playlistName: item.label,
      playlistCover: (item as any).meta?.cover ?? null,
      sourceType: "playlist",
      rows: [],
      overall: null,
      summary: item.summary as any,
      jobOutcome: item.status === "cancelled" ? "cancelled" : null,
      destFolder: null,
      queueFilter: "",
      videoInfo: null,
      videoProgress: null,
      videoResult: item.summary?.outputPath ? { outputPath: String(item.summary.outputPath), skipped: Boolean((item.summary as any).skipped) } : null,
      warnings: [],
      errorMsg: item.error ?? "",
      cancelling: false,
      retryInfo: null,
      request: null,
    };
    setJobs((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Map(prev);
      next.set(item.id, tmpCard);
      return next;
    });
    setJobOrder((prev) => (prev.includes(item.id) ? prev : [item.id, ...prev]));
    setNavView("download");
    // Guard: kalau stream live untuk job ini sudah jalan, jangan buka stream
    // kedua — dua consumer paralel menduplikasi event & merusak abort/cancel.
    if (!controllersRef.current.has(item.id)) {
      terminalsRef.current.set(item.id, false);
      void streamEvents(item.id);
    }
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  }

  function toggleFormat(f: string) {
    setFormats((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  function openPicker(target: "music" | "video") {
    setPickerTarget(target);
    setPickerOpen(true);
  }

  // Derived
  const urlValid = SPOTIFY_RE.test(url);
  const videoUrlValid = YOUTUBE_RE.test(videoUrl) || YOUTUBE_PLAYLIST_RE.test(videoUrl);
  const isVideoPlaylist = YOUTUBE_PLAYLIST_RE.test(videoUrl);
  const activeOutputDir = pickerTarget === "music" ? outputDir : videoOutputDir;

  const orderedJobs = jobOrder.map((id) => jobs.get(id)).filter(Boolean) as JobCard[];
  const hasJobs = orderedJobs.length > 0;
  const runningCount = orderedJobs.filter((j) => j.status === "running" || j.status === "starting").length;

  function JobCardView({ job }: { job: JobCard }) {
    const elapsed = job.status === "running" || job.status === "starting" ? Math.floor((Date.now() - job.createdAt) / 1000) : 0;
    const pct = job.overall && job.overall.total > 0 ? Math.round((job.overall.completed / job.overall.total) * 100) : 0;
    const overallEta = job.overall && job.overall.completed > 0 && (job.status === "running") && elapsed > 0
      ? Math.round((elapsed / job.overall.completed) * (job.overall.total - job.overall.completed))
      : null;
    const typeLabel = job.sourceType === "album" ? "Album" : job.sourceType === "track" ? "Lagu" : "Playlist";
    const isMusicOrPlaylist = job.kind === "music" || job.subKind === "playlist";
    const isRunning = job.status === "running" || job.status === "starting";
    const summaryAny = job.summary as any;

    const visibleRows = job.queueFilter
      ? job.rows.filter((r) => `${r.title} ${r.artists.join(" ")}`.toLowerCase().includes(job.queueFilter.trim().toLowerCase()))
      : job.rows;
    const showQueueSearch = job.rows.length >= 10;

    if (isMusicOrPlaylist) {
      const total = job.overall?.total ?? job.rows.length;
      const completed = job.overall?.completed ?? job.rows.filter((r) => r.state === "done" || r.state === "skipped").length;
      const pctLocal = total > 0 ? Math.round((completed / total) * 100) : 0;
      return (
        <div className={`job-card ${isRunning ? "running" : ""} ${job.status}`} style={{ animationDelay: "0ms" }}>
          <div className="job-card-head">
            <div className="hero">
              <div className="hero-art">
                {job.playlistCover
                  ? <img src={job.playlistCover} alt="" referrerPolicy="no-referrer" />
                  : <span className="hero-art-fallback"><IconMusic size={26} /></span>}
              </div>
              <div className="hero-info">
                <span className="hero-kind">{job.kind === "video" ? "Video Playlist" : typeLabel}</span>
                <div className="hero-name" title={job.playlistName || job.label}>{job.playlistName || job.label || "Mengunduh..."}</div>
                <div className="hero-sub">
                  {job.overall ? <>{completed}/{total} {job.kind === "video" ? "video" : "lagu"} selesai</> : `${total} ${job.kind === "video" ? "video" : "lagu"}`}
                  {job.destFolder && <> · ke <b>{pathTail(job.destFolder)}</b></>}
                  {job.jobOutcome === "cancelled" && " · dibatalkan"}
                  {job.status === "done" && summaryAny?.succeeded !== undefined && <> · {summaryAny.succeeded} berhasil</>}
                </div>
              </div>
              <div className="hero-actions">
                <div className={`pct-big ${isRunning ? "pulse" : ""}`}>{pctLocal}<small>%</small></div>
                {isRunning ? (
                  <button type="button" className="btn danger-ghost btn-sm" onClick={() => cancelJob(job.id)} disabled={job.cancelling}>
                    <IconStop /> {job.cancelling ? "Membatalkan..." : "Batalkan"}
                  </button>
                ) : (
                  <>
                    {/* Video yang gagal bisa dilanjutkan: request sama, yang sudah ada diskip + .part dilanjutkan. */}
                    {job.request && (summaryAny?.failed ?? 0) > 0 && (
                      <button type="button" className="btn tint btn-sm" onClick={() => retryVideoJob(job.id)} disabled={submitting !== null}>
                        <IconDownload /> Coba lagi yang gagal ({summaryAny.failed})
                      </button>
                    )}
                    <button type="button" className="icon-btn" onClick={() => dismissJob(job.id)} aria-label="Tutup"><IconX /></button>
                  </>
                )}
              </div>
            </div>
            {(isRunning || job.overall) && (
              <>
                <div className="bar bar--hero"><div className="bar-fill bar-fill--hero" style={{ width: `${pctLocal}%` }} /></div>
                <div className="hero-stats">
                  {elapsed > 0 && isRunning && <span>{fmtTime(elapsed)} berjalan</span>}
                  {overallEta !== null && isRunning && <span>sisa ± {fmtTime(overallEta)}</span>}
                  {job.status === "done" && summaryAny?.durationMs && <span>selesai dalam {fmtTime(summaryAny.durationMs / 1000)}</span>}
                  {job.warnings.length > 0 && <span className="warn-text">{job.warnings[0]}</span>}
                </div>
              </>
            )}
            {job.retryInfo && isRunning && (
              <div className="warn-box">
                <IconWarn />{" "}
                <span>
                  {job.retryInfo.index !== undefined
                    ? `Video "${job.rows[job.retryInfo.index]?.title ?? `#${job.retryInfo.index + 1}`}" gagal sementara (${lastErrorLine(job.retryInfo.error)})`
                    : `Gagal sementara (${lastErrorLine(job.retryInfo.error)})`}
                  {" — "}menyambung ulang, percobaan {job.retryInfo.attempt}/{job.retryInfo.maxAttempts}
                </span>
              </div>
            )}
          </div>

          {job.rows.length === 0 && isRunning && (
            <div className="queue">
              <div className="queue-head">
                <div>
                  <div className="queue-title">Menyiapkan {job.kind === "video" ? "daftar video" : "daftar lagu"}…</div>
                  <div className="queue-sub">Mengambil metadata dari {job.kind === "video" ? "YouTube" : "Spotify"}</div>
                </div>
                <span className="spinner" />
              </div>
              <div className="queue-rows">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div className="qrow" key={i}>
                    <div className="thumb-wrap"><div className="skeleton thumb-skel" /></div>
                    <div className="qbody">
                      <div className="skeleton skel-line" style={{ width: `${58 - (i % 3) * 9}%` }} />
                      <div className="skeleton skel-line skel-sub" style={{ width: `${34 - (i % 2) * 7}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {job.rows.length > 0 && (
            <div className="queue">
              <div className="queue-head">
                <div>
                  <div className="queue-title">{job.kind === "video" ? "Daftar video" : "Daftar lagu"}</div>
                  <div className="queue-sub">
                    {job.collapsed
                      ? `${job.rows.length} ${job.kind === "video" ? "video" : "lagu"} disembunyikan${job.summary ? ` · ${(job.summary as any).succeeded ?? 0} berhasil` : ""}`
                      : visibleRows.length === job.rows.length
                        ? `${job.rows.length} ${job.kind === "video" ? "video" : "lagu"}${job.summary ? ` · ${(job.summary as any).succeeded ?? 0} berhasil` : ""}`
                        : `${visibleRows.length} dari ${job.rows.length}`}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {showQueueSearch && !job.collapsed && (
                    <div className="queue-search">
                      <IconSearch />
                      <input type="text" value={job.queueFilter} onChange={(e) => updateJob(job.id, { queueFilter: e.target.value })} placeholder="Cari..." />
                    </div>
                  )}
                  <button
                    type="button"
                    className="icon-btn queue-toggle"
                    onClick={() => updateJob(job.id, { collapsed: !job.collapsed })}
                    aria-label={job.collapsed ? "Tampilkan daftar" : "Sembunyikan daftar"}
                    title={job.collapsed ? "Tampilkan daftar" : "Sembunyikan daftar"}
                  >
                    <span className={`queue-chevron ${job.collapsed ? "closed" : ""}`}><IconChevronDown /></span>
                  </button>
                </div>
              </div>
              {!job.collapsed && (
                <div className="queue-rows">
                  {visibleRows.map((r, i) => (
                <div key={`${r.index}-${r.title}`} className={`qrow st-${r.state}`} style={{ animationDelay: `${Math.min(i * 22, 280)}ms` }}>
                  <div className={`thumb-wrap st-${r.state}`}>
                    <div className="thumb-fallback"><IconMusic size={16} /></div>
                    {r.coverArtUrl && (
                      <img className="thumb" src={r.coverArtUrl} alt="" loading="lazy" referrerPolicy="no-referrer"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                    )}
                    <span className="thumb-badge">{<StatusGlyph state={r.state} />}</span>
                  </div>
                  <div className="qbody">
                    <div className="qname" title={r.title}>{r.title}</div>
                    <div className="qsub">
                      {r.artists.length > 0 && <span>{r.artists.join(", ")}</span>}
                      {r.durationSec ? <><span className="sep">·</span><span>{fmtTime(r.durationSec)}</span></> : null}
                      {r.state === "downloading" && r.percent !== null && <><span className="sep">·</span><span>{Math.round(r.percent)}%</span></>}
                      {r.state === "downloading" && r.speedBps ? <><span className="sep">·</span><span>{fmtSpeed(r.speedBps)}</span></> : null}
                      {r.state === "downloading" && r.etaSec ? <><span className="sep">·</span><span>sisa {fmtTime(r.etaSec)}</span></> : null}
                      {r.provider && r.state === "done" && <><span className="sep">·</span><span>via {r.provider}</span></>}
                      {r.hasLyrics && <span className="tag accent">lirik</span>}
                      {r.instrumental && <span className="tag info">instrumental</span>}
                      {r.state === "skipped" && <span className="tag warn">sudah ada</span>}
                      {r.state === "failed" && r.error && <span className="err-text" title={r.error}>— {r.error.split("\n")[0]}</span>}
                    </div>
                    {r.state === "downloading" && r.percent !== null && (
                      <div className="minibar"><div className="minibar-fill" style={{ width: `${r.percent}%` }} /></div>
                    )}
                  </div>
                </div>
              ))}
                </div>
              )}
            </div>
          )}

          {job.status === "done" && job.summary && (
            <>
              <div className="summary-box">
                <div className="stat ok"><b>{(job.summary as any).succeeded ?? 0}</b><span>Berhasil</span></div>
                <div className="stat fail"><b>{(job.summary as any).failed ?? 0}</b><span>Gagal</span></div>
                <div className="stat skip"><b>{(job.summary as any).skipped ?? 0}</b><span>Diskip</span></div>
                <div className="stat"><b>{(job.summary as any).total ?? job.rows.length}</b><span>Total</span></div>
              </div>
              {job.destFolder && (
                <div className="dest-row">
                  <span className="dest-icon"><IconFolder /></span>
                  <div className="dest-info">
                    <div className="dest-label">Tersimpan di</div>
                    <div className="dest-path" title={job.destFolder}>{job.destFolder}</div>
                  </div>
                  <button type="button" className="btn ghost" onClick={() => openFolder(job.destFolder!)}>Buka folder</button>
                </div>
              )}
            </>
          )}
          {job.warnings.map((w, i) => (
            <div key={i} className="warn-box"><IconWarn /> <span>{w}</span></div>
          ))}
          {job.errorMsg && <div className="error-box"><IconX /> <span>{job.errorMsg}</span></div>}
        </div>
      );
    }

    // Single video
    return (
      <div className={`job-card ${isRunning ? "running" : ""} ${job.status}`}>
        <div className="job-card-head">
          {job.videoInfo && (
            <div className="video-preview">
              {job.videoInfo.thumbnailUrl && <img className="video-thumb" src={job.videoInfo.thumbnailUrl} alt="" referrerPolicy="no-referrer" />}
              <div className="video-meta">
                <div className="t" title={job.videoInfo.title}>{job.videoInfo.title}</div>
                <div className="s">{[job.videoInfo.channel, fmtTime(job.videoInfo.durationSec ?? null)].filter(Boolean).join(" · ") || "Mengambil info video..."}</div>
              </div>
              <div className="hero-actions">
                {isRunning ? (
                  <button type="button" className="btn danger-ghost btn-sm" onClick={() => cancelJob(job.id)} disabled={job.cancelling}>
                    <IconStop /> {job.cancelling ? "Membatalkan..." : "Batalkan"}
                  </button>
                ) : (
                  <button type="button" className="icon-btn" onClick={() => dismissJob(job.id)} aria-label="Tutup"><IconX /></button>
                )}
              </div>
            </div>
          )}
          {!job.videoInfo && isRunning && (
            <div className="progress-card">
              <div className="progress-top"><span>Menyiapkan video...</span><span className="spinner" /></div>
              <div className="bar indeterminate" />
            </div>
          )}
          {job.videoProgress && !job.videoResult && (
            <div className="progress-card">
              <div className="progress-top">
                <span>{isRunning ? "Mengunduh video" : "Menunggu"}</span>
                <span className="pct">{job.videoProgress.percent !== null ? `${Math.round(job.videoProgress.percent)}%` : "..."}</span>
              </div>
              {job.videoProgress.percent !== null ? (
                <div className="bar bar--video"><div className="bar-fill bar-fill--video" style={{ width: `${job.videoProgress.percent}%` }} /></div>
              ) : (
                <div className="bar indeterminate" />
              )}
              <div className="hero-stats">
                {job.videoProgress.speedBps ? <span>{fmtSpeed(job.videoProgress.speedBps)}</span> : null}
                {job.videoProgress.etaSec ? <span>sisa ± {fmtTime(job.videoProgress.etaSec)}</span> : null}
                {job.videoProgress.totalBytes ? <span>{fmtBytes(job.videoProgress.totalBytes)}</span> : null}
                {job.cancelling && <span>Membatalkan...</span>}
                {elapsed > 0 && <span>{fmtTime(elapsed)} berjalan</span>}
              </div>
            </div>
          )}
          {job.retryInfo && isRunning && (
            <div className="warn-box">
              <IconWarn />{" "}
              <span>
                Gagal sementara ({lastErrorLine(job.retryInfo.error)}) — menyambung ulang, percobaan {job.retryInfo.attempt}/{job.retryInfo.maxAttempts}
              </span>
            </div>
          )}
          {job.videoResult && (
            <div className="queue">
              <div className="queue-head">
                <div>
                  <div className="queue-title">{job.videoResult.skipped ? "Video sudah pernah diunduh" : "Video selesai diunduh"}</div>
                  <div className="queue-sub" title={job.videoResult.outputPath}>{job.videoResult.outputPath}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn ghost" onClick={() => job.videoResult?.outputPath && openFolder(job.videoResult.outputPath)}>Buka folder</button>
                  <button type="button" className="icon-btn" onClick={() => dismissJob(job.id)} aria-label="Tutup"><IconX /></button>
                </div>
              </div>
            </div>
          )}
          {job.errorMsg && <div className="error-box"><IconX /> <span>{job.errorMsg}</span></div>}
          {job.status === "error" && job.request && (
            <div className="dest-row">
              <span className="dest-icon"><IconDownload /></span>
              <div className="dest-info">
                <div className="dest-label">Unduhan berhenti</div>
                <div className="dest-path">Bagian yang sudah turun tetap disimpan — "Coba lagi" melanjutkan dari titik terakhir, bukan dari nol.</div>
              </div>
              <button type="button" className="btn tint" onClick={() => retryVideoJob(job.id)} disabled={submitting !== null}>
                Coba lagi
              </button>
            </div>
          )}
          {job.warnings.map((w, i) => (
            <div key={i} className="warn-box"><IconWarn /> <span>{w}</span></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"><IconMusic size={16} /></span>
            <span className="brand-name">DROP</span>
          </div>
          <nav className="topnav" aria-label="Navigasi utama">
            <button className={navView === "download" ? "on" : ""} onClick={() => setNavView("download")}>
              Unduh
            </button>
            <button className={navView === "history" ? "on" : ""} onClick={() => setNavView("history")}>
              Riwayat
              {(history.some((h) => h.status === "running") || runningCount > 0) && <span className="nav-pulse" />}
            </button>
          </nav>
          <div className="topbar-right">
            <div className="backend-badge">
              <span className={`dot ${healthOk === null ? "wait" : healthOk ? "ok" : "bad"}`} />
              {healthOk === null ? "Memeriksa..." : healthOk ? "Siap" : "Offline"}
            </div>
            <button className="icon-btn" onClick={() => { themeTouchedRef.current = true; setTheme(theme === "dark" ? "light" : "dark"); }} aria-label="Ganti tema">
              {theme === "dark" ? <IconSun /> : <IconMoon />}
            </button>
          </div>
        </div>
      </div>

      {navView === "history" ? (
        <div className="history-view">
          <div className="history-hero">
            <h2>Riwayat unduhan</h2>
            <p>Semua aktivitas download di komputermu, tersimpan otomatis.</p>
          </div>
          {history.length === 0 && (
            <div className="empty-state">
              <div className="empty-art">
                <span className="empty-note"><IconClock size={30} /></span>
              </div>
              <h3>Belum ada riwayat</h3>
              <p className="history-empty-hint">Mulai download pertamamu dari halaman Unduh.</p>
              <button type="button" className="btn tint" onClick={() => setNavView("download")}>Mulai unduh</button>
            </div>
          )}
          {history.map((h) => {
            const s: any = h.summary ?? {};
            const folder = s.reportPath ? dirname(s.reportPath) : s.outputPath ? dirname(s.outputPath) : null;
            const statusText = h.status === "done" ? "Selesai" : h.status === "error" ? "Gagal" : h.status === "cancelled" ? "Dibatalkan" : "Sedang berjalan";
            return (
              <div key={h.id} className="hrow" onClick={() => openHistory(h)} role="button" tabIndex={0}>
                <span className={`tag ${h.kind === "music" ? "accent" : "info"}`}>{h.kind === "music" ? "musik" : "video"}</span>
                <span className={`hrow-dot ${h.status}`}>
                  {h.status === "done" ? <IconCheck /> : h.status === "error" ? <IconX /> : <span className={`dot ${h.status === "cancelled" ? "wait" : "ok"}`} />}
                </span>
                <div className="hrow-main">
                  <div className="hrow-label" title={h.label}>{h.label}</div>
                  <div className="hrow-sub">
                    <span className={`hrow-status ${h.status}`}>{statusText}</span>
                    <span className="sep">·</span>
                    <span>{fmtAgo(h.createdAt)}</span>
                    {s.total ? <><span className="sep">·</span><span>{s.succeeded ?? 0}/{s.total} {h.kind === "video" && s.total === 1 ? "video" : "lagu"}</span></> : null}
                    {h.status === "running" && <span className="tag accent">berlangsung</span>}
                  </div>
                </div>
                {folder && (
                  <button type="button" className="btn ghost hrow-open" onClick={(e) => { e.stopPropagation(); void openFolder(folder); }}>
                    Buka folder
                  </button>
                )}
                <span className="dir-go"><IconChevron /></span>
              </div>
            );
          })}
        </div>
      ) : (
      <>
      <div className="layout">
        <div className="col-form">
      <div className="tabs">
        <button className={`tab ${tab === "music" ? "active" : ""}`} onClick={() => setTab("music")}>
          <IconMusic size={15} /> Musik
        </button>
        <button className={`tab ${tab === "video" ? "active" : ""}`} onClick={() => setTab("video")}>
          <IconVideo /> Video
        </button>
      </div>

      {tab === "music" && (
        <form onSubmit={submitMusic} className="card">
          <div className="field">
            <label className="label">Tempel link Spotify di sini <span className="hint">bisa playlist, album, atau satu lagu</span></label>
            <div className="input-wrap has-icon">
              <IconLink />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://open.spotify.com/playlist/..."
                className={url.length > 0 && !urlValid ? "input-error" : ""}
              />
            </div>
            {url.length > 0 && !urlValid && <div className="inline-hint">Link belum benar — salin link dari aplikasi Spotify (menu Share → Copy Link).</div>}
          </div>

          <div className="form-row">
            <div className="field">
              <label className="label">Format file</label>
              <div className="chips">
                {ALL_FORMATS.map((f) => (
                  <button type="button" key={f} className={`chip ${formats.has(f) ? "on" : ""}`}
                    onClick={() => toggleFormat(f)}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">Jumlah lagu <span className="hint">kosongkan untuk semua</span></label>
              <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)}
                placeholder="Semua" />
            </div>
          </div>

          <div className="field">
            <label className="label">Lirik lagu</label>
            <div className={`switch-row`} onClick={() => setWantLyrics((v) => !v)} role="switch" aria-checked={wantLyrics}>
              <span className="switch-text">
                Tanam lirik ke dalam file
                <small>tersimpan di tag lagu — tanpa file terpisah, tampil di foobar/MusicBee/pemutar HP</small>
              </span>
              <span className={`switch ${wantLyrics ? "on" : ""}`} />
            </div>
          </div>

          <div className="field">
            <label className="label">Simpan di folder</label>
            <div className="target-box">
              <span className="target-icon"><IconFolder /></span>
              <div className="target-info">
                <div className="target-name">{outputDir ? pathTail(outputDir) : "Musik (default)"}</div>
                <div className="target-path">{outputDir || "otomatis di folder aplikasi"}</div>
              </div>
              <button type="button" className="btn ghost" onClick={() => openPicker("music")}>
                Jelajahi...
              </button>
            </div>
          </div>

          <div className="actions">
            <button type="submit" className="btn primary" disabled={!urlValid || formats.size === 0 || submitting === "music"}>
              {submitting === "music" ? <><span className="spinner" /> Memulai...</> : <><IconDownload /> Download musik</>}
            </button>
          </div>
          {runningCount > 0 && <div className="inline-hint" style={{ marginTop: 10 }}>{runningCount} unduhan berjalan — kamu bisa tambah lagi tanpa menunggu.</div>}
        </form>
      )}

      {tab === "video" && (
        <form onSubmit={submitVideo} className="card">
          <div className="field">
            <label className="label">Tempel link YouTube <span className="hint">video, shorts, atau playlist</span></label>
            <div className="input-wrap has-icon">
              <IconLink />
              <input type="text" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... atau playlist?list=..."
                className={videoUrl.length > 0 && !videoUrlValid ? "input-error" : ""} />
            </div>
            {videoUrl.length > 0 && !videoUrlValid && <div className="inline-hint">Link YouTube belum benar.</div>}
            {isVideoPlaylist && videoUrlValid && <div className="inline-hint" style={{ color: "var(--accent-deep)" }}>Playlist terdeteksi — semua video akan di-download berurutan.</div>}
          </div>

          <div className="field">
            <label className="label">Kualitas video</label>
            <div className="chips">
              {["144", "240", "360", "480", "720", "1080", "1440", "2160", "best"].map((r) => (
                <button type="button" key={r} className={`chip ${resolution === r ? "on" : ""}`}
                  onClick={() => setResolution(r)}>
                  {r === "best" ? "Terbaik" : `${r}p`}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label">Jenis file</label>
            <div className="chips">
              {["mp4", "webm", "mkv"].map((f) => (
                <button type="button" key={f} className={`chip ${videoFormat === f ? "on" : ""}`}
                  onClick={() => setVideoFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label">Simpan di folder</label>
            <div className="target-box">
              <span className="target-icon"><IconFolder /></span>
              <div className="target-info">
                <div className="target-name">{videoOutputDir ? pathTail(videoOutputDir) : "Video (default)"}</div>
                <div className="target-path">{videoOutputDir || "otomatis di folder aplikasi"}</div>
              </div>
              <button type="button" className="btn ghost" onClick={() => openPicker("video")}>
                Jelajahi...
              </button>
            </div>
          </div>

          <div className="actions">
            <button type="submit" className="btn primary" disabled={!videoUrlValid || submitting === "video"}>
              {submitting === "video" ? <><span className="spinner" /> Memulai...</> : <><IconDownload /> {isVideoPlaylist ? "Download playlist" : "Download video"}</>}
            </button>
          </div>
          {runningCount > 0 && <div className="inline-hint" style={{ marginTop: 10 }}>{runningCount} unduhan berjalan — tambah lagi? Bisa!</div>}
        </form>
      )}
        </div>

        <div className="col-results" ref={resultsRef}>
      {hasJobs ? (
        <>
          {runningCount > 0 && (
            <div className="active-banner">
              <span className="dot ok" /> {runningCount} unduhan aktif — kamu bisa mulai unduhan baru tanpa menunggu
            </div>
          )}
          <div className="job-stack">
            {orderedJobs.map((job) => (
              // Dipanggil sebagai fungsi render (bukan <JobCardView/>) supaya
              // tipe elemen stabil antar update progress — tanpa ini, setiap
              // event progress me-remount seluruh card dan animasi CSS
              // entrance (rise/fade) diputar ulang → UI tampak glitch/kedip.
              <Fragment key={job.id}>{JobCardView({ job })}</Fragment>
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <div className="empty-art">
            <span className="empty-note"><IconMusic size={30} /></span>
            <span className="empty-arrow"><IconDownload /></span>
          </div>
          <h3>Belum ada unduhan</h3>
          <div className="steps">
            <div className="step"><span className="step-num">1</span><span>Buka Spotify atau YouTube, salin link lagu / playlist</span></div>
            <div className="step"><span className="step-num">2</span><span>Tempel di panel kiri, pilih format & kualitas</span></div>
            <div className="step"><span className="step-num">3</span><span>Klik download — tambah sebanyak mau, semua jalan paralel</span></div>
          </div>
        </div>
      )}
        </div>
      </div>
      </>
      )}

      <div className="footer">
        DROP berjalan lokal di komputermu · tarik-lepas atau tempel link di mana saja · tanpa batas antrian
      </div>

      <FolderPicker
        open={pickerOpen}
        initial={activeOutputDir || null}
        onCancel={() => setPickerOpen(false)}
        onPick={(p) => {
          if (pickerTarget === "music") setOutputDir(p);
          else setVideoOutputDir(p);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
