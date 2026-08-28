"use client";

import { useState, useEffect, useRef } from "react";

// Kosong = same-origin (UI diserve oleh backend sendiri — satu port).
// Untuk pengembangan UI terpisah (next dev di :3000), set
// NEXT_PUBLIC_BACKEND_URL=http://localhost:3001 di web/.env.local.
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

// ---------------- Icons (feather-style, no emoji) ----------------

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

const SPOTIFY_RE = /(open\.spotify\.com\/(track|album|playlist)|spotify:(track|album|playlist):[A-Za-z0-9]+)/;
const YOUTUBE_RE = /(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com)/;

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
  async function navigate(p: string) {
    setLoading(true);
    setErr("");
    try {
      const r = await (await fetch(`${BACKEND_URL}/api/fs/list?path=${encodeURIComponent(p)}`)).json();
      if (r.error) setErr(r.error);
      else setListing(r);
    } catch {
      setErr("Tidak bisa membaca folder");
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!open) return;
    setErr(""); setCreating(false); setNewName("");
    (async () => {
      const r = await loadRoot();
      navigate(initial ?? r.home ?? "C:\\");
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

  // Breadcrumb segments dari path Windows.
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

  // Theme
  const [theme, setTheme] = useState<"light" | "dark">("light");

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

  // Active job state
  const [phase, setPhase] = useState<"idle" | "starting" | "running">("idle");
  const [viewKind, setViewKind] = useState<Tab>("music");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [, setTick] = useState(0);

  // Music live state
  const [playlistName, setPlaylistName] = useState("");
  const [playlistCover, setPlaylistCover] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<"playlist" | "album" | "track">("playlist");
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [overall, setOverall] = useState<{ completed: number; total: number } | null>(null);
  const [summary, setSummary] = useState<MusicSummary | null>(null);
  const [jobOutcome, setJobOutcome] = useState<"cancelled" | null>(null);

  // Video live state
  const [videoInfo, setVideoInfo] = useState<VideoInfoLite | null>(null);
  const [videoProgress, setVideoProgress] = useState<{ percent: number | null; speedBps: number | null; etaSec: number | null; totalBytes: number | null } | null>(null);
  const [videoResult, setVideoResult] = useState<{ outputPath: string; skipped: boolean } | null>(null);

  // Shared
  const [warnings, setWarnings] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [destFolder, setDestFolder] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState("");
  const [navView, setNavView] = useState<"download" | "history">("download");
  const resultsRef = useRef<HTMLDivElement | null>(null);
  // Reconnect stream: true setelah event terminal diterima.
  const terminalRef = useRef(false);

  // Folder picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"music" | "video">("music");

  const startedAtRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Ref supaya event handler selalu membaca kind terbaru (hindari stale closure).
  const kindRef = useRef<Tab>("music");

  // Theme init + apply
  useEffect(() => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    const initial = saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
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

  // Prefill dari settings tersimpan (server-side, bertahan lintas restart)
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

  // Drag & drop link ke mana saja + paste global (di luar input) -> auto-isi form
  useEffect(() => {
    function handleLink(text: string | undefined | null) {
      if (!text) return;
      const t = text.trim();
      if (SPOTIFY_RE.test(t)) { setUrl(t); setTab("music"); }
      else if (YOUTUBE_RE.test(t)) { setVideoUrl(t); setTab("video"); }
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      handleLink(e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain"));
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return; // jangan curi paste di input
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

  // Elapsed ticker selama job jalan
  useEffect(() => {
    if (phase !== "running") return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // History awal
  useEffect(() => { void refreshHistory(); }, []);
  async function refreshHistory() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/jobs`);
      const data = await res.json();
      setHistory(Array.isArray(data.jobs) ? data.jobs : []);
    } catch { /* backend offline */ }
  }

  /** Reset semua state tampilan untuk job baru / history yang dibuka lagi. */
  function resetViewState(kind: Tab) {
    streamAbortRef.current?.abort();
    kindRef.current = kind;
    setViewKind(kind);
    setRows([]);
    setOverall(null);
    setSummary(null);
    setJobOutcome(null);
    setPlaylistCover(null);
    setSourceType("playlist");
    setVideoInfo(null);
    setVideoProgress(null);
    setVideoResult(null);
    setWarnings([]);
    setErrorMsg("");
    setCancelling(false);
    setPlaylistName("");
    setDestFolder(null);
    setQueueFilter("");
  }

  /** Update satu baris queue berdasarkan index (immutable). */
  function patchRow(index: number, patch: Partial<QueueRow>) {
    setRows((prev) => prev.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  }

  function applyEvent(msg: Record<string, any>) {
    const kind = kindRef.current;
    switch (msg.type) {
      case "start": {
        if (kind === "music") {
          setPlaylistName(String(msg.name ?? ""));
          setPlaylistCover(msg.cover ?? null);
          setSourceType(msg.sourceType === "album" ? "album" : msg.sourceType === "track" ? "track" : "playlist");
          setDestFolder(msg.folder ?? null);
          setRows(
            (msg.tracks ?? []).map((t: any, i: number) => ({
              index: i,
              title: t.title,
              artists: t.artists ?? [],
              durationSec: t.durationSec ?? null,
              coverArtUrl: t.coverArtUrl ?? null,
              state: "queued" as RowState,
              percent: null, speedBps: null, etaSec: null,
              provider: null, error: null,
              hasLyrics: false, instrumental: false,
            })),
          );
          setOverall({ completed: 0, total: Number(msg.total ?? msg.tracks?.length ?? 0) });
          if (msg.truncated) setWarnings((w) => [...w, "Playlist sangat panjang — hanya 100 lagu pertama yang bisa diambil."]);
        } else {
          if (msg.info) setVideoInfo(msg.info);
          else setVideoInfo({ id: "", title: "Menyiapkan...", channel: "", durationSec: null, thumbnailUrl: null });
        }
        break;
      }
      case "track_stage":
        patchRow(Number(msg.index), { state: msg.state });
        break;
      case "track_progress":
        patchRow(Number(msg.index), {
          state: "downloading",
          percent: typeof msg.percent === "number" ? msg.percent : null,
          speedBps: msg.speedBps ?? null,
          etaSec: msg.etaSec ?? null,
        });
        break;
      case "track": {
        const ok = Boolean(msg.ok);
        const skipped = ok && msg.error === "sudah ada";
        patchRow(Number(msg.index), {
          state: skipped ? "skipped" : ok ? "done" : "failed",
          provider: msg.provider ?? null,
          error: !ok || skipped ? msg.error : null,
          hasLyrics: Boolean(msg.hasLyrics),
          instrumental: Boolean(msg.instrumental),
        });
        break;
      }
      case "progress":
        setOverall({ completed: Number(msg.completed), total: Number(msg.total) });
        break;
      case "video_progress":
        setVideoProgress({
          percent: msg.percent ?? null,
          speedBps: msg.speedBps ?? null,
          etaSec: msg.etaSec ?? null,
          totalBytes: msg.totalBytes ?? null,
        });
        break;
      case "warning":
        setWarnings((w) => [...w, String(msg.message)]);
        break;
      case "cancelling":
        setCancelling(true);
        break;
      case "cancelled":
        setJobOutcome("cancelled");
        terminalRef.current = true;
        finishActiveJob();
        break;
      case "done":
        if (kind === "music") setSummary({ ...(msg.summary ?? {}), reportPath: msg.reportPath ?? null });
        else setVideoResult({ outputPath: String(msg.outputPath ?? ""), skipped: Boolean(msg.skipped) });
        terminalRef.current = true;
        finishActiveJob();
        break;
      case "error":
        setErrorMsg(String(msg.error ?? "Terjadi kesalahan"));
        terminalRef.current = true;
        finishActiveJob();
        break;
      default:
        break; // ping & lainnya diabaikan
    }
  }

  function finishActiveJob() {
    setPhase("idle");
    void refreshHistory();
  }

  /** Buka stream event NDJSON untuk satu job; auto-reconnect kalau putus di tengah jalan. */
  async function streamEvents(jobId: string, attempt = 0) {
    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;
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
          try { applyEvent(JSON.parse(line)); } catch { /* baris rusak dilewati */ }
        }
      }
      if (buf.trim()) {
        try { applyEvent(JSON.parse(buf)); } catch { /* abaikan */ }
      }
      // Stream tutup tanpa terminal = server restart / koneksi putus.
      // Buffer event ada di server, jadi reconnect cukup untuk replay semuanya.
      if (!terminalRef.current && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1200));
        if (!ctrl.signal.aborted) return streamEvents(jobId, attempt + 1);
      }
    } catch (err) {
      if (!ctrl.signal.aborted && !terminalRef.current && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1200));
        return streamEvents(jobId, attempt + 1);
      }
      if (!ctrl.signal.aborted) {
        setErrorMsg(err instanceof Error ? err.message : "Stream terputus dari backend");
        finishActiveJob();
      }
    }
  }

  async function beginJob(jobId: string, kind: Tab) {
    resetViewState(kind);
    terminalRef.current = false;
    setActiveJobId(jobId);
    setPhase("running");
    startedAtRef.current = Date.now();
    saveSettings();
    void streamEvents(jobId);
    // Di layar sempit, hasil muncul di bawah form — araskan panduan ke sana.
    if (window.innerWidth < 920) {
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    }
  }

  async function submitMusic(e: React.FormEvent) {
    e.preventDefault();
    if (!urlValid || busy) return;
    setPhase("starting");
    setErrorMsg("");
    setTab("music");
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
        setErrorMsg(data?.error ?? `HTTP ${res.status}`);
        setPhase("idle");
        return;
      }
      await beginJob(data.jobId, "music");
    } catch {
      setErrorMsg("Server belum jalan. Buka aplikasi lewat start.bat ya.");
      setPhase("idle");
    }
  }

  async function submitVideo(e: React.FormEvent) {
    e.preventDefault();
    if (!videoUrlValid || busy) return;
    setPhase("starting");
    setErrorMsg("");
    setTab("video");
    try {
      const res = await fetch(`${BACKEND_URL}/api/download/video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: videoUrl.trim(),
          resolution,
          format: videoFormat,
          outputDir: videoOutputDir.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.jobId) {
        setErrorMsg(data?.error ?? `HTTP ${res.status}`);
        setPhase("idle");
        return;
      }
      await beginJob(data.jobId, "video");
    } catch {
      setErrorMsg("Server belum jalan. Buka aplikasi lewat start.bat ya.");
      setPhase("idle");
    }
  }

  async function cancelJob() {
    if (!activeJobId) return;
    setCancelling(true);
    try {
      await fetch(`${BACKEND_URL}/api/jobs/${activeJobId}`, { method: "DELETE" });
      // Event "cancelling"/"cancelled" akan datang lewat stream.
    } catch { /* stream akan menangani */ }
  }

  async function openFolder(p: string | null) {
    if (!p) return;
    try { await fetch(`${BACKEND_URL}/api/open-path`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    }); } catch { /* diam */ }
  }

  /** Buka job lama dari history (replay buffer event). */
  async function openHistory(item: HistoryItem) {
    resetViewState(item.kind);
    setTab(item.kind);
    setActiveJobId(item.id);
    setPhase(item.status === "running" ? "running" : "idle");
    startedAtRef.current = Date.now();
    void streamEvents(item.id);
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
  const videoUrlValid = YOUTUBE_RE.test(videoUrl);
  const busy = phase === "starting" || phase === "running";

  const elapsed = busy && startedAtRef.current ? Math.floor((Date.now() - startedAtRef.current) / 1000) : 0;
  const pct = overall && overall.total > 0 ? Math.round((overall.completed / overall.total) * 100) : 0;
  const overallEta =
    overall && overall.completed > 0 && busy && elapsed > 0
      ? Math.round((elapsed / overall.completed) * (overall.total - overall.completed))
      : null;

  const activeOutputDir = pickerTarget === "music" ? outputDir : videoOutputDir;
  const typeLabel = sourceType === "album" ? "Album" : sourceType === "track" ? "Lagu" : "Playlist";

  const visibleRows = queueFilter
    ? rows.filter((r) => `${r.title} ${r.artists.join(" ")}`.toLowerCase().includes(queueFilter.trim().toLowerCase()))
    : rows;
  const showQueueSearch = rows.length >= 10;
  const hasResults = viewKind === "music" ? (rows.length > 0 || playlistName) : Boolean(videoInfo || videoProgress || videoResult);

  return (
    <div className="container">
      {/* Top bar ala Apple: brand kiri, navigasi tengah, kontrol kanan */}
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"><IconMusic size={16} /></span>
            <span className="brand-name">Spotify Downloader</span>
          </div>
          <nav className="topnav" aria-label="Navigasi utama">
            <button className={navView === "download" ? "on" : ""} onClick={() => setNavView("download")}>
              Unduh
            </button>
            <button className={navView === "history" ? "on" : ""} onClick={() => setNavView("history")}>
              Riwayat
              {history.some((h) => h.status === "running") && <span className="nav-pulse" />}
            </button>
          </nav>
          <div className="topbar-right">
            <div className="backend-badge">
              <span className={`dot ${healthOk === null ? "wait" : healthOk ? "ok" : "bad"}`} />
              {healthOk === null ? "Memeriksa..." : healthOk ? "Siap" : "Offline"}
            </div>
            <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Ganti tema">
              {theme === "dark" ? <IconSun /> : <IconMoon />}
            </button>
          </div>
        </div>
      </div>

      {navView === "history" ? (
        /* ---------- HALAMAN RIWAYAT ---------- */
        <div className="history-view">
          <div className="history-hero">
            <h2>Riwayat unduhan</h2>
            <p>Semua aktivitas download di komputer ini, tersimpan otomatis.</p>
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
            const s = h.summary ?? {};
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
                    {s.total ? <><span className="sep">·</span><span>{s.succeeded ?? 0}/{s.total} lagu</span></> : null}
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
      {/* Layout dua kolom: form kiri, hasil kanan (stack di layar sempit) */}
      <div className="layout">
        <div className="col-form">
      {/* Tabs */}
      <div className="tabs">
        <button className={`tab ${tab === "music" ? "active" : ""}`} onClick={() => setTab("music")} disabled={busy}>
          <IconMusic size={15} /> Musik
        </button>
        <button className={`tab ${tab === "video" ? "active" : ""}`} onClick={() => setTab("video")} disabled={busy}>
          <IconVideo /> Video
        </button>
      </div>

      {/* ---------- FORM MUSIC ---------- */}
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
                disabled={busy}
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
                    onClick={() => toggleFormat(f)} disabled={busy}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">Jumlah lagu <span className="hint">kosongkan untuk semua</span></label>
              <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)}
                placeholder="Semua" disabled={busy} />
            </div>
          </div>

          <div className="field">
            <label className="label">Lirik lagu</label>
            <div className={`switch-row`} onClick={() => !busy && setWantLyrics((v) => !v)} role="switch" aria-checked={wantLyrics}>
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
              <button type="button" className="btn ghost" onClick={() => openPicker("music")} disabled={busy}>
                Jelajahi...
              </button>
            </div>
          </div>

          <div className="actions">
            <button type="submit" className="btn" disabled={busy || !urlValid || formats.size === 0}>
              {busy && viewKind === "music"
                ? <><span className="spinner" /> Mengunduh{overall ? ` ${overall.completed}/${overall.total}` : "..."}{elapsed > 0 ? ` · ${fmtTime(elapsed)}` : ""}</>
                : <><IconDownload /> Download musik</>}
            </button>
            {busy && activeJobId && viewKind === "music" && (
              <button type="button" className="btn danger-ghost" onClick={cancelJob} disabled={cancelling}>
                <IconStop /> {cancelling ? "Membatalkan..." : "Batalkan"}
              </button>
            )}
          </div>
        </form>
      )}

      {/* ---------- FORM VIDEO ---------- */}
      {tab === "video" && (
        <form onSubmit={submitVideo} className="card">
          <div className="field">
            <label className="label">Tempel link YouTube <span className="hint">video biasa atau shorts</span></label>
            <div className="input-wrap has-icon">
              <IconLink />
              <input type="text" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                disabled={busy}
                className={videoUrl.length > 0 && !videoUrlValid ? "input-error" : ""} />
            </div>
            {videoUrl.length > 0 && !videoUrlValid && <div className="inline-hint">Link YouTube belum benar.</div>}
          </div>

          <div className="field">
            <label className="label">Kualitas video</label>
            <div className="chips">
              {["144", "240", "360", "480", "720", "1080", "1440", "2160", "best"].map((r) => (
                <button type="button" key={r} className={`chip ${resolution === r ? "on" : ""}`}
                  onClick={() => setResolution(r)} disabled={busy}>
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
                  onClick={() => setVideoFormat(f)} disabled={busy}>
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
                <div className="target-name">{videoOutputDir ? pathTail(videoOutputDir) : "Musik (default)"}</div>
                <div className="target-path">{videoOutputDir || "otomatis di folder aplikasi"}</div>
              </div>
              <button type="button" className="btn ghost" onClick={() => openPicker("video")} disabled={busy}>
                Jelajahi...
              </button>
            </div>
          </div>

          <div className="actions">
            <button type="submit" className="btn" disabled={busy || !videoUrlValid}>
              {busy && viewKind === "video"
                ? <><span className="spinner" /> Mengunduh video{elapsed > 0 ? ` · ${fmtTime(elapsed)}` : ""}</>
                : <><IconDownload /> Download video</>}
            </button>
            {busy && activeJobId && viewKind === "video" && (
              <button type="button" className="btn danger-ghost" onClick={cancelJob} disabled={cancelling}>
                <IconStop /> {cancelling ? "Membatalkan..." : "Batalkan"}
              </button>
            )}
          </div>
        </form>
      )}
        </div>

        <div className="col-results" ref={resultsRef}>
      {/* ---------- PANEL HASIL ---------- */}
      {hasResults ? (
        <>
          {/* Hero + progress keseluruhan */}
          {viewKind === "music" && overall && (
            <div className="progress-card">
              <div className="hero">
                <div className="hero-art">
                  {playlistCover
                    ? <img src={playlistCover} alt="" referrerPolicy="no-referrer" />
                    : <span className="hero-art-fallback"><IconMusic size={26} /></span>}
                </div>
                <div className="hero-info">
                  <span className="hero-kind">{typeLabel}</span>
                  <div className="hero-name">{playlistName || "Mengunduh..."}</div>
                  <div className="hero-sub">
                    {overall.completed}/{overall.total} lagu selesai
                    {destFolder && <> · ke folder <b>{pathTail(destFolder)}</b></>}
                    {jobOutcome === "cancelled" && " · dibatalkan"}
                  </div>
                </div>
                <div className="pct-big">{pct}<small>%</small></div>
              </div>
              <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
              <div className="hero-stats">
                {elapsed > 0 && <span>{fmtTime(elapsed)} berjalan</span>}
                {overallEta !== null && <span>sisa ± {fmtTime(overallEta)}</span>}
                {summary && <span>selesai dalam {fmtTime(summary.durationMs / 1000)}</span>}
              </div>
            </div>
          )}

          {/* Video preview + progress */}
          {viewKind === "video" && videoInfo && (
            <div className="video-preview">
              {videoInfo.thumbnailUrl && <img className="video-thumb" src={videoInfo.thumbnailUrl} alt="" referrerPolicy="no-referrer" />}
              <div className="video-meta">
                <div className="t">{videoInfo.title}</div>
                <div className="s">
                  {[videoInfo.channel, fmtTime(videoInfo.durationSec ?? null)].filter(Boolean).join(" · ") ||
                    "Mengambil info video..."}
                </div>
              </div>
            </div>
          )}
          {viewKind === "video" && videoProgress && !videoResult && (
            <div className="progress-card">
              <div className="progress-top">
                <span>Mengunduh video</span>
                <span className="pct">{videoProgress.percent !== null ? `${Math.round(videoProgress.percent)}%` : "..."}</span>
              </div>
              {videoProgress.percent !== null ? (
                <div className="bar"><div className="bar-fill" style={{ width: `${videoProgress.percent}%` }} /></div>
              ) : (
                <div className="bar indeterminate" />
              )}
              <div className="hero-stats">
                {videoProgress.speedBps ? <span>{fmtSpeed(videoProgress.speedBps)}</span> : null}
                {videoProgress.etaSec ? <span>sisa ± {fmtTime(videoProgress.etaSec)}</span> : null}
                {videoProgress.totalBytes ? <span>{fmtBytes(videoProgress.totalBytes)}</span> : null}
                {cancelling && <span>Membatalkan...</span>}
              </div>
            </div>
          )}
          {viewKind === "video" && videoResult && (
            <div className="queue">
              <div className="queue-head">
                <div>
                  <div className="queue-title">{videoResult.skipped ? "Video sudah pernah diunduh" : "Video selesai diunduh"}</div>
                  <div className="queue-sub">{videoResult.outputPath}</div>
                </div>
                <button type="button" className="btn ghost" onClick={() => videoResult.outputPath && openFolder(videoResult.outputPath)}>
                  Buka folder
                </button>
              </div>
            </div>
          )}

          {/* Queue rows */}
          {viewKind === "music" && rows.length > 0 && (
            <div className="queue">
              <div className="queue-head">
                <div>
                  <div className="queue-title">Daftar lagu</div>
                  <div className="queue-sub">
                    {visibleRows.length === rows.length
                      ? `${rows.length} lagu${summary ? ` · ${summary.succeeded} berhasil` : ""}`
                      : `${visibleRows.length} dari ${rows.length} lagu`}
                  </div>
                </div>
                {showQueueSearch && (
                  <div className="queue-search">
                    <IconSearch />
                    <input
                      type="text"
                      value={queueFilter}
                      onChange={(e) => setQueueFilter(e.target.value)}
                      placeholder="Cari lagu..."
                    />
                  </div>
                )}
              </div>
              {visibleRows.map((r, i) => (
                <div key={`${r.index}-${r.title}`} className="qrow" style={{ animationDelay: `${Math.min(i * 25, 250)}ms` }}>
                  {/* Cover + status overlay */}
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
                      {r.state === "downloading" && r.percent !== null && (
                        <><span className="sep">·</span><span>{Math.round(r.percent)}%</span></>
                      )}
                      {r.state === "downloading" && r.speedBps ? <><span className="sep">·</span><span>{fmtSpeed(r.speedBps)}</span></> : null}
                      {r.state === "downloading" && r.etaSec ? <><span className="sep">·</span><span>sisa {fmtTime(r.etaSec)}</span></> : null}
                      {r.provider && r.state === "done" && (
                        <><span className="sep">·</span><span>via {r.provider}</span></>
                      )}
                      {r.hasLyrics && <span className="tag accent">lirik</span>}
                      {r.instrumental && <span className="tag info">instrumental</span>}
                      {r.state === "skipped" && <span className="tag warn">sudah ada</span>}
                      {r.state === "failed" && r.error && (
                        <span className="err-text" title={r.error}>— {r.error.split("\n")[0]}</span>
                      )}
                    </div>
                    {r.state === "downloading" && r.percent !== null && (
                      <div className="minibar"><div className="minibar-fill" style={{ width: `${r.percent}%` }} /></div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Summary */}
          {viewKind === "music" && summary && (
            <>
              <div className="summary-box">
                <div className="stat ok"><b>{summary.succeeded}</b><span>Berhasil</span></div>
                <div className="stat fail"><b>{summary.failed}</b><span>Gagal</span></div>
                <div className="stat skip"><b>{summary.skipped}</b><span>Diskip</span></div>
                <div className="stat"><b>{summary.total}</b><span>Total</span></div>
              </div>
              {destFolder && (
                <div className="dest-row">
                  <span className="dest-icon"><IconFolder /></span>
                  <div className="dest-info">
                    <div className="dest-label">Tersimpan di</div>
                    <div className="dest-path" title={destFolder}>{destFolder}</div>
                  </div>
                  <button type="button" className="btn ghost" onClick={() => openFolder(destFolder)}>
                    Buka folder
                  </button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        /* Empty state: panduan singkat untuk user baru */
        !busy && (
          <div className="empty-state">
            <div className="empty-art">
              <span className="empty-note"><IconMusic size={30} /></span>
              <span className="empty-arrow"><IconDownload /></span>
            </div>
            <h3>Belum ada unduhan</h3>
            <div className="steps">
              <div className="step"><span className="step-num">1</span><span>Buka Spotify atau YouTube, salin link lagu / playlist</span></div>
              <div className="step"><span className="step-num">2</span><span>Tempel di panel sebelah kiri, pilih format</span></div>
              <div className="step"><span className="step-num">3</span><span>Klik download — file rapi per playlist, lengkap cover & lirik</span></div>
            </div>
          </div>
        )
      )}

      {/* Warnings & errors */}
      {warnings.map((w, i) => (
        <div key={i} className="warn-box"><IconWarn /> <span>{w}</span></div>
      ))}
      {errorMsg && <div className="error-box"><IconX /> <span>{errorMsg}</span></div>}
        </div>
      </div>
      </>
      )}

      <div className="footer">
        Semua berjalan lokal di komputermu · tarik-lepas atau tempel link di mana saja
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
