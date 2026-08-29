"""Parsers for the filename conventions already found in the wild.

The brief's target convention is
  LastName FirstName_BioguideID_YYYY-MM-DD_source_sourceID[_proxy].ext
and 203 files already follow a near-exact version of it:
  LastName FirstName_BioguideID_SpeakerID_YYYY-MM-DD_SourceID.ext
e.g. "Riley Josh_R000622_142153_2025-03-27_657764.mp4" where 142153 is
C-SPAN's internal speaker ID for that person (stable per person, useful
as a second identity key once observed, but not part of the target name).

parse_conventional_name() is intentionally strict: a false-positive person
match baked into 9,000 renamed files is much worse than leaving one item
in Unmatched-No-Person for a human to look at.
"""

import re

_FULL = re.compile(
    r"^(?P<full_name>[A-Za-z''\-]+(?: [A-Za-z''\-]+)*)_"
    r"(?P<bioguide>[A-Z]\d{6})_"
    r"(?P<speaker_id>\d{4,8})_"
    r"(?P<date>\d{4}-\d{2}-\d{2})_"
    r"(?P<source_id>\d{5,8})"
    r"(?P<proxy>_proxy)?$"
)

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

_CSPAN_BARE = re.compile(
    r"^cspan_ ?(?P<cspan_id>\d{5,8})(_fixed)?(?P<proxy>_proxy)?$"
)


def parse_conventional_name(stem: str) -> dict | None:
    """stem is the filename with extension already stripped."""
    m = _FULL.match(stem)
    if not m:
        return None
    # "Last First" and "Last Middle First" (e.g. "Gluesenkamp Perez Marie",
    # "McDonald Rivet Kristen") both appear on disk -- the first name is
    # reliably the final space-separated token, whatever the surname is.
    name_parts = m.group("full_name").split(" ")
    first_name = name_parts[-1]
    last_name = " ".join(name_parts[:-1])
    return {
        "last_name": last_name,
        "first_name": first_name,
        "bioguide_id": m.group("bioguide"),
        "cspan_speaker_id": m.group("speaker_id"),
        "date": m.group("date"),
        "source_id": m.group("source_id"),
        "is_proxy": bool(m.group("proxy")),
        "pattern": "full_convention",
    }


def parse_yt_slug_name(stem: str) -> dict | None:
    """"yt_<channel_slug>_<11-char-id>[_proxy]" -- split-based, not a single
    regex, because the channel slug itself can contain underscores (e.g.
    "yt_CSPAN_Channel_iKFbVOnz0bQ_proxy"), so the only reliable anchor is
    that a YouTube ID is always exactly 11 id-charset characters and always
    sits in the second-to-last (or last) underscore-separated segment.
    """
    if not stem.startswith("yt_"):
        return None
    parts = stem.split("_")
    if len(parts) < 3:
        return None
    is_proxy = parts[-1] == "proxy"
    id_index = -2 if is_proxy else -1
    yt_id = parts[id_index]
    if not _YT_ID.match(yt_id):
        return None
    channel_slug = "_".join(parts[1:id_index])
    if not channel_slug:
        return None
    return {
        "channel_slug": channel_slug,
        "youtube_id": yt_id,
        "is_proxy": is_proxy,
        "pattern": "yt_channel_slug",
    }


def parse_cspan_bare_name(stem: str) -> dict | None:
    m = _CSPAN_BARE.match(stem)
    if not m:
        return None
    return {
        "cspan_id": m.group("cspan_id"),
        "is_proxy": bool(m.group("proxy")),
        "pattern": "cspan_bare",
    }
