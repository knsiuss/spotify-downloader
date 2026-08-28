# Handoff: Riset & Rencana Spotify Downloader → WAV (untuk agent berikutnya)

> Dibuat: 19 Agu 2026 — supaya agent baru langsung paham konteks tanpa harus baca semua percakapan.
> Bacaan utama: `RESEARCH-REAL-WAV-ARCHITECTURE.md` (di folder yang sama, 14 section, lengkap dengan diagram Mermaid).

---

## 1. Lokasi & Status Project

| Path | Isi |
|---|---|
| `C:\project\spotify downloader\` | **Folder kerja project ini** (baru, masih kosong kecuali dokumen riset + handoff ini) |
| `C:\project\spotify downloader\RESEARCH-REAL-WAV-ARCHITECTURE.md` | Dokumentasi riset lengkap (14 section). `docs\RESEARCH-...` di repo lain = salinan lama, abaikan |
| `C:\spotify donwloader\sunnify-spotify-downloader\` | **Repo Sunnify existing** (Python + PyQt6, yt-dlp, CLI, web-app) — bisa dipakai sebagai basis kode (Jalur MATCH 90% reuse) |

---

## 2. Kebutuhan User (sudah berevolusi — ini yang final & penting)

1. **Output = WAV asli** — file `.wav` yang isinya raw PCM (`pcm_s16le`), BUKAN MP3 yang cuma di-rename/bungkus jadi `.wav`. Verifikasi: `ffprobe` harus menunjukkan `codec_name=pcm_s16le`.
2. **Tanpa akun Spotify** (dulunya "tanpa Premium", lalu berkembang jadi "tanpa pakai Spotify sama sekali"): input link playlist Spotify → app **otomatis cari audio dari sumber lain**.
3. Output format: **WAV + FLAC + MP3**.
4. Target akhir: **desktop app + mobile app** (dari satu codebase sebisa mungkin).
5. Level analisa yang dipilih user: **arsitektur** (bukan byte-level detail).

---

## 3. Kesimpulan Riset yang SUDAH FINAL (jangan diubah tanpa riset ulang)

1. **"WAV asli dari stream Spotify"** cuma bisa lewat protokol internal Spotify (librespot):
   - librespot-**rs** (Rust) resmi **menolak free account** (README: "only works with Spotify Premium").
   - librespot-**python** (dipakai zotify) **terbukti jalan dengan free account** → max **160 kbps Ogg Vorbis** (Premium = 320). Kualitas 320/FLAC-HiFi tidak bisa di-bypass (ditentukan server dari tier akun).
   - Lossless Spotify (FLAC HiFi) tidak tersedia untuk client eksternal (librespot issue #1583).
   - Streaming langsung punya risiko: **ToS/ban akun**, error "premium-only track", "session has been terminated", rate limit. (Section 11)

2. **"Tanpa akun Spotify + auto-cari" = arsitektur matching engine** — pola spotDL (25.8k stars): link Spotify cuma untuk metadata (cara scraping sudah ada di `spotifydown_api.py` Sunnify), lalu tiap track di-match ke provider sumber audio eksternal. (Section 14)

3. **Realitas kualitas "auto cari WAV" — wajib dikelola ekspektasi:**
   - Sumber **lossless FLAC → WAV** (Qobuz/Tidal/Deezer-HiFi): fragile, butuh akun/ARL (expire 90–120 hari), atau grey-area (API unofficial, contoh SpotiFLAC).
   - Sumber **stabil & gratis** (YouTube/YTM via yt-dlp): cap 128–256 kbps → WAV tetap PCM tulen tapi source lossy.
   - Tidak ada sumber gratis yang sekaligus stabil DAN lossless.

4. **Arsitektur wajib: provider plugin + quality ladder** — tiap sumber = satu modul dengan interface seragam (`search(query) → candidates`, `download() → stream`, `quality()` → rating); engine coba sumber terbaik kualitas dulu, turun ke yang terandalkan, track gagal masuk daftar failed. Sumber hidup-mati terus-menerus, jadi plugin system adalah kunci ketahanan. (Section 14.4)

5. **Matching harus pakai skor**, minimal: title+artist normalized (exact), durasi ±2–3 detik, album match (boost), opsional acoustic fingerprint (Chromaprint/AcoustID). (Section 14.5)

6. **Pipeline multi-format**: satu decode → PCM intermediate → 3 muxer (WAV uncompressed ~10.09 MB/menit, FLAC ~50% WAV, MP3 LAME). (Section 12)

---

## 4. FORKS KEPUTUSAN — Belum diputuskan user

| | **Jalur MATCH** (rekomendasi) | **Jalur DIRECT** |
|---|---|---|
| Butuh akun Spotify? | **Tidak** — link saja | Ya (free/burner) |
| Sumber audio | Eksternal (YT, Qobuz, Deezer, dst) | Stream Spotify sendiri (160k free / 320k premium) |
| "WAV dari Spotify"? | Bukan | Ya |
| Reuse Sunnify existing? | **~90% reuse** (yt-dlp + spotifydown_api.py) | Rewrite engine |
| Sesuai kebutuhan user saat ini? | **Ya** ("tanpa pakai Spotify") | Tidak lagi |

**Rekomendasi tim: Jalur MATCH** — bangun/matangkan dari Sunnify existing, bukan mulai nol.

---

## 5. Keputusan yang Masih Nunggu User (dari Section 13 & 14.6)

1. Jalur MATCH atau DIRECT? (rekomendasi: MATCH)
2. Kalau dibangun Jalur MATCH: provider apa yang wajib di fase awal? (rekomendasi: yt-dlp/YouTube + plugin system; Qobuz/Tidal opsional-lanjutan)
3. Mobile target: Android dulu atau dua-duanya? (Python core → mobile sukar; realistis Android via Chaquopy, iOS sulit)
4. Mode download default: cepat vs real-time.

---

## 6. Rekomendasi Langkah Berikutnya untuk Agent Baru

1. Konfirmasi dulu keputusan pada Section 4/5 ke user (jangan asumsi).
2. Kalau MATCH: audit `C:\spotify donwloader\sunnify-spotify-downloader\` — cara kerja `spotifydown_api.py` (metadata tanpa login), `Spotify_Downloader.py` (pipeline yt-dlp → ffmpeg, sudah dukung wav/flac/mp3), `sunnify_cli.py`, `web-app/`.
3. Tuliskan gap antara Sunnify sekarang vs arsitektur target: (a) provider plugin system belum ada, (b) verifikasi `pcm_s16le` output belum eksplisit, (c) match scoring (normalize + durasi) belum seketat spotDL.
4. Phase 0 proposal (Jalur MATCH): prototipe CLI — input playlist URL → metadata → match YouTube (yt-dlp) → mux WAV → verifikasi ffprobe. Pakai struktur Sunnify, tambah module baru, jangan rewrite.

---

## 7. Referensi Cepat (lengkap di file riset)

- spotDL (arsitektur matching): https://github.com/spotDL/spotify-downloader
- SpotiFLAC (lossless via Tidal/Qobuz, tanpa akun; contoh fragile API): https://github.com/spotbye/SpotiFLAC
- zotify + fork aktif (direct stream, free account 160k): https://github.com/DraftKinner/zotify
- librespot-python: https://github.com/kokarare1212/librespot-python
- alice-spotify-bridge SPEC (contoh pipeline librespot → PCM → encoder): https://github.com/volodarskij/alice-spotify-bridge/blob/master/bridge/SPEC.md
- Deezer demo (FLAC butuh HiFi): https://github.com/honeubadger/deemix-api