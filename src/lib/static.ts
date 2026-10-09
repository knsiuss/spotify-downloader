// Penyaji file statis untuk UI hasil `next build` (web/out).
// Satu proses, satu port: API + UI jalan di server yang sama.

import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./binaries.js";

export function webOutDir(): string {
  return process.env.SPOTDLR_WEB_DIR ?? path.join(projectRoot, "web", "out");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function uiIsBuilt(): boolean {
  return fs.existsSync(path.join(webOutDir(), "index.html"));
}

/**
 * Serve file statis. Return true kalau request ditangani di sini.
 * Path tanpa ekstensi -> index.html (fallback SPA).
 */
export function serveStatic(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const root = webOutDir();
  if (!uiIsBuilt()) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<body style="font-family:system-ui;background:#0a0a0b;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
      `<div style="text-align:center"><h2>UI belum di-build</h2>` +
      `<p style="color:#999">Jalankan <code>npm run build:web</code> lalu restart server.</p>` +
      `<p style="color:#666">API tetap jalan di endpoint /api/*</p></div></body>`,
    );
    return true;
  }

  // Cegah path traversal: hasil resolve wajib tetap DI DALAM web/out.
  // Bandingkan dengan pemisah — tanpa ini "web/out2" lolos prefix "web/out".
  const rootAbs = path.resolve(root);
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  let filePath = path.resolve(root, rel);
  if (filePath !== rootAbs && !filePath.startsWith(rootAbs + path.sep)) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: route tanpa ekstensi -> index.html
    if (!path.extname(rel)) filePath = path.join(root, "index.html");
    else { res.writeHead(404); res.end(); return true; }
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
  });
  if (req.method === "HEAD") { res.end(); return true; }
  fs.createReadStream(filePath).pipe(res);
  return true;
}
