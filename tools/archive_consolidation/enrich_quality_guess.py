"""Step 3: guess proxy vs master for every video file.

Per the brief: presence of "_proxy" / "low-res" / "HLS" in the filename or
path implies proxy; absence implies master. This is explicitly a
heuristic, not a guarantee -- it's applied uniformly here and recorded
with its own source/reasoning per file so a later spot-check against real
files (resolution/bitrate via ffprobe) can compare notes with this guess
rather than silently overwrite it.
"""

import re

import config
import schema

_PROXY_MARKERS = re.compile(r"(proxy|low-res|low_res|lowres|\bHLS\b)", re.IGNORECASE)


def guess_quality(full_path: str, name: str) -> tuple[str, str]:
    haystack = f"{full_path} {name}"
    m = _PROXY_MARKERS.search(haystack)
    if m:
        return "proxy", f"matched marker '{m.group(1)}'"
    return "master", "no proxy/low-res/HLS marker found"


def main():
    con = schema.connect(config.INDEX_DB)

    rows = con.execute("select id, full_path, name from files where role = 'video'").fetchall()

    counts = {"proxy": 0, "master": 0}
    with con:
        for file_id, full_path, name in rows:
            quality, reason = guess_quality(full_path, name)
            counts[quality] += 1
            con.execute(
                "update files set quality_guess = ?, quality_guess_source = ? where id = ?",
                (quality, reason, file_id),
            )

    print(f"video files guessed: {len(rows)}")
    print(f"  master: {counts['master']}")
    print(f"  proxy:  {counts['proxy']}")

    # Cross-check against the registry's own numbers: 854 of 8,992 items
    # have both a high-res and proxy copy; the rest have exactly one file
    # whose role is inferred the same way.
    both = con.execute(
        """select count(*) from (
             select canonical_id from files
             where role = 'video' and canonical_id is not null
             group by canonical_id
             having count(distinct quality_guess) = 2
           )"""
    ).fetchone()[0]
    print(f"canonical items with both a master and a proxy guessed: {both}  <- brief says 854")

    con.close()


if __name__ == "__main__":
    main()
