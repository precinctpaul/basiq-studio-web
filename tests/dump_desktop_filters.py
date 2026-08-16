"""
Dump the desktop app's real filter-graph output as JSON, for the web port's
parity test to compare against.

READ-ONLY against C:\\dev\\basiq_studio_hub. PYTHONDONTWRITEBYTECODE is set by
the caller so importing the package cannot even drop a .pyc into it.
"""
import json
import os
import sys

DESKTOP = os.environ.get("DESKTOP_APP_DIR") or r"C:\dev\basiq_studio_hub"
sys.path.insert(0, DESKTOP)

from app.config import Settings, ASPECT_MODES            # noqa: E402
from app.ffmpeg_ops import (                             # noqa: E402
    MediaInfo,
    build_audio_chain,
    build_video_chain,
    crop_geometry,
    plan_clip,
)

SLUGS = {
    ASPECT_MODES[0]: "native",
    ASPECT_MODES[1]: "vertical_crop",
    ASPECT_MODES[2]: "vertical_blur",
}

settings = Settings()
info = MediaInfo(path="x", width=1920, height=1080, has_video=True, has_audio=True)

video = []
for aspect in ASPECT_MODES:
    for blur_ok in (True, False):
        for ox, oy in ((0.0, 0.0), (0.5, 0.0), (-0.5, 0.25), (1.0, -1.0), (2.0, -3.0)):
            video.append({
                "aspect": SLUGS[aspect],
                "blur_ok": blur_ok,
                "offset_x": ox,
                "offset_y": oy,
                "chain": build_video_chain(
                    aspect, info, settings, blur_ok=blur_ok, offset_x=ox, offset_y=oy
                ),
            })

plans = []
audio = []
for in_pt, out_pt, dur in (
    (10.0, 40.0, 600.0),      # ordinary clip, room on both sides
    (0.0, 30.0, 600.0),       # butts the head — exercises the `or` fallback
    (580.0, 599.0, 600.0),    # butts the tail
    (0.0, 1.0, 1.0),          # degenerate: shorter than the pads
    (5.0, 5.0, 600.0),        # out <= in, the defensive branch
    (100.0, 130.0, 0.0),      # unknown source duration
):
    p = plan_clip(in_pt, out_pt, dur, settings)
    plans.append({
        "in": in_pt, "out": out_pt, "source_duration": dur,
        "plan": {
            "in_point": p.in_point, "out_point": p.out_point,
            "padded_in": p.padded_in, "padded_out": p.padded_out,
            "duration": p.duration, "fade_in": p.fade_in, "fade_out": p.fade_out,
            "fade_out_start": p.fade_out_start,
            "head_clipped": p.head_clipped, "tail_clipped": p.tail_clipped,
        },
    })
    audio.append({
        "in": in_pt, "out": out_pt, "source_duration": dur,
        "chain": build_audio_chain(p),
    })

geometry = []
for iw, ih in ((1920, 1080), (1080, 1920), (1280, 720), (0, 0), (1000, 1000)):
    for ox, oy in ((0.0, 0.0), (0.5, -0.5), (1.0, 1.0)):
        x, y, w, h = crop_geometry(iw, ih, ox, oy)
        geometry.append({
            "iw": iw, "ih": ih, "offset_x": ox, "offset_y": oy,
            "rect": {"x": x, "y": y, "w": w, "h": h},
        })

json.dump(
    {"video": video, "plans": plans, "audio": audio, "geometry": geometry},
    sys.stdout,
    indent=1,
)
