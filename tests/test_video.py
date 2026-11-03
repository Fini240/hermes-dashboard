"""Video tab (h3-engine) routing and the H3 engine state (no GPU needed)."""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dashboard", Path(__file__).resolve().parents[1] / "hermes-dashboard-server.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


class VideoTests(unittest.TestCase):
    def setUp(self):
        self.state = {"online": True, "engine": {"active": "strata", "state": "idle"}}
        self.handler = object.__new__(dashboard.Handler)
        self.handler.headers = {}
        self.proxied, self.errors, self.files = [], [], []
        self.handler._proxy = lambda *a, **kw: self.proxied.append((a, kw))
        self.handler._err = lambda *a: self.errors.append(a)
        self.handler._video_file = lambda url: self.files.append(url)

    def call(self, method, path, raw=None, url="http://pc:8660", key="secret"):
        with patch.object(dashboard, "_snap", return_value=self.state), \
             patch.object(dashboard, "H3_URL", url), patch.object(dashboard, "H3_KEY", key):
            self.handler._video(method, path, "", raw)

    def test_video_paths_are_tailnet_only(self):
        self.assertTrue("api/video/jobs".startswith(dashboard.CONTROL_PATHS))

    def test_not_configured(self):
        self.call("GET", "api/video/jobs", url="")
        self.assertEqual(self.errors[0][0], 503)

    def test_asleep(self):
        self.state["online"] = False
        self.call("GET", "api/video/jobs")
        self.assertEqual(self.errors[0][0], 503)
        self.assertFalse(self.proxied)

    def test_job_post_carries_key_and_body(self):
        self.call("POST", "api/video/jobs", b'{"prompt":"x"}')
        args, kw = self.proxied[0]
        self.assertEqual(args[0], "http://pc:8660/api/jobs")
        self.assertEqual(args[1], "POST")
        self.assertEqual(args[2], b'{"prompt":"x"}')
        self.assertEqual(args[3], "secret")

    def test_health_without_key(self):
        self.call("GET", "api/video/health")
        self.assertEqual(self.proxied[0][0][0], "http://pc:8660/health")

    def test_files_are_streamed(self):
        self.call("GET", "api/video/files/20261103-120000-abcdef/video.mp4")
        self.assertEqual(self.files, ["http://pc:8660/files/20261103-120000-abcdef/video.mp4"])

    def test_path_traversal_rejected(self):
        self.call("GET", "api/video/files/../../etc/passwd")
        self.assertEqual(self.errors[0][0], 400)
        self.assertFalse(self.proxied or self.files)

    def test_chat_refused_while_h3_holds_gpu(self):
        self.state["engine"] = {"active": "h3", "state": "rendering"}
        with patch.object(dashboard, "_snap", return_value=self.state):
            self.handler._chat(json.dumps({"model": "x", "messages": []}).encode())
        self.assertEqual(self.errors[0][0], 503)
        self.assertIn("video", self.errors[0][1])
        self.assertFalse(self.proxied)

    def test_model_list_explains_h3(self):
        with self.assertRaises(ValueError) as cm:
            dashboard.installed_models({"online": True, "engine": {"active": "h3", "state": "ready"}})
        self.assertIn("video", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
