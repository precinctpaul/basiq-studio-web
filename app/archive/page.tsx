import Image from "next/image";
import Link from "next/link";
import { ArchivePanel } from "@/components/archive/ArchivePanel";

export const metadata = {
  title: "Archive — Basiq Studio Hub",
};

export default function ArchivePage() {
  return (
    <div className="flex h-full flex-col">
      <header className="header-bar flex items-center" style={{ padding: "14px 22px", gap: 14 }}>
        <Image
          src="/brand/wordmark.png"
          alt="Majority Democrats"
          height={46}
          width={150}
          priority
          style={{ height: 46, width: "auto" }}
        />
        <span className="section-label whitespace-nowrap">BASIQ STUDIO HUB — ARCHIVE</span>
        <span className="flex-1" />
        <Link href="/" className="btn" style={{ textDecoration: "none" }}>
          ← LIBRARY
        </Link>
      </header>
      <ArchivePanel />
    </div>
  );
}
