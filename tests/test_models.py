"""Model discovery, routing and shared chat selection contracts (no GPU needed)."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dashboard", Path(__file__).resolve().parents[1] / "hermes-dashboard-server.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.state = {"online": True, "engine": {"active": "ollama", "state": "ready"},
                      "ollama": [{"name": "resident:9b"}]}
        self.catalog = {"engine": "ollama", "default": "resident:9b",
                        "data": [{"id": "resident:9b"}, {"id": "unloaded:8b"}]}
        self.handler = object.__new__(dashboard.Handler)
        self.handler.headers = {}
        self.proxied = []
        self.errors = []
        self.handler._proxy = lambda *a, **kw: self.proxied.append((a, kw))
        self.handler._err = lambda *a: self.errors.append(a)

    def send(self, model="resident:9b"):
        with patch.object(dashboard, "_snap", return_value=self.state), \
             patch.object(dashboard, "installed_models", return_value=self.catalog):
            self.handler._chat(json.dumps({"model": model, "messages": [], "stream": True}).encode())

    def test_unloaded_selection_reaches_ollama(self):
        self.handler.headers = {"X-Chat-Model": "unloaded:8b", "X-Chat-Engine": "ollama"}
        self.send()
        args, kwargs = self.proxied[0]
        self.assertEqual(args[0], dashboard.OLLAMA + "/v1/chat/completions")
        self.assertEqual(json.loads(args[2])["model"], "unloaded:8b")
        self.assertTrue(args[4])

    def test_standard_api_body_selection(self):
        self.send("unloaded:8b")
        self.assertEqual(json.loads(self.proxied[0][0][2])["model"], "unloaded:8b")

    def test_unknown_model_never_reaches_upstream(self):
        self.send("not-installed:99b")
        self.assertEqual(self.errors[0][0], 400)
        self.assertFalse(self.proxied)

    def test_engine_change_does_not_silently_use_another_model(self):
        self.state["engine"] = {"active": "strata", "state": "ready"}
        self.handler.headers = {"X-Chat-Model": "unloaded:8b", "X-Chat-Engine": "ollama"}
        self.send()
        self.assertEqual(self.errors[0][0], 409)
        self.assertFalse(self.proxied)

    def test_agent_uses_selected_ollama_model(self):
        self.handler.headers = {"X-Chat-Target": "agent", "X-Chat-Model": "unloaded:8b"}
        with patch.object(dashboard, "AGENT_URL", "http://agent"):
            self.send()
        body = json.loads(self.proxied[0][0][2])
        self.assertEqual(body["model"], "unloaded:8b")
        self.assertEqual(body["provider"], dashboard.AGENT_PROVIDER_OLLAMA)

    def test_asleep_agent_keeps_its_default(self):
        self.state["online"] = False
        self.handler.headers = {"X-Chat-Target": "agent", "X-Chat-Model": "unloaded:8b", "X-Chat-Engine": "ollama"}
        with patch.object(dashboard, "AGENT_URL", "http://agent"):
            self.send()
        body = json.loads(self.proxied[0][0][2])
        self.assertEqual(body["model"], "hermes-agent")
        self.assertNotIn("provider", body)

    def test_discovery_reads_installed_not_resident_models(self):
        import io
        response = io.BytesIO(json.dumps({"models": [{"name": "unloaded:8b"}, {"name": "resident:9b"}]}).encode())
        with patch.object(dashboard.urllib.request, "urlopen", return_value=response) as fetch:
            result = dashboard.installed_models(self.state)
        self.assertEqual(fetch.call_args.args[0], dashboard.OLLAMA + "/api/tags")
        self.assertEqual([m["id"] for m in result["data"]], ["resident:9b", "unloaded:8b"])

    def test_shared_history_keeps_selection(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(dashboard, "CHATS_DIR", directory):
            dashboard.chat_put("model-test", {"messages": [{"role": "user", "text": "test"}], "model": "unloaded:8b"})
            dashboard.chat_put("model-test", {"title": "Renamed"})
            self.assertEqual(dashboard.chat_get("model-test")["model"], "unloaded:8b")

    def test_strata_catalog_keeps_both_variants_and_active_default(self):
        self.state["engine"] = {"active": "strata", "state": "loading", "model": "qwen3.8-flash-next-q2_0"}
        self.state["strata_models"] = dashboard.strata_models({"strata_installed_q2_0": "1", "strata_installed_coder_iq1_m": "1"})
        result = dashboard.installed_models(self.state)
        self.assertEqual(result["default"], "qwen3.8-flash-next-q2_0")
        self.assertEqual(result["state"], "loading")
        self.assertEqual(len(result["data"]), 2)

    def test_strata_inventory_excludes_missing_variants(self):
        models = dashboard.strata_models({"strata_installed_coder_iq1_m": "1"})
        self.assertEqual([m["id"] for m in models], ["qwen3.8-flash-next-coder-iq1_m"])

    def test_stale_strata_selection_never_reaches_current_model(self):
        self.state["engine"] = {"active": "strata", "state": "idle", "model": "qwen3.8-flash-next-q2_0"}
        self.handler.headers = {"X-Chat-Model": "qwen3.8-flash-next-coder-iq1_m", "X-Chat-Engine": "strata"}
        self.send()
        self.assertEqual(self.errors[0][0], 409)
        self.assertFalse(self.proxied)

    def test_stale_strata_body_selection_is_rejected(self):
        self.state["engine"] = {"active": "strata", "state": "idle", "model": "qwen3.8-flash-next-q2_0"}
        self.send("qwen3.8-flash-next-coder-iq1_m")
        self.assertEqual(self.errors[0][0], 409)
        self.assertFalse(self.proxied)

    def test_active_strata_id_reaches_upstream(self):
        self.state["engine"] = {"active": "strata", "state": "idle", "model": "qwen3.8-flash-next-q2_0"}
        self.handler.headers = {"X-Chat-Model": "qwen3.8-flash-next-q2_0", "X-Chat-Engine": "strata"}
        with patch.object(dashboard, "STRATA_URL", "http://strata"):
            self.send("qwen3.8-flash-next-q2_0")
        self.assertEqual(json.loads(self.proxied[0][0][2])["model"], "qwen3.8-flash-next-q2_0")

    def test_switch_uses_allowlisted_variant_and_rejects_unknown_model(self):
        with patch.object(dashboard, "pc_os", return_value="linux"), \
             patch.object(dashboard.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "ok"
            self.assertTrue(dashboard.engine_action("strata", "qwen3.8-flash-next-q2_0")[0])
            self.assertEqual(run.call_args.args[0][-1], "/usr/local/bin/llm-engine strata q2_0")
            run.reset_mock()
            self.assertFalse(dashboard.engine_action("strata", "not-installed")[0])
            self.assertFalse(dashboard.engine_action("ollama", "qwen3.8-flash-next-q2_0")[0])
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
