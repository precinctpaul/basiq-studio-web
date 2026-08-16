"""Regression test for the shared-drive (MEDIA_ROOT) branch of _grab_once.

grab-smoke.mjs only ever drives the Supabase-upload branch (it always passes
a signedUrl), so it never exercises store_in_media_root() or the code around
it. That's exactly the branch that broke: media_file.stat() was called AFTER
store_in_media_root() had already shutil.move()'d the file out from under it,
so every shared-drive GRAB reported "[WinError 2] The system cannot find the
file specified" even though the download itself succeeded.

This test fakes yt_dlp so it runs with no network access and no real
download, points MEDIA_ROOT at a temp directory, and drives _grab_once with
signed_url="" (the branch grab-smoke.mjs never takes) end to end.

Run with:
    python tools/test_grab_media_root.py
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import basiq_agent  # noqa: E402

FAKE_TITLE = "Fake Committee Hearing"
FAKE_CONTENT = b"not really a video, just some bytes to size" * 1000


class FakeYoutubeDL:
    """Stands in for yt_dlp.YoutubeDL: no network, writes a real file to
    disk on download=True so the rest of _grab_once (stat, move, size
    bookkeeping) runs unmodified against a real filesystem object."""

    def __init__(self, opts):
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        if not download:
            return {"title": FAKE_TITLE, "width": 1920, "height": 1080}
        workdir = Path(self.opts["outtmpl"]).parent
        media_path = workdir / f"{FAKE_TITLE}.mp4"
        media_path.write_bytes(FAKE_CONTENT)
        return {"uploader": "Fake Uploader", "upload_date": "20260101"}


class GrabMediaRootTest(unittest.TestCase):
    def setUp(self):
        self.media_root = Path(tempfile.mkdtemp(prefix="basiq_test_media_root_"))
        self._orig_media_root = basiq_agent.MEDIA_ROOT
        self._orig_yt_dlp = basiq_agent.yt_dlp
        basiq_agent.MEDIA_ROOT = self.media_root
        basiq_agent.yt_dlp = SimpleNamespace(YoutubeDL=FakeYoutubeDL)

    def tearDown(self):
        basiq_agent.MEDIA_ROOT = self._orig_media_root
        basiq_agent.yt_dlp = self._orig_yt_dlp
        shutil.rmtree(self.media_root, ignore_errors=True)

    def test_shared_drive_grab_reports_correct_size_and_files_the_media(self):
        """The exact regression: signed_url="" takes the store_in_media_root
        branch. Before the fix, media_file.stat() ran after shutil.move() had
        already relocated the file, and every such grab errored out."""
        job_id = basiq_agent.new_job()

        basiq_agent._grab_once(job_id, "https://example.com/hearing", "Proxy", False, "")

        job = basiq_agent.get_job(job_id)
        self.assertEqual(job["status"], "Complete", job.get("error"))
        result = job["result"]
        self.assertEqual(result["sizeBytes"], len(FAKE_CONTENT))
        self.assertEqual(result["localPath"], f"{FAKE_TITLE}.mp4")

        dest = self.media_root / f"{FAKE_TITLE}.mp4"
        self.assertTrue(dest.is_file(), "store_in_media_root did not leave the file on the shared drive")
        self.assertEqual(dest.stat().st_size, len(FAKE_CONTENT))

    def test_store_in_media_root_avoids_collisions(self):
        src_a = self.media_root.parent / "a.mp4"
        src_b = self.media_root.parent / "b.mp4"
        src_a.write_bytes(b"first")
        src_b.write_bytes(b"second")

        rel_a = basiq_agent.store_in_media_root(src_a, "Same Title")
        rel_b = basiq_agent.store_in_media_root(src_b, "Same Title")

        self.assertNotEqual(rel_a, rel_b)
        self.assertEqual((self.media_root / rel_a).read_bytes(), b"first")
        self.assertEqual((self.media_root / rel_b).read_bytes(), b"second")


if __name__ == "__main__":
    unittest.main()
