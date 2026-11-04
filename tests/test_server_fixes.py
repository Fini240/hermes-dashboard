"""Audit fixes: sensor parsing, request gate, CPU delta resets, prompt handling (no PC needed)."""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dashboard", Path(__file__).resolve().parents[1] / "hermes-dashboard-server.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)

TAIL = "100.91.75.45"      # a tailnet client
LAN = "192.168.178.50"     # home Wi-Fi, no Tailscale


class NumTests(unittest.TestCase):
    def test_missing_and_empty_are_none(self):
        self.assertIsNone(dashboard._num({}, "x"))
        self.assertIsNone(dashboard._num({"x": ""}, "x"))
        self.assertIsNone(dashboard._num({"x": "  "}, "x"))
        self.assertIsNone(dashboard._num(None, "x"))

    def test_garbage_is_none(self):
        for v in ("abc", "12abc", "nan", "inf", None, [1]):
            self.assertIsNone(dashboard._num({"x": v}, "x"), v)

    def test_numbers_and_scale(self):
        self.assertEqual(dashboard._num({"x": "0"}, "x"), 0)          # a real zero stays zero
        self.assertEqual(dashboard._num({"x": "42"}, "x"), 42)
        self.assertIsInstance(dashboard._num({"x": "42"}, "x"), int)
        self.assertEqual(dashboard._num({"x": "12.5"}, "x"), 12.5)
        self.assertEqual(dashboard._num({"x": "50000"}, "x", 1000), 50.0)
        self.assertEqual(dashboard._num({"x": "28000000"}, "x", 1e6), 28.0)


class PcStatsTests(unittest.TestCase):
    PROBE = {"_os": "linux", "gpu_busy": "12.4", "vram_used": "2187538432", "vram_total": "12868124672",
             "gpu_temp_edge": "47000", "gpu_temp_junction": "50000", "gpu_temp_junction_crit": "110000",
             "gpu_temp_mem": "58000", "gpu_power": "28000000", "gpu_power_cap": "211000000",
             "gpu_fan": "0", "gpu_fan_max": "3300", "pcie_speed": "8", "pcie_width": "16",
             "pcie_max_speed": "8", "pcie_max_width": "16", "mem_total": "49220572", "mem_avail": "43315312",
             "cpu_temp": "44750", "cpu_freq": "3845685", "cpu_freq_max": "4204630", "ncpu": "16",
             "load": "0.85", "uptime": "3241"}

    def test_full_probe(self):
        p = dashboard.pc_stats(self.PROBE, 40.0, 10.0)
        self.assertEqual(p["temp"], 50.0)            # junction, not the hottest (mem) and not edge
        self.assertEqual(p["temp_mem"], 58.0)
        self.assertEqual(p["temp_edge"], 47.0)
        self.assertEqual(p["temp_crit"], 110.0)
        self.assertEqual(p["busy"], 12.4)
        self.assertEqual(p["fan"], 0)
        self.assertAlmostEqual(p["cpu_freq_max"], 4.20463)
        self.assertEqual(p["pcie_link"], "Gen3 x16 · 8 GT/s")
        self.assertEqual((p["pcie_gen"], p["pcie_gen_max"], p["pcie_width"]), (3, 3, 16))
        self.assertAlmostEqual(p["total_watts"], (40 + 28 + dashboard.SYSTEM_OVERHEAD_W) / dashboard.PSU_EFFICIENCY)
        self.assertAlmostEqual(p["ram_pct"], 100 * (49220572 - 43315312) / 49220572)

    def test_empty_probe_gives_none_not_zero(self):
        p = dashboard.pc_stats({"_os": "windows", "gpu_power": "", "gpu_temp_junction": ""}, None, None)
        for k in ("busy", "temp", "temp_mem", "power", "power_cap", "fan", "cpu_temp", "cpu_freq",
                  "cpu_freq_max", "mem_used", "ram_pct", "load", "total_watts", "pcie_link", "vram_total"):
            self.assertIsNone(p[k], k)

    def test_unlabelled_temps_fall_back_to_hottest(self):
        j, mem, edge, crit = dashboard.gpu_temps({"gpu_temp_temp1": "40000", "gpu_temp_temp2": "71000"})
        self.assertEqual((j, mem, edge, crit), (71.0, None, None, None))

    def test_hardware_block_keys(self):
        hw = dashboard.hardware(dashboard.pc_stats(self.PROBE, None, None))
        self.assertEqual(hw["gpu_temp"], 50.0)
        self.assertEqual(hw["gpu_mem_temp"], 58.0)
        self.assertEqual(hw["gpu_pcie_gen"], 3)
        self.assertEqual(hw["gpu_pcie_width"], 16)
        self.assertIsNone(hw["gpu_pcie_rx_mb"])      # amdgpu has no throughput counter
        self.assertIsNone(hw["total_watts"])         # no CPU watts yet -> no estimate


class GateTests(unittest.TestCase):
    def allowed(self, method, path, headers=None, ip=TAIL):
        return dashboard._request_allowed(method, path, headers or {}, ip)

    def test_controls_are_tailnet_only(self):
        for path in ("api/power", "api/engine", "api/display", "api/rgb", "api/rgbauto", "slots", "props",
                     "v1/chat/completions", "api/chats/x"):
            self.assertEqual(self.allowed("POST", path, {"Host": "192.168.178.164:8765"}, LAN)[0], 403, path)
        self.assertEqual(self.allowed("GET", "props", {}, LAN)[0], 403)

    def test_wake_stays_open(self):
        self.assertIsNone(self.allowed("POST", "api/wake", {"Host": "192.168.178.164:8765",
                                                            "Content-Length": "0"}, LAN))

    def test_relay_server_to_server(self):
        # wake_via_relay_dashboard: urllib POST, empty body, no Origin, Host = the relay's IP
        self.assertIsNone(self.allowed("POST", "api/wake", {"Host": "100.123.82.82:8765", "Content-Length": "0",
                                                            "Content-Type": "application/x-www-form-urlencoded"}))

    def test_plain_gets_unaffected(self):
        self.assertIsNone(self.allowed("GET", "api/stats", {"Host": "evil.example.com"}, LAN))
        self.assertIsNone(self.allowed("GET", "metrics", {}, LAN))

    def test_host_names(self):
        for host in ("100.123.82.82:8765", "localhost:8765", "zimaos:8765", "zimaos.tailff2e9e.ts.net",
                     "[::1]:8765", "127.0.0.1"):
            self.assertIsNone(self.allowed("POST", "api/power", {"Host": host}), host)
        self.assertEqual(self.allowed("POST", "api/power", {"Host": "rebind.evil.com:8765"})[0], 403)
        with patch.object(dashboard, "ALLOWED_HOSTS", {"dash.example.org"}):
            self.assertIsNone(self.allowed("POST", "api/power", {"Host": "dash.example.org"}))

    def test_origin(self):
        h = {"Host": "100.123.82.82:8765"}
        self.assertIsNone(self.allowed("POST", "api/power", dict(h, Origin="http://100.123.82.82:8765")))
        self.assertEqual(self.allowed("POST", "api/power", dict(h, Origin="https://evil.com"))[0], 403)
        self.assertEqual(self.allowed("POST", "api/power", dict(h, Origin="null"))[0], 403)
        self.assertEqual(self.allowed("POST", "api/wake", dict(h, Origin="http://100.123.82.82:9999"))[0], 403)
        # scheme-agnostic, default ports ignored (tailscale serve https in front)
        ts = {"Host": "zimaos.tailff2e9e.ts.net", "Origin": "https://zimaos.tailff2e9e.ts.net"}
        self.assertIsNone(self.allowed("POST", "api/power", ts))
        # behind a local proxy that rewrote Host, X-Forwarded-Host counts — but only from loopback
        fwd = {"Host": "127.0.0.1:8765", "X-Forwarded-Host": "zimaos.tailff2e9e.ts.net",
               "Origin": "https://zimaos.tailff2e9e.ts.net"}
        self.assertIsNone(self.allowed("POST", "api/power", fwd, "127.0.0.1"))
        self.assertEqual(self.allowed("POST", "api/power", fwd, TAIL)[0], 403)

    def test_body_rules(self):
        h = {"Host": "localhost:8765"}
        self.assertEqual(self.allowed("POST", "api/power", dict(h, **{"Content-Length": "5",
                                                                      "Content-Type": "text/plain"}))[0], 415)
        self.assertIsNone(self.allowed("POST", "api/power", dict(h, **{"Content-Length": "5",
                                       "Content-Type": "application/json; charset=utf-8"})))
        self.assertEqual(self.allowed("POST", "api/power", dict(h, **{"Content-Length": "-1"}))[0], 400)
        self.assertEqual(self.allowed("POST", "api/power", dict(h, **{"Content-Length": "abc"}))[0], 400)
        big = str(dashboard.MAX_BODY + 1)
        self.assertEqual(self.allowed("PUT", "api/chats/x", dict(h, **{"Content-Length": big,
                                      "Content-Type": "application/json"}))[0], 413)

    def test_put_delete_tailnet_only(self):
        self.assertEqual(self.allowed("PUT", "api/chats/x", {}, LAN)[0], 403)
        self.assertEqual(self.allowed("DELETE", "api/chats/x", {}, LAN)[0], 403)
        self.assertIsNone(self.allowed("DELETE", "api/chats/x", {"Host": "localhost"}))


class CpuDeltaTests(unittest.TestCase):
    def pc(self, energy, stat_total_idle, uptime=1000, os_="linux", now_ns=None):
        total, idle = stat_total_idle
        d = {"_os": os_, "cpu_energy": str(energy), "cpu_energy_max": "1000000000", "uptime": str(uptime),
             "cpu_stat": "cpu %d 0 0 %d" % (total - idle, idle)}
        if now_ns is not None:
            d["now_ns"] = str(now_ns)
        return d

    def test_normal_delta(self):
        _, _, st = dashboard.cpu_deltas(None, self.pc(1_000_000, (1000, 900)), 100.0, 6)
        w, pct, st = dashboard.cpu_deltas(st, self.pc(81_000_000, (1200, 1000), 1002), 102.0, 6)
        self.assertAlmostEqual(w, 40.0)
        self.assertAlmostEqual(pct, 50.0)

    def test_uses_pc_clock(self):
        _, _, st = dashboard.cpu_deltas(None, self.pc(0, (1, 0), now_ns=10_000_000_000), 100.0, 6)
        w, _, _ = dashboard.cpu_deltas(st, self.pc(50_000_000, (2, 0), now_ns=11_000_000_000), 103.0, 6)
        self.assertAlmostEqual(w, 50.0)                   # 1 s on the PC, not 3 s here

    def test_resets(self):
        _, _, st = dashboard.cpu_deltas(None, self.pc(1_000_000, (1000, 900)), 100.0, 6)
        self.assertEqual(dashboard.cpu_deltas(st, None, 102.0, 6), (None, None, None))      # unreachable
        w, p, _ = dashboard.cpu_deltas(st, self.pc(9_000_000, (1100, 950), uptime=5), 102.0, 6)
        self.assertEqual((w, p), (None, None))                                           # rebooted
        w, p, _ = dashboard.cpu_deltas(st, self.pc(9_000_000, (1100, 950), os_="windows"), 102.0, 6)
        self.assertEqual((w, p), (None, None))                                           # other OS
        w, p, _ = dashboard.cpu_deltas(st, self.pc(9_000_000, (1100, 950)), 110.0, 6)
        self.assertEqual((w, p), (None, None))                                           # gap too long

    def test_wrap_only_near_the_top(self):
        _, _, st = dashboard.cpu_deltas(None, self.pc(990_000_000, (1, 0)), 100.0, 6)
        w, _, _ = dashboard.cpu_deltas(st, self.pc(30_000_000, (2, 0)), 101.0, 6)
        self.assertAlmostEqual(w, 40.0)                   # (1e9 - 990e6) + 30e6 µJ in 1 s
        _, _, st = dashboard.cpu_deltas(None, self.pc(500_000_000, (1, 0)), 100.0, 6)
        w, _, st2 = dashboard.cpu_deltas(st, self.pc(30_000_000, (2, 0)), 101.0, 6)
        self.assertIsNone(w)                              # a reset, not a wrap: re-seed
        self.assertEqual(st2["energy"], 30_000_000)


class PromptAndJsonTests(unittest.TestCase):
    def test_with_system_keeps_user_prompts(self):
        body = {"messages": [{"role": "system", "content": "You are a pirate. Answer in rhymes."},
                             {"role": "system", "content": dashboard.system_note("old", False, False)},
                             {"role": "user", "content": "hi"}]}
        dashboard.with_system(body, dashboard.system_note("new-model", False, False))
        contents = [m["content"] for m in body["messages"]]
        self.assertIn("You are a pirate. Answer in rhymes.", contents)
        self.assertEqual(sum(dashboard.IDENTITY_MARK in c for c in contents), 1)
        self.assertIn("new-model", contents[0])

    def test_json_field_non_dict(self):
        h = object.__new__(dashboard.Handler)
        self.assertEqual(h._json_field(b'["action"]', "action"), "")
        self.assertEqual(h._json_field(b'"x"', "action", None), None)
        self.assertEqual(h._json_field(b"not json", "action"), "")
        self.assertEqual(h._json_field(b'{"action": "suspend"}', "action"), "suspend")


class MetricsTests(unittest.TestCase):
    def snap(self, **kw):
        s = {"online": True, "engine": {"active": "ollama", "state": "ready"}, "ts": 1.0,
             "pc": dashboard.pc_stats(PcStatsTests.PROBE, None, None), "gen_rate": 50.0, "gen_age": 2.0,
             "last_request": {"time": 1.0, "decode_tok_s": 50.0}}
        s.update(kw)
        return s

    def test_finished_ollama_response_is_not_generating(self):
        m = dashboard.synth_metrics(self.snap())         # busy 12 %: the response is over
        self.assertEqual(m["live"]["state"], "idle")
        self.assertEqual(m["requests"], [{"time": 1.0, "decode_tok_s": 50.0}])

    def test_states(self):
        busy = dict(self.snap()["pc"], busy=90.0)
        self.assertEqual(dashboard.synth_metrics(self.snap(pc=busy))["live"]["state"], "generating")
        self.assertEqual(dashboard.synth_metrics(self.snap(engine={"active": "h3", "state": "rendering"}))
                         ["live"]["state"], "rendering")
        self.assertEqual(dashboard.synth_metrics(self.snap(engine={"active": "strata", "state": "loading"}))
                         ["live"]["state"], "loading")
        self.assertEqual(dashboard.synth_metrics(self.snap(online=False))["live"]["state"], "asleep")

    def test_last_request_from_journal(self):
        pc = {"gen_ts": "1000", "gen_rate": "52.83", "gen_ms": "5678.90", "gen_tokens": "300",
              "prompt_ms": "123.45", "prompt_tokens": "50"}
        r = dashboard.last_ollama_request(pc, 1010.0)
        self.assertEqual((r["time"], r["decode_tok_s"], r["output_tokens"], r["prompt_tokens"]), (1000, 52.83, 300, 50))
        self.assertAlmostEqual(r["duration_s"], 5.80235)
        self.assertIsNone(dashboard.last_ollama_request(pc, 1000 + 8000))


if __name__ == "__main__":
    unittest.main()
