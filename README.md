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
2. **Flag yt-dlp cerdas** (disuntikkan terpusat di `src/providers/youtube.ts`): `--force-ipv4`, `--sleep-requests 1.0` (jeda antar request), `--retries` + `--retry-sleep http:exp=1:20` (backoff eksponensial khusus HTTP 429/503).
3. **Cooldown + backoff khusus rate-limit** di level batch (`src/lib/index.ts`) — saat satu lagu kena limit, worker lain ikut mengendur, bukan retry barengan (stampede). Cooldown dasar 30s, maksimum 120s. Error "not a bot" dan 429 diperlakukan sebagai rate-limit juga.

**Knob (opsional):** `DROP_YT_MIN_GAP_MS` (ms) untuk mengatur jeda pacing (default 2000). Lebih besar = lebih aman tapi lebih lambat.

> Kalau punya **cookies YouTube** (`.txt`) atau **akun Qobuz**, stabilitas naik drastis (lihat Konfigurasi).

---

## 🔁 Resume & retry download video

Kegagalan (timeout, `HTTP Error 403/429`, koneksi putus) tidak lagi langsung menggagalkan unduhan:

1. **Retry otomatis** — sampai 3 percobaan per file dengan backoff eksponensial + jitter. Error fatal (video privat/dihapus) tidak diulang.
2. **Resume sungguhan** — tiap percobaan memakai perintah yt-dlp yang identik dengan `--continue`, jadi byte/fragment yang sudah turun (`.part`/`.ytdl`) **dilanjutkan**, bukan diulang dari 0%.
3. **Bukan gagal palsu** — kalau file final sudah lengkap ditulis sebelum proses yt-dlp tewas, unduhan dihitung sukses (dibuktikan: file utuh tapi job tadinya lapor error).
4. **Tanpa proses yatim** — yt-dlp yang dibatalkan/di-timeout dibunuh beserta turunannya (ffmpeg penyebab file terus ditulis setelah job "gagal").
5. **Tombol "Coba lagi"** di kartu yang gagal (single video + playlist yang punya video gagal) — mengirim request yang sama, otomatis melanjutkan dari titik berhenti. Video yang sudah ada di-skip, jadi playlist bisa diulang tanpa mengunduh ulang yang sudah selesai.

Selama percobaan ulang berjalan, kartu menampilkan peringatan “menyambung ulang, percobaan 2/3” supaya tidak terlihat macet.

**Knob (opsional):** `DROP_VIDEO_RETRIES` (jumlah percobaan per file, default 3) dan `DROP_VIDEO_TIMEOUT_MS` (timeout **per percobaan**, default 600000).

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
DROP_YT_MIN_GAP_MS=2000

# Percobaan ulang download video (per file) + timeout per percobaan (ms)
DROP_VIDEO_RETRIES=3
DROP_VIDEO_TIMEOUT_MS=600000
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

## 📦 Kenapa build ini (v0.3.1)

Perbaikan audit + anti rate-limit lanjutan:

- **Fix cover art** - MP3/FLAC tidak di-encode ulang saat menyisipkan cover (`-c:a copy`), dan file temp cover pakai nama unik (tidak saling menimpa antar worker paralel).
- **Fix API input** - `concurrency`/`retries`/`limit` dari body API dipaksa finite + di-clamp; `"abc"` dulu bikin batch berakhir "done" dengan nol file.
- **Fix retry sia-sia** - gagal verifikasi WAV/ffprobe kini dikategorikan `format` (tidak diulang); error fatal yt-dlp ("video unavailable"/"private video") tidak di-retry walau per kategori `provider`.
- **Fix tahap lirik di UI** - status "lirik" punya ikon + style sendiri (sebelumnya tampil seperti queued).
- **Fix riwayat persisten** - membuka job dari `history.json` yang tidak ada di memori server tidak lagi mengubah kartu "done" jadi error HTTP 404.
- **Fix Qobuz** - `getFileUrl` kini ditandatangani (`request_ts` + `request_sig` = MD5 sesuai algoritma web player), login memakai GET + password MD5 (sebelumnya POST plaintext yang bukan format API), token dikirim sebagai header `X-User-Auth-Token`, `app_id` juga disertakan sebagai query param, dan format dicoba berjenjang 27→7→6→5 sesuai tier akun. Provider Qobuz juga kini aktif di mode server (dulu `req.env` kosong sehingga diam-diam tidak terpakai walau diagnostics melaporkan terkonfigurasi).
- **Fix cancel** - membatalkan job saat mengambil metadata Spotify benar-benar berhenti (sebelumnya fetch tanpa signal bisa menggantung forever); semua fetch eksternal sekarang punya timeout keras (Spotify embed/oEmbed 20s, cover 10s, Qobuz 15-300s).
- **Fix report order** - `report.json` berurutan sesuai playlist (sebelumnya urutan selesai, acak).
- **Anti rate-limit v2** - default spawn gap 2000ms (dari 1400), `--force-ipv4`, `--sleep-requests 1.0`, cooldown batch 30s/maksimum 120s, "not a bot" dianggap rate-limit. Kalau masih kena, naikkan `DROP_YT_MIN_GAP_MS` atau pakai cookies.
- **Hardening** - `spawn` eksternal selalu punya error handler (taskkill/explorer/yt-dlp -U) supaya kegagalan spawn tidak jadi uncaught exception; nama folder playlist video di UI = lokasi file sungguhan.

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
