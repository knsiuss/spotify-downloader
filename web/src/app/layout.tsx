import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spotify Downloader",
  description: "Download playlist Spotify sebagai WAV/FLAC/MP3 asli + video YouTube custom resolusi.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
