"""
Dump the desktop app's real extract_topic_sections() output as JSON, for the
web port's parity test to compare against. READ-ONLY against basiq_studio_hub.
"""
import json
import os
import sys

DESKTOP = os.environ.get("DESKTOP_APP_DIR") or r"C:\dev\basiq_studio_hub"
sys.path.insert(0, DESKTOP)

from app.highlights import extract_topic_sections  # noqa: E402
from app.transcript import Paragraph  # noqa: E402

# Two clearly distinct topics, phrased like a hearing transcript, spread
# across enough duration to produce multiple ~75s sections.
HEALTHCARE = (
    "Healthcare funding remains a top priority for this committee this year. "
    "The proposed budget increases funding for rural hospitals and community "
    "health centers across the state. Members raised concerns about "
    "healthcare funding shortfalls affecting Medicaid reimbursement rates. "
    "Rural healthcare funding has fallen behind urban healthcare funding for "
    "the past decade according to committee staff. The chair emphasized that "
    "healthcare funding decisions this session will shape access for years."
)
INFRASTRUCTURE = (
    "Now turning to infrastructure spending for roads and bridges statewide. "
    "The department requests infrastructure funding to repair aging bridges "
    "that have been flagged as structurally deficient. Infrastructure "
    "spending on highway maintenance has lagged behind population growth in "
    "several counties. Members discussed whether infrastructure funding "
    "should prioritize rural roads or urban transit expansion this cycle. "
    "The ranking member asked how infrastructure spending compares to "
    "neighboring states over the past five years."
)


def make_two_topic_paragraphs():
    """Six paragraphs per topic, 12 total, ~15s apart -> ~165s duration."""
    paras = []
    t = 0.0
    for block in (HEALTHCARE, INFRASTRUCTURE):
        sentences = [s.strip() + "." for s in block.split(". ") if s.strip()]
        for s in sentences:
            paras.append((t, t + 14.0, s))
            t += 15.0
    return paras


CASES = {
    "two_distinct_topics": make_two_topic_paragraphs(),
    "too_short": [(0.0, 2.0, "Just a quick remark.")],
    "single_topic_repeated": [
        (i * 10.0, i * 10.0 + 9.0, "The budget committee discussed budget allocations for the budget cycle.")
        for i in range(12)
    ],
    "empty": [],
}


def run(paras):
    objs = [Paragraph(start=s, end=e, text=t, segments=[]) for (s, e, t) in paras]
    sections = extract_topic_sections(objs)
    return {
        "input": [{"start": s, "end": e, "text": t} for (s, e, t) in paras],
        "sections": [
            {"start": sec.start, "end": sec.end, "label": sec.label, "text": sec.text}
            for sec in sections
        ],
    }


json.dump({name: run(paras) for name, paras in CASES.items()}, sys.stdout, indent=1)
