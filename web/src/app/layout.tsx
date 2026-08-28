import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DROP — Media Downloader",
  description: "Download musik & video dari Spotify & YouTube sebagai WAV/FLAC/MP3 + MP4/WEBM/MKV — lokal, cepat, lengkap cover & lirik.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
