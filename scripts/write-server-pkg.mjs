// WHY: server.js hasil compile adalah ES module (pakai `import`). Node hanya
// memperlakukannya sebagai ESM bila ada package.json bernilai "type":"module"
// di dekatnya/distnya. Saat dijalankan di dalam folder project, package.json
// root cukup. Tapi saat ter-paket (C:\Program Files\DROP\...) tidak ada
// package.json di direktori atasnya, sehingga Node gagal: "Cannot use import
// statement outside a module". File ini menulis penanda itu ke dist/ saat build.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(
  path.join(root, "dist", "package.json"),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" }, null, 2)}\n`,
);
