import type { NextConfig } from "next";

// Static export: hasil build di web/out — diserve langsung oleh backend Node
// (satu proses, satu port). Tidak ada lagi `next dev` di alur produksi.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
