"""
Dump the desktop app's real group_paragraphs() output as JSON, for the web
port's parity test to compare against. READ-ONLY against basiq_studio_hub.
"""
import json
import os
import sys

DESKTOP = os.environ.get("DESKTOP_APP_DIR") or r"C:\dev\basiq_studio_hub"
sys.path.insert(0, DESKTOP)

from app.transcript import Segment, group_paragraphs  # noqa: E402

CASES = {
    "ordinary": [
        (0.0, 2.0, "This is the first sentence."),
        (2.1, 4.0, "And a second one right after it."),
        (4.1, 7.5, "A third sentence keeps the paragraph going"),
    ],
    "gap_forces_break": [
        (0.0, 2.0, "First paragraph starts here"),
        (5.0, 7.0, "Big silence before this one forces a new paragraph"),
    ],
    "sentence_end_variants": [
        (0.0, 1.0, "Ends with a question?"),
        (1.1, 2.0, "Starts a new paragraph after that"),
        (2.1, 3.0, "Ends with an ellipsis…"),
        (3.1, 4.0, "New paragraph again"),
        (4.1, 5.0, "Ends with a smart quote after a period.\u201d"),
        (5.1, 6.0, "New paragraph once more"),
        (6.1, 7.0, "Ends with a closing paren)"),
        (7.1, 8.0, "Last paragraph"),
    ],
    "max_chars_split": [
        (float(i), float(i) + 0.9, "word " * 20) for i in range(0, 40, 1)
    ],
    "empty": [],
    "single": [(0.0, 1.5, "Just one segment")],
    "zero_length_and_backwards": [
        (0.0, 0.0, "Zero duration segment"),
        (0.0, -1.0, "End before start, defensive"),
    ],
}


def run(segs):
    segments = [Segment(s, e, t) for (s, e, t) in segs]
    paras = group_paragraphs(segments)
    return {
        # Echo the inputs back so the JS side is purely data-driven from this
        # dump, rather than hand-duplicating the same case list in two
        # languages — the exact drift risk the filter-parity harness avoids.
        "input": [{"start": s, "end": e, "text": t} for (s, e, t) in segs],
        "paragraphs": [
            {"start": p.start, "end": p.end, "text": p.text, "n_segments": len(p.segments)}
            for p in paras
        ],
    }


json.dump({name: run(segs) for name, segs in CASES.items()}, sys.stdout, indent=1)
