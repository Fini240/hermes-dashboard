# hermes-dashboard

A single-file browser dashboard for a remote Ollama box: live GPU/CPU/RAM/power,
wake-on-LAN, suspend/shutdown, monitor blanking, RGB lighting that can follow the
machine's own load, and Hermes token accounting. Stdlib-only Python — no pip install, no build step, no JS framework.

Runs anywhere with Docker — a NAS, a mini PC, a Raspberry Pi — as long as it shares
the monitored machine's LAN.

---

## Why it runs where it runs

Put the dashboard on a **machine that is always on and shares the PC's LAN** — not on
your laptop. That placement is what makes three things work:

- **Wake-on-LAN.** A magic packet is a layer-2 broadcast. It does not cross Tailscale
  or any VPN. Only a host already on the PC's LAN can wake it.
- **The SSH probe.** A LAN address with key auth is reliable. Tailscale SSH demands a
  periodic browser re-auth and *hangs* rather than refusing, so the probe times out and
  the PC looks asleep when it is fine.
- **Uptime.** The PC's stats are only "always available" if the watcher is.

Your laptop can still run a copy; it will relay wake requests to the LAN-side one over
`HERMES_WAKE_RELAY_URL`.

## Architecture

```
browser ──GET /──────────► PAGE_HTML   (static, placeholders substituted at startup)
        ──GET /api/stats─► _snapshot   (cached dict, never blocks on I/O)
        ──POST /api/wake─► magic packet, direct or relayed
        ──POST /api/display► ssh <PC> kscreen-doctor --dpms on|off
        ──POST /api/rgb────► ssh <PC> rgb-apply red|purple|blue|off
        ──POST /api/rgbauto► ssh <PC> systemctl …able --now rgb-auto
                              ▲
   poller thread (2s) ────────┤  ssh <PC> sysfs probe  → GPU/CPU/RAM/power
                              │  GET /api/ps           → resident models
                              └  read state.db         → token totals
   syncer thread (15s) ─────────  ssh <mac> sqlite3 export → state.db
```

Two background threads own all slow I/O and write into `_snapshot`; HTTP handlers only
serve the cached dict, so the page never waits on SSH.

## Setting it up for a new PC

**On the PC being monitored:**

1. Ollama installed and bound to an address the dashboard can reach
   (`OLLAMA_HOST=0.0.0.0:11434` or a tailnet address).
2. `sshd` running, with the dashboard host's public key in `/root/.ssh/authorized_keys`.
   Avoid Tailscale SSH here — see above.
3. Wake-on-LAN armed: `ethtool <iface> | grep Wake-on` must show `g`.
   Enable with `ethtool -s <iface> wol g` and make it persist across reboots.
4. AMD GPUs report through `/sys/class/drm/card*/device/gpu_busy_percent`. NVIDIA does
   not — the probe in `PROBE` needs replacing with `nvidia-smi` for those cards.
5. For the RGB button, install what is in `pc-setup/` — see *RGB lighting* below.
   Without it the button simply reads `RGB n/a`.

**On the host that will run the dashboard:**

```sh
git clone <this repo> hermes-dashboard && cd hermes-dashboard
cp .env.example .env && $EDITOR .env          # fill in name, host, MAC, subnet
mkdir -p ssh state
ssh-keygen -t ed25519 -N "" -f ssh/id_ed25519 # then install the .pub on the PC
docker compose up -d --build
```

Open `http://<host>:8765`.

Without Docker: `HERMES_PC_NAME=… ./hermes-dashboard-server.py` works the same;
every setting is an environment variable with a working default.

## Configuration

Every value is an env var — one file serves every machine, so a fix reaches all of them
instead of drifting across forked copies. See `.env.example` for the annotated list.

| Variable | Purpose |
|---|---|
| `HERMES_PC_NAME` | Tab title, header, wake button |
| `HERMES_PC_HOST` | SSH target for the sysfs probe |
| `HERMES_OLLAMA` | Ollama base URL (often a *different* address to the SSH host) |
| `HERMES_GPU_LABEL` | Cosmetic GPU name — Ollama does not report one |
| `HERMES_PC_MAC` / `HERMES_LAN_PREFIX` | Wake-on-LAN target and subnet |
| `HERMES_WAKE_RELAY_URL` | LAN-side dashboard to relay wake through when away |
| `HERMES_SSH_KEY` / `HERMES_KNOWN_HOSTS` | Key paths (no ssh-agent in a container) |
| `HERMES_STATE_SYNC` | `user@host:/path/to/state.db`; blank disables token panels |
| `HERMES_STATE_SYNC_SECONDS` | Token sync interval (default 15) |

## Monitors off, machine on

The Power card's third button blanks the PC's displays and leaves the machine fully
awake and on the network. On a desk setup that is where most of the idle wattage
actually sits — two panels easily outdraw an idling box — so it is the middle setting
between "running with the screens lit" and "suspended and unreachable".

- **It is a compositor operation, not a sysfs write.** The running KMS master owns the
  connectors and overrides anything written behind its back. `display_action()` asks
  logind for seat0's *active* session, then runs `kscreen-doctor --dpms` as that
  session's own user against its Wayland socket (with an `xset` path for X11). The
  session is resolved per call, because it is the greeter while nobody is logged in and
  the desktop user's afterwards — different uid, different socket.
- **The state is read back, never assumed.** Each connected DRM connector exposes its
  own `dpms` attribute and the compositor's change lands there, so the probe reports the
  truth whoever turned the screens off — this button, the lock screen, or a key press at
  the desk. The button relabels itself from that reading on the next 2s poll.
- **Filter connectors on `status`, not `enabled`.** Blanking disables the CRTC, so a
  blanked display reports `enabled=disabled`; filtering on it makes the monitors
  disappear from the count instead of reading "off".
- **No arm/confirm step**, unlike its two neighbours: it is instantly reversible and
  costs nothing if mis-clicked.
- **Linux only.** An ssh session on Windows lands outside the interactive desktop, so
  the `SC_MONITORPOWER` broadcast never reaches the session that owns the displays. The
  button says `Monitors n/a` there rather than failing cryptically.
- It does **not** hold off an idle-suspend timer on the PC. If the box is set to suspend
  on idle, blanking the screens will not keep it up.

## RGB lighting

The fourth Power button carries four swatches — red, purple, blue, green. Clicking a swatch
sets that colour on every controller in the machine; clicking the button *beside* the
swatches switches the lighting off. The active swatch is the one that is lit, so the
button reports the current preset without a separate indicator.

Everything hardware-facing lives on the PC, in `pc-setup/`:

| File | Goes to | |
|---|---|---|
| `rgb-apply` | `/usr/local/bin/` | Applies a preset and records it |
| `rgb-restore` | `/usr/local/bin/` | Sizes the zones, re-applies the preset |
| `rgb-auto` | `/usr/local/bin/` | Loop: red while working, green while idle |
| `rgb-auto.service` | `/etc/systemd/system/` | The Auto toggle enables/disables this |
| `openrgb.service` | `/etc/systemd/system/` | OpenRGB in server mode |
| `openrgb-resume.service` | `/etc/systemd/system/` | Restarts it after resume |

```sh
pacman -S openrgb                     # or your distro's package
install -m755 pc-setup/rgb-* /usr/local/bin/
cp pc-setup/openrgb*.service /etc/systemd/system/
systemctl enable --now openrgb.service openrgb-resume.service
```

### The Auto toggle

Next to the swatches, `Auto` hands the lighting to the PC: **red while it is working,
green while it is idle**. Picking a colour by hand switches Auto back off — leaving both
on would mean the daemon quietly reverting the choice at the next load transition, which
reads as a broken button.

The loop runs **on the PC**, as `rgb-auto.service`, not in the dashboard's poller. That
is deliberate: rebuilding the container or rebooting the dashboard host must not freeze
the lighting, and `systemctl enable` makes the mode survive a reboot of the PC itself.
The dashboard only flips the switch and reports `systemctl is-active`.

- **The GPU is the signal that matters.** A model generating pins it near 100% while
  barely moving the CPU, so a CPU-only trigger would miss exactly the case worth showing.
  Heavy CPU work counts as working too, at 35% of all cores.
- **Asymmetric timing.** Red is immediate; the idle colour waits for `IDLE_HOLD` (20s)
  of quiet, so the gaps between tokens in a response do not strobe the case.
- **It only writes on a transition**, comparing against the same state file `rgb-apply`
  records, so OpenRGB is not sent the same colour every few seconds.
- Thresholds are environment variables with defaults — `GPU_BUSY`, `CPU_BUSY`,
  `IDLE_HOLD`, `POLL`, `BUSY_COLOR`, `IDLE_COLOR` — so a systemd drop-in can retune it
  without editing the script.

Why it is built that way:

- **The server mode is not optional.** A bare `openrgb --mode …` re-detects every
  controller before doing anything — 22 seconds on this machine. Against a running
  `openrgb --server`, the same change takes under a second, which is the difference
  between a button and a chore.
- **Two passes, not one.** No single mode covers every controller: Corsair Vengeance
  DRAM offers no `static`, and the Sapphire GPU offers no `direct`. `rgb-apply` sends
  both and lets each controller ignore the one it does not implement. `--mode off`
  *is* supported by all of them.
- **The PC owns the state, not the dashboard.** OpenRGB's CLI cannot read a colour
  back, so `rgb-apply` records what it set under `/var/lib/hermes-rgb/state` and the
  probe reads that file. The same file is what `rgb-restore` replays, so the lighting
  survives a reboot (the board would otherwise return to its firmware effect) and a
  resume (the server loses its SMBus and hidraw handles across S3). A value the
  dashboard merely remembered would go stale in exactly those two cases.
- **Corsair channel zones arrive sized to zero LEDs**, and a zone with no LEDs swallows
  every colour write in silence. That is the failure this cost a session to find: the
  DRAM obeyed immediately while the fans on a Lighting Node Core stayed dark, with no
  error anywhere. `rgb-restore` sizes both headers to their full length before applying
  anything, so a fresh config, a rebuilt container or a new machine cannot reintroduce
  it. Nothing reports how many LEDs are physically on the chain, so addressing the full
  length is the honest default: whatever is plugged in falls inside the range.
- **`--size` is rejected unless a mode or colour is passed in the same invocation** —
  on its own it fails with the unhelpful `Device 0 specified, but neither mode nor
  color given`.
- **Caveat:** if the lighting is changed by something else — the BIOS, or Windows on
  the other boot — that file is no longer the truth. It is what this machine last
  applied, not a read-back.

## The look

Dark, flat, information-dense — readable at a glance from across the room.

- **Palette** is defined once as CSS custom properties on `:root`:
  `--grn #3ddc84`, `--yel #ffc857`, `--red #ff5f56`, `--blu #5aa9ff`, `--mag #c98bff`.
- **Colour carries meaning, consistently.** Blue = load, amber = temperature,
  green = power, magenta = memory. The rows read as families rather than decoration.
- **Cards** are `--card` on a 1px `--line` border, `14px` radius, `16px 17px` padding.
  Rows are laid out with `.grid` (`gap:14px`); `.g4` for the four-up stat rows, `.g2`
  for two-up, `.g1` to give standalone cards the same rhythm. Never hardcode a second
  spacing value — inherit the grid gap so it can't drift.
- **`.g2` sets `align-items:start`** so a short card is not stretched to a tall
  neighbour's height, which leaves dead space under its chart. `.g4` keeps the default
  stretch, where uniform card heights look right.
- **Sparklines** are inline SVG, `viewBox="0 0 100 38"` with
  `preserveAspectRatio="none"` and `vector-effect="non-scaling-stroke"` so the line
  keeps its weight when the card is wide. 60 points of client-side history at 2s each.
  Do *not* anchor them to the card bottom — it squashes them in the four-up rows.
- **The Power card is `data-keep`** — `morph()` never touches its contents, or a 2s tick
  would wipe the arm/confirm state mid-click. Anything live inside it is therefore
  updated by hand; `syncMonitors()` is the one that does so for the monitors indicator.
- **The favicon is a status light.** An activity trace recoloured live: green healthy,
  amber when host metrics are missing, red when unreachable. The href is rewritten only
  when the colour changes; rewriting per tick makes Chrome re-fetch and flicker.
- **Degraded states are stated, not faked.** Stale token numbers are labelled "from the
  source machine N min ago"; a failed SSH probe says "host metrics unavailable" rather than
  claiming the PC is asleep.

## Gotchas worth keeping

These each cost real debugging time.

- **`online` must not mean "SSH worked."** Ollama answering is the honest liveness
  signal; SSH only adds host metrics. Conflating them reports a busy PC as asleep.
- **Ollama enumerates GPUs once, at startup.** On a cold boot it can win the race
  against the amdgpu driver, find no GPU, and run *every* model on CPU for the whole
  session with no error. Symptom: `llama-server` pinning cores while `gpu_busy_percent`
  reads 0. Gate the service on `/dev/kfd` existing.
- **Check `size` vs `size_vram` in `/api/ps`.** Equal means fully on GPU; `size_vram: 0`
  means CPU-only. Fastest way to catch both the race above and an oversized `num_ctx`.
- **Sync the table, not the database.** Only `session_model_usage` is read (~100 rows).
  The full `state.db` is 11 MB of messages and FTS indexes. Exporting the one table is
  24 KB — 450× smaller, which is what makes a 15s interval affordable.
- **`os.replace()` leaves stale `-wal`/`-shm`.** They belong to the *previous* database
  and SQLite will read a mismatched WAL and hand back corrupt rows. Delete both.
- **ZimaOS `/root` is read-only squashfs.** Keys and state go under `/DATA`, and
  `docker compose` needs `DOCKER_CONFIG` pointed somewhere writable or it dies on
  `mkdir /root/.docker`.
- **Don't register it as a CasaOS app.** A CasaOS app *update* regenerates the compose
  from its template and silently drops volumes. A plain compose project avoids that.

## Files

| File | |
|---|---|
| `hermes-dashboard-server.py` | Everything — server, poller, page, CSS, JS |
| `Dockerfile` | `python:3.12-alpine` + `openssh-client` |
| `docker-compose.yml` | Host networking, `.env`, ssh + state volumes |
| `.env.example` | Annotated settings template |
| `pc-setup/` | What goes *on the monitored PC* for RGB control |
