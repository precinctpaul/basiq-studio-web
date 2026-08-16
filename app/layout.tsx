import type { Metadata } from "next";
import "./globals.css";

// Brand faces are self-hosted woff2 declared in globals.css (@font-face),
// built from the licensed OTF cuts by tools/build_webfonts.py — not
// next/font/google, which can't reach the network here and doesn't apply to
// self-hosted licensed faces anyway.

export const metadata: Metadata = {
  title: "Majority Dems — Basiq Studio Hub",
  description: "Grab, cut, transcribe, and clip video.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
