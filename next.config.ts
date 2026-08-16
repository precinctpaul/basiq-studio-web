import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * ffprobe-static and ffmpeg-static resolve their binary path via __dirname
   * at require time. Left to Next's own bundler, that __dirname gets
   * statically rewritten for tracing (both in dev and in the standalone
   * output Vercel deploys), producing a path like \ROOT\node_modules\... that
   * doesn't exist on disk — confirmed locally: ffprobe spawned against that
   * exact broken path and failed with ENOENT. Marking them external makes
   * Next require() them at runtime unmodified, so __dirname resolves to
   * their real install location instead.
   */
  serverExternalPackages: ["ffprobe-static", "ffmpeg-static"],
};

export default nextConfig;
