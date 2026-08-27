#!/usr/bin/env python3
"""
hermes-dashboard — browser dashboard for a remote Ollama box + Hermes token usage.

Runs a small local server on the Mac. A background thread polls the PC
(sysfs over Tailscale SSH), Ollama, and ~/.hermes/state.db; the page fetches
that cached snapshot, so the browser never waits on SSH.

    ./hermes-dashboard-server.py            # then open http://localhost:8765
    ./hermes-dashboard-server.py -p 9000    # different port

Stdlib only — no pip install.
"""

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Every address below can be overridden from the environment, so one copy of
# this file serves both hosts: the Mac uses the defaults, zimaos passes its own
# values in (see docker-compose.yml next to this file). Keeping it one file
# means a fix here reaches both instead of drifting across a forked copy.
HOST = os.environ.get("HERMES_PC_HOST", "192.168.1.50")
# Display-only: the machine name in the header/title, and the GPU model shown
# on the GPU card. Ollama reports no GPU name, so this is a label, not a probe.
PC_NAME = os.environ.get("HERMES_PC_NAME", "ollama-box")
GPU_LABEL = os.environ.get("HERMES_GPU_LABEL", "GPU")
# Ollama binds the tailnet address only, so it is configured separately from
# the SSH host — on zimaos SSH goes over the LAN while Ollama goes over the
# tailnet, and those are two different addresses for the same machine.
OLLAMA = os.environ.get("HERMES_OLLAMA", "http://%s:11434" % HOST)
STATE_DB = os.path.expanduser(os.environ.get("HERMES_STATE_DB", "~/.hermes/state.db"))
POLL_SECONDS = 2.0
# Seconds of history the tok/s average is computed over.
RATE_WINDOW = 25.0
# Everything RAPL and the GPU sensor cannot see: chipset, RAM, NVMe, fans,
# USB. A rough constant, so the wall figure is labelled an estimate.
SYSTEM_OVERHEAD_W = 55.0
PSU_EFFICIENCY = 0.90

# --- wake-on-lan -----------------------------------------------------------
# The PC's wired NIC. `ethtool <iface> | grep Wake-on` must report "g" or the
# card ignores magic packets; set it with `ethtool -s <iface> wol g`.
MAC = os.environ.get("HERMES_PC_MAC", "aa:bb:cc:dd:ee:ff")
# The PC's home subnet, used both to decide "am I on the same LAN as the PC"
# and as the directed-broadcast target for the magic packet.
LAN_PREFIX = os.environ.get("HERMES_LAN_PREFIX", "192.168.1.")
LAN_BCAST = LAN_PREFIX + "255"
# Magic packets are layer-2 broadcast and do NOT traverse Tailscale. Away from
# home the packet must be emitted by something already on the PC's LAN; zimaos
# sits on both networks, so we ask it to do the shouting.
RELAY_HOST = os.environ.get("HERMES_RELAY_SSH_HOST", "")
# Dashboard on a box that shares the PC's LAN. Reached over Tailscale from
# anywhere; ?direct=1 tells it to broadcast itself and never relay onward,
# which stops two dashboards bouncing a wake request between each other.
RELAY_URL = os.environ.get(
    "HERMES_WAKE_RELAY_URL", "")

SSH_OPTS = [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
    "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/.hermes-dash-%r@%h",
    "-o", "ControlPersist=120s", "-o", "StrictHostKeyChecking=accept-new",
]

# On the Mac the agent supplies the key. In a container there is no agent, so
# the key and its known_hosts file are passed in explicitly; IdentitiesOnly
# stops ssh from offering anything else and tripping MaxAuthTries.
_SSH_KEY = os.environ.get("HERMES_SSH_KEY")
if _SSH_KEY:
    SSH_OPTS += [
        "-i", _SSH_KEY, "-o", "IdentitiesOnly=yes",
        "-o", "UserKnownHostsFile=" + os.environ.get(
            "HERMES_KNOWN_HOSTS", os.path.join(os.path.dirname(_SSH_KEY), "known_hosts")),
    ]

PROBE = r"""
for c in /sys/class/drm/card*/device; do
  [ -f "$c/gpu_busy_percent" ] || continue
  echo "gpu_busy=$(cat $c/gpu_busy_percent 2>/dev/null)"
  echo "vram_used=$(cat $c/mem_info_vram_used 2>/dev/null)"
  echo "vram_total=$(cat $c/mem_info_vram_total 2>/dev/null)"
  for h in $c/hwmon/hwmon*/; do
    echo "gpu_temp=$(cat ${h}temp1_input 2>/dev/null)"
    echo "gpu_power=$(cat ${h}power1_average 2>/dev/null)"
    echo "gpu_fan=$(cat ${h}fan1_input 2>/dev/null)"
  done
  break
done
awk '/MemTotal/{print "mem_total="$2} /MemAvailable/{print "mem_avail="$2}' /proc/meminfo
echo "cpu_energy=$(cat /sys/class/powercap/intel-rapl:0/energy_uj 2>/dev/null)"
echo "cpu_energy_max=$(cat /sys/class/powercap/intel-rapl:0/max_energy_range_uj 2>/dev/null)"
for h in /sys/class/hwmon/hwmon*/; do
  [ "$(cat $h/name 2>/dev/null)" = "k10temp" ] && echo "cpu_temp=$(cat ${h}temp1_input 2>/dev/null)" && break
done
echo "cpu_freq=$(awk '{s+=$1;n++} END{if(n)printf "%d", s/n}' /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null)"
echo "cpu_stat=$(head -1 /proc/stat)"
echo "cpu_model=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//')"
echo "ncpu=$(nproc)"
echo "load=$(cut -d' ' -f1 /proc/loadavg)"
echo "uptime=$(cut -d. -f1 /proc/uptime)"
echo "top=$(ps -eo pcpu,comm --sort=-pcpu --no-headers 2>/dev/null | head -3 | awk '{printf "%s %s|", $1, $2}')"
# True generation speed straight from Ollama's own llama-server timings, which
# it logs to the system journal (identifier "ollama"). This is the real tok/s of
# the last completed response for ANY client, not just Hermes traffic, and it
# lands in the journal within a moment of the response finishing. The grep runs
# here on the box (only the final line crosses SSH), so -n can be generous — it
# has to reach back past llama-server's very verbose per-request logging to the
# last generation line. (journalctl --grep reorders results under -n on some
# versions, so we filter chronological output client-side instead.)
_g=$(journalctl -t ollama -o short-unix --no-pager -n 3000 2>/dev/null | grep 'eval time =' | grep -v 'prompt eval time' | tail -1)
echo "gen_rate=$(printf '%s' "$_g" | sed -n 's/.*, *\([0-9.]*\) tokens per second.*/\1/p')"
echo "gen_ts=$(printf '%s' "$_g" | awk '{print $1}' | cut -d. -f1)"
"""

def _magic(mac):
    return b"\xff" * 6 + bytes.fromhex(mac.replace(":", "").replace("-", "")) * 16


def on_home_lan():
    """True when this Mac shares the PC's LAN, so it can broadcast directly."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((LAN_PREFIX + "1", 80))   # no traffic, just picks a route
        ip = s.getsockname()[0]
        s.close()
        return ip.startswith(LAN_PREFIX)
    except OSError:
        return False


def wake_direct():
    """Broadcast the magic packet from this machine. Home network only."""
    pkt, sent = _magic(MAC), []
    for target in (LAN_BCAST, "255.255.255.255"):
        for port in (9, 7):
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.settimeout(2)
                s.sendto(pkt, (target, port))
                s.close()
                sent.append("%s:%d" % (target, port))
            except OSError:
                pass
    return sent


def wake_via_relay_dashboard():
    """Ask the LAN-side dashboard to broadcast for us. Returns (ok, message)."""
    if not RELAY_URL:
        return False, "no relay url configured"
    try:
        req = urllib.request.Request(RELAY_URL, data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
        if d.get("ok"):
            return True, "relayed via %s" % urllib.parse.urlsplit(RELAY_URL).hostname
        return False, str(d.get("message") or "relay refused")[:160]
    except Exception as e:
        return False, str(e)[:160]


def wake_relay():
    """Have a tailnet host that sits on the PC's LAN emit the packet."""
    snippet = (
        "import socket;"
        "p=b'\\xff'*6+bytes.fromhex('%s')*16;"
        "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);"
        "s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);"
        "s.sendto(p,('%s',9));s.sendto(p,('255.255.255.255',9));"
        "print('sent')"
    ) % (MAC.replace(":", ""), LAN_BCAST)
    try:
        r = subprocess.run(
            ["ssh", *SSH_OPTS, RELAY_HOST, 'python3 -c "%s"' % snippet],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0 and "sent" in r.stdout:
            return True, "relayed via %s" % RELAY_HOST
        return False, (r.stderr or r.stdout or "relay failed").strip().splitlines()[-1][:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


def wake():
    """Direct broadcast when home, relay when away. Returns (ok, message)."""
    if on_home_lan():
        sent = wake_direct()
        if sent:
            return True, "magic packet broadcast on the local network"
        return False, "could not open a broadcast socket"
    ok, msg = wake_via_relay_dashboard()
    if ok:
        return True, msg
    ok2, msg2 = wake_relay()
    if ok2:
        return True, msg2
    return False, "away from home and both relays failed: %s / %s" % (msg, msg2)


def power_action(action):
    """Suspend or power off the PC. Returns (ok, message).

    The command is detached with a short delay so sshd can close the session
    cleanly before the machine goes down — otherwise ssh returns an error even
    though the action succeeded.
    """
    if action == "suspend":
        cmd, done = "systemctl suspend", "suspending — wake should bring it back"
    elif action == "poweroff":
        cmd, done = "systemctl poweroff", "powering off"
    else:
        return False, "unknown action"
    remote = "nohup sh -c 'sleep 1; %s' >/dev/null 2>&1 & echo queued" % cmd
    try:
        r = subprocess.run(["ssh", *SSH_OPTS, "root@" + HOST, remote],
                           capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and "queued" in r.stdout:
            return True, done
        return False, (r.stderr or r.stdout or "command failed").strip()[:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


_snapshot = {"ok": False, "error": "starting up"}
_lock = threading.Lock()


def probe_pc():
    try:
        r = subprocess.run(["ssh", *SSH_OPTS, "root@" + HOST, PROBE],
                           capture_output=True, text=True, timeout=12)
        if r.returncode != 0:
            return None
        d = {}
        for line in r.stdout.splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                d[k.strip()] = v.strip()
        return d or None
    except (subprocess.TimeoutExpired, OSError):
        return None


def probe_ollama():
    try:
        with urllib.request.urlopen(OLLAMA + "/api/ps", timeout=6) as r:
            return json.load(r).get("models", [])
    except Exception:
        return None


def probe_tokens():
    if not os.path.exists(STATE_DB):
        return None
    try:
        con = sqlite3.connect("file:%s?mode=ro" % STATE_DB, uri=True, timeout=3)
        cur = con.cursor()
        tot = cur.execute("""
            SELECT COALESCE(SUM(api_call_count),0), COALESCE(SUM(input_tokens),0),
                   COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                   COALESCE(SUM(cache_write_tokens),0), COALESCE(SUM(reasoning_tokens),0),
                   COUNT(DISTINCT session_id)
            FROM session_model_usage""").fetchone()
        # The current session can span several rows (Hermes writes a new
        # session_model_usage row per segment / model switch), and some rows
        # carry first_seen == last_seen. Picking one row gave a partial count
        # and, on a zero-span row, a garbage tok/s. Aggregate the whole session
        # instead: real totals, and a true span from MIN/MAX of the timestamps.
        latest = cur.execute("""
            SELECT session_id FROM session_model_usage
            ORDER BY last_seen DESC LIMIT 1""").fetchone()
        cs = None
        if latest:
            sid = latest[0]
            cs = cur.execute("""
                SELECT session_id,
                       (SELECT model FROM session_model_usage
                        WHERE session_id = ? ORDER BY last_seen DESC LIMIT 1),
                       COALESCE(SUM(api_call_count), 0),
                       COALESCE(SUM(input_tokens), 0),
                       COALESCE(SUM(output_tokens), 0),
                       COALESCE(SUM(cache_read_tokens), 0),
                       MIN(first_seen), MAX(last_seen)
                FROM session_model_usage WHERE session_id = ?""",
                (sid, sid)).fetchone()
        models = cur.execute("""
            SELECT model, SUM(api_call_count), SUM(input_tokens),
                   SUM(output_tokens), SUM(cache_read_tokens)
            FROM session_model_usage GROUP BY model
            ORDER BY SUM(output_tokens) DESC LIMIT 8""").fetchall()
        con.close()
        return {"tot": tot, "cur": cs, "models": models}
    except sqlite3.Error:
        return None


# --- state.db sync ---------------------------------------------------------
# Hermes writes the token counts on the Mac. When the dashboard runs somewhere
# else (zimaos), pull them across on an interval.
#
# Only ONE table is ever read here - session_model_usage, 97 rows - while the
# full state.db is 11 MB of messages and FTS indexes. So instead of copying the
# database, export just that table into a throwaway sqlite file: 24 KB, a 450x
# reduction. Same schema, so probe_tokens() reads it with no special case.
# That makes the sync cheap enough to run every few seconds, which is the point
# - it is both far less traffic AND far less lag than the old 5-minute copy.
#
# The export runs as a single sqlite3 statement against a WAL database, so it
# sees one consistent point in time; the result is landed via os.replace so a
# reader never observes a half-written file.
#
# When the Mac is asleep the sync simply fails and the previous copy stays put,
# so the panel keeps showing the last known numbers. STATE_SYNCED carries the
# age so the page can label them rather than passing them off as live.
STATE_SYNC_FROM = os.environ.get("HERMES_STATE_SYNC")      # user@host:/abs/path
STATE_SYNC_SECONDS = float(os.environ.get("HERMES_STATE_SYNC_SECONDS", "15"))
STATE_SYNCED = {"at": None, "ok": False, "error": "not configured"}


def sync_state_db():
    """Pull a consistent copy of the Mac's state.db. Returns (ok, error)."""
    if not STATE_SYNC_FROM or ":" not in STATE_SYNC_FROM:
        return False, "not configured"
    remote_host, _, remote_path = STATE_SYNC_FROM.partition(":")
    snap = "/tmp/hermes-tokens-%d.db" % os.getpid()
    # CREATE TABLE AS drops indexes and constraints, which is fine: every read
    # against this file is a plain aggregate SELECT.
    export = (
        "rm -f {snap} && sqlite3 {db} \"ATTACH '{snap}' AS t; "
        "CREATE TABLE t.session_model_usage AS SELECT * FROM session_model_usage;\""
    ).format(snap=snap, db=remote_path)
    try:
        r = subprocess.run(
            ["ssh", *SSH_OPTS, remote_host, export],
            capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return False, (r.stderr or "export failed").strip().splitlines()[-1][:160]
        # Land it via a temp file + rename so a reader never sees a half copy.
        tmp = STATE_DB + ".part"
        os.makedirs(os.path.dirname(STATE_DB), exist_ok=True)
        r = subprocess.run(
            ["scp", *SSH_OPTS, "%s:%s" % (remote_host, snap), tmp],
            capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, (r.stderr or "scp failed").strip().splitlines()[-1][:160]
        os.replace(tmp, STATE_DB)
        # The exported file is self-contained. Any -wal/-shm left over from a
        # previous copy belongs to a different database now, and sqlite will
        # happily read a mismatched WAL and hand back stale or corrupt rows.
        for side in (STATE_DB + "-wal", STATE_DB + "-shm"):
            try:
                os.remove(side)
            except OSError:
                pass
        subprocess.run(["ssh", *SSH_OPTS, remote_host, "rm -f " + snap],
                       capture_output=True, text=True, timeout=20)
        return True, None
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


def state_syncer():
    """Background loop; no-op unless HERMES_STATE_SYNC is set."""
    if not STATE_SYNC_FROM:
        return
    while True:
        ok, err = sync_state_db()
        STATE_SYNCED.update(ok=ok, error=err)
        if ok:
            STATE_SYNCED["at"] = time.time()
        time.sleep(STATE_SYNC_SECONDS)


def poller():
    """Background loop. Owns all the slow I/O so HTTP stays instant."""
    # Hermes only writes token counts when an API call finishes, so a 2s delta
    # reads zero almost every tick and spikes once per call. Average over a
    # longer window instead, against the all-time total (monotonic, and it
    # survives the session id changing mid-stream).
    hist = []
    prev_energy = prev_energy_t = None
    prev_stat = None
    while True:
        t0 = time.time()
        pc, oll, tok = probe_pc(), probe_ollama(), probe_tokens()

        # RAPL reports cumulative microjoules; watts is the delta over time.
        cpu_watts = cpu_pct = None
        if pc:
            try:
                e = int(pc.get("cpu_energy") or 0)
                if prev_energy is not None and e:
                    de, dt = e - prev_energy, t0 - prev_energy_t
                    if de < 0:                      # counter wrapped
                        de += int(pc.get("cpu_energy_max") or 0)
                    if dt > 0 and de >= 0:
                        cpu_watts = de / 1e6 / dt
                if e:
                    prev_energy, prev_energy_t = e, t0
            except (TypeError, ValueError):
                pass
            try:
                f = [int(x) for x in (pc.get("cpu_stat") or "").split()[1:]]
                if f:
                    total, idle = sum(f), f[3] + (f[4] if len(f) > 4 else 0)
                    if prev_stat:
                        dt_, di = total - prev_stat[0], idle - prev_stat[1]
                        if dt_ > 0:
                            cpu_pct = max(0.0, min(100.0, 100.0 * (1 - di / dt_)))
                    prev_stat = (total, idle)
            except (TypeError, ValueError, IndexError):
                pass

        rate = None
        if tok:
            total_out = tok["tot"][2]
            hist.append((t0, total_out))
            cutoff = t0 - RATE_WINDOW
            while len(hist) > 2 and hist[0][0] < cutoff:
                hist.pop(0)
            if len(hist) >= 2:
                dt = t0 - hist[0][0]
                d = total_out - hist[0][1]
                if dt >= 2.0 and d > 0:
                    rate = d / dt

        # True generation rate from Ollama's llama-server timings (via probe_pc).
        # gen_ts is when the last response finished, so gen_age tells the page how
        # fresh it is; the poll runs on POLL_SECONDS so this refreshes promptly.
        gen_rate = gen_age = None
        if pc:
            try:
                gr = float(pc.get("gen_rate") or 0)
                gts = float(pc.get("gen_ts") or 0)
                # Ignore a rate older than an hour: past that the box has been
                # idle and "last response 3h ago" is just noise, so fall to idle.
                if gr > 0 and gts > 0 and (t0 - gts) < 3600:
                    gen_rate, gen_age = gr, max(0.0, t0 - gts)
            except (TypeError, ValueError):
                pass

        snap = {"ok": True, "ts": t0,
                "online": pc is not None or oll is not None,
                # ssh reachable, so GPU/CPU/RAM figures are available.
                "host_stats": pc is not None,
                "rate": rate,
                "gen_rate": gen_rate, "gen_age": gen_age,
                "home": on_home_lan(), "relay": RELAY_HOST,
                "window": RATE_WINDOW,
                # Age of the token numbers. None when this host owns state.db
                # directly (the Mac), a number of seconds when it is a synced
                # copy, so the page can say so instead of implying live data.
                "tokens_age": (None if not STATE_SYNC_FROM else
                               (None if not STATE_SYNCED["at"]
                                else t0 - STATE_SYNCED["at"])),
                "tokens_sync_error": STATE_SYNCED["error"] if STATE_SYNC_FROM else None}

        if pc:
            vt = int(pc.get("vram_total", 1) or 1)
            mt = int(pc.get("mem_total", 1) or 1)
            ma = int(pc.get("mem_avail", 0) or 0)
            top = [p for p in (pc.get("top", "") or "").split("|") if p.strip()]
            snap["pc"] = {
                "busy": float(pc.get("gpu_busy", 0) or 0),
                "vram_used": int(pc.get("vram_used", 0) or 0), "vram_total": vt,
                "temp": int(pc.get("gpu_temp", 0) or 0) / 1000,
                "power": int(pc.get("gpu_power", 0) or 0) / 1e6,
                "fan": int(pc.get("gpu_fan", 0) or 0),
                "mem_used": (mt - ma) * 1024, "mem_total": mt * 1024,
                "load": float(pc.get("load", 0) or 0),
                "uptime": int(pc.get("uptime", 0) or 0),
                "top": top,
                "cpu_model": pc.get("cpu_model", ""),
                "ncpu": int(pc.get("ncpu", 0) or 0),
                "cpu_watts": cpu_watts,
                "cpu_pct": cpu_pct,
                "cpu_temp": int(pc.get("cpu_temp", 0) or 0) / 1000 or None,
                "cpu_freq": int(pc.get("cpu_freq", 0) or 0) / 1e6 or None,
            }
            gw = snap["pc"]["power"] if "pc" in snap else 0
            if cpu_watts is not None:
                snap["pc"]["total_watts"] = (
                    cpu_watts + gw + SYSTEM_OVERHEAD_W) / PSU_EFFICIENCY
        if oll is not None:
            snap["ollama"] = [{
                "name": m["name"], "vram": m.get("size_vram", 0),
                "ctx": m.get("context_length", 0),
                "params": m.get("details", {}).get("parameter_size", "?"),
                "quant": m.get("details", {}).get("quantization_level", "?"),
                "expires": m.get("expires_at"),
            } for m in oll]
        if tok:
            c, ti, to, cr, cw, rz, ns = tok["tot"]
            snap["tokens"] = {
                "calls": c, "in": ti, "out": to, "cache_read": cr,
                "cache_write": cw, "reasoning": rz, "sessions": ns,
                "models": [{"name": m[0], "calls": m[1], "in": m[2],
                            "out": m[3], "cached": m[4]} for m in tok["models"]],
            }
            if tok["cur"]:
                sid, model, cc, ci, co, cch, fs, ls = tok["cur"]
                snap["tokens"]["current"] = {
                    "id": sid, "model": model, "calls": cc, "in": ci, "out": co,
                    "cached": cch, "span": max(1.0, (ls or 0) - (fs or 0)),
                    "idle": time.time() - (ls or 0),
                }

        with _lock:
            _snapshot.clear()
            _snapshot.update(snap)
        time.sleep(max(0.2, POLL_SECONDS - (time.time() - t0)))


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__PC_NAME__</title>
<!-- Activity trace, recoloured live by setFav(): green healthy, amber when
     host metrics are missing, red when the PC is unreachable. The tab strip
     then works as a status light without opening the page. -->
<link id="fav" rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%230d1117%22%2F%3E%3Cpath%20d%3D%22M3%2020h5.5l3-9.5%204%2016%203-8H29%22%20fill%3D%22none%22%20stroke%3D%22%233ddc84%22%20stroke-width%3D%223.4%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E">
<style>
:root{
  --bg:#0f1115; --card:#171a21; --card2:#1d212a; --line:#252a34;
  --fg:#e8ecf3; --dim:#8b94a6; --faint:#5a6375;
  --grn:#3ddc84; --yel:#ffc857; --red:#ff5f56; --blu:#5aa9ff; --mag:#c98bff;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif;
  padding:28px 22px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:22px;margin:0;letter-spacing:-.02em;font-weight:650}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
.pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;
  padding:5px 11px;border-radius:999px;background:var(--card2);color:var(--dim);
  border:1px solid var(--line);font-weight:500}
.dot{width:8px;height:8px;border-radius:50%;background:var(--grn);
  box-shadow:0 0 0 3px rgba(61,220,132,.16)}
.dot.off{background:var(--red);box-shadow:0 0 0 3px rgba(255,95,86,.16)}
.sub{color:var(--faint);font-size:13px;margin:0 0 22px}
.grid{display:grid;gap:14px;margin-bottom:14px}
.g4{grid-template-columns:repeat(4,1fr)}
.g2{grid-template-columns:repeat(2,1fr);align-items:start}
.g1{grid-template-columns:1fr}
.stackcol{display:grid;gap:14px;align-content:start}
@media(max-width:860px){.g4{grid-template-columns:repeat(2,1fr)}.g2{grid-template-columns:1fr}}
@media(max-width:480px){.g4{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 17px}
.label{font-size:11px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--faint);font-weight:600;margin-bottom:9px}
.big{font-size:30px;font-weight:640;letter-spacing:-.025em;
  font-variant-numeric:tabular-nums;line-height:1.1}
.unit{font-size:14px;color:var(--dim);font-weight:500;margin-left:3px}
.meta{color:var(--dim);font-size:12.5px;margin-top:5px;font-variant-numeric:tabular-nums}
.track{height:7px;border-radius:4px;background:#0a0c10;overflow:hidden;margin-top:11px}
.fill{height:100%;border-radius:4px;transition:width .4s ease,background .4s ease}
h2{font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);
  margin:26px 0 11px;font-weight:600}
.stale{text-transform:none;letter-spacing:0;opacity:.75;font-weight:400}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:right;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--faint);font-weight:600;padding:0 0 9px}
th:first-child{text-align:left}
td{padding:8px 0;border-top:1px solid var(--line);text-align:right;font-size:14px}
td:first-child{text-align:left;color:var(--fg)}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px}
.rowsplit{display:flex;justify-content:space-between;align-items:baseline;
  padding:7px 0;border-top:1px solid var(--line)}
.rowsplit:first-of-type{border-top:0}
.rowsplit .k{color:var(--dim);font-size:13.5px}
.rowsplit .v{font-variant-numeric:tabular-nums;font-weight:560;font-size:15px}
.offline{text-align:center;padding:34px 18px;color:var(--dim)}
.offline .t{font-size:17px;color:var(--red);font-weight:600;margin-bottom:6px}
svg.spark{display:block;width:100%;height:38px;margin-top:10px;overflow:visible}
.tag{font-size:11px;color:var(--faint);background:var(--card2);padding:2px 7px;
  border-radius:5px;border:1px solid var(--line);margin-left:7px;font-weight:500}
.note{color:var(--faint);font-size:12px;margin-top:9px;line-height:1.45}
button.wake{font:inherit;font-weight:600;font-size:15px;color:#04160b;
  background:var(--grn);border:0;border-radius:10px;padding:11px 22px;cursor:pointer;
  transition:filter .15s ease,opacity .15s ease}
button.wake:hover{filter:brightness(1.08)}
button.wake:disabled{opacity:.55;cursor:default}
.power{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.cpurow{display:flex;gap:26px;flex-wrap:wrap;align-items:baseline}
.cpurow>div{display:flex;flex-direction:column;gap:2px}
.ck{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:600}
.cv{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
button.pw{font:inherit;font-weight:550;font-size:13.5px;color:var(--dim);
  background:var(--card2);border:1px solid var(--line);border-radius:9px;
  padding:9px 15px;cursor:pointer;transition:color .15s,border-color .15s;
  white-space:nowrap;min-width:168px;text-align:center;line-height:1.35}
button.pw:hover{color:var(--fg);border-color:var(--faint)}
button.pw.armed{color:#04160b;background:var(--yel);border-color:var(--yel)}
button.pw.danger.armed{color:#fff;background:var(--red);border-color:var(--red)}
button.pw:disabled{opacity:.5;cursor:default}
footer{color:var(--faint);font-size:12px;margin-top:30px;text-align:center}
</style></head><body><div class="wrap">
<header><h1>__PC_NAME__</h1><span class="pill" id="status"><i class="dot"></i>connecting</span></header>
<p class="sub" id="sub">__PC_HOST__ · over Tailscale</p>
<div id="body"></div>
<footer>refreshes every 2s · ctrl-c in the terminal to stop the server</footer>
</div>
<script>
const FAVICON=c=>'data:image/svg+xml,'+encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'+
  '<rect width="32" height="32" rx="7" fill="#0d1117"/>'+
  '<path d="M3 20h5.5l3-9.5 4 16 3-8H29" fill="none" stroke="'+c+'" stroke-width="3.4" '+
  'stroke-linecap="round" stroke-linejoin="round"/></svg>');
let _fav='';
// Rewriting the href on every 2s tick makes Chrome re-fetch and flicker,
// so only touch it when the colour actually changes.
const setFav=c=>{if(c===_fav)return;_fav=c;
  const l=document.getElementById('fav');if(l)l.href=FAVICON(c);};
const H={busy:[],temp:[],rate:[],vram:[],mem:[],cpuw:[],cpup:[],cput:[],totw:[]};
const MAXH=60;
const push=(k,v)=>{if(v==null)return;H[k].push(v);if(H[k].length>MAXH)H[k].shift();};
const gib=b=>(b/1073741824).toFixed(1);
const num=n=>{n=+n||0;if(n<1000)return String(Math.round(n));
  const u=['K','M','G','T'];let i=-1;while(n>=1000&&i<3){n/=1000;i++;}
  return n.toFixed(1)+u[i];};
const dur=s=>{s=Math.max(0,Math.round(s));const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d?d+'d '+h+'h':(h?h+'h '+m+'m':m+'m');};
const col=p=>p<60?'var(--grn)':(p<85?'var(--yel)':'var(--red)');

function spark(key,color){
  const a=H[key];if(a.length<2)return'';
  const mx=Math.max(...a,1),mn=Math.min(...a,0),rg=(mx-mn)||1,W=100,Hh=38;
  const pts=a.map((v,i)=>[(i/(a.length-1))*W,Hh-((v-mn)/rg)*(Hh-5)-2]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(2)+' '+p[1].toFixed(2)).join(' ');
  const area=d+' L'+W+' '+Hh+' L0 '+Hh+' Z';
  const id='g'+key;
  return '<svg class="spark" viewBox="0 0 '+W+' '+Hh+'" preserveAspectRatio="none">'+
    '<defs><linearGradient id="'+id+'" x1="0" x2="0" y1="0" y2="1">'+
    '<stop offset="0" stop-color="'+color+'" stop-opacity=".28"/>'+
    '<stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>'+
    '<path d="'+area+'" fill="url(#'+id+')"/>'+
    '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.6" '+
    'vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
}
const stat=(label,val,unit,meta,pct,color,sp)=>
  '<div class="card"><div class="label">'+label+'</div>'+
  '<div class="big">'+val+(unit?'<span class="unit">'+unit+'</span>':'')+'</div>'+
  (meta?'<div class="meta">'+meta+'</div>':'')+
  (pct!=null?'<div class="track"><div class="fill" style="width:'+Math.min(100,pct)+'%;background:'+(color||col(pct))+'"></div></div>':'')+
  (sp||'')+'</div>';

async function tick(){
  let s;try{s=await(await fetch('/api/stats',{cache:'no-store'})).json();}
  catch(e){document.getElementById('status').innerHTML='<i class="dot off"></i>server gone';setFav('#ff5f56');return;}
  const st=document.getElementById('status');
  st.innerHTML='<i class="dot'+(s.online?'':' off')+'"></i>'+(s.online?'online':'unreachable');
  setFav(!s.online?'#ff5f56':(s.host_stats?'#3ddc84':'#ffc857'));
  const B=[];

  if(s.online&&!s.host_stats){
    // Ollama answers, so the machine is up and usable — only the ssh-derived
    // host metrics are missing. Say exactly that instead of crying "asleep".
    B.push('<div class="card"><div class="label">Host metrics unavailable</div>'+
      '<div class="note">The PC is up and serving Ollama, but the SSH probe is not '+
      'answering, so GPU, CPU, RAM and power readings are missing. Tailscale SSH '+
      'asks for a periodic browser re-auth and hangs until it gets one — run '+
      '<span class="mono">ssh root@__PC_HOST__</span> once and open the URL it prints. '+
      'Token stats below are unaffected.</div></div>');
  }
  if(!s.online){
    B.push('<div class="card offline"><div class="t">PC is asleep or off</div>'+
      'Hermes cannot reach Ollama right now.'+
      '<div style="margin-top:16px"><button class="wake" onclick="doWake()">Wake __PC_NAME__</button></div>'+
      '<div class="note" id="wakemsg">'+(s.home
        ? 'You are on the home network — the magic packet goes out directly.'
        : 'You are away, so the packet is relayed through '+(s.relay||'the relay')+'.')+'</div></div>');
  }
  if(s.host_stats){
    const p=s.pc;
    const vp=p.vram_used/p.vram_total*100, mp=p.mem_used/p.mem_total*100;
    push('busy',p.busy);push('temp',p.temp);push('vram',vp);push('mem',mp);
    B.push('<div class="grid g4">'+
      stat('GPU load',p.busy.toFixed(0),'%','__GPU_LABEL__',p.busy,null,spark('busy','#5aa9ff'))+
      stat('VRAM',gib(p.vram_used),'GiB','of '+gib(p.vram_total)+' GiB',vp,null,spark('vram','#c98bff'))+
      stat('Temp',p.temp.toFixed(0),'°C',p.fan+' rpm · '+p.power.toFixed(0)+' W',
           Math.min(100,p.temp/95*100),p.temp<70?'var(--grn)':(p.temp<85?'var(--yel)':'var(--red)'),
           spark('temp','#ffc857'))+
      stat('RAM',gib(p.mem_used),'GiB','of '+gib(p.mem_total)+' GiB · load '+p.load.toFixed(2),mp,null,spark('mem','#c98bff'))+
      '</div>');
    push('cpuw',p.cpu_watts);push('cpup',p.cpu_pct);push('cput',p.cpu_temp);push('totw',p.total_watts);
    B.push('<div class="grid g4">'+
      stat('CPU load',p.cpu_pct!=null?p.cpu_pct.toFixed(0):'—','%',
           p.cpu_model||'CPU',
           p.cpu_pct||0,null,spark('cpup','#5aa9ff'))+
      stat('CPU temp',p.cpu_temp?p.cpu_temp.toFixed(0):'—','°C',
           (p.ncpu?p.ncpu+' threads':'')+(p.cpu_freq?' · '+p.cpu_freq.toFixed(2)+' GHz':''),
           p.cpu_temp?Math.min(100,p.cpu_temp/95*100):0,
           !p.cpu_temp?null:(p.cpu_temp<70?'var(--grn)':(p.cpu_temp<85?'var(--yel)':'var(--red)')),
           spark('cput','#ffc857'))+
      stat('CPU power',p.cpu_watts!=null?p.cpu_watts.toFixed(0):'—','W',
           'package · 142 W limit',
           p.cpu_watts!=null?Math.min(100,p.cpu_watts/142*100):0,null,spark('cpuw','#3ddc84'))+
      stat('System draw',p.total_watts!=null?p.total_watts.toFixed(0):'—','W',
           p.cpu_watts!=null?('cpu '+p.cpu_watts.toFixed(0)+' W · gpu '+p.power.toFixed(0)+' W · est.'):'',
           p.total_watts!=null?Math.min(100,p.total_watts/750*100):0,null,
           spark('totw','#3ddc84'))+
      '</div>');

    B.push('<div class="grid g1">');
    B.push('<div class="card"><div class="label">Power</div>'+
      '<div class="power">'+
      '<button class="pw" data-act="suspend" onclick="doPower(this)">Suspend</button>'+
      '<button class="pw danger" data-act="poweroff" onclick="doPower(this)">Shut down</button>'+
      '</div><div class="note" id="pwmsg">Suspend keeps the network card armed, so Wake '+
      'can bring it back. Shut down cuts power to the card — it will not wake until '+
      'wake-on-LAN is enabled in the BIOS.</div></div>');
    if(p.top&&p.top.length)
      B.push('<div class="card"><div class="label">Top processes · up '+dur(p.uptime)+'</div>'+
        p.top.map(t=>{const q=t.trim().split(/\s+/);
          return '<div class="rowsplit"><span class="k mono">'+(q[1]||'?')+'</span>'+
                 '<span class="v">'+(q[0]||'0')+'%</span></div>';}).join('')+'</div>');
    B.push('</div>');
  }

  const t=s.tokens;
  if(t){
    const c=t.current;
    // On a synced copy the numbers are only as fresh as the last successful
    // pull from the Mac, so say so rather than letting them read as live.
    let age='';
    if(s.tokens_age!=null&&s.tokens_age>90){
      const m=Math.round(s.tokens_age/60);
      age=' <span class="stale">· from the Mac '+(m<60?m+' min':Math.round(m/60)+' h')+' ago</span>';
    }else if(s.tokens_age==null&&s.tokens_sync_error){
      age=' <span class="stale">· Mac unreachable</span>';
    }
    B.push('<h2>Tokens'+age+'</h2><div class="grid g2">');
    B.push('<div class="stackcol">');
    // Prefer the true generation rate straight from Ollama (any client), which
    // is fresh within a poll of each response finishing. Fall back to the
    // Hermes-derived window rate, then to idle. The GPU busy % tells us whether
    // a response is being produced right now vs. just recently.
    const g=(s.gen_rate!=null&&s.gen_age!=null), busy=!!(s.pc&&s.pc.busy>40);
    const gFresh=g&&s.gen_age<120;
    let bignum,unit,sub;
    if(gFresh){
      bignum=s.gen_rate.toFixed(1); unit='tok/s';
      sub=busy?'generating now':'last response '+dur(s.gen_age)+' ago';
    }else if(busy){
      bignum='···'; unit='';
      sub='model busy — waiting for first response';
    }else if(s.rate){
      bignum=s.rate.toFixed(1); unit='tok/s';
      sub='averaged over '+Math.round(s.window||25)+'s';
    }else{
      bignum='idle'; unit='';
      sub=g?'last response '+dur(s.gen_age)+' ago':'no recent generation';
    }
    if(c&&c.span>=10&&c.out>0) sub+=' · session avg '+(c.out/c.span).toFixed(1)+' tok/s';
    push('rate', gFresh&&busy ? s.gen_rate : (s.rate||0));
    B.push(stat('Generating now',bignum,unit,sub,null,null,spark('rate','#3ddc84')));
    let o='<div class="card"><div class="label">All time · '+t.sessions+' sessions</div>';
    o+='<div class="rowsplit"><span class="k">Input</span><span class="v">'+num(t['in'])+'</span></div>';
    o+='<div class="rowsplit"><span class="k">Output</span><span class="v">'+num(t.out)+'</span></div>';
    o+='<div class="rowsplit"><span class="k">Cached</span><span class="v">'+num(t.cache_read)+'</span></div>';
    if(t.reasoning)o+='<div class="rowsplit"><span class="k">Reasoning</span><span class="v">'+num(t.reasoning)+'</span></div>';
    o+='<div class="rowsplit"><span class="k">API calls</span><span class="v">'+t.calls.toLocaleString()+'</span></div>';
    if(c) B.push('<div class="card"><div class="label">Current session</div>'+
      '<div class="mono" style="color:var(--blu);margin-bottom:9px">'+c.id+'</div>'+
      '<div class="rowsplit"><span class="k">Model</span><span class="v mono">'+c.model+'</span></div>'+
      '<div class="rowsplit"><span class="k">In / Out</span><span class="v">'+num(c['in'])+' / '+num(c.out)+'</span></div>'+
      '<div class="rowsplit"><span class="k">API calls</span><span class="v">'+c.calls+'</span></div>'+
      '<div class="rowsplit"><span class="k">Last activity</span><span class="v">'+dur(c.idle)+' ago</span></div></div>');
    B.push('</div>');
    B.push(o+'</div>');
    B.push('</div>');

    if(t.models&&t.models.length){
      let m='<h2>By model</h2><div class="card"><table><tr><th>Model</th><th>Calls</th>'+
            '<th>In</th><th>Out</th><th>Cached</th></tr>';
      t.models.forEach(x=>{m+='<tr><td class="mono">'+x.name+'</td><td>'+x.calls+'</td><td>'+
        num(x['in'])+'</td><td>'+num(x.out)+'</td><td>'+
        (x.cached?num(x.cached):'<span style="color:var(--faint)">—</span>')+'</td></tr>';});
      m+='</table><div class="note">Local Ollama models report no cache statistics, '+
         'so their cached column stays empty. Cloud models via OpenRouter do report it.</div>';
      B.push(m+'</div>');
    }
  }

  if(s.ollama){
    let o='<h2>Ollama</h2>';
    if(!s.ollama.length){
      o+='<div class="card"><div class="meta">No model resident — the next request pays load time.</div></div>';
    }else{
      o+='<div class="grid g2">'+s.ollama.map(m=>{
        let left='';
        if(m.expires){const d=(new Date(m.expires)-new Date())/1000;
          left=d>0?'unloads in '+Math.round(d)+'s':'expired';}
        return '<div class="card"><div class="label">Resident model</div>'+
          '<div style="font-size:17px;font-weight:600;color:var(--mag);margin-bottom:4px" class="mono">'+m.name+'</div>'+
          '<div class="meta">'+m.params+' · '+m.quant+' · ctx '+m.ctx.toLocaleString()+
          '<span class="tag">'+gib(m.vram)+' GiB VRAM</span></div>'+
          '<div class="meta">'+left+'</div></div>';}).join('')+'</div>';
    }
    B.push(o);
  }
  document.getElementById('body').innerHTML=B.join('');
  document.getElementById('sub').textContent='__PC_HOST__ · over Tailscale · updated '+
    new Date(s.ts*1000).toLocaleTimeString();
}
async function doPower(b){
  const msg=document.getElementById('pwmsg'), act=b.dataset.act;
  if(!b.classList.contains('armed')){
    document.querySelectorAll('button.pw').forEach(o=>{
      o.classList.remove('armed');o.textContent=o.dataset.act==='suspend'?'Suspend':'Shut down';});
    b.classList.add('armed');
    b.textContent=act==='suspend'?'Confirm suspend':'Confirm shut down';
    clearTimeout(b._t);
    b._t=setTimeout(()=>{b.classList.remove('armed');
      b.textContent=act==='suspend'?'Suspend':'Shut down';},5000);
    if(msg)msg.textContent='Click again within 5 seconds to confirm.';
    return;
  }
  clearTimeout(b._t);
  document.querySelectorAll('button.pw').forEach(o=>o.disabled=true);
  b.textContent='Sending…';
  try{
    const r=await(await fetch('/api/power',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:act})})).json();
    if(msg)msg.textContent=r.message;
    b.textContent=r.ok?'Sent':'Failed';
  }catch(e){ if(msg)msg.textContent='Could not reach the dashboard server.'; b.textContent='Failed'; }
}
async function doWake(){
  const b=document.querySelector('button.wake'), m=document.getElementById('wakemsg');
  if(b){b.disabled=true;b.textContent='Sending magic packet…';}
  try{
    const r=await(await fetch('/api/wake',{method:'POST'})).json();
    if(m)m.textContent=r.message;
    if(b)b.textContent=r.ok?'Packet sent — booting takes ~30s':'Wake failed';
    if(r.ok&&b)setTimeout(()=>{b.disabled=false;b.textContent='Send again';},25000);
    else if(b)b.disabled=false;
  }catch(e){
    if(m)m.textContent='Could not reach the dashboard server.';
    if(b){b.disabled=false;b.textContent='Wake __PC_NAME__';}
  }
}
tick();setInterval(tick,2000);
</script></body></html>"""

# Substituted once at startup rather than per request — these never change.
PAGE_HTML = (PAGE.replace("__PC_NAME__", PC_NAME)
                 .replace("__PC_HOST__", HOST)
                 .replace("__GPU_LABEL__", GPU_LABEL))



class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/stats"):
            with _lock:
                body = json.dumps(_snapshot).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
        else:
            body = PAGE_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.startswith("/api/power"):
            n = int(self.headers.get("Content-Length") or 0)
            try:
                action = json.loads(self.rfile.read(n) or b"{}").get("action", "")
            except ValueError:
                action = ""
            ok, msg = power_action(action)
        elif self.path.startswith("/api/wake"):
            # direct=1 comes from another dashboard relaying to us: broadcast
            # locally only, never relay onward, so the two can't ping-pong.
            if "direct=1" in (urllib.parse.urlsplit(self.path).query or ""):
                sent = wake_direct()
                ok = bool(sent)
                msg = ("magic packet broadcast on the local network" if ok
                       else "relay is not on the PC's LAN")
            else:
                ok, msg = wake()
        else:
            self.send_error(404)
            return
        body = json.dumps({"ok": ok, "message": msg}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass  # keep the terminal clean


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=8765)
    ap.add_argument("-b", "--bind", default="0.0.0.0",
                    help="0.0.0.0 exposes it to the tailnet (default); "
                         "127.0.0.1 keeps it local-only")
    args = ap.parse_args()

    # Pull state.db first so the token panel has data on the very first paint,
    # then keep both loops running in the background.
    threading.Thread(target=state_syncer, daemon=True).start()
    threading.Thread(target=poller, daemon=True).start()
    # Bind loopback only — this exposes SSH-derived host stats and should not
    # be reachable from the LAN or the tailnet.
    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    print("hermes-dashboard  →  http://localhost:%d" % args.port)
    if args.bind != "127.0.0.1":
        ts = ""
        try:
            ts = subprocess.run(["tailscale", "ip", "-4"], capture_output=True,
                                text=True, timeout=4).stdout.strip().splitlines()[0]
        except Exception:
            try:
                ts = subprocess.run(
                    ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "-4"],
                    capture_output=True, text=True, timeout=4).stdout.strip().splitlines()[0]
            except Exception:
                ts = ""
        if ts:
            print("from any tailnet device  →  http://%s:%d" % (ts, args.port))
    print("ctrl-c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
