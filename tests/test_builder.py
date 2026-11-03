"""Builder (strata-agent) proxy and the plain-model identity note (no PC needed)."""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dashboard_b", Path(__file__).resolve().parents[1] / "hermes-dashboard-server.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


class BuilderProxyTests(unittest.TestCase):
    def setUp(self):
        self.h = object.__new__(dashboard.Handler)
        self.proxied, self.errors = [], []
        self.h._proxy = lambda *a, **kw: self.proxied.append((a, kw))
        self.h._err = lambda *a: self.errors.append(a)

    def call(self, method, path, query="", raw=None, url="http://agent:8650", key="k"):
        with patch.object(dashboard, "BUILDER_URL", url), patch.object(dashboard, "BUILDER_KEY", key), \
             patch.object(dashboard, "_snap", return_value={"online": True}):
            self.h._builder(method, path, query, raw)

    def test_unconfigured(self):
        self.call("GET", "api/builder/sessions", url="")
        self.assertEqual(self.errors[0][0], 503)

    def test_path_checks(self):
        for bad in ("api/builder/../secret", "api/builder/sessions?x", "api/builder/a b"):
            self.errors.clear()
            self.call("GET", bad)
            self.assertEqual(self.errors[0][0], 400, bad)
        self.assertEqual(self.proxied, [])

    def test_session_list_gets_key_and_api_prefix(self):
        self.call("GET", "api/builder/sessions")
        (url, method, body, key, stream), kw = self.proxied[0][0][:5], self.proxied[0][1]
        self.assertEqual((url, method, key, stream), ("http://agent:8650/api/sessions", "GET", "k", False))

    def test_events_stream_with_query(self):
        self.call("GET", "api/builder/sessions/20261008-1-abc/events", "after=12")
        args, kw = self.proxied[0]
        self.assertEqual(args[0], "http://agent:8650/api/sessions/20261008-1-abc/events?after=12")
        self.assertTrue(args[4])
        self.assertEqual(kw["timeout"], 3600)

    def test_post_message_body_passes_through(self):
        raw = json.dumps({"text": "hi"}).encode()
        self.call("POST", "api/builder/sessions/x/messages", raw=raw)
        self.assertEqual(self.proxied[0][0][2], raw)

    def test_health_has_no_key(self):
        self.call("GET", "api/builder/health")
        self.assertEqual(self.proxied[0][0][0], "http://agent:8650/health")
        self.assertEqual(self.proxied[0][0][3], "")

    def test_chat_keeps_builder_meta(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, patch.object(dashboard, "CHATS_DIR", d):
            dashboard.chat_put("abc-1", {"messages": [], "target": "builder",
                                         "builder": {"session": "s1", "project": "uhr"}})
            self.assertEqual(dashboard.chat_get("abc-1")["builder"], {"session": "s1", "project": "uhr"})
            self.assertEqual(dashboard.chats_list()[0]["project"], "uhr")


class IdentityNoteTests(unittest.TestCase):
    def test_note_replaces_old_copies(self):
        body = {"messages": [{"role": "system", "content": dashboard.RESEARCH_NOTE},
                             {"role": "system", "content": "You are an old note"},
                             {"role": "user", "content": "hi"}]}
        dashboard.with_system(body, dashboard.system_note(dashboard.STRATA_LABEL, True, True))
        sys_msgs = [m for m in body["messages"] if m["role"] == "system"]
        self.assertEqual(len(sys_msgs), 1)
        self.assertIn("not Claude", sys_msgs[0]["content"])
        self.assertIn("can see pictures", sys_msgs[0]["content"])
        self.assertIn(dashboard.RESEARCH_NOTE, sys_msgs[0]["content"])
        self.assertEqual(body["messages"][-1], {"role": "user", "content": "hi"})


if __name__ == "__main__":
    unittest.main()
