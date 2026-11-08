// Electron main process — shell tipis di sekeliling server lokal kita.
// Server Node jalan sebagai child process (ELECTRON_RUN_AS_NODE), UI statis
// sudah diserve oleh server itu sendiri, window cuma menampilkan URL-nya.
//
// Keuntungan pola ini: NOL perubahan di backend/UI; semua keamanan
// (bind 127.0.0.1 + Origin guard) tetap berlaku di dalam app.

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

let serverProc = null;
let win = null;

// ---- Path yang benar untuk dev & packaged ----
const isPackaged = app.isPackaged;
const resourcesBase = isPackaged ? process.resourcesPath : path.join(__dirname, "..");

const SERVER_JS = isPackaged
  ? path.join(resourcesBase, "server", "dist", "server.js")
  : path.join(resourcesBase, "dist", "server.js");
const BINS_DIR = path.join(resourcesBase, "bin");
const WEB_DIR = isPackaged ? path.join(resourcesBase, "ui") : path.join(resourcesBase, "web", "out");

/** Ambil satu port kosong dari OS. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function healthCheck(base) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitServer(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await healthCheck(base)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Update yt-dlp bundled kalau versinya mulai basi (>30 hari). Fire-and-forget. */
function maybeUpdateYtDlp(base) {
  (async () => {
    try {
      const res = await fetch(`${base}/api/diagnostics`);
      const d = await res.json();
      if (!d?.ytDlp?.found || !(d.ytDlp.ageDays > 30)) return;
      const ytdlpExe = path.join(BINS_DIR, "yt-dlp.exe");
      if (!require("node:fs").existsSync(ytdlpExe)) return; // PATH fallback (dev): jangan update sistem user
      console.log("[desktop] yt-dlp berumur", d.ytDlp.ageDays, "hari — mencoba self-update...");
      const up = spawn(ytdlpExe, ["-U"], { windowsHide: true, stdio: "ignore" });
      up.on("error", (err) => console.error("[desktop] yt-dlp self-update gagal spawn:", err.message));
      up.on("close", (code) => console.log("[desktop] yt-dlp -U exit:", code));
    } catch { /* offline / dsb — abaikan */ }
  })();
}

let serverLog = "";
function startServer(port) {
  const fs = require("node:fs");
  // Pre-flight check: pastikan file server ada (sering gagal karena belum npm run build)
  if (!fs.existsSync(SERVER_JS)) {
    console.error(`[desktop] SERVER_JS tidak ditemukan: ${SERVER_JS}`);
    console.error(`[desktop] Pastikan sudah jalankan: npm run build (dari root)`);
  }
  if (!fs.existsSync(WEB_DIR) || !fs.existsSync(path.join(WEB_DIR, "index.html"))) {
    console.warn(`[desktop] WEB_DIR belum di-build: ${WEB_DIR}`);
  }
  console.log(`[desktop] spawn ${process.execPath} ${SERVER_JS}`);
  console.log(`[desktop] BINS_DIR=${BINS_DIR} WEB_DIR=${WEB_DIR}`);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    SPOTDLR_BINS: BINS_DIR,
    SPOTDLR_WEB_DIR: WEB_DIR,
  };
  serverProc = spawn(process.execPath, [SERVER_JS], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  serverProc.stdout.on("data", (d) => {
    const s = d.toString();
    serverLog += s;
    if (serverLog.length > 8000) serverLog = serverLog.slice(-8000);
    process.stdout.write("[server] " + d);
  });
  serverProc.stderr.on("data", (d) => {
    const s = d.toString();
    serverLog += s;
    if (serverLog.length > 8000) serverLog = serverLog.slice(-8000);
    process.stderr.write("[server] " + d);
  });
  serverProc.on("error", (err) => {
    console.error("[desktop] spawn error:", err);
    serverLog += `\nspawn error: ${err.message}\n`;
  });
  serverProc.on("exit", (code, signal) => {
    console.log(`[desktop] server exited: code=${code} signal=${signal}`);
    if (serverLog) console.log(`[desktop] last serverLog:\n${serverLog.slice(-2000)}`);
    if (win && code !== 0) app.quit();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    console.log(`[desktop] freePort=${port} base=${base}`);
    console.log(`[desktop] SERVER_JS=${SERVER_JS} exists=${require("node:fs").existsSync(SERVER_JS)}`);
    console.log(`[desktop] WEB_DIR=${WEB_DIR} exists=${require("node:fs").existsSync(WEB_DIR)} uiBuilt=${require("node:fs").existsSync(path.join(WEB_DIR, "index.html"))}`);

    startServer(port);
    const ok = await waitServer(base);
    if (!ok) {
      const { dialog } = require("electron");
      const tail = (serverLog || "").slice(-1200).trim() || "(tidak ada output server)";
      const msg = `Server internal gagal start.\n\nBase: ${base}\nSERVER_JS: ${SERVER_JS}\nWEB_DIR: ${WEB_DIR}\n\nLog tail:\n${tail}\n\nCek log lengkap di %APPDATA%\\spotify-downloader\\logs`;
      console.error("[desktop] waitServer failed, showing dialog");
      console.error(msg);
      dialog.showErrorBox("DROP", msg);
      app.quit();
      return;
    }

    win = new BrowserWindow({
      width: 1140,
      height: 820,
      minWidth: 720,
      minHeight: 560,
      autoHideMenuBar: true,
      backgroundColor: "#f5f5f7",
      title: "DROP",
      show: false,
    });
    win.once("ready-to-show", () => win.show());
    // Link eksternal (mis. user klik link di halaman) buka di browser default, bukan window baru.
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    win.loadURL(base);

    maybeUpdateYtDlp(base);
  });

  app.on("window-all-closed", () => {
    // Windows: serverProc.kill("SIGTERM") = TerminateProcess — handler
    // graceful server TIDAK sempat jalan, sehingga yt-dlp/ffmpeg jadi yatim
    // dan terus berjalan. taskkill /T membunuh seluruh tree proses
    // (server + semua child download) secara andal.
    if (serverProc && serverProc.pid) {
      if (process.platform === "win32") {
        try {
          const tk = spawn("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          tk.on("error", (err) => console.error("[desktop] taskkill gagal spawn:", err.message));
        } catch (err) {
          console.error("[desktop] taskkill gagal:", err);
          serverProc.kill("SIGTERM");
        }
      } else {
        serverProc.kill("SIGTERM");
      }
    }
    app.quit();
  });
}
