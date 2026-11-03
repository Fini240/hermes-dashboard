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
import base64
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
# Strata (the alternative engine, see pc-setup/llm-engine). Its /metrics feeds
# the model-state card while it holds the GPU. Empty URL = not set up.
STRATA_URL = os.environ.get("HERMES_STRATA_URL", "").rstrip("/")
STRATA_KEY = os.environ.get("HERMES_STRATA_KEY", "")
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
    echo "gpu_power_cap=$(cat ${h}power1_cap 2>/dev/null)"
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
# Are the monitors lit? Every connected DRM connector carries its own DPMS
# state, and the compositor's blanking lands here, so this reads the truth
# whoever turned them off — the dashboard, the screen locker, or a key press
# at the desk. Filter on `status` only, NOT on `enabled`: blanking disables
# the CRTC, so a blanked display reports enabled=disabled and would vanish
# from the count entirely. (Writeback-1 is a virtual connector: status=unknown,
# so it drops out on its own.)
_mon_on=0; _mon_off=0
for c in /sys/class/drm/card*-*/; do
  [ "$(cat "$c/status" 2>/dev/null)" = connected ] || continue
  case "$(cat "$c/dpms" 2>/dev/null)" in
    On) _mon_on=$((_mon_on+1)) ;;
    Off) _mon_off=$((_mon_off+1)) ;;
  esac
done
echo "mon_on=$_mon_on"
echo "mon_off=$_mon_off"
# Lighting preset last applied by rgb-apply on the PC. There is no read-back
# path in OpenRGB's CLI, so the PC records what it set and re-applies it after
# a reboot or resume — which makes this file the honest answer to "what are the
# lights doing", not a guess the dashboard keeps to itself.
echo "rgb=$(cat /var/lib/hermes-rgb/state 2>/dev/null)"
[ -x /usr/local/bin/rgb-apply ] && echo "rgb_avail=1" || echo "rgb_avail=0"
echo "rgb_auto=$(systemctl is-active rgb-auto 2>/dev/null)"
# Which engine holds the GPU, Ollama or Strata (and Strata's live state).
# llm-engine lives on the PC (pc-setup/), so service names, Strata's address
# and its API key stay there; absent, the engine card simply does not render.
[ -x /usr/local/bin/llm-engine ] && /usr/local/bin/llm-engine probe 2>/dev/null
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

# The same box may be booted into Windows. Windows needs a completely different
# probe (no /sys, no /proc, no journald), but it must emit the SAME keys in the
# SAME units so the rest of the dashboard does not care which OS answered:
#   vram_* bytes · mem_* kB · *_temp millidegrees · cpu_freq kHz
#   cpu_stat "cpu user nice system idle ..." in 1/100s jiffies
# Temps/fan/power are absent: Windows exposes no vendor-neutral sensor API, so
# those keys are simply omitted and the UI already renders them as "-".
WIN_USER = os.environ.get("HERMES_WIN_SSH_USER", "user")

PROBE_WIN = r"""
$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'
# Count only render/compute engines. Summing every engine double-counts and a
# video-decode engine alone was reading 52% while the GPU was otherwise idle.
$gs = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -EA 0).CounterSamples |
      Where-Object { $_.InstanceName -match 'engtype_(3D|Compute)' }
$busy = 0; if($gs){ $busy = [math]::Min(100,[math]::Round(($gs | Measure-Object CookedValue -Sum).Sum,0)) }
"gpu_busy=$busy"
$vm = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -EA 0).CounterSamples
if($vm){ "vram_used=$([int64](($vm | Measure-Object CookedValue -Sum).Sum))" }
$vt = 0
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -EA 0 |
  ForEach-Object { $q = (Get-ItemProperty $_.PSPath -EA 0).'HardwareInformation.qwMemorySize'
                   if($q -and $q -gt $vt){ $vt = [int64]$q } }
if($vt){ "vram_total=$vt" }
$os = Get-CimInstance Win32_OperatingSystem
"mem_total=$($os.TotalVisibleMemorySize)"
"mem_avail=$($os.FreePhysicalMemory)"
# Cumulative 100ns counters -> /proc/stat jiffies, so the existing delta maths works.
$c = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
if($c){ "cpu_stat=cpu $([int64]($c.PercentUserTime/100000)) 0 $([int64]($c.PercentPrivilegedTime/100000)) $([int64]($c.PercentIdleTime/100000)) 0 0 0" }
$p = Get-CimInstance Win32_Processor | Select-Object -First 1
"cpu_model=$($p.Name)"
"ncpu=$($p.NumberOfLogicalProcessors)"
"cpu_freq=$([int]$p.CurrentClockSpeed * 1000)"
"uptime=$([int]((Get-Date) - $os.LastBootUpTime).TotalSeconds)"
$q = (Get-Counter '\System\Processor Queue Length' -EA 0).CounterSamples.CookedValue
"load=$([math]::Round($(if($q){$q}else{0}),2))"
"top=$((Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 | ForEach-Object { '{0:N1} {1}|' -f $_.CPU,$_.ProcessName }) -join '')"
# Ollama's own llama-server timings, same figure the Linux side reads from journald.
$best=$null
Get-ChildItem "$env:LOCALAPPDATA\Ollama\server*.log" -EA 0 | Sort-Object LastWriteTime -Descending | ForEach-Object {
  if(-not $best){
    $l = Get-Content $_.FullName -Tail 3000 -EA 0 |
         Where-Object { $_ -match 'eval time =' -and $_ -notmatch 'prompt eval time' } | Select-Object -Last 1
    if($l -and $l -match '([0-9.]+) tokens per second'){
      $best = $matches[1]
      "gen_rate=$best"
      "gen_ts=$([int](Get-Date -UFormat %s))"
    }
  }
}
"""


def _win_cmd(ps):
    """Windows commands go over ssh base64-encoded.

    The remote default shell is PowerShell, and passing a multi-line script as a
    plain ssh argument gets mangled by two layers of quoting (and by any
    non-ASCII character, which silently truncates the script). -EncodedCommand
    takes UTF-16LE base64 and sidesteps all of it.
    """
    return "powershell -NoProfile -EncodedCommand " + base64.b64encode(
        ps.encode("utf-16-le")).decode()

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


# Blanking the monitors is a DPMS change inside whatever compositor owns the
# seat, so it cannot be done by writing sysfs over ssh: the running KMS master
# (here plasmalogin's KWin on the greeter session) owns the connectors and
# overrides anything written behind its back. So find seat0's active session,
# then speak to that session as its own user. Reading the state back IS a plain
# sysfs read, which is why the probe gets a live indicator for free.
#
# The session is resolved on every call rather than baked in: the active
# session is the greeter while nobody is logged in and the desktop user's
# afterwards, and each has its own uid and wayland socket.
DISPLAY_SH = r"""
act=__ACT__
sess=$(loginctl show-seat seat0 -p ActiveSession --value 2>/dev/null)
[ -n "$sess" ] || sess=$(loginctl list-sessions --no-legend 2>/dev/null | awk '$4=="seat0"{print $1;exit}')
[ -n "$sess" ] || { echo "no graphical session on seat0" >&2; exit 1; }
uid=$(loginctl show-session "$sess" -p User --value)
usr=$(loginctl show-session "$sess" -p Name --value)
typ=$(loginctl show-session "$sess" -p Type --value)
rt=/run/user/$uid
if [ "$typ" = wayland ]; then
  wd=$(ls "$rt" 2>/dev/null | grep -m1 '^wayland-[0-9]*$')
  [ -n "$wd" ] || { echo "session $sess has no wayland socket" >&2; exit 1; }
  runuser -u "$usr" -- env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY="$wd" \
      kscreen-doctor --dpms $act >/dev/null 2>&1 \
    || { echo "kscreen-doctor --dpms $act failed in session $sess" >&2; exit 1; }
else
  dsp=$(loginctl show-session "$sess" -p Display --value); [ -n "$dsp" ] || dsp=:0
  xa=$(ls "$rt"/xauth* 2>/dev/null | head -1)
  runuser -u "$usr" -- env DISPLAY="$dsp" XAUTHORITY="$xa" xset dpms force $act >/dev/null 2>&1 \
    || { echo "xset dpms force $act failed on $dsp" >&2; exit 1; }
fi
echo queued
"""


def display_action(action):
    """Blank or unblank the PC's monitors. Returns (ok, message).

    Unlike suspend this leaves the machine fully awake and on the network: it
    only stops the panels drawing, which is where nearly all of the idle wattage
    of a desk setup actually goes. Any key press or mouse move at the PC wakes
    them again, and the indicator follows that because it is read from sysfs.
    """
    if action not in ("on", "off"):
        return False, "unknown action"
    if pc_os() == "windows":
        # An ssh session on Windows lands outside the interactive desktop, so
        # the SC_MONITORPOWER broadcast never reaches the session that owns the
        # displays. Nothing to do short of a helper task running as the logged-in
        # user, so say so rather than failing cryptically.
        return False, ("monitor control is Linux-only — an ssh session on Windows "
                       "cannot reach the desktop that owns the displays")
    remote = DISPLAY_SH.replace("__ACT__", action)
    try:
        r = subprocess.run(["ssh", *SSH_OPTS, "root@" + HOST, remote],
                           capture_output=True, text=True, timeout=20)
        if r.returncode == 0 and "queued" in r.stdout:
            return True, ("monitors off — the PC stays awake and online; a key press "
                          "or mouse move at the PC brings them back"
                          if action == "off" else "monitors on")
        return False, (r.stderr or r.stdout or "command failed").strip().splitlines()[-1][:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


RGB_COLORS = ("red", "purple", "blue", "green", "off")


def rgb_action(color):
    """Set the PC's RGB lighting to a preset, or switch it off.

    The work is done by `rgb-apply` on the PC rather than by a command composed
    here, because it needs OpenRGB's server: a bare `openrgb` call re-detects
    every controller first and takes ~22s, against well under a second through
    the running server. That script also records what it applied and re-applies
    it after a reboot or a resume, which is what makes the indicator truthful.
    """
    if color not in RGB_COLORS:
        return False, "unknown colour"
    if pc_os() == "windows":
        return False, "RGB control is Linux-only — OpenRGB is set up on the Linux side"
    try:
        # Picking a colour by hand ends the automatic mode. Leaving both on
        # would mean the daemon silently reverting the choice at the next load
        # transition, which reads as the button not working.
        r = subprocess.run(["ssh", *SSH_OPTS, "root@" + HOST,
                            "systemctl disable --now rgb-auto >/dev/null 2>&1; "
                            "/usr/local/bin/rgb-apply " + color],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and "ok" in r.stdout:
            return True, ("lights off" if color == "off" else "lights set to " + color)
        err = (r.stderr or r.stdout or "command failed").strip().splitlines()
        return False, (err[-1] if err else "command failed")[:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


def rgb_auto_action(on):
    """Enable or disable the PC's load-following lighting daemon.

    The loop lives on the PC rather than in this poller so that it keeps
    working with no dashboard attached — a container rebuild or a zimaos reboot
    must not leave the lighting frozen — and `enable` makes it survive a reboot
    of the PC too. The dashboard only flips the switch and reports its state.
    """
    if pc_os() == "windows":
        return False, "automatic lighting is Linux-only"
    cmd = ("systemctl enable --now rgb-auto" if on
           else "systemctl disable --now rgb-auto")
    try:
        r = subprocess.run(["ssh", *SSH_OPTS, "root@" + HOST, cmd + " && echo queued"],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0 and "queued" in r.stdout:
            return True, ("lighting now follows the load — red while working, "
                          "green when idle" if on else
                          "automatic lighting off — the colour stays where it is")
        err = (r.stderr or r.stdout or "command failed").strip().splitlines()
        return False, (err[-1] if err else "command failed")[:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


ENGINES = ("ollama", "strata")
STRATA_MODELS = {
    "qwen3.8-flash-next-q2_0": {"variant": "q2_0", "label": "Strata Q2_0", "probe": "strata_installed_q2_0"},
    "qwen3.8-flash-next-coder-iq1_m": {"variant": "coder-iq1_m", "label": "Strata Coder IQ1_M", "probe": "strata_installed_coder_iq1_m"},
}


def strata_models(pc):
    return [{"id": name, "object": "model", "engine": "strata", "label": model["label"]}
            for name, model in STRATA_MODELS.items() if (pc or {}).get(model["probe"]) == "1"]


def engine_action(engine, model=""):
    """Hand the GPU to Ollama or to Strata.

    Both need the whole card, so exactly one runs. `llm-engine` on the PC does
    the switch (stop one, start the other); the dashboard only names the target.
    Starting Strata returns at once, but the model then takes ~80 s to load —
    the probe reports that as "loading", so the card says so honestly.
    """
    if engine not in ENGINES:
        return False, "unknown engine"
    if not isinstance(model, str) or (model and (engine != "strata" or model not in STRATA_MODELS)):
        return False, "unknown Strata model"
    if pc_os() == "windows":
        return False, "the engine switch is Linux-only"
    try:
        r = subprocess.run(["ssh", *SSH_OPTS, "root@" + HOST,
                            "/usr/local/bin/llm-engine " + engine + (" " + STRATA_MODELS[model]["variant"] if model else "")],
                           capture_output=True, text=True, timeout=90)
        if r.returncode == 0 and "ok" in r.stdout:
            return True, ("Strata is loading — about 80 s until it answers"
                          if engine == "strata" else "Ollama has the GPU again")
        err = (r.stderr or r.stdout or "command failed").strip().splitlines()
        return False, (err[-1] if err else "command failed")[:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


def power_action(action):
    """Suspend or power off the PC. Returns (ok, message).

    The command is detached with a short delay so sshd can close the session
    cleanly before the machine goes down — otherwise ssh returns an error even
    though the action succeeded.
    """
    if action == "suspend":
        done = "suspending — wake should bring it back"
    elif action == "poweroff":
        done = "powering off"
    else:
        return False, "unknown action"

    if pc_os() == "windows":
        # SetSuspendState(bHibernate=0) is a real S3 sleep, and it BLOCKS, so it
        # is launched detached or ssh never gets its reply. shutdown /t 5 already
        # returns immediately. Both print "queued" to match the Linux contract.
        if action == "suspend":
            ps = ("Start-Process -WindowStyle Hidden rundll32.exe "
                  "-ArgumentList 'powrprof.dll,SetSuspendState','0,1,0'; 'queued'")
        else:
            ps = "shutdown /s /t 5 | Out-Null; 'queued'"
        target, remote = WIN_USER + "@" + HOST, _win_cmd(ps)
    elif action == "suspend" and (_snap().get("engine") or {}).get("active") == "strata":
        # A suspend with Strata loaded does not resume (the PC hangs and needs a
        # power cycle); strata-awake blocks it anyway. Say why instead of failing.
        return False, ("Strata is running, and the PC cannot sleep with it loaded. "
                       "Switch to Ollama first, then Suspend.")
    else:
        cmd = "systemctl suspend" if action == "suspend" else "systemctl poweroff"
        target = "root@" + HOST
        remote = "nohup sh -c 'sleep 1; %s' >/dev/null 2>&1 & echo queued" % cmd

    try:
        r = subprocess.run(["ssh", *SSH_OPTS, target, remote],
                           capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and "queued" in r.stdout:
            return True, done
        return False, (r.stderr or r.stdout or "command failed").strip()[:160]
    except (subprocess.TimeoutExpired, OSError) as e:
        return False, str(e)[:160]


_snapshot = {"ok": False, "error": "starting up"}
# Sparkline history for the page's Monitor while Strata is not the one answering
# (Strata keeps its own). Same series names as Strata's /metrics "history".
_HIST_KEYS = ("gpu_util", "gpu_mem_used", "gpu_temp", "gpu_power", "cpu", "tok_s", "disk_read_mb",
              "gpu_pcie_rx_mb", "prefill_tok_s_mean")
_hist = {k: [] for k in _HIST_KEYS}
_hist_lock = threading.Lock()
_agent = {"ok": None, "at": 0.0}


def probe_agent():
    """Is the Hermes agent's API server answering? Checked every 15 s at most."""
    if not os.environ.get("HERMES_AGENT_URL"):
        return None
    if time.time() - _agent["at"] < 15:
        return _agent["ok"]
    _agent["at"] = time.time()
    try:
        with urllib.request.urlopen(os.environ["HERMES_AGENT_URL"].rstrip("/") + "/health", timeout=4) as r:
            _agent["ok"] = r.status == 200
    except Exception:
        _agent["ok"] = False
    return _agent["ok"]
_lock = threading.Lock()


# Which OS answered last. The box dual-boots, so this flips at runtime; we try
# the remembered one first and fall back to the other, which means a reboot into
# the other OS costs one wasted ssh attempt and then self-heals. No config.
_os_kind = None


def pc_os():
    """Last known OS of the PC: 'linux', 'windows', or None if never reached."""
    return _os_kind


def _probe_kind(kind):
    if kind == "windows":
        target, cmd, tmo = WIN_USER + "@" + HOST, _win_cmd(PROBE_WIN), 25
    else:
        target, cmd, tmo = "root@" + HOST, PROBE, 12
    r = subprocess.run(["ssh", *SSH_OPTS, target, cmd],
                       capture_output=True, text=True, timeout=tmo)
    if r.returncode != 0:
        return None
    d = {}
    for line in r.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            d[k.strip()] = v.strip()
    return d or None


def probe_pc():
    global _os_kind
    order = [_os_kind] if _os_kind else []
    order += [k for k in ("linux", "windows") if k not in order]
    for kind in order:
        try:
            d = _probe_kind(kind)
        except (subprocess.TimeoutExpired, OSError):
            d = None
        if d:
            _os_kind = kind
            return d
    return None


def probe_ollama():
    try:
        with urllib.request.urlopen(OLLAMA + "/api/ps", timeout=6) as r:
            return json.load(r).get("models", [])
    except Exception:
        return None


def probe_strata():
    """Strata's own monitor data, trimmed to what the page draws.

    Called only while the probe says Strata holds the GPU, so an idle Ollama
    box costs no extra request. /metrics wants the API key once one is set.
    """
    if not STRATA_URL:
        return None
    req = urllib.request.Request(STRATA_URL + "/metrics")
    if STRATA_KEY:
        req.add_header("Authorization", "Bearer " + STRATA_KEY)
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            d = json.load(r)
    except Exception:
        return None
    e, live, tot = d.get("engine") or {}, d.get("live") or {}, d.get("totals") or {}
    reqs = d.get("requests") or []
    off, acc = tot.get("drafts_offered") or 0, tot.get("drafts_accepted") or 0
    return {
        "model": e.get("model"), "version": e.get("version"),
        "max_context": e.get("max_context") or e.get("context"),
        "experts": e.get("expert_slots"), "experts_mib": e.get("expert_cache_mib"),
        "live": {k: live.get(k) for k in ("state", "phase", "queued", "prompt_tokens", "generated",
                                          "max_tokens", "elapsed_s", "tok_s", "tok_s_mean",
                                          "prefill_tok_s_mean", "prompt_read", "prompt_total")},
        "accept": (acc / off) if off else None,
        "requests_total": tot.get("requests"),
        "requests": [{k: q.get(k) for k in ("time", "duration_s", "finish", "prompt_tokens", "reused",
                                            "output_tokens", "decode_tok_s", "hit_rate", "prompt_ms")}
                     for q in reqs[:8]],
    }


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

        # Which engine has the GPU. "loading" while Strata reads its weights.
        # Strata logs nothing to the journal, so while it generates its own
        # live rate stands in for the Ollama journal figure above.
        engine = None
        if pc and pc.get("engine_avail") == "1":
            if pc.get("engine_strata") in ("active", "activating"):
                engine = {"active": "strata",
                          "state": pc.get("strata_state") or "loading",
                          "model": pc.get("strata_model") or "strata"}
                try:
                    tps = float(pc.get("strata_tok_s") or 0)
                except ValueError:
                    tps = 0
                if engine["state"] == "generating" and tps > 0:
                    gen_rate, gen_age = tps, 0.0
            elif pc.get("engine_ollama") in ("active", "activating"):
                engine = {"active": "ollama", "state": "ready"}
            elif pc.get("engine_h3") in ("active", "activating"):
                # the H3 video server borrowed the GPU; it hands it back by itself after the videos
                engine = {"active": "h3", "state": "rendering" if pc.get("h3_state") == "rendering" else "ready"}
            else:
                engine = {"active": None, "state": "none"}
        strata = None     # the page reads Strata's /metrics itself, through this server
        if strata and engine["state"] == "generating" and strata["live"].get("tok_s"):
            # /metrics' rate is the same window Strata's own page shows.
            gen_rate, gen_age = strata["live"]["tok_s"], 0.0

        # on / off / mixed for the monitors, or None when it cannot be known
        # (PC unreachable, booted into Windows, or no display attached at all).
        monitors = None
        if pc:
            try:
                m_on = int(pc.get("mon_on") or 0)
                m_off = int(pc.get("mon_off") or 0)
                if m_on and m_off:
                    monitors = "mixed"
                elif m_on:
                    monitors = "on"
                elif m_off:
                    monitors = "off"
            except (TypeError, ValueError):
                pass

        snap = {"ok": True, "ts": t0,
                "online": pc is not None or oll is not None,
                "monitors": monitors,
                "engine": engine,
                "strata_models": strata_models(pc),
                "strata_default": (pc or {}).get("strata_model") or "strata",
                "strata": strata,
                # Strata's own page, linked from the header while it runs.
                # The key is deliberately not passed to the browser.
                "strata_url": STRATA_URL or None,
                # Lighting preset, or None when it cannot be known: PC down,
                # booted into Windows, or OpenRGB not set up on it.
                "rgb": ((pc.get("rgb") or None)
                        if pc and pc.get("rgb_avail") == "1" else None),
                "rgb_auto": ((pc.get("rgb_auto") == "active")
                             if pc and pc.get("rgb_avail") == "1" else None),
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
                "power_cap": int(pc.get("gpu_power_cap", 0) or 0) / 1e6 or None,
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

        snap["agent"] = probe_agent()
        if "pc" in snap:
            p = snap["pc"]
            sample = {"gpu_util": p["busy"], "gpu_mem_used": p["vram_used"], "gpu_temp": p["temp"],
                      "gpu_power": p["power"], "cpu": p["cpu_pct"], "tok_s": gen_rate if gen_rate and gen_age == 0 else
                      (gen_rate if gen_rate and gen_age is not None and gen_age < 5 else 0)}
            with _hist_lock:
                for k in _HIST_KEYS:
                    _hist[k].append(sample.get(k))
                    del _hist[k][:-120]
        with _lock:
            _snapshot.clear()
            _snapshot.update(snap)
        time.sleep(max(0.2, POLL_SECONDS - (time.time() - t0)))


# --- the page ----------------------------------------------------------------
# The page is Strata's own web UI (MIT, copied into ui/ from the Strata repo) plus
# a Manage tab (ui/web/manage.js). This server answers the relative paths that
# page calls — health, metrics, v1/chat/completions, ... — by forwarding them to
# Strata while it holds the GPU, and by filling them from this dashboard's own
# probe otherwise. So the one page keeps working when Strata is off, under Ollama,
# and when the PC sleeps (Manage → Wake), which Strata's page on the PC cannot.
UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")
UI_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2",
            ".txt": "text/plain; charset=utf-8"}


def ui_file(rel):
    """(bytes, content type) for a file under ui/, or None. Text gets the page identity."""
    path = os.path.normpath(os.path.join(UI_DIR, rel))
    if not path.startswith(UI_DIR + os.sep) or not os.path.isfile(path):
        return None
    ext = os.path.splitext(path)[1]
    with open(path, "rb") as f:
        body = f.read()
    if ext in (".html", ".js", ".webmanifest"):
        body = body.replace(b"__PC_NAME__", PC_NAME.encode())
    return body, UI_TYPES.get(ext, "application/octet-stream")


# The tab icon: the dashboard's activity trace.
FAVICON_SVG = (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" '
               b'fill="#0d1117"/><path d="M3 20h5.5l3-9.5 4 16 3-8H29" fill="none" stroke="#34d399" '
               b'stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>')

# Strata's page talks to these (relative) paths.
STRATA_PATHS = ("health", "api/health", "metrics", "status", "config", "settings", "mcp",
                "models", "props", "slots", "load", "unload")
# Paths that run the model, run tools or change settings: tailnet devices only.
# The dashboard is also reachable from the home Wi-Fi with no login, and the
# Hermes agent behind the chat has a terminal on the Mac.
CONTROL_PATHS = ("v1/", "config", "settings", "load", "unload", "mcp", "api/chats", "api/builder", "api/video")

# h3-engine ("Video" tab): MiniMax H3 text/image-to-video on the PC. It borrows the GPU from
# Strata/Ollama per video and gives it back by itself. Key added here, never sent to the browser.
H3_URL = os.environ.get("HERMES_H3_URL", "").rstrip("/")
H3_KEY = os.environ.get("HERMES_H3_KEY", "")

# strata-agent ("Builder" in the chat): Finn's own coding agent on the PC. The page talks to it through
# /api/builder/* and this server adds the key, so the key never reaches a browser.
BUILDER_URL = os.environ.get("HERMES_BUILDER_URL", "").rstrip("/")
BUILDER_KEY = os.environ.get("HERMES_BUILDER_KEY", "")

# The Hermes agent's OpenAI-compatible API server (gateway platform api_server).
AGENT_URL = os.environ.get("HERMES_AGENT_URL", "").rstrip("/")
AGENT_KEY = os.environ.get("HERMES_AGENT_KEY", "")
# Hermes provider names for the PC's two engines (see ~/.hermes/config.yaml).
AGENT_PROVIDER_STRATA = os.environ.get("HERMES_AGENT_PROVIDER_STRATA", "custom:strata")
AGENT_PROVIDER_OLLAMA = os.environ.get("HERMES_AGENT_PROVIDER_OLLAMA", "custom:pc-ollama")
# The Ollama model a chat gets when none is resident.
OLLAMA_CHAT_MODEL = os.environ.get("HERMES_OLLAMA_CHAT_MODEL", "qwen3.5:9b")
# Added to plain-model chats that may use Strata's web tools (see _chat).
RESEARCH_NOTE = ("You can search the web with the search and fetch_content tools. Search, then read only the 2-4 most "
                 "relevant pages. Shops and big sites often block page reads (403/404): then use what the search "
                 "results already say instead of trying more pages. Stop using tools after about 6 calls and always "
                 "finish with a written answer that names your sources (with links).")

# Put in front of every plain-model chat: without it Strata's Qwen model introduced itself as
# Claude and denied it could see pictures. Kept short and fixed per day so Strata's prompt
# cache still hits on every turn.
IDENTITY_NOTE = ("You are {model}, an open-weights language model running locally on Finn's own PC "
                 "({pc}) and reached through his private web dashboard. You are not Claude, ChatGPT or any "
                 "cloud assistant, and nothing leaves this PC. Today is {date}. {pictures} You have no memory "
                 "between chats and cannot run code or touch files; for that Finn uses the dashboard's Agent "
                 "chat. Answer in the language Finn writes in (usually German or English).")
STRATA_LABEL = "Qwen3.8-Flash-Next (a 125B mixture-of-experts model) served by the Strata engine"


def system_note(model, pictures, research):
    note = IDENTITY_NOTE.format(
        model=model, pc=PC_NAME, date=time.strftime("%A, %d %B %Y"),
        pictures="You can see pictures Finn attaches." if pictures else "You cannot see pictures in this setup.")
    return note + ("\n\n" + RESEARCH_NOTE if research else "")


def with_system(body, note):
    """The dashboard's note first; drop a copy of an earlier note so a resent chat doesn't stack them."""
    msgs = [m for m in body.get("messages") or [] if not (m.get("role") == "system" and (
        m.get("content") == RESEARCH_NOTE or str(m.get("content", "")).startswith("You are ")))]
    body["messages"] = [{"role": "system", "content": note}] + msgs


# Strata-only request fields other servers would reject or ignore.
STRATA_ONLY_FIELDS = ("strata_mcp", "experimental_speed_projection")


# --- chat history -------------------------------------------------------------
# Every conversation is one JSON file, so the Mac and the phone see the same list
# (Strata's page alone keeps one chat in each browser's localStorage). On zimaos
# /data is the persistent ./state volume. Read and written from tailnet clients only.
CHATS_DIR = os.environ.get("HERMES_CHATS_DIR") or (
    "/data/chats" if os.path.isdir("/data") else os.path.expanduser("~/.hermes-dashboard/chats"))
_chats_lock = threading.Lock()


def _chat_path(cid):
    if not cid or len(cid) > 48 or not all(c.isalnum() or c == "-" for c in cid):
        return None
    return os.path.join(CHATS_DIR, cid + ".json")


def chats_list():
    out = []
    with _chats_lock:
        if not os.path.isdir(CHATS_DIR):
            return out
        for name in os.listdir(CHATS_DIR):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(CHATS_DIR, name)) as f:
                    c = json.load(f)
            except (OSError, ValueError):
                continue
            out.append({"id": c.get("id"), "title": c.get("title") or "New chat", "updated": c.get("updated", 0),
                        "target": c.get("target"), "count": len(c.get("messages") or []),
                        "project": (c.get("builder") or {}).get("project")})
    return sorted(out, key=lambda c: c["updated"], reverse=True)


def chat_get(cid):
    p = _chat_path(cid)
    if not p or not os.path.isfile(p):
        return None
    with _chats_lock, open(p) as f:
        return json.load(f)


def chat_put(cid, data):
    """Create or update. A title is kept once set (renamed or derived from the first question)."""
    p = _chat_path(cid)
    if not p or not isinstance(data, dict):
        return None
    with _chats_lock:
        os.makedirs(CHATS_DIR, exist_ok=True)
        cur = {}
        if os.path.isfile(p):
            try:
                with open(p) as f:
                    cur = json.load(f)
            except (OSError, ValueError):
                cur = {}
        cur["id"] = cid
        cur.setdefault("created", time.time())
        for k in ("messages", "target", "model", "builder"):
            if k in data:
                cur[k] = data[k]
        if data.get("title"):
            cur["title"] = str(data["title"])[:120]
        if not cur.get("title"):
            first = next((m.get("text") for m in cur.get("messages") or []
                          if m.get("role") == "user" and m.get("text")), "")
            if first:
                first = " ".join(first.split())
                cur["title"] = first[:60] + ("…" if len(first) > 60 else "")
        cur["updated"] = time.time()
        tmp = p + ".part"
        with open(tmp, "w") as f:
            json.dump(cur, f)
        os.replace(tmp, p)       # never a half-written chat
        return {k: cur.get(k) for k in ("id", "title", "updated", "target")}


def chat_delete(cid):
    p = _chat_path(cid)
    with _chats_lock:
        if p and os.path.isfile(p):
            os.remove(p)
            return True
    return False


# strata-voice server (https, because browsers only give a page the microphone over https), e.g.
# https://<pc>.<tailnet>.ts.net/ - the dashboard must then also be opened over https (tailscale serve).
VOICE_URL = os.environ.get("HERMES_VOICE_URL", "").rstrip("/")
# This dashboard's own https address (tailscale serve). Set = tailnet visitors on http are sent there.
HTTPS_URL = os.environ.get("HERMES_HTTPS_URL", "").rstrip("/")


def _tailnet(ip):
    """Tailscale's CGNAT range (100.64.0.0/10) or this host itself."""
    if ip in ("127.0.0.1", "::1"):
        return True
    try:
        a, b = (int(x) for x in ip.split(".")[:2])
        return a == 100 and 64 <= b <= 127
    except ValueError:
        return False


def _snap():
    with _lock:
        return dict(_snapshot)


def strata_up(s=None):
    s = s or _snap()
    e = s.get("engine") or {}
    return bool(STRATA_URL) and e.get("active") == "strata" and e.get("state") != "loading"


def ollama_model(s):
    """The resident Ollama model, else the configured default."""
    m = s.get("ollama") or []
    return m[0]["name"] if m else OLLAMA_CHAT_MODEL


def installed_models(s):
    """Installed models for the engine holding the GPU, including unloaded Ollama models."""
    engine = (s.get("engine") or {}).get("active")
    if not s.get("online"):
        raise ValueError("%s is asleep — wake it under Manage." % PC_NAME)
    if engine == "strata":
        model = (s.get("engine") or {}).get("model") or (s.get("strata") or {}).get("model") or "strata"
        return {"engine": engine, "default": model,
                "data": s.get("strata_models") or [{"id": model, "object": "model", "label": model if model != "strata" else "Strata 125B"}],
                "strata_models": s.get("strata_models") or [], "state": (s.get("engine") or {}).get("state")}
    if engine == "h3":
        raise ValueError("The GPU is making a video (H3). Chat is back a few minutes after the last video, "
                         "or choose an engine under Manage.")
    if engine != "ollama":
        raise ValueError("No model engine is ready. Choose one under Manage.")
    with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=6) as r:
        models = json.load(r).get("models", [])
    data = [{"id": m["name"], "object": "model",
             "params": (m.get("details") or {}).get("parameter_size"),
             "size": m.get("size")} for m in models if m.get("name")]
    data.sort(key=lambda m: m["id"].lower())
    return {"engine": engine, "default": ollama_model(s), "data": data,
            "strata_models": s.get("strata_models") or [], "state": (s.get("engine") or {}).get("state")}


def synth_health(s):
    e = s.get("engine") or {}
    if not s.get("online"):
        model = "%s (asleep)" % PC_NAME
    elif e.get("active") == "strata":
        model = "Strata (loading)"
    else:
        model = ollama_model(s)
    m = s.get("ollama") or []
    return {"status": "ok", "model": model, "images": False, "api_key": False, "loaded": bool(s.get("online")),
            "max_context": (m[0].get("ctx") if m else 0) or 0, "service": "dashboard"}


def synth_metrics(s):
    """Strata's /metrics shape, filled from this dashboard's probe — for Ollama and loading/asleep."""
    p = s.get("pc") or {}
    gen = s.get("gen_rate") if (s.get("gen_age") is not None and s["gen_age"] < 5 and p.get("busy", 0) > 40) else None
    live = {"state": "generating" if gen else "idle", "queued": 0, "tok_s": gen, "phase": None,
            "prompt_tokens": None, "generated": None, "max_tokens": None, "prefill_tok_s_mean": None}
    hw = {}
    if p:
        hw = {"gpu_util": p.get("busy"), "gpu_mem_used": p.get("vram_used"), "gpu_mem_total": p.get("vram_total"),
              "gpu_temp": p.get("temp"), "gpu_power": p.get("power"), "gpu_power_limit": p.get("power_cap"),
              "cpu": p.get("cpu_pct"), "ram_used": p.get("mem_used"), "ram_total": p.get("mem_total"),
              "tok_s": gen}
    m = s.get("ollama") or []
    with _hist_lock:
        hist = {k: list(v) for k, v in _hist.items()}
    return {"engine": {"model": synth_health(s)["model"], "max_context": (m[0].get("ctx") if m else 0) or 0},
            "live": live, "requests": [], "requests_kept": 0, "totals": {}, "conversation_cache": None,
            "hardware": hw, "history": hist, "time": time.time(),
            "hardware_static": {"gpu_name": GPU_LABEL, "cpu_name": p.get("cpu_model"),
                                "threads": p.get("ncpu"), "cores": (p.get("ncpu") or 0) // 2 or None,
                                "psutil": True}}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, {"error": {"message": msg, "type": "dashboard"}})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json_field(self, raw, key, default=""):
        try:
            return json.loads(raw or b"{}").get(key, default)
        except ValueError:
            return default

    def _hermes_events(self, r):
        """Relay the Hermes agent's SSE, turning its tool events into the page's tool blocks.

        Hermes announces each tool as `event: hermes.tool.progress` + `data: {tool, emoji,
        label, toolCallId, status}`. Strata's page already draws tool calls from a chunk's
        `strata_mcp` field (call -> running, result -> done), so each Hermes event is
        re-emitted in that shape; everything else passes through untouched.
        """
        started, buf, event = {}, b"", None
        while True:
            chunk = r.read1(65536)
            if not chunk:
                break
            buf += chunk
            out = []
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", "replace")
                if text.startswith("event:"):
                    event = text[6:].strip()
                    continue                          # re-emitted below as a plain data line
                if event == "hermes.tool.progress" and text.startswith("data:"):
                    event = None
                    try:
                        x = json.loads(text[5:])
                    except ValueError:
                        continue
                    cid = x.get("toolCallId") or x.get("tool") or "tool"
                    name = x.get("tool") or "tool"
                    if x.get("status") == "running":
                        started[cid] = (time.time(), x.get("label") or "")
                        mcp = {"event": "call", "id": cid, "name": name, "server": "Hermes",
                               "tool": ((x.get("emoji") or "") + " " + name).strip(),
                               "arguments": {"what": x.get("label") or ""}}
                    else:
                        ok = x.get("status") in ("completed", "done", "ok", "success")
                        t0, label = started.pop(cid, (time.time(), ""))
                        # the block's one-line preview: what the tool worked on (Hermes sends no result)
                        mcp = {"event": "result", "id": cid, "ok": ok, "ms": int((time.time() - t0) * 1000),
                               "text": label if ok else (x.get("error") or x.get("status") or "failed")}
                    out.append(b"data: " + json.dumps({"strata_mcp": mcp}).encode() + b"\n")
                    continue
                if event and text.startswith("data:"):
                    event = None                      # other hermes.* events: not drawn
                    continue
                out.append(line + b"\n")
            if out:
                self.wfile.write(b"".join(out))
                self.wfile.flush()
        if buf:
            self.wfile.write(buf)
            self.wfile.flush()

    def _proxy(self, url, method, body=None, key="", stream=False, timeout=30, hermes=False):
        """Forward to url; stream=True relays an SSE answer chunk by chunk."""
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Content-Type", "application/json")
        if key:
            req.add_header("Authorization", "Bearer " + key)
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read() or b"{}", e.headers.get("Content-Type") or "application/json")
            return
        except Exception as e:
            self._err(502, "upstream not reachable: %s" % str(e)[:120])
            return
        with r:
            if not stream:
                self._send(r.status, r.read(), r.headers.get("Content-Type") or "application/json")
                return
            self.send_response(r.status)
            self.send_header("Content-Type", r.headers.get("Content-Type") or "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                if hermes:
                    return self._hermes_events(r)
                while True:
                    chunk = r.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass      # the page pressed Stop: dropping the upstream ends the run there too

    def _builder(self, method, path, query, raw):
        """/api/builder/<x> -> strata-agent's /api/<x> (health -> /health). Event streams are relayed live."""
        if not BUILDER_URL:
            return self._err(503, "Builder is not configured on this dashboard (HERMES_BUILDER_URL).")
        rest = path[len("api/builder/"):]
        if ".." in rest or not all(c.isalnum() or c in "-_/" for c in rest):
            return self._err(400, "bad path")
        if rest == "health":
            if not _snap().get("online"):
                return self._err(503, "%s is asleep — wake it under Manage." % PC_NAME)
            return self._proxy(BUILDER_URL + "/health", "GET", None, "", timeout=5)
        stream = method == "GET" and rest.endswith("/events")
        url = BUILDER_URL + "/api/" + rest + (("?" + query) if query else "")
        return self._proxy(url, method, raw if method == "POST" else None, BUILDER_KEY, stream,
                           timeout=3600 if stream else 30)

    def _video(self, method, path, query, raw):
        """/api/video/<x> -> h3-engine. health -> /health, files/<id>/<name> -> /files/... (Range passed on)."""
        if not H3_URL:
            return self._err(503, "Video is not configured on this dashboard (HERMES_H3_URL).")
        rest = path[len("api/video/"):]
        if ".." in rest or not all(c.isalnum() or c in "-_/." for c in rest):
            return self._err(400, "bad path")
        if not _snap().get("online"):
            return self._err(503, "%s is asleep — wake it under Manage." % PC_NAME)
        if rest == "health":
            return self._proxy(H3_URL + "/health", "GET", None, "", timeout=5)
        if rest.startswith("files/") and method == "GET":
            return self._video_file(H3_URL + "/" + rest)
        url = H3_URL + "/api/" + rest + (("?" + query) if query else "")
        return self._proxy(url, method, raw if method == "POST" else None, H3_KEY, timeout=60)

    def _video_file(self, url):
        """Stream a clip or poster with Range support (Safari will not play a video without it)."""
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + H3_KEY})
        if self.headers.get("Range"):
            req.add_header("Range", self.headers["Range"])
        try:
            r = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            return self._send(e.code, e.read() or b"{}", e.headers.get("Content-Type") or "application/json")
        except Exception as e:
            return self._err(502, "video server not reachable: %s" % str(e)[:120])
        with r:
            self.send_response(r.status)
            for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control"):
                if r.headers.get(h):
                    self.send_header(h, r.headers[h])
            self.end_headers()
            if self.command == "HEAD":
                return
            try:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _chat(self, raw):
        """POST v1/chat/completions from the page: the model on the PC, or the Hermes agent."""
        s = _snap()
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self._err(400, "bad JSON")
        if not isinstance(body, dict):
            return self._err(400, "Chat request must be a JSON object.")
        for k in STRATA_ONLY_FIELDS:
            if not strata_up(s):
                body.pop(k, None)
        stream = bool(body.get("stream"))
        e = s.get("engine") or {}
        selected = self.headers.get("X-Chat-Model")
        if not selected and isinstance(body.get("model"), str) and body["model"] in STRATA_MODELS:
            selected = body["model"]
        selected_engine = self.headers.get("X-Chat-Engine")
        if selected and s.get("online") and selected_engine and selected_engine != e.get("active"):
            return self._err(409, "The engine changed. Refresh the model picker and send again.")
        if selected and e.get("active") == "strata" and selected not in ("strata", e.get("model") or "strata"):
            return self._err(409, "A different Strata model is active. Refresh the model picker and send again.")
        if s.get("online") and e.get("active") == "ollama":
            selected = selected or body.get("model") or ollama_model(s)
            try:
                available = installed_models(s)
            except Exception:
                return self._err(503, "Could not read installed Ollama models. Try again when Ollama is ready.")
            if selected not in [m["id"] for m in available["data"]]:
                return self._err(400, "That model is not installed. Refresh the model picker and choose an installed model.")
        if (self.headers.get("X-Chat-Target") or "model") == "agent":
            if not AGENT_URL:
                return self._err(503, "The Hermes agent is not configured on this dashboard (HERMES_AGENT_URL).")
            # reasoning_effort too: the page sends its own (Strata's default "high"); the agent's
            # provider sets "low" in Hermes, which keeps each tool round quick.
            for k in STRATA_ONLY_FIELDS + ("seed", "top_k", "reasoning_effort"):
                body.pop(k, None)
            # The agent thinks with whatever holds the PC's GPU; asleep, with its own default.
            body.pop("provider", None)
            body["model"] = "hermes-agent"
            if s.get("online") and e.get("active") == "strata" and e.get("state") != "loading":
                body.update(provider=AGENT_PROVIDER_STRATA, model="strata")
            elif s.get("online") and e.get("active") == "ollama":
                body.update(provider=AGENT_PROVIDER_OLLAMA, model=selected)
            return self._proxy(AGENT_URL + "/v1/chat/completions", "POST", json.dumps(body).encode(),
                               AGENT_KEY, stream, timeout=900, hermes=True)
        if not s.get("online"):
            return self._err(503, "%s is asleep — wake it under Manage." % PC_NAME)
        if e.get("active") == "h3":
            return self._err(503, "The GPU is making a video (H3). Chat is back a few minutes after the last "
                                  "video, or choose an engine under Manage.")
        if strata_up(s):
            body["model"] = e.get("model") or body.get("model") or "strata"
            if isinstance(body.get("messages"), list):
                # With web tools the model kept reading shop pages that answer 403 until it hit
                # mcp.max_rounds, and Strata ends an answer there without any text. The research
                # part keeps it to a few reads and makes it always finish with an answer.
                with_system(body, system_note(STRATA_LABEL, True, bool(body.get("strata_mcp"))))
            return self._proxy(STRATA_URL + "/v1/chat/completions", "POST", json.dumps(body).encode(),
                               STRATA_KEY, stream, timeout=900)
        if e.get("active") == "strata":
            return self._err(503, "Strata is still loading — about 80 s after the switch.")
        body["model"] = selected or ollama_model(s)
        if isinstance(body.get("messages"), list):
            with_system(body, system_note(body["model"] + " (served by Ollama)", False, False))
        return self._proxy(OLLAMA + "/v1/chat/completions", "POST", json.dumps(body).encode(), "", stream, timeout=900)

    def _strata_path(self, method, path, query, raw):
        s = _snap()
        if strata_up(s):
            url = STRATA_URL + "/" + path + (("?" + query) if query else "")
            return self._proxy(url, method, raw if method == "POST" else None, STRATA_KEY)
        if path in ("health", "api/health"):
            return self._send(200, synth_health(s))
        if path == "metrics":
            if not s.get("online"):
                return self._err(503, "%s is asleep" % PC_NAME)
            return self._send(200, synth_metrics(s))
        if path == "mcp":           # no MCP servers while Strata is off: an empty list, not an error
            return self._send(200, {"servers": [], "tools": 0})
        if path == "models":
            try:
                return self._send(200, dict(installed_models(s), object="list"))
            except Exception:
                return self._err(503, "Could not read installed models. Check the engine under Manage.")
        # config / settings / mcp / load / unload are Strata's own: absent while it is off,
        # which the page already handles (it hides those cards).
        return self._err(404, "only while Strata runs")

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        path = u.path.lstrip("/")
        if path == "api/stats":
            with _lock:
                return self._send(200, json.dumps(_snapshot).encode())
        if path == "api/models":
            try:
                return self._send(200, installed_models(_snap()))
            except ValueError as e:
                return self._err(503, str(e))
            except Exception:
                return self._err(503, "Could not read installed models. Check the engine under Manage.")
        if path in ("", "index.html"):
            # a tailnet device on plain http gets the https address (only there may the page use the microphone);
            # only the page redirects, API calls stay as they are. LAN devices without Tailscale stay on http.
            ip = self.client_address[0]
            if HTTPS_URL and ip not in ("127.0.0.1", "::1") and _tailnet(ip):
                self.send_response(302)
                self.send_header("Location", HTTPS_URL + "/" + (("?" + u.query) if u.query else ""))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            f = ui_file("index.html")
            return self._send(200, f[0], f[1]) if f else self._err(500, "ui/index.html missing")
        if path == "favicon.ico":
            return self._send(200, FAVICON_SVG, "image/svg+xml")
        if path.startswith("fonts/"):      # tokens.css asks for /fonts/..., the files sit in web/fonts
            path = "web/" + path
        if path.startswith("web/"):
            f = ui_file(path)
            return self._send(200, f[0], f[1]) if f else self._err(404, "not found")
        if path.startswith(CONTROL_PATHS) and not _tailnet(self.client_address[0]):
            return self._err(403, "Only from a Tailscale device.")
        if path == "api/voice":            # strata-voice (talk to the model); empty url = no voice button
            return self._send(200, json.dumps({"url": VOICE_URL}).encode())
        if path.startswith("api/builder/"):
            return self._builder("GET", path, u.query, None)
        if path.startswith("api/video/"):
            return self._video("GET", path, u.query, None)
        if path == "api/chats":
            return self._send(200, chats_list())
        if path.startswith("api/chats/"):
            c = chat_get(path[len("api/chats/"):])
            return self._send(200, c) if c else self._err(404, "no such chat")
        if path in STRATA_PATHS or path.startswith("v1/"):
            if path == "v1/models":
                path = "models"
            return self._strata_path("GET", path, u.query, None)
        if path in ("manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"):
            f = ui_file(path)
            ctype = "application/manifest+json" if path.endswith("manifest") else "image/png"
            return self._send(200, f[0], ctype) if f else self._err(404, "not found")
        self._err(404, "not found")

    def do_PUT(self):
        path = urllib.parse.urlsplit(self.path).path.lstrip("/")
        raw = self._body()
        if not _tailnet(self.client_address[0]):
            return self._err(403, "Only from a Tailscale device.")
        if path.startswith("api/chats/"):
            try:
                data = json.loads(raw or b"{}")
            except ValueError:
                return self._err(400, "bad JSON")
            r = chat_put(path[len("api/chats/"):], data)
            return self._send(200, r) if r else self._err(400, "bad chat id")
        self._err(404, "not found")

    def do_DELETE(self):
        path = urllib.parse.urlsplit(self.path).path.lstrip("/")
        if not _tailnet(self.client_address[0]):
            return self._err(403, "Only from a Tailscale device.")
        if path.startswith("api/chats/"):
            return self._send(200, {"ok": chat_delete(path[len("api/chats/"):])})
        if path.startswith("api/video/jobs/"):
            return self._video("DELETE", path, "", None)
        self._err(404, "not found")

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        path = u.path.lstrip("/")
        raw = self._body()
        if path.startswith(CONTROL_PATHS) and not _tailnet(self.client_address[0]):
            return self._err(403, "Chat and model settings only from a Tailscale device — "
                                  "the agent behind them can run commands on the Mac.")
        if path == "v1/chat/completions":
            return self._chat(raw)
        if path.startswith("api/builder/"):
            return self._builder("POST", path, u.query, raw)
        if path.startswith("api/video/"):
            return self._video("POST", path, u.query, raw)
        if path in STRATA_PATHS or path.startswith("v1/"):
            return self._strata_path("POST", path, u.query, raw)
        if path == "api/power":
            ok, msg = power_action(self._json_field(raw, "action"))
        elif path == "api/display":
            ok, msg = display_action(self._json_field(raw, "action"))
        elif path == "api/rgbauto":
            ok, msg = rgb_auto_action(bool(self._json_field(raw, "on", False)))
        elif path == "api/rgb":
            ok, msg = rgb_action(self._json_field(raw, "color"))
        elif path == "api/engine":
            ok, msg = engine_action(self._json_field(raw, "engine"), self._json_field(raw, "model"))
        elif path == "api/wake":
            # direct=1 comes from another dashboard relaying to us: broadcast
            # locally only, never relay onward, so the two can't ping-pong.
            if "direct=1" in (u.query or ""):
                sent = wake_direct()
                ok = bool(sent)
                msg = ("magic packet broadcast on the local network" if ok
                       else "relay is not on the PC's LAN")
            else:
                ok, msg = wake()
        else:
            return self._err(404, "not found")
        self._send(200, {"ok": ok, "message": msg})

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
