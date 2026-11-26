# SpotDLR — Spotify link to WAV / FLAC / MP3

A TypeScript CLI and web app that takes a **Spotify playlist, album, or track link** and
produces audio files locally: **WAV (raw PCM `s16le`)**, plus FLAC and MP3.

The Spotify link is used for **metadata only** — title, artist, album, duration, order.
No Spotify account, no Spotify API key, no Spotify audio. Audio is sourced from external
providers, decoded to PCM inside this app, and muxed to the target container. Every
download is verified: a WAV file must report `codec_name=pcm_s16le`, not an MP3 wearing a
WAV header.

> Use this on material you have the rights to. What you download is your responsibility.

---

## Layout

```text
src/cli/          CLI entry point (bin: spotdlr)
src/server.ts     HTTP backend; also serves the built UI
src/metadata/     Spotify link parsing and metadata fetch
src/providers/    External audio providers and matching
src/audio/        Decode, mux, and pcm_s16le verification
src/lyrics/       Lyric handling
src/video/        Video/artwork side of the pipeline
src/core/         Job orchestration
src/lib/          Shared utilities
web/              Next.js UI
desktop/          Desktop wrapper
```

## Requirements

- Node.js 22 or newer
- `ffmpeg` and `ffprobe` on `PATH`

## Quickstart

```bash
npm install
npm run build          # tsc + Next.js build
cp .env.example .env   # then fill in what your providers need
npm start              # backend + UI on one port
```

Development, with the TypeScript sources running through `tsx`:

```bash
npm run dev            # CLI
npm run web            # Next.js dev server on :3000
npm run typecheck
npm test               # node:test suite in src/__tests__
```

On Windows, `start.bat` boots the same single process as `start-servers.mjs`; the UI has
to be built first.

## How a job runs

1. Parse the Spotify link into a track list with metadata.
2. Match each track against the available providers, best candidate first.
3. Download the best available source.
4. Decode to PCM and mux into the requested container.
5. Verify the output (codec, sample rate, channels, duration) and record the result.

Failures are reported per track — one bad match does not sink the whole playlist.

## Docs

| File | What it covers |
| :--- | :--- |
| `PRD.md` | Product scope, formats, non-goals |
| `RESEARCH-REAL-WAV-ARCHITECTURE.md` | Why raw PCM output and how the pipeline is built |
| `HANDOFF.md` | Current state and what is next |

## License

MIT — see [LICENSE](LICENSE).
