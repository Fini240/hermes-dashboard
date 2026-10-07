// The dashboard's additions to Strata's page: the Manage tab (engine, chat target, power, monitors, lighting,
// wake, Hermes tokens) and the chat target switch in the composer. Loaded BEFORE app.js, so the fetch hook below
// is in place for app.js' first request. Everything here talks to the dashboard's own /api/* endpoints.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const icon = (n, cls = "st-icon st-icon--sm") => `<svg class="${cls}" aria-hidden="true"><use href="web/sprite.svg#i-${n}"/></svg>`;
  const num = (n) => { n = +n || 0; if (n < 1000) return String(Math.round(n)); const u = ["K", "M", "G", "T"]; let i = -1;
    while (n >= 1000 && i < 3) { n /= 1000; i++; } return n.toFixed(1) + u[i]; };
  const dur = (s) => { s = Math.max(0, Math.round(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };

  // ---------------------------------------------------------------- chat target
  // Who answers the chat: the model on the PC (Strata or Ollama, whichever holds the GPU) or the Hermes agent
  // (tools, memory, terminal on the Mac). The dashboard server routes on this header; app.js never knows.
  let target = store.get("dash.chat-target", "model");
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (typeof url === "string" && url.replace(/^\//, "").startsWith("v1/chat/completions")) {
      opts = Object.assign({}, opts);
      opts.headers = Object.assign({}, opts.headers, {"X-Chat-Target": target});
    }
    return realFetch(url, opts);
  };

  const css = `
.view--manage{overflow-y:auto}
.manage{max-width:1240px;width:100%;margin:0 auto;padding:var(--st-s-6);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--st-s-4);align-content:start}
.manage .st-card{display:flex;flex-direction:column;gap:var(--st-s-3)}
.manage .wide{grid-column:1/-1}
.manage p{margin:0}
.mg-row{display:flex;gap:var(--st-s-2);flex-wrap:wrap;align-items:center}
.mg-seg{display:inline-flex;gap:4px;padding:4px;background:var(--st-surface-2);border:1px solid var(--st-line);border-radius:var(--st-r-md);flex-wrap:wrap}
.mg-seg button{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border:0;border-radius:10px;background:transparent;color:var(--st-ink-muted);font:500 var(--st-fs-md)/1 var(--st-font);cursor:pointer;white-space:nowrap}
.mg-seg button:hover:not(:disabled){color:var(--st-ink)}
.mg-seg button[aria-pressed="true"]{background:var(--st-surface);color:var(--st-ink);font-weight:700;box-shadow:var(--st-sh-card);cursor:default}
.mg-seg button:disabled{opacity:.45;cursor:not-allowed}
.mg-dot{width:8px;height:8px;border-radius:50%;background:var(--st-ink-muted);opacity:.5;flex:none}
.mg-dot.on{background:var(--st-accent);opacity:1;box-shadow:0 0 0 3px var(--st-accent-tint)}
.mg-dot.warn{background:var(--st-warn);opacity:1;box-shadow:0 0 0 3px var(--st-warn-tint)}
.mg-dot.off{background:var(--st-danger);opacity:1;box-shadow:0 0 0 3px var(--st-danger-tint)}
.mg-btn.armed{background:var(--st-warn-tint);color:var(--st-warn-text);border-color:var(--st-warn)}
.mg-btn.danger.armed{background:var(--st-danger-tint);color:var(--st-danger-text);border-color:var(--st-danger)}
.mg-sw{width:16px;height:16px;border-radius:50%;border:1px solid rgba(255,255,255,.18);opacity:.4;cursor:pointer;flex:none}
.mg-sw.on{opacity:1;box-shadow:0 0 0 3px var(--st-line)}
.mg-status{display:flex;align-items:center;gap:10px;font-size:var(--st-fs-md)}
.mg-msg{font-size:var(--st-fs-sm);color:var(--st-ink-soft);min-height:20px}
.mg-kv{display:flex;justify-content:space-between;gap:12px;font-size:var(--st-fs-md);padding:6px 0;border-bottom:1px solid var(--st-line-soft)}
.mg-kv:last-child{border-bottom:0}
.mg-kv .v{color:var(--st-ink-muted);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.chat-target{display:inline-flex;gap:2px;padding:3px;background:var(--st-surface-2);border:1px solid var(--st-line);border-radius:10px}
.chat-target button{height:30px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--st-ink-muted);font:500 var(--st-fs-sm)/1 var(--st-font);cursor:pointer;white-space:nowrap}
.chat-target button[aria-pressed="true"]{background:var(--st-surface);color:var(--st-ink);font-weight:700;box-shadow:var(--st-sh-card)}
@media(max-width:860px){.manage{grid-template-columns:1fr;padding:var(--st-s-4)}}`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  const SW = {red: "#ff2d2d", purple: "#8000ff", blue: "#2d6bff", green: "#2ddd6b"};

  function build() {
    $("manage").innerHTML = `
      <div class="st-card wide" id="mg-asleep" hidden>
        <span class="card-title">__PC_NAME__ is asleep or off</span>
        <p class="muted">Chat and the model are not available until it wakes. Waking takes about 10 seconds from sleep.</p>
        <div class="mg-row"><button class="st-btn st-btn--primary" id="mg-wake">${icon("bolt")}Wake __PC_NAME__</button></div>
        <div class="mg-msg" id="mg-wake-msg"></div>
      </div>
      <div class="st-card">
        <span class="card-title">Model engine</span>
        <div class="mg-row"><div class="mg-seg" id="mg-eng">
          <button data-eng="ollama"><span class="mg-dot"></span><span>Ollama</span></button>
          <button data-eng="strata"><span class="mg-dot"></span><span>Strata 125B</span></button></div></div>
        <p class="muted small">Only one runs at a time — both need the whole GPU. Ollama: the everyday models, fastest
          overall. Strata: the 125B coder, strongest at code (~33 tok/s, about 80 s to load). The PC stops Strata before it
          suspends and comes back with Ollama.</p>
        <div class="mg-msg" id="mg-eng-msg"></div>
      </div>
      <div class="st-card">
        <span class="card-title">Chat goes to</span>
        <div class="mg-row"><div class="mg-seg" id="mg-target">
          <button data-t="model"><span class="mg-dot on"></span><span>Model on the PC</span></button>
          <button data-t="agent"><span class="mg-dot" id="mg-agent-dot"></span><span>Hermes agent</span></button></div></div>
        <p class="muted small" id="mg-target-note"></p>
      </div>
      <div class="st-card">
        <span class="card-title">Power</span>
        <div class="mg-status"><span class="mg-dot" id="mg-pc-dot"></span><span id="mg-pc-text">–</span></div>
        <div class="mg-row">
          <button class="st-btn st-btn--secondary mg-btn" data-act="suspend">Suspend</button>
          <button class="st-btn st-btn--secondary mg-btn danger" data-act="poweroff">Shut down</button>
          <button class="st-btn st-btn--secondary" id="mg-mon"><span class="mg-dot"></span><span>Monitors</span></button>
        </div>
        <p class="muted small">Suspend keeps the network card armed, so Wake brings it back; Shut down needs
          wake-on-LAN in the BIOS. Monitors off blanks the displays only — the PC stays awake.</p>
        <div class="mg-msg" id="mg-pw-msg"></div>
      </div>
      <div class="st-card">
        <span class="card-title">Lighting</span>
        <div class="mg-row" id="mg-rgb">
          ${Object.entries(SW).map(([c, hex]) => `<button class="st-btn st-btn--secondary" data-c="${c}" title="${c}">
            <span class="mg-sw" style="background:${hex}"></span>${c[0].toUpperCase() + c.slice(1)}</button>`).join("")}
          <button class="st-btn st-btn--secondary" data-c="off">Off</button>
        </div>
        <div class="toggle-row"><span>Auto<br><span class="muted small">red while the PC works, green while it is idle;
          picking a colour turns it off</span></span>
          <button class="st-toggle" id="mg-auto" role="switch" aria-checked="false" aria-label="Automatic lighting"></button></div>
        <div class="mg-msg" id="mg-rgb-msg"></div>
      </div>
      <div class="st-card wide" id="mg-tokens" hidden>
        <span class="card-title" id="mg-tok-title">Hermes tokens</span>
        <div class="manage" style="padding:0;max-width:none" id="mg-tok-body"></div>
      </div>`;

    for (const b of $("mg-eng").querySelectorAll("button")) b.onclick = () => doEngine(b);
    for (const b of $("mg-target").querySelectorAll("button")) b.onclick = () => setTarget(b.dataset.t);
    for (const b of document.querySelectorAll(".mg-btn")) b.onclick = () => doPower(b);
    $("mg-mon").onclick = doMonitors;
    for (const b of $("mg-rgb").querySelectorAll("button")) b.onclick = () => post("/api/rgb", {color: b.dataset.c}, "mg-rgb-msg");
    $("mg-auto").onclick = () => post("/api/rgbauto", {on: $("mg-auto").getAttribute("aria-checked") !== "true"}, "mg-rgb-msg");
    $("mg-wake").onclick = doWake;
    paintTarget();
  }

  // the composer's own switch, so the target is visible where you type
  function buildComposerSwitch() {
    const bar = document.querySelector(".st-composer__bar .spacer");
    if (!bar || $("chat-target")) return;
    bar.insertAdjacentHTML("beforebegin", `<span class="chat-target" id="chat-target" title="Who answers">
      <button type="button" data-t="model">Model</button><button type="button" data-t="agent">Hermes agent</button></span>`);
    for (const b of $("chat-target").querySelectorAll("button")) b.onclick = () => setTarget(b.dataset.t);
  }
  function setTarget(t) { target = t; store.set("dash.chat-target", t); paintTarget(); }
  function paintTarget() {
    for (const b of document.querySelectorAll("#mg-target button, #chat-target button"))
      b.setAttribute("aria-pressed", String(b.dataset.t === target));
    const sub = $("chat-empty-sub");
    if (sub && target === "agent") sub.textContent = "Hermes answers with its tools and memory — it can run commands on the Mac.";
    const n = $("mg-target-note");
    if (n) n.textContent = target === "agent"
      ? "The Hermes agent on the Mac answers, with its tools, memory and terminal. It thinks with the model on the PC (Strata or Ollama), or with the Mac's own 4B when the PC is asleep."
      : "The model on the PC answers directly — fast, no tools. Strata or Ollama, whichever holds the GPU.";
  }

  // ---------------------------------------------------------------- actions
  async function post(url, body, msgId) {
    const m = $(msgId);
    try {
      const r = await (await realFetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)})).json();
      if (m) m.textContent = r.message;
      return r;
    } catch (e) { if (m) m.textContent = "Could not reach the dashboard server."; return {ok: false}; }
  }
  let engBusy = 0;
  async function doEngine(b) {
    if (b.disabled || b.getAttribute("aria-pressed") === "true") return;
    engBusy = Date.now();
    b.querySelector("span:last-child").textContent = "Switching…";
    for (const o of $("mg-eng").querySelectorAll("button")) o.disabled = true;
    await post("/api/engine", {engine: b.dataset.eng}, "mg-eng-msg");
    setTimeout(() => { engBusy = 0; }, 3000);
  }
  async function doPower(b) {
    const msg = $("mg-pw-msg"), act = b.dataset.act, label = act === "suspend" ? "Suspend" : "Shut down";
    if (!b.classList.contains("armed")) {
      for (const o of document.querySelectorAll(".mg-btn")) { o.classList.remove("armed"); o.textContent = o.dataset.act === "suspend" ? "Suspend" : "Shut down"; }
      b.classList.add("armed"); b.textContent = `Confirm ${label.toLowerCase()}`;
      clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove("armed"); b.textContent = label; }, 5000);
      msg.textContent = "Click again within 5 seconds to confirm.";
      return;
    }
    clearTimeout(b._t); b.classList.remove("armed"); b.textContent = "Sending…";
    const r = await post("/api/power", {action: act}, "mg-pw-msg");
    b.textContent = r.ok ? "Sent" : "Failed";
    setTimeout(() => { b.textContent = label; }, 4000);
  }
  let monBusy = 0;
  async function doMonitors() {
    const b = $("mg-mon"); if (b.disabled) return;
    monBusy = Date.now();
    b.querySelector("span:last-child").textContent = b.dataset.state === "off" ? "Turning on…" : "Turning off…";
    await post("/api/display", {action: b.dataset.state === "off" ? "on" : "off"}, "mg-pw-msg");
  }
  async function doWake() {
    const b = $("mg-wake"); b.disabled = true;
    const r = await post("/api/wake", {}, "mg-wake-msg");
    setTimeout(() => { b.disabled = false; }, r.ok ? 20000 : 0);
  }

  // ---------------------------------------------------------------- state
  const ENG = {loading: "loading…", idle: "ready", reading: "reading", generating: "generating", ready: "ready", error: "not answering"};
  let asleepToasted = false;
  function paint(s) {
    // asleep / awake
    $("mg-asleep").hidden = !!s.online;
    if (!s.online && !asleepToasted && typeof toast === "function") {
      asleepToasted = true;
      toast("warn", "__PC_NAME__ is asleep", "Wake it under Manage.", 6000);
    }
    if (s.online) asleepToasted = false;
    const p = s.pc;
    $("mg-pc-dot").className = "mg-dot " + (!s.online ? "off" : s.host_stats ? "on" : "warn");
    $("mg-pc-text").textContent = !s.online ? "Asleep or off" : !s.host_stats ? "Online — no host metrics (SSH probe not answering)"
      : `Online · up ${dur(p.uptime)} · ${p.total_watts != null ? Math.round(p.total_watts) + " W (est.)" : ""}`;
    for (const b of document.querySelectorAll(".mg-btn")) if (!b.classList.contains("armed")) b.disabled = !s.host_stats;

    // engine
    const e = s.engine;
    if (!engBusy) for (const b of $("mg-eng").querySelectorAll("button")) {
      const name = b.dataset.eng === "strata" ? "Strata 125B" : "Ollama", on = !!e && e.active === b.dataset.eng;
      b.disabled = !e; b.setAttribute("aria-pressed", String(on));
      b.querySelector(".mg-dot").className = "mg-dot" + (on ? (e.state === "loading" || e.state === "error" ? " warn" : " on") : "");
      b.querySelector("span:last-child").textContent = on ? `${name} · ${ENG[e.state] || e.state}` : name;
    }

    // chat target: is the agent reachable?
    $("mg-agent-dot").className = "mg-dot" + (s.agent == null ? "" : s.agent ? " on" : " off");
    $("mg-agent-dot").title = s.agent == null ? "not configured" : s.agent ? "Hermes is reachable" : "Hermes is not reachable (Mac asleep?)";

    // monitors
    const mb = $("mg-mon");
    if (!monBusy || Date.now() - monBusy > 2500) {
      monBusy = 0;
      const m = s.monitors;
      mb.dataset.state = m || "na"; mb.disabled = !m;
      mb.querySelector(".mg-dot").className = "mg-dot" + (m === "on" ? " on" : m === "mixed" ? " warn" : "");
      mb.querySelector("span:last-child").textContent = !m ? "Monitors n/a" : m === "off" ? "Monitors off" : m === "mixed" ? "Monitors mixed" : "Monitors on";
    }

    // lighting
    for (const b of $("mg-rgb").querySelectorAll("button")) {
      b.disabled = s.rgb == null;
      const sw = b.querySelector(".mg-sw"); if (sw) sw.classList.toggle("on", b.dataset.c === s.rgb);
      b.style.borderColor = b.dataset.c === s.rgb ? "var(--st-accent)" : "";
    }
    const a = $("mg-auto"); a.disabled = s.rgb_auto == null; a.setAttribute("aria-checked", String(!!s.rgb_auto));

    // Hermes tokens
    const t = s.tokens;
    $("mg-tokens").hidden = !t;
    if (t) {
      let age = "";
      if (s.tokens_age != null && s.tokens_age > 90) { const m = Math.round(s.tokens_age / 60); age = ` · from the Mac ${m < 60 ? m + " min" : Math.round(m / 60) + " h"} ago`; }
      $("mg-tok-title").textContent = "Hermes tokens" + age;
      const kv = (k, v) => `<div class="mg-kv"><span>${esc(k)}</span><span class="v">${v}</span></div>`;
      const c = t.current;
      let h = `<div>${kv("Input", num(t.in))}${kv("Output", num(t.out))}${kv("Cached", num(t.cache_read))}` +
              `${t.reasoning ? kv("Reasoning", num(t.reasoning)) : ""}${kv("API calls", t.calls.toLocaleString())}${kv("Sessions", t.sessions)}</div>`;
      h += `<div>${c ? kv("Current session", `<code>${esc(c.id)}</code>`) + kv("Model", `<code>${esc(c.model)}</code>`) +
            kv("In / Out", `${num(c.in)} / ${num(c.out)}`) + kv("Last activity", `${dur(c.idle)} ago`) : ""}` +
           `${(t.models || []).slice(0, 4).map((x) => kv(x.name, `${num(x.out)} out · ${x.calls} calls`)).join("")}</div>`;
      $("mg-tok-body").innerHTML = h;
    }
  }

  let tabNow = "chat";
  window.manageShown = (t) => { tabNow = t; };
  async function poll() {
    try {
      const s = await (await realFetch("/api/stats", {cache: "no-store"})).json();
      paint(s);
    } catch (e) { /* dashboard server restarting */ }
    setTimeout(poll, tabNow === "manage" ? 2000 : 5000);
  }
  document.addEventListener("DOMContentLoaded", () => { build(); buildComposerSwitch(); paintTarget(); poll(); });
})();
