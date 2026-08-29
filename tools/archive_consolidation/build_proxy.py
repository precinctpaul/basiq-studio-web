"""Step 6 (validation stage): generate a scrub proxy per the settings
agreed with the user -- 480p H.264, CRF 28 capped at 800kbps, closed
2-second GOP, AAC 96kbps mono, delivered as HLS (not a flat MP4) so an
11-hour source loads in about the time it takes to fetch one 6-second
segment regardless of where in the timeline you seek.

This is deliberately NOT wired up to run archive-wide yet: transcoding
~8,680 master-only items (some 11 hours long) is real, possibly
multi-day CPU time and disk I/O, and that scope/scheduling decision
belongs to the user, not this script. Use --limit-seconds to validate
against a slice of a long file without paying for the full transcode.
"""

import argparse
import json
import shutil
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def find_binary(name: str) -> str:
    exe = shutil.which(name)
    if exe:
        return exe
    node_modules = HERE.parent.parent / "node_modules"
    for candidate in (
        node_modules / f"{name}-static" / f"{name}.exe",
        node_modules / f"{name}-static" / name,
        node_modules / f"{name}-static" / "bin" / f"{name}.exe",
    ):
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError(f"{name} not found on PATH or in node_modules/{name}-static")


def probe_fps(ffprobe: str, input_path: str) -> float:
    out = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate,duration", "-of", "json", input_path],
        capture_output=True, text=True, check=True,
    )
    stream = json.loads(out.stdout)["streams"][0]
    num, den = stream["r_frame_rate"].split("/")
    return float(num) / float(den)


def build_proxy(input_path: str, out_dir: Path, limit_seconds: int | None = None) -> dict:
    ffmpeg = find_binary("ffmpeg")
    ffprobe = find_binary("ffprobe")
    fps = probe_fps(ffprobe, input_path)
    gop = max(1, round(fps * 2))  # 2-second closed GOP -- the actual lever for scrub responsiveness

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = out_dir / "proxy.m3u8"

    args = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
    if limit_seconds:
        args += ["-t", str(limit_seconds)]
    args += [
        "-i", input_path,
        "-vf", "scale=-2:480",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-maxrate", "800k", "-bufsize", "1600k",
        "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-c:a", "aac", "-b:a", "96k", "-ac", "1", "-ar", "44100",
        "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
        "-hls_segment_filename", str(out_dir / "seg_%04d.ts"),
        str(manifest),
    ]

    started = time.monotonic()
    subprocess.run(args, check=True, capture_output=True, text=True)
    elapsed = time.monotonic() - started

    segments = sorted(out_dir.glob("seg_*.ts"))
    total_bytes = manifest.stat().st_size + sum(s.stat().st_size for s in segments)
    return {
        "source_fps": fps, "gop": gop, "elapsed_seconds": elapsed,
        "segment_count": len(segments), "total_bytes": total_bytes,
        "manifest": str(manifest),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--limit-seconds", type=int, default=None,
                         help="only transcode the first N seconds -- for validating against a long source without the full run")
    args = parser.parse_args()

    result = build_proxy(args.input, Path(args.out_dir), args.limit_seconds)
    print(json.dumps(result, indent=2))
    mb = result["total_bytes"] / 1_000_000
    seconds_covered = args.limit_seconds or None
    print(f"\n{mb:.1f} MB across {result['segment_count']} segments in {result['elapsed_seconds']:.1f}s")
    if seconds_covered:
        print(f"(covers {seconds_covered}s of source -- extrapolated full-length size/time will scale roughly linearly)")


if __name__ == "__main__":
    main()
