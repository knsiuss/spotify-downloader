// Provider Qobuz via API unofficial (https://www.qobuz.com/api.json/0.2/).
// Satu-satunya sumber lossless (FLAC 16/24-bit) yang bisa menghasilkan WAV sungguhan.
// BUTUH kredensial Qobuz (app_id + app_secret dari reverse-engineer web player Qobuz,
// email/password akun Qobuz) — config via .env. Kalau tidak ada, provider auto-skip.
// ⚠ Fragile: API unofficial bisa berubah / kena anti-bot kapan saja.

import fs from "node:fs";
import path from "node:path";
import type { Candidate, Provider, ProviderContext, Track } from "../core/types.js";

const API = "https://www.qobuz.com/api.json/0.2";

interface QobuzConfig {
  appId: string;
  appSecret: string;
  email: string;
  password: string;
}

export function loadQobuzConfig(env: NodeJS.ProcessEnv = process.env): QobuzConfig | null {
  const appId = env.QOBUZ_APP_ID?.trim();
  const appSecret = env.QOBUZ_APP_SECRET?.trim();
  const email = env.QOBUZ_EMAIL?.trim();
  const password = env.QOBUZ_PASSWORD?.trim();
  if (!appId || !appSecret || !email || !password) return null;
  return { appId, appSecret, email, password };
}

async function apiGet<T>(pathStr: string, params: Record<string, string>, config: QobuzConfig): Promise<T> {
  const url = new URL(`${API}${pathStr}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "X-App-Id": config.appId, "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Qobuz API HTTP ${res.status}`);
  return (await res.json()) as T;
}

export class QobuzProvider implements Provider {
  name = "qobuz";
  /** Kualitas terbaik → dicoba paling awal (quality ladder). */
  priority = 10;

  constructor(private config: QobuzConfig) {}

  /** Login sekali untuk seluruh session, simpan token. */
  private authToken: string | null = null;

  private async auth(): Promise<string> {
    if (this.authToken) return this.authToken;
    const body = new URLSearchParams({ email: this.config.email, password: this.config.password });
    const res = await fetch(`${API}/user/login?app_id=${this.config.appId}`, {
      method: "POST",
      body,
      headers: { "X-App-Id": this.config.appId, "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) throw new Error(`Qobuz login gagal (HTTP ${res.status})`);
    const json = (await res.json()) as { user_auth_token?: string };
    if (!json.user_auth_token) throw new Error("Qobuz login: token kosong (cek kredensial)");
    this.authToken = json.user_auth_token;
    return this.authToken;
  }

  async search(track: Track): Promise<Candidate[]> {
    const token = await this.auth();
    const query = `${track.title} ${track.artists.join(" ")}`;
    const json = await apiGet<{ tracks?: { items?: Array<Record<string, unknown>> } }>(
      "/track/search",
      { query, limit: "5" },
      this.config,
    );
    const items = json.tracks?.items ?? [];
    return items.map((t) => {
      const e = t as Record<string, any>;
      const album = e.album as Record<string, any> | undefined;
      return {
        id: String(t.id),
        title: String(t.title ?? ""),
        artist: String(album?.artist?.name ?? e.performer?.name ?? ""),
        durationSec: typeof t.duration === "number" ? t.duration : null,
        url: String(t.id),
      };
    });
  }

  async download(candidate: Candidate, workDir: string, ctx?: ProviderContext): Promise<string> {
    if (ctx?.signal?.aborted) throw new Error("cancelled");
    const token = await this.auth();
    const json = await apiGet<{ url?: string }>(
      "/track/getFileUrl",
      { track_id: candidate.id, format_id: "27", intent: "stream" },
      this.config,
    );
    if (!json.url) throw new Error("Qobuz: tidak dapat URL file (format 27=FLAC)");

    // signal diteruskan ke fetch supaya cancel membatalkan transfer besar FLAC.
    const res = await fetch(json.url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctx?.signal,
    });
    if (!res.ok) throw new Error(`Qobuz download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const outPath = path.join(workDir, `qobuz-${candidate.id}.flac`);
    fs.writeFileSync(outPath, buf);
    ctx?.onProgress?.({ percent: 100, downloadedBytes: buf.length, totalBytes: buf.length, speedBps: null, etaSec: 0 });
    return outPath;
  }
}