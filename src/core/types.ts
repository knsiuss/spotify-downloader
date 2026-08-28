// Definisi tipe inti untuk seluruh pipeline.
// Dari sini semua modul lain ketergantungan — jangan sampai 2 modul definisi tipe sendiri.

/** Track hasil parse metadata Spotify. */
export interface Track {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  /** Durasi dalam detik (dari metadata). */
  durationSec: number;
  trackNumber: number | null;
  coverArtUrl: string | null;
}

/** Kandidat hasil pencarian dari sebuah provider audio. */
export interface Candidate {
  /** ID unik kandidat di provider (video ID / track ID). */
  id: string;
  title: string;
  artist: string;
  /** Durasi dalam detik, untuk pencocokan sama metadata. */
  durationSec: number | null;
  /** URL download langsung atau identitas yang dipakai provider. */
  url: string;
}

/** Format output audio yang didukung. */
export type OutputFormat = "wav" | "flac" | "mp3";

/** Resolusi video YouTube. */
export type VideoResolution = "144" | "240" | "360" | "480" | "720" | "1080" | "1440" | "2160" | "best";
export type VideoFormat = "mp4" | "webm" | "mkv";

/** Hasil fetch lirik. */
export interface LyricsResult {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
  source: string;
}

/** Progress satu file yang sedang didownload (diparse dari output yt-dlp / fetch). */
export interface FileProgress {
  /** Persen 0-100, null kalau total size tidak diketahui. */
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  /** Kecepatan bytes/detik. */
  speedBps: number | null;
  /** Perkiraan sisa waktu detik. */
  etaSec: number | null;
}

/** Context opsional dari engine ke provider (cancel + progress reporting). */
export interface ProviderContext {
  /** Aborted = batalkan download secepatnya (child process ikut dibunuh). */
  signal?: AbortSignal;
  /** Dipanggil berkala selama file berjalan. */
  onProgress?: (p: FileProgress) => void;
}

/** Abstraksi satu sumber audio. Engine tidak boleh tahu detail tiap source. */
export interface Provider {
  name: string;

  /**
   * Urutan prioritas dikala ladder: makin kecil makin dicoba duluan.
   * YouTube = 100 (rendah, reliable). Qobuz = 10 (tinggi, fragile).
   */
  priority: number;

  /**
   * Cari kandidat untuk satu track. Balikan kandidat terbaik dulu.
   * opts.relaxed = pass kedua setelah semua provider no-match — provider boleh
   * memperlebar query (mis. judul saja tanpa artist) supaya peluang match naik.
   */
  search(track: Track, opts?: { relaxed?: boolean }): Promise<Candidate[]>;

  /**
   * Download stream sumber ke file sementara (belum di-mux).
   * Return path absolut file hasil download.
   * ctx bersifat opsional supaya provider lama tetap kompatibel.
   */
  download(candidate: Candidate, workDir: string, ctx?: ProviderContext): Promise<string>;
}

/** Kategori error untuk logging dan retry logic. */
export type ErrorCategory =
  | "network"       // koneksi gagal, timeout, DNS
  | "no-match"      // tidak ada kandidat di atas threshold
  | "rate-limit"    // HTTP 429 / blocked
  | "format"        // file corrupt, codec salah, probe gagal
  | "provider"      // error tak terduga dari provider (yt-dlp crash, API error)
  | "metadata"      // gagal fetch metadata Spotify
  | "auth"          // kredensial salah / expired
  | "cancelled";    // dibatalkan user (tidak pernah di-retry)

/** Error terstruktur — menggantikan raw string. */
export class AppError extends Error {
  constructor(
    message: string,
    public category: ErrorCategory,
    public provider?: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Hasil verifikasi output (dipakai untuk memastikan WAV bukan palsu). */
export interface AudioProbe {
  codecName: string;
  sampleRate: number;
  channels: number;
  bitRate: number;
  formatName: string;
}

/** Hasil pemrosesan satu track. */
export interface DownloadResult {
  track: Track;
  ok: boolean;
  providerUsed: string | null;
  outputPath: string | null;
  error: string | null;
  errorCategory?: ErrorCategory;
  /** True kalau lirik berhasil ditanam ke tag file (USLT/LYRICS). */
  lyricsEmbedded?: boolean;
  /** Apakah lirik instrumental (no lyrics). */
  instrumental?: boolean;
}