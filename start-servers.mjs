// Launcher: satu proses (backend + UI statis di port yang sama).
// Dipakai untuk menjalankan app tanpa start.bat; UI wajib sudah di-build (npm run build).

import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/server.js"], { stdio: "inherit", windowsHide: true });
child.on("exit", (code) => process.exit(code ?? 0));
