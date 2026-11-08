// Provider Qobuz via API unofficial (https://www.qobuz.com/api.json/0.2/).
// Satu-satunya sumber lossless (FLAC 16/24-bit) yang bisa menghasilkan WAV sungguhan.
// BUTUH kredensial Qobuz (app_id + app_secret dari reverse-engineer web player Qobuz,
// email/password akun Qobuz) — config via .env. Kalau tidak ada, provider auto-skip.
// ⚠ Fragile: API unofficial bisa berubah / kena anti-bot kapan saja.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

/** MD5 hex bertanda? tidak - hex biasa. Diekspor untuk test. */
export function md5hex(data: string): string {
  return createHash("md5").update(data).digest("hex");
}

/**
 * Tanda tangan request getFileUrl (r_sig).
 * Terverifikasi dari QobuzApiSharp (DJDoubleD/QobuzApiSharp, QobuzApiHelper.cs):
 *   data = "trackgetFileUrlformat_id" + formatId + "intentstreamtrack_id"
 *        + trackId + requestTs + appSecret
 *   signature = MD5(data) hex
 * Diekspor untuk test (vektor: format 27, track 7398, ts 1234567890, secret testsecret).
 */
export function generateFileUrlRequestSignature(
  formatId: string,
  trackId: string,
  timestamp: string,
  appSecret: string,
): string {
  return md5hex(
    `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${timestamp}${appSecret}`,
  );
}

async function apiGet<T>(
  pathStr: string,
  params: Record<string, string>,
  config: QobuzConfig,
  authToken?: string | null,
): Promise<T> {
  const url = new URL(`${API}${pathStr}`);
  // app_id sebagai query DAN header: API membalas "Invalid or missing app_id
  // parameter" kalau hanya header yang dikirim.
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("app_id", config.appId);
  const headers: Record<string, string> = { "X-App-Id": config.appId, "User-Agent": "Mozilla/5.0" };
  if (authToken) headers["X-User-Auth-Token"] = authToken;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
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
    // Terverifikasi dari QobuzApiSharp (QobuzApiService.User.cs - LoginWithEmail):
    // GET /user/login dengan email + password = MD5(password). Yang lama (POST
    // body plaintext) bukan format API dan tidak menghasilkan token.
    const url = new URL(`${API}/user/login`);
    url.searchParams.set("app_id", this.config.appId);
    url.searchParams.set("email", this.config.email);
    url.searchParams.set("password", md5hex(this.config.password));
    const res = await fetch(url, {
      headers: { "X-App-Id": this.config.appId, "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
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
      token,
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

    // Format id per QobuzApiSharp: 27 = Hi-Res >96kHz, 7 = Hi-Res 96kHz,
    // 6 = FLAC lossless, 5 = MP3 320. Tier akun berbeda-beda; turunkan
    // tangga sampai ada yang membalas URL (request bertanda tangan + token).
    let fileUrl: string | null = null;
    let lastErr: unknown = null;
    for (const formatId of ["27", "7", "6", "5"]) {
      if (ctx?.signal?.aborted) throw new Error("cancelled");
      try {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = generateFileUrlRequestSignature(
          formatId, candidate.id, timestamp, this.config.appSecret,
        );
        const json = await apiGet<{ url?: string }>(
          "/track/getFileUrl",
          {
            track_id: candidate.id,
            format_id: formatId,
            intent: "stream",
            request_ts: timestamp,
            request_sig: signature,
          },
          this.config,
          token,
        );
        if (json.url) { fileUrl = json.url; break; }
      } catch (err) {
        if (err instanceof Error && err.message === "cancelled") throw err;
        lastErr = err;
      }
    }
    if (!fileUrl) {
      throw new Error(`Qobuz: tidak dapat URL file (${lastErr ? (lastErr as Error).message : "tidak ada format yang tersedia"})`);
    }

    // signal diteruskan ke fetch supaya cancel membatalkan transfer besar FLAC;
    // timeout keras tetap berlaku supaya transfer yang stall tidak menggantung worker.
    const downloadSignal = ctx?.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)])
      : AbortSignal.timeout(300_000);
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: downloadSignal,
    });
    if (!res.ok) throw new Error(`Qobuz download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("Qobuz download: file kosong");
    const outPath = path.join(workDir, `qobuz-${candidate.id}.flac`);
    fs.writeFileSync(outPath, buf);
    ctx?.onProgress?.({ percent: 100, downloadedBytes: buf.length, totalBytes: buf.length, speedBps: null, etaSec: 0 });
    return outPath;
  }
}