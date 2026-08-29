"""Step 3b: classify every canonical item's video completeness.

Per the brief: a proxy-only item cannot be upsampled into a master --
that has to be flagged, never silently treated as complete. This makes
that flag explicit and queryable (video_completeness) instead of leaving
it as something you'd have to re-derive from the files table every time.
"""

import config
import schema


def main():
    con = schema.connect(config.INDEX_DB)

    with con:
        con.execute("update canonical_items set video_completeness = 'no_video' where has_video = 0")

        con.execute(
            """update canonical_items set video_completeness = (
                 select case count(distinct f.quality_guess)
                        when 2 then 'both'
                        else max(f.quality_guess) || '_only'
                        end
                 from files f where f.role = 'video' and f.canonical_id = canonical_items.canonical_id
               )
               where has_video = 1"""
        )

    print("video_completeness breakdown:")
    for status, n in con.execute(
        "select video_completeness, count(*) from canonical_items group by 1 order by 2 desc"
    ):
        print(f"  {status:15s} {n}")

    (proxy_only,) = con.execute(
        "select count(*) from canonical_items where video_completeness = 'proxy_only'"
    ).fetchone()
    print(f"\nflagged as master-unavailable (proxy_only): {proxy_only}")

    con.close()


if __name__ == "__main__":
    main()
