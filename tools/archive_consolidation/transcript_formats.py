"""Parsers for every transcript/caption format found in the archive, all
normalizing to the same shape: a list of (start_seconds, end_seconds,
text) tuples. One writer (write_srt) turns that into the brief's target
format regardless of which parser produced it.

Format zoo found by inspecting real files rather than assuming from
extension alone:
  .srt              standard SubRip -- C-SPAN closed-caption exports,
                     often ALL CAPS with a legal boilerplate line
  .vtt              WebVTT -- same content as the .srt sibling when both
                     exist, with <v SPEAKER> tags instead of a prefix
  .json3            YouTube's caption API format -- word-level "segs"
                     grouped into caption-line "events"
  transcript*.csv   StartMs,EndMs,Start,End,Text -- clean and precise,
                     preferred over parsing .srt/.vtt text when present
  *.timestamped.txt "[HH:MM:SS] text" per line, start time only -- end is
                     approximated from the next line's start
  *.transcript.json Basiq Studio Hub's own {segments:[{start,end,text}]}
  *.clean.json      transcriptor's {chunks:[{start_time,end_time,text}]},
                     coarser (~40s) chunks but clean full sentences

Every parser returns [] (not an exception) on a file it can't make sense
of -- resolve_transcript_source.py tries formats in priority order and
moves on, so a single malformed file should never take down a batch run.
"""

import csv
import json
import re
from dataclasses import dataclass


@dataclass
class Segment:
    start: float
    end: float
    text: str


_BOILERPLATE_PATTERNS = [
    re.compile(r"\[CAPTIONING MADE POSSIBLE BY.*?\]", re.IGNORECASE | re.DOTALL),
    re.compile(r"\[END OF (CAPTION|TAPE|TRANSCRIPT)\]", re.IGNORECASE),
]


def clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)  # <v SPEAKER>, <i>, etc.
    for pattern in _BOILERPLATE_PATTERNS:
        text = pattern.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def _srt_timecode_to_seconds(tc: str) -> float:
    h, m, rest = tc.split(":")
    s, ms = re.split(r"[,.]", rest)
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def parse_srt(path) -> list[Segment]:
    try:
        text = _read_text(path)
    except OSError:
        return []
    blocks = re.split(r"\r?\n\r?\n+", text.strip())
    segments = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue
        # Line 0 is normally a cue number, line 1 the timecode -- but a few
        # exports skip the cue number, putting the timecode first.
        tc_index = 1 if "-->" in lines[1] else 0
        m = re.search(r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})", lines[tc_index])
        if not m:
            continue
        start, end = _srt_timecode_to_seconds(m.group(1)), _srt_timecode_to_seconds(m.group(2))
        body = clean_text(" ".join(lines[tc_index + 1:]))
        if body:
            segments.append(Segment(start, end, body))
    return segments


def parse_vtt(path) -> list[Segment]:
    try:
        text = _read_text(path)
    except OSError:
        return []
    text = re.sub(r"^WEBVTT.*?\n\n", "", text, flags=re.DOTALL)
    blocks = re.split(r"\r?\n\r?\n+", text.strip())
    segments = []
    for block in blocks:
        lines = [l for l in block.strip().splitlines() if l.strip()]
        if not lines:
            continue
        timecode_line = next((l for l in lines if "-->" in l), None)
        if not timecode_line:
            continue
        m = re.search(r"(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})", timecode_line)
        if not m:
            continue
        start, end = _srt_timecode_to_seconds(m.group(1)), _srt_timecode_to_seconds(m.group(2))
        text_lines = lines[lines.index(timecode_line) + 1:]
        body = clean_text(" ".join(text_lines))
        if body:
            segments.append(Segment(start, end, body))
    return segments


def parse_transcript_csv(path) -> list[Segment]:
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
    except (OSError, csv.Error):
        return []
    segments = []
    for row in rows:
        try:
            start = float(row["StartMs"]) / 1000
            end = float(row["EndMs"]) / 1000
        except (KeyError, ValueError):
            continue
        body = clean_text(row.get("Text", ""))
        if body:
            segments.append(Segment(start, end, body))
    return segments


def parse_timestamped_txt(path) -> list[Segment]:
    try:
        lines = _read_text(path).splitlines()
    except OSError:
        return []
    raw = []
    pattern = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$")
    for line in lines:
        m = pattern.match(line.strip())
        if not m:
            continue
        h, mi, s, body = m.groups()
        start = int(h) * 3600 + int(mi) * 60 + int(s)
        body = clean_text(body)
        if body:
            raw.append([start, None, body])
    for i, seg in enumerate(raw):
        seg[1] = raw[i + 1][0] if i + 1 < len(raw) else seg[0] + 3.0
    return [Segment(s, e, t) for s, e, t in raw]


def parse_json3(path) -> list[Segment]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    segments = []
    for event in data.get("events", []):
        if "segs" not in event:
            continue
        body = clean_text("".join(seg.get("utf8", "") for seg in event["segs"]))
        if not body:
            continue
        start = event.get("tStartMs", 0) / 1000
        end = start + event.get("dDurationMs", 0) / 1000
        segments.append(Segment(start, end, body))
    return segments


def parse_simple_segments_json(path, list_key: str, start_key: str, end_key: str, text_key: str) -> list[Segment]:
    """Covers both Basiq's {"segments": [{"start","end","text"}]} and
    transcriptor's {"chunks": [{"start_time","end_time","text"}]}."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get(list_key)
    if not isinstance(items, list):
        return []
    segments = []
    for item in items:
        try:
            start, end = float(item[start_key]), float(item[end_key])
        except (KeyError, TypeError, ValueError):
            continue
        body = clean_text(item.get(text_key, ""))
        if body:
            segments.append(Segment(start, end, body))
    return segments


def parse_transcript_json_auto(path) -> list[Segment]:
    """Dispatches *.transcript.json (Basiq: {"segments":[{start,end,text}]})
    vs *.clean.json (transcriptor: {"chunks":[{start_time,end_time,text}]})
    by peeking at which key is actually present, not by filename, since
    both share the transcript_json file role."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data.get("segments"), list):
        return parse_simple_segments_json(path, "segments", "start", "end", "text")
    if isinstance(data.get("chunks"), list):
        return parse_simple_segments_json(path, "chunks", "start_time", "end_time", "text")
    return []


def _read_text(path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "cp1252"):
        try:
            with open(path, encoding=encoding) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def _seconds_to_srt_timecode(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    total_ms = round(seconds * 1000)
    h, rem = divmod(total_ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments: list[Segment], out_path) -> int:
    """Writes segments as SRT, dropping empty text and enforcing end >
    start (a few source formats have zero-length or negative gaps).
    Returns the number of cues written."""
    cues = [s for s in segments if s.text and s.end > s.start]
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        for i, seg in enumerate(cues, start=1):
            f.write(f"{i}\n")
            f.write(f"{_seconds_to_srt_timecode(seg.start)} --> {_seconds_to_srt_timecode(seg.end)}\n")
            f.write(f"{seg.text}\n\n")
    return len(cues)
