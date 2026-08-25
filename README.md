# hermes-dashboard

A single-file browser dashboard for a remote Ollama box: live GPU/CPU/RAM/power,
wake-on-LAN, suspend/shutdown, and Hermes token accounting. Stdlib-only Python —
no pip install, no build step, no JS framework.

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
