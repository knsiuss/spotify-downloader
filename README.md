# DROP — Media Downloader

Aplikasi desktop (lokal) untuk mengunduh **lagu dari link Spotify** dan **video dari YouTube** menjadi **WAV / FLAC / MP3** (+ video **MP4 / WEBM / MKV**) — **tanpa akun Spotify**, data & proses jalan sepenuhnya di komputermu.

> ⚠️ **Disclaimer.** Ini proyek pribadi/edukasi. Link Spotify hanya dipakai sebagai **sumber metadata** (judul, artist, album, durasi). Audio dicari dari provider pihak ketiga (YouTube/SoundCloud/Qobuz). Hormati hak cipta & ToS layanan terkait; gunakan untuk koleksi pribadi yang legal.

---

## ✨ Fitur

- **Tempel link → auto unduh.** Dukungan playlist / album / track Spotify, dan video / shorts / playlist YouTube.
- **WAV asli terverifikasi** (`pcm_s16le`, 44100 Hz, stereo) — bukan MP3 yang dibungkus `.wav`. FLAC & MP3 di-mux dari PCM yang sama.
- **Metadata + cover + lirik** tertanam di dalam file (ID3/RIFF/Vorbis) — tanpa file sampah terpisah.
- **Multi-job paralel**: bisa menjalankan banyak unduhan sekaligus, tiap job punya kartu progres sendiri (progress per lagu, speed, ETA).
- **Provider ladder**: Qobuz (lossless, opsional) → YouTube → SoundCloud; kalau satu sumber gagal, otomatis turun ke sumber berikutnya. Satu track gagal **tidak** membatalkan batch.
- **Anti rate-limit**: pacing + retry cerdas (lihat bagian di bawah).
- **Tema terang/gelap** ala Apple, folder picker, drag-drop / paste link, riwayat unduhan.
- **Offline & privat**: UI + API + download jadi satu server lokal, hanya bind ke `127.0.0.1`.

---

## 🚀 Cara pakai (untuk pengguna)

**Paling mudah — pakai installer:**
1. Jalankan `release/DROP Setup 0.3.0.exe` (installer Windows, per-user, tanpa perlu admin).
2. Buka aplikasi **DROP** dari Start Menu / shortcut Desktop.
3. Tempel link Spotify / YouTube → pilih format → Download.

**Alternatif tanpa install (portable):**
- Jalankan langsung `release/win-unpacked/DROP.exe`.

> Menjalankan via shortcut menyiapkan server internal + UI secara otomatis. Kalau muncul pesan "Server internal gagal start", lihat log di `%APPDATA%\spotify-downloader\logs`.

---

## 🛠️ Cara build / develop (untuk pengembang)

**Prasyarat:** Node.js ≥ 22, plus binary di folder `bin/` (sudah dibundel): `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`.

```bash
# 1. Install dependency (root)
npm install

# 2. Build backend (tsc → dist/ + tulis dist/package.json) + UI (Next static → web/out)
npm run build

# 3a. Jalankan versi web (buka browser otomatis ke http://127.0.0.1:3001)
start.bat
#    atau manual: node dist/server.js

# 3b. Jalankan shell desktop Electron (mode dev, pakai ../dist + ../web/out)
cd desktop && npm run dev

# (opsional) dev UI dengan hot reload
cd web && npm run dev
```

**Bundle aplikasi desktop (installer + portable):**
```bash
npm run build                                   # pastikan dist/ + web/out terbaru
cd desktop && npx electron-builder --win nsis    # output ke folder release/
```

**Test & typecheck:**
```bash
npm run typecheck
npm test
```

---

## 🛡️ Anti rate-limit (inti build v0.3.0)

Tanpa cookies/akun, menembak YouTube terlalu cepat akan memicu `429` / “Sign in to confirm you're not a bot”. Mitigasinya (terpasang otomatis):

1. **Pacing gate global** — jeda minimum + jitter antar peluncuran proses yt-dlp, lintas semua worker paralel, supaya tidak menembak bersamaan.
2. **Flag yt-dlp cerdas** (disuntikkan terpusat di `src/providers/youtube.ts`): `--sleep-requests` (jeda antar request), `--retries` + `--retry-sleep http:exp=1:20` (backoff eksponensial khusus HTTP 429/503).
3. **Cooldown + backoff khusus rate-limit** di level batch (`src/lib/index.ts`) — saat satu lagu kena limit, worker lain ikut mengendur, bukan retry barengan (stampede).

**Knob (opsional):** `DROP_YT_MIN_GAP_MS` (ms) untuk mengatur jeda pacing (default 1400). Lebih besar = lebih aman tapi lebih lambat.

> Kalau punya **cookies YouTube** (`.txt`) atau **akun Qobuz**, stabilitas naik drastis (lihat Konfigurasi).

---

## ⚙️ Konfigurasi (`.env`, opsional)

```
# Qobuz lossless (opsional) — kalau ada, jadi sumber paling atas di quality ladder
QOBUZ_APP_ID=...
QOBUZ_APP_SECRET=...
QOBUZ_EMAIL=...
QOBUZ_PASSWORD=...

# Cookies YouTube (opsional) — kurangi 403/rate-limit
YT_COOKIES=./cookies.txt

# Jeda minimum antar spawn yt-dlp (ms)
DROP_YT_MIN_GAP_MS=1400
```

---

## 🧱 Arsitektur (ringkas)

```
Tempel link
   │
   ▼
[Metadata Spotify]  scrape embed publik (__NEXT_DATA__) — tanpa login
   │                (fallback oEmbed untuk track tunggal)
   ▼
[Provider ladder]   Qobuz (lossless, opsional) → YouTube (yt-dlp) → SoundCloud (yt-dlp)
   │                tiap track: cari kandidat → skor match → pilih terbaik
   ▼
[Pipeline]          download (yt-dlp) → transcode (ffmpeg) → mux WAV/FLAC/MP3
   │                → verifikasi WAV (pcm_s16le) → tanam metadata/cover/lirik
   ▼
[Output]            output/<artist - title>.{wav,flac,mp3}  + report.json
```

Stack: **TypeScript / Node ≥ 22** untuk backend & pipeline, **Next.js (static export)** untuk UI, **Electron** sebagai shell desktop tipis, `yt-dlp` + `ffmpeg` sebagai binary eksternal (di-bundel di `bin/`). Detail produk ada di `PRD.md`.

```
├── src/                 # backend: server, pipeline, providers, metadata, lyrics, audio
│   ├── server.ts        # API + penyaji UI statis (satu proses, satu port)
│   ├── core/            # pipeline per-track + matching
│   ├── providers/       # youtube, soundcloud, qobuz
│   ├── metadata/        # scrape Spotify
│   ├── lyrics/          # lirik (LRCLIB)
│   ├── audio/           # ffmpeg, tags, verifikasi WAV
│   └── lib/             # jobs, settings, report, binaries...
├── web/                 # UI Next.js (client), di-export statis ke web/out
├── desktop/             # shell Electron (main.js spawn server lokal)
├── bin/                 # yt-dlp.exe, ffmpeg.exe, ffprobe.exe (dibundel)
├── scripts/             # helper build (mis. write-server-pkg.mjs)
└── release/             # output bundling (installer + portable) — tidak masuk git
```

---

## 🐞 ⚠️ Catatan packaging (penting!)

`dist/server.js` adalah **ES module**. Saat ter-paket dan dijalankan **di luar folder project** (mis. `C:\Users\<kamu>\Programs\DROP\`), Node mencari `package.json` bernilai `"type":"module"` di direktori di atasnya. Karena itu, `scripts/write-server-pkg.mjs` **wajib** menulis `dist/package.json` saat build (langkah ini ada di `npm run build`). Kalau hilang/dihilangkan, server internal gagal start dengan `SyntaxError: Cannot use import statement outside a module`.

---

## 📦 Kenapa build ini (v0.3.0)

Ringkasan perubahan yang masuk di rilis ini:

- **Fix rate-limit** — pacing gate + flag retry yt-dlp + cooldown khusus rate-limit di batch.
- **Fix bug** — progres snapshot job musik yang tadinya selalu `0` (indikator "completed" tidak ter-update).
- **Polish UI (ala Apple)** — tombol aksi utama lebih menonjol, skeleton loading, focus ring keyboard.
- **Fix packaging fatal** — penanda ESM (`dist/package.json`) supaya server internal app ter-install bisa start (penyebab banyak error "Server internal gagal start").
- **Fitur** — unduhan playlist YouTube + kartu job paralel tanpa batas.

---

_Build lokal & pribadi. Gunakan secara bertanggung jawab._
