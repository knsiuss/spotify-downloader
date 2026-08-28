# PRD — Spotify Downloader (WAV/FLAC/MP3)

> Status: **Draft v1** — 19 Agu 2026
> Milestone: MVP CLI telah berjalan end-to-end (metadata → match → download → mux → verifikasi).
> Bahasa: Indonesia dengan istilah teknis English.

---

## 1. Ringkasan Produk

Aplikasi yang menerima **link playlist/album/track Spotify** dan men-download audionya menjadi
**file WAV asli (raw PCM s16le)** — plus FLAC & MP3 — **tanpa akun Spotify sama sekali**.

Link Spotify hanya dipakai sebagai **sumber metadata** (judul, artist, album, durasi). Audio
di-cari dari **provider eksternal** dengan kualitas terbaik yang tersedia, lalu di-decode ke PCM
di app sendiri dan di-mux ke format target. Verifikasi wajib: file WAV harus menunjukkan
`codec_name=pcm_s16le` (bukan MP3 dalam container WAV).

Target akhir: **desktop app + mobile app** dari satu codebase.

---

## 2. Problem Statement

| | |
|---|---|
| **User yang dituju** | Orang yang mau punya koleksi lagu offline dalam format edit/DJ-friendly (WAV lossless container), dari playlist Spotify kesayangannya |
| **Masalah utama** | Ingin WAV *benar* dari playlist, tapi (a) tidak punya/harus pakai akun Spotify, (b) kebanyakan tool cuma bungkus MP3 jadi `.wav` (PALSU), (c) solusi lossless existing (librespot/zotify) butuh akun + melanggar ToS + di-free cuma 160kbps |
| **Kenapa layak dibangun** | Pola ini terbukti di spotDL (25.8k stars); Sunnify existing (Python) sudah 90% jalur yang sama tapi tidak punya matching engine & provider ladder yang robust |

## 3. Goals / Non-Goals

**Goals**
1. Output **WAV asli pcm_s16le** yang terverifikasi (non-negotiable).
2. **Tanpa akun Spotify** — link cukup.
3. Multi-format dari satu pipeline: WAV + FLAC + MP3.
4. Batch download playlist/album dengan resume & skip file yang sudah ada.
5. Satu codebase menyasar desktop dulu, mobile menyusul.

**Non-Goals (fase ini)**
- Tidak meng-klaim "WAV lossless dari Spotify" (tidak mungkin tanpa akun/sumber resmi).
- Tidak menjadi Spotify client (play/pause/queue streaming).
- Tidak menyasar integer/byte-level perfect yang membuang waktu tanpa manfaat user.
- Tidak menyelesaikan masalah "sumber lossless yang stabil" — dikelola via provider ladder, bukan satu sumber tunggal.

---

## 4. Persona & Use Case

**Persona utama — "Ani, Editor Konten Amatir"**
- Mempunyai playlist Spotify panjang (100–500 lagu).
- Butuh WAV untuk dipotong/edit di DAW atau DJ software.
- Tidak mau akun Spotify (ToS/ban), tidak mau ribet dengan cookies.
- Ekspektasi: tempel link → keluar folder berisi lagu. Kalau ada yang gagal, minta daftarnya.

**Use case utama (Model: MATCH)**
```
User menempel link Spotify (playlist/album/track)
→ App scrape metadata (tanpa login)
→ Untuk tiap track: cari kandidat di provider (urutan kualitas)
→ Skor match (title+artist normalized, durasi ±3s, album)
→ Ambil sumber terbaik → decode ke PCM di app → mux WAV/FLAC/MP3
→ Verifikasi codec → simpan + report
```

---

## 5. Requirement Fungsional

### FR-1 Metadata input (tanpa login)
- **FR-1.1** Terima input: URL `open.spotify.com/{playlist|album|track}/<id>`, URI `spotify:{type}:<id>`, atau track list manual.
- **FR-1.2** Ambil: title, artist(s), album, durasi, track number, cover art.
- **FR-1.3** Batasan terverifikasi: embed endpoint render hingga ~100 track per playlist. Playlist lebih panjang butuh pagination (lihat FR-1.4).
- **FR-1.4** *(future)* Pagination/source alternatif (API internal anonymous) untuk playlist >100 track.

### FR-2 Matching engine
- **FR-2.1** Normalisasi: lowercase, buang punctuation/noise ("Official Video", "Lyrics", "(ft. X)").
- **FR-2.2** Strip nama artist dari judul kandidat sebelum discore.
- **FR-2.3** Skor: similarity title (containment + token Dice + Levenshtein) + artist + durasi ±3s + album boost. Threshold default 0.8.
- **FR-2.4** Provider berurutan dari kualitas terbaik → terandalkan (quality ladder). Yang gagal dicoba palang sampai ada match atau habis.

### FR-3 Provider plugins
Interface seragam per sumber: `search(track) → candidates[]`, `download(candidate) → file`, `priority`.
- **FR-3.1** **YouTube via yt-dlp** (priority 100, lantai ladder): paling reliable, gratis, tanpa akun. Kualitas Opus 48k stereo dari mweb client.
- **FR-3.2** **Qobuz** (priority 10, puncak ladder): FLAC lossless 16/24-bit. Butuh kredensial `.env` (`QOBUZ_APP_ID/SECRET/EMAIL/PASSWORD`). Fragile — gagal = turun ke provider berikut.
- **FR-3.3** Provider baru bisa ditambah tanpa mengubah engine (tambal satu modul).

### FR-4 Download & pipeline audio
- **FR-4.1** Satu download → satu decode ke PCM → mux ke semua format yang diminta (tanpa encode ulang lossy berganda).
- **FR-4.2** Parameter WAV wajib: `pcm_s16le`, 44100 Hz, stereo. (FLAC & MP3 256k dari PCM yang sama.)
- **FR-4.3** **Verifikasi wajib output**: probe header → WAV harus `pcm_s16le`, kalau tidak → buang & tandai gagal.
- **FR-4.4** Skip file yang sudah ada (per track, semua format terpenuhi → skip).
- **FR-4.5** Kerja di temp dir, hasil pindah ke output dir hanya setelah sukses.
- **FR-4.6** Concurrency terkendali (mulai serial; paralel 2–4 sebagai opsi nanti, batasi untuk free-tier API).
- **FR-4.7** ✅ **Metadata lengkap tertanam** (selesai 26 Agu 2026): title, artist, album, album artist, track no/total
  di semua format (RIFF INFO untuk WAV via ffmpeg, ID3 untuk MP3, Vorbis untuk FLAC) + **cover art embedded**:
  MP3 (APIC), FLAC (METADATA_BLOCK_PICTURE), dan WAV via chunk `id3 ` yang ditulis manual
  (`src/audio/tags.ts` `writeWavId3`, tanpa dependency) karena muxer WAV ffmpeg menolak video stream.
  Tag bersih: `-map_metadata -1` (tag sampah dari sumber tidak ikut).

### FR-5 Batch & report
- **FR-5.1** Summary per batch: berhasil/gagal/ETA.
- **FR-5.2** Daftar track gagal + alasan (no match, source error, WAV-palsu, rate limit).
- **FR-5.3** Satu track gagal tidak membatalkan batch.

### FR-6 CLI (fase saat ini)
- Flags: `-u <url>`, `-o <dir>` (default `./output`), `-f <formats>` (default `wav`), `-c <cookies.txt>` (opsional, jalur cadangan jika 403), `-n <limit>`.
- Baca config `.env` (Qobuz credentials, `YT_COOKIES`).

---

## 6. Requirement Non-Fungsional

| Kode | Requirement |
|---|---|
| **NFR-1** | **Zero-config YouTube**: pada mesin user, app harus auto-menyiapkan PO-token solver (plugin `yt-dlp-getpot-wpc` + `yt-dlp-ejs` + plain JS runtime) — tidak boleh mewajibkan user memahami cookies. Saat ini: setup manual sekali lewat installer/`init` script. |
| **NFR-2** | WAV selalu benar. Kalau ragu, gagal lebih baik daripada menyimpan WAV palsu. |
| **NFR-3** | Ketahanan provider: matinya satu sumber tidak boleh menghentikan batch (ladder + error per provider). |
| **NFR-4** | Performa: throughput > real-time (wajar untuk stream lossy). Progress & ETA per track wajib tampil. |
| **NFR-5** | Storage awareness: tampilkan perkiraan ukuran & gunakan FLAC jika user khawatir ruang (WAV 10.09 MB/menit). |
| **NFR-6** | Privasi: kredensial Qobuz hanya di `.env` lokal / keychain app; tidak pernah log/commit. |
| **NFR-7** | Bahasa kode & komentar: Inggris untuk istilah teknis; dokumen/UI ke pengguna Indonesia-friendly. |

---

## 7. Arsitektur (ringkas)

```
Input Spotify link
   │
   ▼
[Spotify Metadata]  scrape embed page (__NEXT_DATA__) → Track[]
   │
   ▼
[Matching Engine]   per-track: gemuruh provider → skor → kandidat terbaik
   │
   ├──▶ Provider Qobuz  (FLAC lossless, priority 10, butuh .env)
   ├──▶ Provider YouTube (Opus 48k, priority 100, yt-dlp + PO-token)
   │
   ▼
[Pipeline]  download → decode FFmpeg → mux WAV/FLAC/MP3 → probe verifikasi
   ▼
[Output dir]  artist - title.{wav,flac,mp3}   (+ report gagal)
```

Stack: **TypeScript/Node ≥22**, FFmpeg + ffprobe eksternal, yt-dlp eksternal (dibundel saat desktop packaging). Tanpa framework UI untuk fase CLI.

---

## 8. Definisi Sukses (verifikasi)

1. `ffprobe output.wav` → `codec_name=pcm_s16le`, `sample_rate=44100`, `channels=2`, `bit_rate=1411200`. *(diterapkan otomatis sebagai test saat runtime)*
2. Playlist 50-track real mendownload ≥95% tanpa akun Spotify, tanpa intervensi manual selain input link.
3. Satu sumber mati (disimulasikan) → track dialihkan otomatis ke provider berikutnya, batch tetap selesai.
4. Re-run batch yang sama → track yang sudah ada diskip (tidak ada download ulang).

---

## 9. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| YouTube ubah proteksi (siapapun kena) | 403/DRM | Provider ladder (Qobuz dsb), cadangan cookies, update terjadwal yt-dlp + PO-token tool |
| Qobuz API unofficial mati | Hilangnya sumber lossless | Plugin terisolasi; turun ke YouTube otomatis |
| Spotify ubah struktur embed page | Metadata gagal | Unit test golden-file; fallback endpoint (oEmbed) |
| Ukuran WAV besar (10 MB/mnt) | Storage mobile | Peringatan ukuran, opsi FLAC, batas storage check |
| Legal/grey area | Distribusi toko app | Distribusi sideload; disclaimer; JANGAN label produk sebagai alat pembajakan |
| PO-token tooling butuh install | User non-teknis gagal setup | Installer app yang mengurus setup ini otomatis (NFR-1) |

---

## 10. Scope Fase

| Fase | Isi | Status |
|---|---|---|
| **Phase 0 (sekarang)** | CLI TypeScript: metadata → match → YouTube download (zero-config PO-token) → WAV/FLAC/MP3 → verifikasi; Qobuz scaffold | ✅ Berjalan |
| **Phase 1** | Batch robust: resume penuh, concurrency 2–4, report file, ~~cover art tag (ID3/INFO)~~ ✅ selesai (FR-4.7, termasuk cover di WAV), golden-file test, refactor CLI→domain API | 🔶 Sebagian |
| **Phase 1.5** | ✅ Web UI end-user: job-based API (cancel, resume event stream), live queue + album art, folder picker native, metadata lengkap, dark/light theme | ✅ Selesai 26 Agu 2026 |
| **Phase 1.75** | ✅ Siap-bundling: satu proses satu port (static export diserve backend), bind 127.0.0.1 + Origin guard, binary resolver + diagnostik, persistensi settings/history ke %APPDATA%, graceful shutdown + child process tracking, auto-reconnect stream, file logging, buka-folder, drag-drop/paste, matching fix (artist-di-judul + pass relaxed) | ✅ Selesai 26 Agu 2026 |
| **Phase 2** | Provider matang: Qobuz live (butuh kredensial test), provider ke-3 (Deezer/YT Music), pagination playlist >100 | ⬜ |
| **Phase 3** | Desktop app (Tauri/Electron) + installer yang auto-setup PO-token & bundling yt-dlp/ffmpeg | ⬜ |
| **Phase 4** | Mobile (Android dulu — realistis; iOS evaluasi core Rust/Chaquopy) | ⬜ |

---

## 11. Pertanyaan Terbuka (butuh keputusan user)

1. Setuju WAV dari YouTube (Opus 48k → PCM) dianggap "WAV asli"? → **Sudah disetujui** ("wav dari yt juga bisa").
2. Kredensial Qobuz test — punya akun Qobuz?
3. Desktop app: Tauri (Rust, kecil) atau Electron (matang)? Keputusan riset awal condong Tauri 2.
4. Mobile: wajib di fase ini atau cukup risiko desain core yang mobile-friendly?