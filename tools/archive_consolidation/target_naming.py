"""Builds the destination filename/folder for a canonical item under the
new consolidated structure. Pure functions over already-resolved DB
columns -- no filesystem access, so this can be unit-tested against real
rows without touching the archive.

Shape (extends the brief's own convention, never departs from it except
where a real gap showed up -- see the conversation this was designed in):

  {PersonLabel}_{IdentitySlot}_{Date}_{Source}_{SourceID}[_proxy].ext

  PersonLabel   "Last First" for a resolved person (Congress or
                name-slug); a derived content-type slug for institutional
                content (e.g. "House-Session"); "Unmatched" otherwise.
  IdentitySlot  BioGuideID for Congress members (incl. ex-Congress
                cabinet); "NC-<slug>" for a name-slug figure (no
                BioGuideID exists); "NOPERSON" for institutional/unmatched.
  Date          resolved publish_date regardless of how it was resolved
                (see date_source in metadata.json for provenance);
                "0000-00-00" for the handful of items with no date at all.
  Source        "cspan" | "yt" | "basiq" (id_type lowercased and mapped).
  SourceID      canonical_id as-is -- it already IS that source's own ID.

Metadata/transcript sidecars share the base name WITHOUT "_proxy": they
describe the content, not which quality variant you're looking at, so
there is exactly one metadata.json and one transcript.srt per item no
matter how many video quality variants exist.
"""

import re

_ID_TYPE_TO_SOURCE = {"CSPAN": "cspan", "YouTube": "yt", "BasiqUUID": "basiq"}

_INSTITUTIONAL_SLUGS = [
    (re.compile(r"Senate Session", re.IGNORECASE), "Senate-Session"),
    (re.compile(r"House Session", re.IGNORECASE), "House-Session"),
    (re.compile(r"Morning Hour", re.IGNORECASE), "Morning-Hour"),
    (re.compile(r"Daily Briefing|Press Briefing|Pen and Pad", re.IGNORECASE), "Press-Briefing"),
    (re.compile(r"Cabinet Meeting", re.IGNORECASE), "Cabinet-Meeting"),
    (re.compile(r"News Conference", re.IGNORECASE), "News-Conference"),
    (re.compile(r"Speaks to Reporters", re.IGNORECASE), "Press-Gaggle"),
    (re.compile(r"Republican Agenda|Democratic Agenda|Weekly Briefing", re.IGNORECASE), "Party-Briefing"),
]


def sanitize(text: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "_", text).strip()


def derive_institutional_slug(title: str | None) -> str:
    if title:
        for pattern, slug in _INSTITUTIONAL_SLUGS:
            if pattern.search(title):
                return slug
    return "Institutional"


def person_label(item: dict) -> str:
    if item["person_folder_key"]:
        return sanitize(f"{item['person_last_name']} {item['person_first_name']}")
    if item["is_institutional"]:
        return derive_institutional_slug(item["title"])
    return "Unmatched"


def identity_slot(item: dict) -> str:
    if item["person_identifier_type"] == "bioguide":
        return item["person_bioguide_id"]
    if item["person_identifier_type"] == "name_slug":
        return f"NC-{item['person_folder_key']}"
    return "NOPERSON"


def top_level_folder(item: dict) -> str:
    if item["person_folder_key"]:
        return sanitize(item["person_last_name"])
    if item["is_institutional"]:
        return "Institutional"
    return "Unmatched-No-Person"


def base_name(item: dict) -> str:
    date = item["publish_date"] or "0000-00-00"
    source = _ID_TYPE_TO_SOURCE[item["id_type"]]
    return f"{person_label(item)}_{identity_slot(item)}_{date}_{source}_{item['canonical_id']}"


def video_filename(item: dict, quality: str, ext: str = "mp4") -> str:
    suffix = "_proxy" if quality == "proxy" else ""
    return f"{base_name(item)}{suffix}.{ext}"


def metadata_filename(item: dict) -> str:
    return f"{base_name(item)}_metadata.json"


def transcript_filename(item: dict) -> str:
    return f"{base_name(item)}_transcript.srt"
