import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export interface SidecarFile {
  name: string;
  path: string; // relative to MEDIA_ROOT, same shape as videos.local_path
  full_path: string; // absolute, ready to paste into Explorer
  size_bytes: number;
}

/**
 * Sidecar files (.srt, .vtt, .info.json, thumbnails, ...) live next to the
 * master in the same folder, sharing its basename. Discovering them is one
 * directory read against the shared drive -- cheap enough to do live when a
 * row is expanded, so cache-list doesn't have to walk 11k+ folders itself.
 */
export async function GET(req: NextRequest) {
  const localPath = req.nextUrl.searchParams.get("path") || "";
  if (!localPath) {
    return NextResponse.json({ error: "missing path" }, { status: 400 });
  }

  const mediaRoot = process.env.MEDIA_ROOT || "";
  if (!mediaRoot) {
    return NextResponse.json({ error: "MEDIA_ROOT not configured" }, { status: 500 });
  }

  const rootResolved = path.resolve(mediaRoot);
  const fullPath = path.resolve(rootResolved, localPath);
  // localPath comes from a value we ourselves wrote to Supabase, but it's
  // still attacker-shaped input to this endpoint -- refuse anything that
  // would escape MEDIA_ROOT via ../ segments.
  if (fullPath !== rootResolved && !fullPath.startsWith(rootResolved + path.sep)) {
    return NextResponse.json({ error: "path escapes MEDIA_ROOT" }, { status: 400 });
  }

  const dir = path.dirname(fullPath);
  const videoName = path.basename(fullPath);
  const baseName = videoName.slice(0, videoName.length - path.extname(videoName).length);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return NextResponse.json({ error: "drive not mounted or folder missing", dir }, { status: 502 });
  }

  const files: SidecarFile[] = [];
  for (const name of entries) {
    if (name === videoName) continue;
    if (!name.startsWith(baseName)) continue;
    const abs = path.join(dir, name);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      files.push({
        name,
        path: path.posix.join(path.dirname(localPath.replace(/\\/g, "/")), name),
        full_path: abs,
        size_bytes: stat.size,
      });
    } catch {
      // Vanished between readdir and stat -- skip it.
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ files, dir });
}
