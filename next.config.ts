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

  // Stops every response from announcing "X-Powered-By: Next.js" to anyone
  // who looks — no functional effect, just one less hint for a stranger
  // probing the site.
  poweredByHeader: false,

  // tools/ holds this project's Python agent/worker, not anything Next
  // needs to trace — but Turbopack's file tracing walks the whole project
  // root by default, not just app/. Confirmed fatal in practice (2026-09-10):
  // tools/youtube_profile/ (a real Chrome profile a separate worker feature
  // keeps alive) has a leveldb LOCK file that's exclusively held while that
  // process is running, and Turbopack crashed outright trying to read
  // through it while resolving app/globals.css -- nothing to do with that
  // file's actual content, just an incidental scan into an unrelated
  // directory. Excluding tools/ (and this app's own worktree/session
  // scratch dirs, same reasoning) stops Next from ever walking in there.
  outputFileTracingExcludes: {
    "**/*": ["./tools/**", "./.claude/**"],
  },
};

export default nextConfig;
