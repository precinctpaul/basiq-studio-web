"""Regression test for base_opts()'s YTDLP_PROXY env var handling.

Proxy support is meant to be per-identity insurance, off by default for
every worker -- this just confirms the opt-in wiring is correct and that
leaving YTDLP_PROXY unset never adds a "proxy" key at all. No network calls.

Run with:
    python tools/test_base_opts_proxy.py
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import basiq_agent  # noqa: E402


class BaseOptsProxyTest(unittest.TestCase):
    def setUp(self):
        self._orig = os.environ.pop("YTDLP_PROXY", None)

    def tearDown(self):
        if self._orig is not None:
            os.environ["YTDLP_PROXY"] = self._orig
        else:
            os.environ.pop("YTDLP_PROXY", None)

    def test_proxy_key_absent_by_default(self):
        opts = basiq_agent.base_opts("https://example.com")
        self.assertNotIn("proxy", opts)

    def test_proxy_key_set_when_env_var_present(self):
        os.environ["YTDLP_PROXY"] = "http://user:pass@proxy.example.com:8080"
        opts = basiq_agent.base_opts("https://example.com")
        self.assertEqual(opts["proxy"], "http://user:pass@proxy.example.com:8080")

    def test_blank_env_var_is_treated_as_unset(self):
        os.environ["YTDLP_PROXY"] = "   "
        opts = basiq_agent.base_opts("https://example.com")
        self.assertNotIn("proxy", opts)


if __name__ == "__main__":
    unittest.main()
