// serve/web/app.js - the Strata web app: Chat, Monitor, About. No framework, no network beyond this server.
// The Monitor tab rebuilds PR #22's dashboard idea (code-martin) on the server's own /metrics.
"use strict";

const $ = (id) => document.getElementById(id);
const SPRITE = "web/sprite.svg";
const icon = (name, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
// numbers in en-US style ("19.7", "1,234") everywhere, whatever the browser's locale: the page text is English
const fmt = (n, d = 0) => (n == null || Number.isNaN(+n) ? "–" : Number(n).toLocaleString("en-US", {maximumFractionDigits: d, minimumFractionDigits: d}));
// 950 -> "950", 12345 -> "12.3k", 63400042 -> "63.4M"
const kfmt = (n) => {
  if (n == null || Number.isNaN(+n)) return "–";
  n = +n;
  if (Math.abs(n) < 1000) return fmt(n);
  const u = ["k", "M", "B", "T"];
  let i = -1;
  while (Math.abs(n) >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${fmt(n, Math.abs(n) < 100 ? 1 : 0)}${u[i]}`;
};
// a context size: 32768 -> "32K" (powers of two), else like kfmt
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));   // memory: binary GB, as Windows shows it
// a metric's sub-line: pieces joined by " · ", each kept on one line so a narrow card wraps between them
const subHtml = (parts) => (Array.isArray(parts) ? parts.filter((x) => x != null && x !== "")
  .map((x) => `<span class="nw">${esc(x)}</span>`).join(" · ") : esc(parts || ""));
// polls give up after a while, so a hung request cannot stall the loop
const timeout = (ms) => (window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

const store = {
  get(k, d) { try { const v = localStorage.getItem("strata." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("strata." + k, JSON.stringify(v)); } catch (e) { /* private mode: in memory only */ } },
};

// ------------------------------------------------------------------ toasts
function toast(kind, title, text = "", ms = 3500, action = null) {
  const names = {info: "info", success: "check", warn: "warning", error: "error"};
  const el = document.createElement("div");
  el.className = `st-toast st-toast--${kind}`;
  el.innerHTML = `${icon(names[kind] || "info")}<div><div class="st-toast__title"></div><div class="t-text"></div></div>`;
  el.querySelector(".st-toast__title").textContent = title;
  el.querySelector(".t-text").textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.className = "st-btn st-btn--secondary";
    b.style.height = "32px";
    b.style.marginLeft = "auto";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {                                   // http on another host: no async clipboard
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const use = btn.querySelector("use");
    use.setAttribute("href", `${SPRITE}#i-check`);
    setTimeout(() => use.setAttribute("href", `${SPRITE}#i-copy`), 1500);
  }
  toast("success", "Copied to clipboard", "", 1800);
}

// ------------------------------------------------------------------ theme and tabs
// the system's theme until the user picks one (only a click is saved)
function setTheme(t, save) {
  document.documentElement.dataset.theme = t;
  if (save) try { localStorage.setItem("strata.theme", t); } catch (e) { /* ignore */ }
  $("theme-icon").setAttribute("href", `${SPRITE}#i-${t === "dark" ? "sun" : "moon"}`);
}
// the header's moon/sun is the one theme control
const flipTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
$("theme-btn").onclick = flipTheme;
setTheme(document.documentElement.dataset.theme || "light", false);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let saved = null;
  try { saved = localStorage.getItem("strata.theme"); } catch (err) { /* ignore */ }
  if (!saved) setTheme(e.matches ? "dark" : "light", false);
});

let tab = "chat";
function showTab(name) {
  tab = ["chat", "monitor", "video", "about", "manage"].includes(name) ? name : "chat";
  for (const b of document.querySelectorAll(".st-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of ["chat", "monitor", "video", "about", "manage"]) $(`view-${v}`).hidden = v !== tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", tab === "chat" ? location.pathname : `#${tab}`);
  if (tab === "chat") focusInput();
  if (tab === "monitor") loadMcp();
  if (tab === "about") { aboutKey = ""; loadConfig(); }
  if (window.manageShown) window.manageShown(tab);
  render(lastMetrics);
  if (fastTab() && !document.hidden && typeof poll === "function") poll();   // fresh numbers now, not in 5 s
}
for (const b of document.querySelectorAll(".st-tab")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------------ server access
function headers(json = false) {
  const h = {};
  const key = store.get("apikey", "");
  if (key) h.Authorization = "Bearer " + key;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
// the key field lives in Manage > Settings, which manage.js builds on DOMContentLoaded (before this listener runs)
document.addEventListener("DOMContentLoaded", () => {
  const k = $("api-key");
  if (!k) return;
  k.value = store.get("apikey", "");
  k.onchange = () => { store.set("apikey", k.value.trim()); toast("success", "API key saved", "Kept in this browser only."); };
});

let health = {model: "strata", images: false, max_context: 0};
async function loadHealth() {
  try {
    health = await (await fetch("health", {signal: timeout(8000)})).json();
    $("attach-btn").title = health.images ? "Attach a text file or a picture (or drop it here)"
                                          : "Attach a text file (or drop it here)";
    paintEmpty();
  } catch (e) {
    clearTimeout(healthRetry);
    healthRetry = setTimeout(loadHealth, 2000);
  }
}
let healthRetry = 0;

// ------------------------------------------------------------------ Monitor
// group: which heading a card sits under on the Monitor (GPU or System); manage.js adds its four the same way
const METRICS = [
  {key: "speed", label: "Speed", icon: "gauge", unit: "t/s", series: "tok_s", group: "gpu"},
  {key: "gpu", label: "GPU load", icon: "gpu", unit: "%", series: "gpu_util", max: 100, group: "gpu"},
  {key: "vram", label: "VRAM", icon: "layers", unit: "GB", series: "gpu_mem_used", group: "gpu"},
  {key: "temp", label: "GPU temp", icon: "thermometer", unit: "°C", series: "gpu_temp", group: "gpu"},
  {key: "power", label: "Power", icon: "bolt", unit: "W", series: "gpu_power", group: "gpu"},
  {key: "pcie", label: "PCIe", icon: "link", unit: "", series: "gpu_pcie_rx_mb", tone: "info", group: "gpu"},
  {key: "cpu", label: "CPU", icon: "cpu", unit: "%", series: "cpu", max: 100, group: "sys"},
  {key: "disk", label: "Disk read", icon: "disk", unit: "MB/s", series: "disk_read_mb", tone: "info", group: "sys"},
];
// a temperature line turns amber, then red, where it crosses these (°C): GPU junction and CPU package
const TEMP_BANDS = {gpu: [[85, "warn"], [100, "danger"]], cpu: [[80, "warn"], [90, "danger"]]};
for (const g of ["gpu", "sys"]) $(`metrics-${g}`).innerHTML = METRICS.filter((m) => m.group === g).map((m) => `
  <div class="st-card metric-card"><div class="st-metric">
    <span class="st-metric__label">${icon(m.icon, "st-icon st-icon--sm")}${esc(m.label)}</span>
    ${m.key === "speed" ? `<div class="speed-values">
      <div><span class="st-metric__value" id="mv-speed">-</span><span class="st-metric__sub" id="ms-speed">Decode</span></div>
      <div class="speed-prefill"><span class="st-metric__value" id="mv-prefill">-</span><span class="st-metric__sub" id="ms-prefill">Prefill</span></div>
    </div>` : `<span class="st-metric__value" id="mv-${m.key}">–</span>
    <span class="st-metric__sub" id="ms-${m.key}"></span>`}
    <svg class="st-metric__spark" id="sp-${m.key}" viewBox="0 0 100 32" preserveAspectRatio="none"${m.tone ? ` data-tone="${m.tone}"` : ""}>
      <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${m.key === "speed" ? `<g id="sp-prefill" class="speed-prefill"><path class="area" fill="currentColor" opacity=".12"/>
        <path class="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/></g>` : ""}</svg>
  </div></div>`).join("");
$("mv-speed").closest(".metric-card").id = "card-speed";

// A sparkline. Nulls are gaps (the PC was off, a sensor did not answer): the path breaks there, and an all-null
// series draws nothing. The scale runs from `min` to `max` (or the highest value, if higher). `bands`
// ([[value, tone], ...], rising) colour the line and its area by height: the part above a value takes its tone.
function spark(id, values, max, min = 0, bands = null) {
  const svg = $(id);
  if (!svg) return;
  const v = values || [], line = svg.querySelector(".line"), area = svg.querySelector(".area");
  const real = v.filter((x) => x != null && !Number.isNaN(+x)).map(Number);
  if (v.length < 2 || !real.length) {
    for (const p of svg.querySelectorAll(".line, .area")) p.setAttribute("d", "");
    return;
  }
  const top = Math.max(max || 0, ...real, min + 1e-9), span = top - min;
  const x = (i) => ((i / (v.length - 1)) * 100).toFixed(2);
  const y = (n) => (30 - Math.max(0, Math.min(1, (n - min) / span)) * 26).toFixed(2);
  let l = "", ar = "", run = [];
  const flush = () => {
    if (!run.length) return;
    const pts = run.map(([i, n]) => `${x(i)},${y(n)}`);
    l += `M${pts.join("L")}` + (run.length === 1 ? "l0.6,0" : "");
    ar += `M${x(run[0][0])},32L${pts.join("L")}L${x(run[run.length - 1][0])},32Z`;
    run = [];
  };
  v.forEach((n, i) => { if (n == null || Number.isNaN(+n)) flush(); else run.push([i, +n]); });
  flush();
  line.setAttribute("d", l);
  area.setAttribute("d", ar);
  if (bands) bandPaths(svg, id, bands, (n) => +y(n), l, ar);
}
// Temperature bands: a copy of the line and its area per band, in the band's tone, clipped to the part above its
// value. (A gradient would be simpler, but Chrome resolves it in screen space on a non-scaling stroke.)
function bandPaths(svg, id, bands, y, l, ar) {
  if (!svg.querySelector(".band")) {
    svg.insertAdjacentHTML("beforeend", `<defs>${bands.map((_, i) => `<clipPath id="clip-${id}-${i}"><rect x="-2" y="-10" width="104" height="0"/></clipPath>`).join("")}</defs>` +
      bands.map(([, tone], i) => `<g class="band" clip-path="url(#clip-${id}-${i})" style="color:var(--st-${tone})"><path class="area" fill="currentColor" opacity=".12"/>` +
        `<path class="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></g>`).join(""));
  }
  bands.forEach(([value], i) => svg.querySelector(`#clip-${id}-${i} rect`).setAttribute("height", String(Math.max(0, y(value) + 10))));
  for (const g of svg.querySelectorAll(".band")) { g.querySelector(".line").setAttribute("d", l); g.querySelector(".area").setAttribute("d", ar); }
}
function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).innerHTML = subHtml(sub);
}

// ------------------------------------------------------------------ polling and the header pill
// /metrics every second while the Monitor or About is open, every 5 s elsewhere, not at all while the page is
// hidden. manage.js polls /api/stats (online, engine, power...) and hands each answer over through dash.setStats,
// so the pill is decided here, from both, in one place.
let lastMetrics = null, metricsFailures = 0, metricsErr = null, keyNeeded = false, keyWarned = false, mcpTick = 0;
let stats = null, statsAt = 0;            // the latest /api/stats and when it arrived (ms)
let reqShowAll = false;   // the Monitor's request table: the last 12, or every one the server keeps (issue #35)
let pollTimer = 0, polling = false;
const fastTab = () => tab === "monitor" || tab === "about";
async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    const r = await fetch(reqShowAll ? "metrics?requests=all" : "metrics", {headers: headers(), signal: timeout(5000)});
    if (r.status === 401) {
      keyNeeded = true;
      metricsErr = {status: 401, message: "API key needed"};
      if (!keyWarned) { keyWarned = true; toast("warn", "API key needed", "This server needs a key: add it under Manage > Settings.", 6000); }
      dropMetrics();
    } else if (r.ok) {
      keyNeeded = false;
      lastMetrics = await r.json();
      metricsFailures = 0; metricsErr = null;
      render(lastMetrics);
      window.dispatchEvent(new CustomEvent("dash:metrics", {detail: lastMetrics}));
    } else {
      let message = `HTTP ${r.status}`;
      try { message = (await r.json()).error.message || message; } catch (e) { /* not json */ }
      throw Object.assign(new Error(message), {status: r.status});
    }
  } catch (e) {
    metricsErr = {status: e.status || 0, message: e.message || String(e)};
    metricsFailures++;
    dropMetrics();
  }
  polling = false;
  if (tab === "monitor" && ++mcpTick % 10 === 0) loadMcp();       // server states change rarely: every 10 s
  if (!document.hidden) pollTimer = setTimeout(poll, fastTab() ? 1000 : 5000);
}
// no fresh numbers: every card goes back to "–" rather than showing the last ones as if they were current
function dropMetrics() {
  lastMetrics = null;
  render(null);
  window.dispatchEvent(new CustomEvent("dash:metrics", {detail: null}));
}
document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (!document.hidden) poll();
});

const asleepMsg = (e) => !!e && e.status === 503 && /asleep/i.test(e.message || "");
// the engine's name for people: "Strata Q2_0" (its label from /api/stats), "Ollama"
function engineName(e) {
  if (!e || e.active !== "strata") return "Ollama";
  const m = ((stats && stats.strata_models) || []).find((x) => x.id === e.model);
  return m && m.label ? m.label.replace(/ IQ\w+$/, "") : "Strata";
}
const llmRunning = (e) => !!e && (e.active === "strata" || e.active === "ollama");
// the running H3 job from the Studio's list (video.js), for its progress
const videoJob = () => (window.dashVideo ? window.dashVideo.running() : null);
const VIDEO_ACT = {label: "Open Studio", tab: "video"};
// What the PC is doing, from /metrics, /api/stats and the Studio's job list - the one place that decides it.
// kind: the situation; state: the dot's colour; text: the header pill; short: the pill on a phone;
// label + detail: the Monitor's status bar; pct: real progress (0-100) or null; act: where to go about it.
function pcState() {
  const live = (lastMetrics && lastMetrics.live) || {}, e = (stats && stats.engine) || {};
  if (keyNeeded) return {kind: "key", state: "error", text: "API key needed", short: "Key", label: "This server needs an API key",
                         act: {label: "Add key", tab: "manage", card: "mg-settings"}};
  if ((stats && stats.ok !== false && stats.online === false) || asleepMsg(metricsErr) || live.state === "asleep")
    return {kind: "asleep", state: "off", text: "Asleep", short: "Asleep", label: "__PC_NAME__ is asleep",
            detail: "waking takes about 10 seconds", act: {label: "Wake", tab: "manage", card: "mg-asleep"}};
  // H3 holds the GPU: rendering, or kept a few minutes for quick follow-ups (chat waits either way)
  if (live.state === "rendering" || e.active === "h3") {
    if (live.state === "rendering" || e.state === "rendering") {
      const j = videoJob(), pct = j && j.progress != null ? Math.round(100 * j.progress) : null;
      return {kind: "video", state: "busy", text: `Video · rendering${pct != null ? ` ${pct} %` : ""}`, short: "Video",
              label: `The GPU is making a ${j && j.kind === "picture" ? "picture" : "video"}`, pct,
              detail: j ? [j.phase || "", j.step && j.steps ? `step ${j.step} of ${j.steps}` : "", pct != null ? `${pct} %` : ""] : "",
              act: VIDEO_ACT};
    }
    return {kind: "video-idle", state: "busy", text: "Video · idle", short: "Video", label: "The video engine holds the GPU — idle",
            detail: "chat waits until it gives the GPU back", act: {label: "Give GPU back", tab: "manage", card: "mg-eng-card"}};
  }
  if (live.state === "loading" || (llmRunning(e) && e.state === "loading"))
    return {kind: "loading", state: "busy", text: `${e.active === "ollama" ? "Ollama" : "Strata"} · loading`, short: "Loading",
            label: `Loading ${engineName(e)}…`, detail: e.active === "ollama" ? "" : "usually 1–3 minutes"};
  if (!lastMetrics) {
    if (!stats && metricsFailures < 3) return {kind: "connecting", state: "idle", text: "Connecting…", short: "…", label: "Connecting…"};
    if (metricsFailures >= 3 || !stats)
      return {kind: "offline", state: "error", text: "Server not reachable", short: "Offline", label: "No data from the server",
              detail: metricsErr ? metricsErr.message : ""};
  }
  const name = engineName(e), who = e.active === "strata" ? "Strata" : e.active === "ollama" ? "Ollama" : "Model";
  if (e.active === "strata" && e.state === "error")
    return {kind: "error", state: "error", text: "Strata · not answering", short: "Error", label: `${name} is not answering`,
            act: {label: "Model engine", tab: "manage", card: "mg-eng-card"}};
  if (stats && e.active == null && e.state === "none")
    return {kind: "none", state: "idle", text: "No engine", short: "Idle", label: "No model engine runs",
            act: {label: "Pick one", tab: "manage", card: "mg-eng-card"}};
  if (live.queued > 0)
    return {kind: "queued", state: "queued", text: `${who} · ${live.queued} waiting`, short: "Busy",
            label: `${name} is busy — ${live.queued} request${live.queued > 1 ? "s" : ""} waiting`};
  if (live.state === "reading") {
    const pct = live.prompt_total ? Math.round((100 * live.prompt_read) / live.prompt_total) : null;
    return {kind: "reading", state: "reading", text: `${who} · reading${pct != null ? ` ${pct} %` : ""}`, short: "Reading",
            label: `${name} is reading the prompt`, pct,
            detail: live.prompt_total ? `${fmt(live.prompt_read)} / ${fmt(live.prompt_total)} tokens`
                  : live.prompt_tokens != null ? `${fmt(live.prompt_tokens)} tokens` : ""};
  }
  if (live.state === "generating") {
    const verb = live.phase === "thinking" ? "thinking" : "answering";
    return {kind: "generating", state: "generating", text: `${who} · ${verb}`, short: verb[0].toUpperCase() + verb.slice(1),
            label: `${name} is ${verb}${live.tok_s != null ? ` · ${fmt(live.tok_s, 1)} t/s` : ""}`,
            pct: live.max_tokens && live.generated != null ? Math.min(100, (100 * live.generated) / live.max_tokens) : null,
            detail: live.generated != null ? `${fmt(live.generated)} tokens` : ""};
  }
  const last = ((lastMetrics && lastMetrics.requests) || [])[0];
  const lastText = last && last.decode_tok_s ? `last answer ${fmt(last.output_tokens)} tokens at ${fmt(last.decode_tok_s, 1)} t/s` : "";
  if (e.active === "ollama") {
    const model = (window.dashGetModel && window.dashGetModel()) || health.model;
    return {kind: "ready", state: "ready", text: "Ollama · idle", short: "Idle", label: `Ollama ready · ${model}`, detail: lastText};
  }
  return {kind: "ready", state: "ready", text: `${who} · idle`, short: "Idle", label: `${name} ready`, detail: lastText};
}
// /api/stats older than 15 s (or the server says its poller failed): the numbers may not be current
function statsStale() {
  if (!stats) return false;
  if (stats.stale) return true;
  if (statsAt && Date.now() - statsAt > 15000) return true;
  return stats.ts != null && Date.now() / 1000 - stats.ts > 15;
}
function updatePill() {
  const p = pcState(), stale = statsStale() && p.state !== "error";
  const text = p.text + (stale ? " · stale" : "");
  $("pill").dataset.state = p.state;
  $("pill-text").textContent = text;
  $("pill-short").textContent = p.short + (stale ? " · stale" : "");
  const why = stale ? (stats && stats.error ? `Data may be out of date: ${stats.error}` : "Data may be out of date") : "";
  $("pill").title = why ? `${text} — ${why}` : text;
  $("pill").setAttribute("aria-label", $("pill").title);
  renderStatus(p);
  paintEmpty(p);
}
// the Monitor's status bar: the dot, the sentence, its detail, the action and (only for real progress) the bar
function renderStatus(p) {
  if (tab !== "monitor") return;
  const card = $("state-card"), act = $("state-act"), prog = $("state-progress");
  card.dataset.state = p.state;
  $("state-label").textContent = p.label;
  $("state-detail").innerHTML = subHtml(p.detail);
  act.hidden = !p.act;
  if (p.act) { act.textContent = p.act.label; act.onclick = () => goTo(p.act.tab, p.act.card); }
  prog.hidden = p.pct == null;
  if (p.kind === "reading") prog.dataset.tone = "info"; else delete prog.dataset.tone;
  $("state-bar").style.width = `${p.pct || 0}%`;
}
// open a tab and bring one of its cards into view (the status bar's and the chat's actions)
function goTo(name, card) {
  showTab(name);
  const el = card && $(card);
  if (el && !el.hidden) { el.scrollIntoView({block: "start"}); el.focus({preventScroll: true}); }
}
// The chat's empty state says what will happen to a question now, not just which model is installed.
// Builder writes its own line (builder.js).
function paintEmpty(p = pcState()) {
  const sub = $("chat-empty-sub"), target = window.dashGetTarget ? window.dashGetTarget() : "model";
  if (!sub || target === "builder") return;
  const e = (stats && stats.engine) || {};
  const model = e.active === "strata" ? engineName(e) : (window.dashGetModel && window.dashGetModel()) || health.model;
  const text = target === "agent" ? "Hermes answers with its tools and memory — it can run commands on the PC."
    : {asleep: "__PC_NAME__ is asleep — wake it under Manage.",
       video: "The GPU is making a video — chat answers when it's done.",
       "video-idle": "The video engine still holds the GPU — chat answers once it gives it back, or take it back under Manage.",
       loading: `Loading ${engineName(e)} — chat answers when it's ready.`,
       none: "No model engine runs — pick one under Manage.",
       offline: "The dashboard server does not answer right now.",
       error: `${engineName(e)} is not answering — restart it under Manage.`}[p.kind]
    || `${model} runs on this PC. Nothing leaves it.`;
  if (sub.textContent !== text) sub.textContent = text;
}

function render(m) {
  updatePill();
  const has = !!m;
  m = m || {};
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];
  if (tab === "monitor") renderMonitor(live, hw, st, eng, h, last, m.requests || [], m.totals, m.requests_kept, has);
  if (tab === "monitor") renderConvCache(has ? m.conversation_cache : null);
  if (tab === "about" && has) renderAbout(eng, hw, st);
}

// #596: the conversation cache - the prompt's state the engine keeps between requests (always), and the whole
// conversations it parks in RAM when "--conversation-cache-mib N" is in the run config's args (opt-in)
function since(t) {
  if (!t) return "";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${fmt(s / 60)} min ago` : `${fmt(s / 3600, 1)} h ago`;
}
function renderConvCache(c) {
  $("cc-card").hidden = !c;
  if (!c) return;                                  // an older server
  const pct = (a, b) => (b ? `${Math.min(100, (100 * a) / b)}%` : "0%");
  $("cc-bars").hidden = !c.enabled;
  if (c.enabled) {
    $("cc-slots-text").textContent = `${fmt(c.parked)} / ${fmt(c.slots)}`;
    $("cc-slots-bar").style.width = pct(c.parked, c.slots);
    const budget = c.budget_mib * 1048576;
    $("cc-mem-text").textContent = `${gb(c.bytes)} / ${gb(budget)} GB`;
    $("cc-mem-bar").style.width = pct(c.bytes, budget);
  }
  $("cc-sum").textContent = c.requests ? `${fmt(c.requests_reused)} of ${fmt(c.requests)} requests reused part of their prompt` : "";
  const share = c.prompt_tokens ? ` (${fmt((100 * c.reused_tokens) / c.prompt_tokens)}% of all prompt tokens)` : "";
  const event = c.last_event ? `${c.last_event === "parked" ? "Parked" : "Restored"} ${fmt(c.last_tokens)} tokens, ${since(c.last_at)}` : null;
  facts($("cc-facts"), [
    ["Last request", c.last_prompt != null ? `${fmt(c.last_reused || 0)} of ${fmt(c.last_prompt)} prompt tokens reused` : null],
    ["Reused since start", c.requests ? `${fmt(c.reused_tokens)} tokens${share}` : null],
    ["Parked / restored", c.enabled ? `${fmt(c.parks)} / ${fmt(c.restores)}${c.evictions ? ` · ${fmt(c.evictions)} evicted` : ""}` : null],
    ["Last switch", c.enabled ? event : null],
  ]);
  $("cc-note").textContent = c.enabled
    ? "A request that continues a parked conversation gets its state back instead of reading it again; the oldest goes when the slots or the memory are full."
    : "The engine keeps the last conversation's state, so a follow-up reads only what is new. To keep several conversations (agents taking turns), add \"--conversation-cache-mib\", \"8192\" to the run config's args (docs/DETAILS.md).";
}

function renderTotals(t) {
  if (!t || !t.requests) return "";
  const since = new Date(t.since * 1000).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"});
  const read = t.prompt_tokens - t.reused;
  const pSpeed = t.prompt_ms > 0 && read > 0 ? ` at ${fmt(read / (t.prompt_ms / 1000))} tok/s` : "";
  const oSpeed = t.decode_ms > 0 && t.output_tokens > 0 ? ` at ${fmt(t.output_tokens / (t.decode_ms / 1000), 1)} tok/s` : "";
  return `Since ${since}: ${fmt(t.requests)} requests · ${fmt(read)} prompt tokens read${pSpeed} (${fmt(t.reused)} reused) · ` +
         `${fmt(t.output_tokens)} written${oSpeed}`;
}
let reqKey = "";          // the request table is rebuilt only when its rows change
function renderMonitor(live, hw, st, eng, h, last, requests, totals, kept, has) {
  // the time the graphs cover: the server keeps up to 120 samples, one per poll (/api/stats poll_s)
  const samples = Math.max(0, ...Object.values(h).map((x) => (Array.isArray(x) ? x.length : 0)));
  const secs = (samples - 1) * ((stats && stats.poll_s) || 2);
  const spanText = has && samples > 1 ? `graphs: last ${secs < 90 ? `${fmt(secs)} s` : `${fmt(secs / 60)} min`}` : "";
  for (const el of document.querySelectorAll(".spark-span")) el.textContent = spanText;

  // the eight cards. Speed: no engine that writes text (asleep, H3, none) = one dash and why, not two lone dashes
  const e = stats && stats.engine, noModel = !!stats && (stats.online === false || !llmRunning(e));
  $("card-speed").classList.toggle("speed-off", noModel);
  const speed = live.state === "generating" ? live.tok_s : last ? last.decode_tok_s : null;
  setMetric("speed", speed == null || noModel ? null : fmt(speed, 1), "t/s", noModel ? "no model running" :
            live.state === "generating" ? "Decode now" : last ? "Decode last request" : "Decode");
  const prefill = live.state === "reading" || live.state === "generating" ? live.prefill_tok_s_mean
                : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  setMetric("prefill", prefill == null ? null : fmt(prefill), "t/s",
            live.state === "reading" ? "Prefill now" : live.state === "generating" ? "Prefill this request" : last ? "Prefill last request" : "Prefill");
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s_mean);
  // a model split across several cards (issue #112): the cards show their total / mean / hottest, and each card's own
  const per = (f) => (hw.gpus || []).map((g) => `GPU ${g.index} ${f(g)}`);
  const multi = (hw.gpus || []).length > 1;
  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%",
            multi ? per((g) => (g.util == null ? "–" : `${fmt(g.util)}%`)) : st.gpu_name || "");
  spark("sp-gpu", h.gpu_util, 100);
  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
            multi ? per((g) => (g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`))
                  : eng.expert_slots ? `${fmt(eng.expert_slots)} experts cached` : "");
  spark("sp-vram", h.gpu_mem_used, hw.gpu_mem_total);
  // GPU temp is the junction (hottest) sensor; VRAM has its own
  const crit = hw.gpu_temp_crit || 110;
  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C",
            multi ? per((g) => (g.temp == null ? "–" : `${fmt(g.temp)}°`))
                  : hw.gpu_mem_temp != null ? `VRAM ${fmt(hw.gpu_mem_temp)} °C` : "");
  spark("sp-temp", h.gpu_temp, crit, 30, TEMP_BANDS.gpu);
  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W", hw.gpu_power_limit ? `of ${fmt(hw.gpu_power_limit)} W limit` : "");
  spark("sp-power", h.gpu_power, hw.gpu_power_limit);
  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  if (hw.gpu_pcie_rx_mb == null && hw.gpu_pcie_link) {
    // no throughput counters (AMD): the negotiated link instead, "Gen3 x16 · 8 GT/s"
    const [head, ...rest] = String(hw.gpu_pcie_link).split(" · ");
    setMetric("pcie", head, "", rest.join(" · ") || "link");
  } else {
    setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
              hw.gpu_pcie_rx_mb == null ? "" : [`to GPU ${fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)} MB/s`,
              hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? `idle Gen${hw.gpu_pcie_gen}` : ""]);
  }
  spark("sp-pcie", h.gpu_pcie_rx_mb);
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", st.threads ? [st.cores ? `${st.cores} cores` : "", `${st.threads} threads`] : "");
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", has && st.psutil === false ? "needs psutil (setup installs it)" : "");
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0), big ? "GB/s" : "MB/s",
              hw.disk_write_mb == null ? "" : `write ${fmt(hw.disk_write_mb, 1)} MB/s`);
  }
  spark("sp-disk", h.disk_read_mb);

  // context fill: the running request, else the last one; no model or no context size = no gauge. The experts
  // are Strata's alone. Without either, the card's other two bars repeat the RAM and GPU temp cards: it goes.
  const ctx = noModel ? 0 : eng.max_context || 0;
  $("ctx-gauge").hidden = !ctx;
  $("ctx-experts").hidden = !eng.expert_slots;
  document.querySelector(".ctx-card").classList.toggle("no-data", !ctx && !eng.expert_slots);
  document.querySelector(".monitor-row").classList.toggle("dash-single-auto", !ctx && !eng.expert_slots);
  let used = null;
  if (live.state === "reading" || live.state === "generating") used = (live.prompt_tokens || 0) + (live.generated || 0);
  else if (last && last.prompt_tokens != null) used = (last.prompt_tokens || 0) + (last.output_tokens || 0);
  const frac = ctx && used != null ? Math.min(1, used / ctx) : 0;
  $("ctx-fill").setAttribute("stroke-dasharray", `${(235.6 * frac).toFixed(1)} 314.2`);
  $("ctx-fill").style.opacity = 235.6 * frac >= 3 ? "1" : "0";         // a near-zero arc would draw just its round cap
  $("ctx-pct").textContent = ctx && used != null ? `${Math.round(frac * 100)}%` : "–";
  $("ctx-sub").textContent = ctx ? `${used != null ? kfmt(used) : "–"} / ${ctxfmt(ctx)}` : "–";
  const cacheBytes = (eng.expert_cache_mib || 0) * 1048576;
  $("slots-text").textContent = eng.expert_slots ? `${fmt(eng.expert_slots)} · ${gb(cacheBytes)} GB` : "–";
  $("slots-bar").style.width = hw.gpu_mem_total ? `${Math.min(100, (100 * cacheBytes) / hw.gpu_mem_total)}%` : "0%";
  $("ram-text").textContent = hw.ram_total && hw.ram_used != null ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = hw.ram_total && hw.ram_used != null ? (100 * hw.ram_used) / hw.ram_total : 0;
  $("ram-bar").style.width = `${ramPct}%`;
  if (ramPct > 92) $("ram-progress").dataset.tone = "danger"; else delete $("ram-progress").dataset.tone;
  // the temperature bar runs from 30 °C to the card's critical point (about 110 °C junction)
  const t = hw.gpu_temp;
  $("temp-text").textContent = t == null ? "–" : `${fmt(t)} °C${hw.gpu_mem_temp != null ? ` · VRAM ${fmt(hw.gpu_mem_temp)} °C` : ""}`;
  $("temp-bar").style.width = t == null ? "0%" : `${Math.max(0, Math.min(100, (100 * (t - 30)) / (crit - 30)))}%`;
  if (t != null && t >= 100) $("temp-progress").dataset.tone = "danger";
  else if (t != null && t >= 85) $("temp-progress").dataset.tone = "warn";
  else delete $("temp-progress").dataset.tone;

  // recent requests
  const key = JSON.stringify([has, requests.length, last ? [last.time, last.finish, last.output_tokens] : null, reqShowAll]);
  if (key !== reqKey) {
    reqKey = key;
    const body = $("req-body");
    // nothing to list: one line instead of an empty table
    $("req-none").hidden = !!requests.length;
    $("req-none").textContent = has ? "No requests yet" : "–";
    $("req-wrap").hidden = !requests.length;
    if (!requests.length) {
      body.innerHTML = `<tr><td colspan="8" class="muted">${has ? "No requests yet" : "–"}</td></tr>`;
    } else {
      const badge = {stop: ["", "Done"], length: ["", "Max tokens"], cancel: ["st-badge--queued", "Stopped"],
                     disconnect: ["st-badge--queued", "Closed"], error: ["st-badge--error", "Error"]};
      body.innerHTML = requests.slice(0, reqShowAll ? requests.length : 12).map((r) => {
        const [cls, text] = badge[r.finish] || ["", r.finish || "Done"];
        const t = r.time ? new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"}) : "–";
        const proj = r.projection == null ? "" : ` <span class="st-badge${r.projection ? " st-badge--reading" : ""}" title="experimental speed projection ${r.projection ? "on" : "off"}">${r.projection ? "ESP" : "stock"}</span>`;
        // #588: the VRAM share; the PCIe share (--pcie-frac) beside it when there is one
        const hit = r.hit_rate == null ? "–" : `${(r.hit_rate * 100).toFixed(1)}%` +
          (r.pcie_share ? ` <span class="muted" title="routed experts the GPU read over PCIe (--pcie-frac) or another GPU computed">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
        return `<tr><td>${esc(t)}</td><td><span class="st-badge ${cls}">${esc(text)}</span>${proj}</td><td class="num">${fmt(r.prompt_tokens)}</td>
          <td class="num col-opt">${fmt(r.reused)}</td><td class="num">${fmt(r.output_tokens)}</td><td class="num">${fmt(r.decode_tok_s, 1)}</td>
          <td class="num col-opt">${hit}</td><td class="num col-opt">${r.duration_s == null ? "–" : `${fmt(r.duration_s, 1)} s`}</td></tr>`;
      }).join("");
    }
  }
  const all = $("req-all");
  kept = kept == null ? requests.length : kept;
  all.hidden = kept <= 12;
  all.textContent = reqShowAll ? "Show fewer" : `Show all (${kept})`;
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(totals);
}

function facts(el, rows) {
  el.innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v, copy]) =>
    `<dt>${esc(k)}</dt><dd>${copy ? `<code>${esc(v)}</code><button class="st-btn st-btn--icon" data-copy="${esc(v)}" aria-label="Copy">${icon("copy")}</button>` : esc(v)}</dd>`).join("");
}
// INFO cvec=project:4-44[:singleL] | add:A-B | 0
function projectionText(c) {
  if (!c || c === "0" || c === 0) return null;
  const [mode, range, single] = String(c).split(":");
  const [a, b] = (range || "").split("-");
  return `${mode === "project" ? "Projection" : "Additive"} control vector on layers ${a}–${b}` +
         `${single ? ` (layer ${single.replace("single", "")}'s direction)` : ""}. Per chat in Sampling. Its package ` +
         "describes the vector as a refusal-direction projection; measure the speed yourself";
}
let aboutKey = "";        // About is rebuilt only when what it shows changes (or the tab opens)
function renderAbout(eng, hw, st) {
  // with H3 or no engine on the GPU, /metrics still names Ollama's default model: say nothing is loaded instead
  const e = stats && stats.engine, on = !stats || llmRunning(e);
  if (!on) eng = {};
  const key = JSON.stringify([eng, on, e && e.active, hw.gpu_mem_total, hw.ram_total, st]);
  if (key === aboutKey) return;
  aboutKey = key;
  const kv = {int8: "8-bit", q4_0: "4-bit (Hadamard-rotated)", fp16: "16-bit"}[eng.kv] || eng.kv;
  facts($("facts-engine"), [
    ["Model", on ? (e && e.active === "strata" ? `${engineName(e)} (${eng.model || e.model})` : eng.model)
              : e && e.active === "h3" ? "nothing loaded — the video engine holds the GPU" : "nothing loaded"],
    ["Engine", on && e ? (e.active === "strata" ? "Strata" : "Ollama") + (eng.version ? ` v${eng.version}` : "") : eng.version ? `v${eng.version}` : null],
    ["Context", eng.max_context ? `${fmt(eng.max_context)} tokens` : null],
    ["KV cache", kv ? `${kv}${eng.kv_resident ? `, streamed: ${fmt(eng.kv_resident)} positions per layer in VRAM, the rest in RAM` : ", all in VRAM"}` : null],
    ["Experts in VRAM", eng.expert_slots ? `${fmt(eng.expert_slots)} (${gb((eng.expert_cache_mib || 0) * 1048576)} GB)` : null],
    ["Speculation", eng.spec ? `MTP drafts up to ${Math.max(0, (eng.mtp_max || eng.spec) - 1)} tokens${eng.lookup ? ", prompt lookup on" : ""}` : null],
    ["Images", eng.images ? "on" : "off"],
    ["Experimental speed projection", projectionText(eng.cvec)],
  ]);
  facts($("facts-hw"), [
    ["GPU", st.gpu_name ? `${st.gpu_name}${hw.gpu_mem_total ? `, ${gb(hw.gpu_mem_total, 0)} GB` : ""}` : "not readable (NVML)"],
    ["CPU", st.cpu_name ? `${st.cpu_name}${st.threads ? `, ${st.threads} threads` : ""}` : null],
    ["RAM", hw.ram_total ? `${gb(hw.ram_total, 0)} GB` : null],
  ]);
  const base = location.origin;
  facts($("facts-api"), [
    ["OpenAI base URL", `${base}/v1`, true],
    ["Anthropic base URL", base, true],
    ["Model name", on ? eng.model : null, true],
  ]);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.dataset.copy, b);
});
$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); });

// ------------------------------------------------------------------ MCP servers (GET /mcp)
// Tools from the MCP servers in the run config: the chat offers them to the model (opt-in per request,
// "strata_mcp": true, which only this page sends); the Monitor lists the servers and what they offer.
let mcpInfo = {servers: [], tools: 0}, mcpRetry = null;
async function loadMcp() {
  try {
    const r = await fetch("mcp", {headers: headers(), signal: timeout(8000)});
    if (!r.ok) return;
    mcpInfo = await r.json();
  } catch (e) { return; /* an older server: no MCP */ }
  renderMcp();
  clearTimeout(mcpRetry);                          // right after the start, servers may still be starting (npx downloads)
  if ((mcpInfo.servers || []).some((s) => s.status === "starting")) mcpRetry = setTimeout(loadMcp, 3000);
}
const MCP_STATE = {ready: ["st-badge--generating", "Connected"], starting: ["st-badge--reading", "Starting"],
                   failed: ["st-badge--error", "Failed"], stopped: ["st-badge--queued", "Stopped"], idle: ["", "Waiting"]};
function renderMcp() {
  const servers = mcpInfo.servers || [];
  $("mcp-card").hidden = !servers.length;
  $("mcp-row").hidden = !servers.length;
  const ready = servers.filter((s) => s.status === "ready" || s.status === "stopped");
  $("mcp-sum").textContent = servers.length ? `${fmt(mcpInfo.tools)} tools · ${ready.length} of ${servers.length} servers connected` : "";
  $("mcp-row-sub").textContent = mcpInfo.tools ? `${fmt(mcpInfo.tools)} tools from ${ready.map((s) => s.name).join(", ")}; the model calls them when it decides to`
                                               : "no server is connected yet (see the Monitor)";
  $("mcp-list").innerHTML = servers.map((s) => {
    const [cls, text] = MCP_STATE[s.status] || ["", s.status];
    const info = s.info && s.info.name ? ` · ${s.info.name}${s.info.version ? ` ${s.info.version}` : ""}` : "";
    return `<div class="mcp-server"><div class="mcp-server__head"><span class="st-badge ${cls}">${esc(text)}</span>` +
      `<strong>${esc(s.name)}</strong><span class="muted small">${esc(s.transport)} · ${fmt(s.tools.length)} tools${esc(info)}</span></div>` +
      (s.error ? `<div class="msg-error">${esc(s.error)}</div>` : "") +
      (s.tools.length ? `<div class="mcp-server__tools">${s.tools.map((t) => `<span class="chip" title="${esc(t.description || "")}">${esc(t.tool)}</span>`).join("")}</div>` : "") +
      `</div>`;
  }).join("");
}

// ------------------------------------------------------------------ Model settings (GET / POST /config, #564)
// A few documented keys of the run config (strata-<model>.json), for every client, from the next start on.  The
// server lists them, checks every value and keeps every other key of the file as it is.
let cfgKeys = [];
// only Strata has a run config: with Ollama, H3 or a sleeping PC the request would just 404
const strataUp = () => !!stats && stats.online !== false && stats.engine && stats.engine.active === "strata" && stats.engine.state !== "loading";
async function loadConfig() {
  if (!strataUp()) { $("cfg-card").hidden = true; return; }
  let r;
  try { r = await fetch("config", {headers: headers(), signal: timeout(8000)}); } catch (e) { return; }
  if (!r.ok) { $("cfg-card").hidden = true; return; }       // no run config, an older server, or no key yet
  const c = await r.json();
  cfgKeys = c.keys || [];
  $("cfg-file").textContent = c.file || "";
  $("cfg-form").innerHTML = cfgKeys.map((k, i) => {
    const id = `cfg-${i}`, v = k.value;
    let input;
    if (k.kind === "bool" || k.kind === "enum") {
      const opts = k.kind === "bool" ? [["true", "on"], ["false", "off"]] : k.choices.map((x) => [x, x]);
      const cur = v == null ? "" : String(v);
      input = `<select class="st-input" id="${id}"><option value=""${cur === "" ? " selected" : ""}>default</option>` +
        opts.map(([val, text]) => `<option value="${esc(val)}"${cur === val ? " selected" : ""}>${esc(text)}</option>`).join("") + `</select>`;
    } else {
      const text = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
      input = `<input class="st-input" id="${id}" ${k.kind === "number" ? 'type="number" step="any" min="0"' : 'type="text"'} ` +
        `value="${esc(text)}" placeholder="default" autocomplete="off">`;
    }
    return `<label for="${id}" title="${esc(k.help)}">${esc(k.help)}<code>${esc(k.key)}</code></label>${input}`;
  }).join("");
  $("cfg-card").hidden = false;
}
function configValue(k, el) {
  const s = el.value.trim();
  if (s === "") return null;
  if (k.kind === "bool") return s === "true";
  if (k.kind === "number") return Number(s);
  return s;                                         // enum, or names (the server splits them at commas)
}
$("cfg-save").addEventListener("click", async () => {
  const set = {};
  cfgKeys.forEach((k, i) => {
    const v = configValue(k, $(`cfg-${i}`));
    const old = Array.isArray(k.value) ? k.value.join(", ") : k.value;
    if (JSON.stringify(v) !== JSON.stringify(old ?? null)) set[k.key] = v;
  });
  if (!Object.keys(set).length) { $("cfg-msg").textContent = "Nothing changed."; return; }
  try {
    const r = await fetch("config", {method: "POST", headers: headers(true), body: JSON.stringify({set})});
    const b = await r.json();
    if (!r.ok) throw new Error((b.error || {}).message || `HTTP ${r.status}`);
    $("cfg-msg").textContent = b.changed.length
      ? `Saved (${b.changed.join(", ")}); the earlier file is ${b.file}.bak. Start the model again to use it.` : "Nothing changed.";
    loadConfig();
  } catch (e) {
    $("cfg-msg").textContent = "";
    toast("error", "Not saved", String(e.message || e), 6000);
  }
});

// ------------------------------------------------------------------ Markdown (escaped first, then formatted)
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[+i])}</code>`);
}
function codeBlock(lang, code) {
  return `<div class="st-code"><div class="st-code__head"><span>${esc(lang || "code")}</span>` +
    `<button class="st-btn st-btn--icon" data-code-copy aria-label="Copy code">${icon("copy")}</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`;
}
function blocks(text) {
  const out = [], lines = text.split("\n");
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flushPara(); flushList(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<${m[1].length <= 2 ? "h3" : "h4"}>${inline(m[2])}</${m[1].length <= 2 ? "h3" : "h4"}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      i--;
      out.push(html + "</tbody></table>");
      continue;
    }
    if ((m = l.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = {tag, items: []}; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out.join("");
}
function markdown(text) {
  let html = "", rest = text;
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { html += blocks(rest); break; }
    html += blocks(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```[ \t]*(\n|$)/);
    if (!end) { html += codeBlock(m[2].trim(), rest); break; }         // still streaming
    html += codeBlock(m[2].trim(), rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return html;
}

// ------------------------------------------------------------------ Chat
const DEFAULTS = {thinking: "high", temperature: 0.6, top_p: 0.95, top_k: 20, max: "", seed: "", show: true, esp: true, mcp: true};
let settings = {...DEFAULTS, ...store.get("sampling", {})};
let messages = store.get("chat", []);
let attachments = [];                 // {name, url}
let busy = null;                      // {controller, msg}

function saveChat() {
  store.set("chat", messages.map((m) => ({...m, images: (m.images || []).map((i) => ({name: i.name})),
                                           files: (m.files || []).map((f) => ({name: f.name}))})));
}
function timeStr(t) { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

function msgEl(m, i) {
  const el = document.createElement("div");
  el.className = `st-msg st-msg--${m.role}`;
  el.dataset.i = i;
  if (m.role === "user") {
    if (m.files && m.files.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const f of m.files) {
        const c = document.createElement("span");
        c.className = "chip";
        c.innerHTML = icon("attach", "st-icon st-icon--sm");
        c.append(f.name);
        wrap.appendChild(c);
      }
      el.appendChild(wrap);
    }
    if (m.images && m.images.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const im of m.images) {
        if (im.url) { const img = document.createElement("img"); img.src = im.url; img.alt = im.name || "image"; wrap.appendChild(img); }
        else { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = icon("image", "st-icon st-icon--sm"); c.append(im.name || "image"); wrap.appendChild(c); }
      }
      el.appendChild(wrap);
    }
    const b = document.createElement("div");
    b.className = "st-bubble";
    b.textContent = m.text;
    el.appendChild(b);
    const meta = document.createElement("div");
    meta.className = "st-msg__meta";
    meta.textContent = `You · ${timeStr(m.time)}`;
    if (m.text) meta.insertAdjacentHTML("beforeend",
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="Copy the prompt" title="Copy">${icon("copy")}</button>`);
    el.appendChild(meta);
  } else {
    el.innerHTML = `<details class="st-collapse think" hidden><summary>${icon("thinking", "st-icon st-icon--sm")}<span class="think-title"></span>` +
      `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body thinking"></div></details>` +
      `<div class="st-bubble"></div><div class="st-msg__meta"><span class="meta-text"></span>` +
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="Copy the answer" title="Copy">${icon("copy")}</button></div>`;
    updateAssistant(el, m, false);
  }
  return el;
}
// One MCP tool call in the answer: a compact block (name, state, a one-line preview) that opens to the arguments and
// the result as the model read it.  Its body is built only while open: a result can be 20,000 characters.
const TOOL_STATE = {writing: ["st-badge--reading", "Writing"], running: ["st-badge--generating", "Running"], done: ["", "Done"],
                    error: ["st-badge--error", "Error"], skipped: ["st-badge--queued", "Not run"]};
function toolHtml(t, k) {
  const [cls, label] = TOOL_STATE[t.state] || ["", t.state];
  const args = t.arguments == null ? "" : JSON.stringify(t.arguments, null, 2);
  const preview = t.result != null ? t.result : args.replace(/\s+/g, " ");
  let body = "";
  if (t.open) {
    body = `<div class="tool-call__label">Arguments</div><pre class="tool-call__pre">${esc(args || "(being written)")}</pre>`;
    if (t.result != null) {
      body += `<div class="tool-call__label">${t.ok ? "Result" : "Error"}${t.chars ? ` · ${fmt(t.chars)} characters` : ""}` +
              `${t.truncated ? ", cut for the model" : ""}</div><pre class="tool-call__pre">${esc(t.result)}</pre>`;
    }
  }
  return `<details class="st-collapse tool-call" data-tool="${k}" data-state="${esc(t.state)}"${t.open ? " open" : ""}>` +
    `<summary>${icon("tool", "st-icon st-icon--sm")}<span class="tool-call__name" title="${esc(t.name || "")}">${esc(t.tool || t.name || "tool")}</span>` +
    (t.server ? `<span class="muted small">${esc(t.server)}</span>` : "") +
    `<span class="tool-call__preview muted">${esc(preview.slice(0, 200))}</span>` +
    `<span class="st-badge ${cls}">${esc(label)}</span>${t.ms != null && t.state !== "skipped" ? `<span class="muted small">${fmt(t.ms / 1000, 1)} s</span>` : ""}` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body">${body}</div></details>`;
}
// the answer's text with the tool blocks where the model called them
function answerHtml(m) {
  if (!m.tools || !m.tools.length) return markdown(m.text || "");
  let html = "", pos = 0;
  m.tools.forEach((t, k) => {
    const at = Math.min(Math.max(t.at || 0, pos), m.text.length);
    if (at > pos) html += markdown(m.text.slice(pos, at));
    pos = at;
    html += toolHtml(t, k);
  });
  return html + markdown(m.text.slice(pos));
}
// a tool event from the stream (the `strata_mcp` field of a chunk)
function onTool(m, x) {
  if (x.event === "limit") { m.limit = x.max_rounds; return; }
  m.tools = m.tools || [];
  let t = m.tools.find((y) => y.id === x.id);
  if (!t) { t = {id: x.id, name: x.name, at: m.text.length, rat: m.reasoning.length, state: "writing"}; m.tools.push(t); }
  if (x.event === "call") {
    Object.assign(t, {name: x.name, server: x.server, tool: x.tool, arguments: x.arguments, round: x.round, state: "running"});
  } else if (x.event === "result") {
    Object.assign(t, {result: x.text, ok: x.ok, chars: x.chars, truncated: x.truncated, ms: x.ms,
                      state: x.skipped ? "skipped" : x.ok ? "done" : "error"});
  }
}
function updateAssistant(el, m, streaming) {
  const det = el.querySelector("details.think");
  if (m.reasoning) {
    det.hidden = false;
    const thinkingNow = streaming && !m.text;
    el.querySelector(".think-title").textContent = thinkingNow ? "Thinking…" :
      m.thinkSecs != null ? `Thought for ${fmt(m.thinkSecs, 1)} s` : "Thoughts";
    const body = el.querySelector(".thinking");
    if (det.open || thinkingNow) body.textContent = m.reasoning;
    else body.dataset.pending = "1";
    // open while it streams (if wanted), closed once the answer starts - unless the user toggled it themselves
    if (thinkingNow && settings.show && !det.dataset.touched && !det.open) { det._auto = true; det.open = true; }
    if (!thinkingNow && det.open && !det.dataset.touched) { det._auto = true; det.open = false; }
  }
  const bubble = el.querySelector(".st-bubble");
  if (m.error) {
    bubble.innerHTML = `<div class="msg-error"></div>`;
    bubble.firstChild.textContent = m.error;
  } else if (!m.text && streaming && !(m.tools && m.tools.length)) {
    bubble.innerHTML = m.reasoning ? `<span class="muted cursor">Writing</span>` : `<span class="cursor"></span>`;
  } else {
    bubble.innerHTML = answerHtml(m);
    if (streaming) bubble.classList.add("cursor"); else bubble.classList.remove("cursor");
  }
  el.querySelector(".meta-text").textContent = m.meta || (streaming ? "" : m.stopped ? "Stopped" : "");
  el.querySelector("[data-msg-copy]").hidden = streaming || !m.text;
}
function renderChat() {
  const chat = $("chat");
  chat.querySelectorAll(".st-msg").forEach((e) => e.remove());
  $("chat-empty").hidden = messages.length > 0;
  messages.forEach((m, i) => chat.appendChild(msgEl(m, i)));
  scrollDown(true);
}
function nearBottom() { const s = $("chat-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; }
function followsChat() { return window.dashChatPinned ? window.dashChatPinned() : nearBottom(); }
function scrollDown(force) {
  const s = $("chat-scroll");
  if (force || followsChat()) {
    if (window.dashChatPin) window.dashChatPin();
    s.scrollTop = s.scrollHeight;
  }
}

function focusInput() {
  // A phone should open its keyboard only when the user taps the editor.
  if (innerWidth > 640 && matchMedia("(hover: hover) and (pointer: fine)").matches)
    $("input").focus({preventScroll: true});
}

$("chat").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) { copyText(cc.closest(".st-code").querySelector("pre").textContent, cc); return; }
  const mc = e.target.closest("[data-msg-copy]");
  if (mc) { const i = +mc.closest(".st-msg").dataset.i; copyText(messages[i].text, mc); return; }
  // a tool block: its open state lives in the message (the answer is rebuilt while it streams), so the click sets it
  const sum = e.target.closest(".tool-call > summary");
  if (sum) {
    e.preventDefault();
    const el = sum.closest(".st-msg"), m = messages[+el.dataset.i], t = m && m.tools && m.tools[+sum.parentElement.dataset.tool];
    if (!t) return;
    t.open = !t.open;
    updateAssistant(el, m, !!busy && busy.msg === m);
  }
});
$("chat").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS" || !d.classList.contains("think")) return;
  if (d._auto) { d._auto = false; return; }          // our own open/close, not the user's
  d.dataset.touched = "1";
  const body = d.querySelector(".thinking");
  if (d.open && body.dataset.pending) { body.textContent = messages[+d.closest(".st-msg").dataset.i].reasoning; delete body.dataset.pending; }
}, true);

function apiMessages() {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = (m.images || []).filter((i) => i.url);
      const text = userText(m);
      out.push({role: "user", content: imgs.length ? [{type: "text", text},
        ...imgs.map((i) => ({type: "image_url", image_url: {url: i.url}}))] : text});
    } else if (!m.error) {
      out.push(...assistantMessages(m));
    }
  }
  return out;
}
// An answer that used MCP tools goes back as the model wrote it: per round the text before the calls, the calls and
// their results (as the model read them), then the rest - so the next question can build on what the tools found.
function assistantMessages(m) {
  const ran = (m.tools || []).filter((t) => t.round != null && t.result != null && t.state !== "skipped");
  if (!ran.length) return m.text ? [{role: "assistant", content: m.text}] : [];
  const out = [];
  let pos = 0;
  for (const r of [...new Set(ran.map((t) => t.round))]) {
    const calls = ran.filter((t) => t.round === r);
    const at = Math.min(Math.max(pos, calls[0].at || 0), m.text.length);
    out.push({role: "assistant", content: m.text.slice(pos, at).trim(),
              tool_calls: calls.map((t) => ({id: t.id, type: "function", function: {name: t.name, arguments: JSON.stringify(t.arguments || {})}}))});
    for (const t of calls) out.push({role: "tool", tool_call_id: t.id, content: t.result});
    pos = at;
  }
  const rest = m.text.slice(pos).trim();
  if (rest) out.push({role: "assistant", content: rest});
  return out;
}

function setBusy(on) {
  $("stop-btn").hidden = !on;
  $("send-btn").hidden = on;
  $("send-btn").disabled = on;
  $("composer-hint").textContent = on ? "" : "Shift+Enter: new line";
  if (window.dashModelBusy) window.dashModelBusy();
}

async function send() {
  const text = $("input").value.trim();
  if ((!text && !attachments.length) || busy) return;
  messages.push({role: "user", text, images: attachments.filter((a) => a.kind !== "file"),
                 files: attachments.filter((a) => a.kind === "file"), time: Date.now()});
  attachments = [];
  renderAttachments();
  $("input").value = "";
  autosize();
  const m = {role: "assistant", text: "", reasoning: "", time: Date.now()};
  messages.push(m);
  renderChat();
  const el = $("chat").lastElementChild;
  const controller = new AbortController();
  busy = {controller, msg: m};
  setBusy(true);

  const body = {model: health.model, messages: apiMessages(), stream: true,
                reasoning_effort: settings.thinking};
  if (settings.temperature > 0) {
    Object.assign(body, {temperature: +settings.temperature, top_p: +settings.top_p, top_k: +settings.top_k});
  } else {
    body.temperature = 0;
  }
  if (settings.seed) body.seed = +settings.seed;
  if (settings.max) body.max_tokens = +settings.max;
  if (projectionLoaded()) body.experimental_speed_projection = !!settings.esp;
  if (settings.mcp !== false && mcpInfo.tools > 0) body.strata_mcp = true;   // this server may run MCP tools for it

  let firstAt = null, thinkStart = null, usage = null, frame = 0;
  const paint = () => { frame = 0; const pinned = followsChat(); updateAssistant(el, m, true); scrollDown(pinned); };
  try {
    const r = await fetch("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body),
                                                   signal: controller.signal});
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
      if (r.status === 401) msg = "This server needs an API key: add it under Manage > Settings.";
      throw new Error(msg);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;              // ": keep-alive" comments while a long prompt is read
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || "the engine reported an error");
        if (j.usage) usage = j.usage;
        if (j.strata_mcp) onTool(m, j.strata_mcp);
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        const lastTool = m.tools && m.tools.length ? m.tools[m.tools.length - 1] : null;   // a new round after a tool
        if (d.reasoning_content) {
          if (!firstAt) firstAt = performance.now();
          if (!thinkStart) thinkStart = performance.now();
          if (lastTool && m.reasoning && lastTool.rat === m.reasoning.length) m.reasoning += "\n\n";
          m.reasoning += d.reasoning_content;
        }
        if (d.content) {
          if (!firstAt) firstAt = performance.now();
          if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
          if (lastTool && m.text && lastTool.at === m.text.length) m.text += "\n\n";
          m.text += d.content;
        }
        if (!frame) frame = requestAnimationFrame(paint);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") m.stopped = true;
    else { m.error = e.message || String(e); toast("error", "The request failed", m.error, 6000); }
  }
  if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
  const n = usage ? usage.completion_tokens : null;
  if (n && firstAt) {
    const secs = (performance.now() - firstAt) / 1000;
    m.meta = `${fmt(n)} tokens${secs > 0.25 ? ` · ${fmt(n / secs, 1)} tok/s` : ""}${m.stopped ? " · stopped" : ""}` +
             (projectionLoaded() ? (settings.esp ? " · projection on" : " · projection off") : "");
  } else if (m.stopped) {
    m.meta = "Stopped";
  }
  for (const t of m.tools || []) if (t.state === "writing" || t.state === "running") { t.state = "skipped"; t.ms = null; }
  const ran = (m.tools || []).filter((t) => t.state === "done" || t.state === "error").length;
  if (ran) m.meta = `${m.meta ? `${m.meta} · ` : ""}${ran} tool call${ran > 1 ? "s" : ""}`;
  if (m.limit) m.meta = `${m.meta || ""} · stopped at the limit of ${m.limit} tool rounds (mcp.max_rounds)`;
  busy = null;
  setBusy(false);
  if (frame) cancelAnimationFrame(frame);
  const pinned = followsChat();
  updateAssistant(el, m, false);
  saveChat();
  scrollDown(pinned);
}

$("composer").onsubmit = (e) => { e.preventDefault(); send(); };
$("stop-btn").onclick = () => { if (busy) busy.controller.abort(); };
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autosize() {
  const t = $("input"), height = window.visualViewport?.height || innerHeight;
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, Math.max(40, height * (innerWidth <= 640 ? 0.3 : 0.4)))}px`;
}
$("input").addEventListener("input", autosize);

$("new-btn").onclick = () => {
  if (busy) { toast("warn", "Still writing", "Stop the answer first."); return; }
  if (!messages.length) return;
  const backup = messages;
  messages = [];
  saveChat();
  renderChat();
  toast("info", "New chat", "The last one was cleared.", 6000, {label: "Undo", run: () => { messages = backup; saveChat(); renderChat(); }});
};
$("export-btn").onclick = () => {
  if (!messages.length) { toast("info", "Nothing to save yet"); return; }
  const tools = (m) => (m.tools || []).filter((t) => t.result != null).map((t) =>
    `<details><summary>Tool ${t.server ? `${t.server} / ` : ""}${t.tool || t.name}${t.ok ? "" : " (error)"}</summary>\n\n` +
    `\`\`\`json\n${JSON.stringify(t.arguments || {}, null, 2)}\n\`\`\`\n\n\`\`\`\n${t.result}\n\`\`\`\n\n</details>\n\n`).join("");
  const md = messages.map((m) => m.role === "user" ? `## You\n\n${m.text}\n` :
    `## ${health.model}\n\n${m.reasoning ? `<details><summary>Thinking</summary>\n\n${m.reasoning}\n\n</details>\n\n` : ""}${tools(m)}${m.text || m.error || ""}\n`).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], {type: "text/markdown"}));
  a.download = `strata-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// pictures and text files: the attach button, dropping them on the chat, or pasting a picture (issue #30)
const TEXT_EXT = /\.(txt|md|markdown|rst|tex|py|pyi|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|c|cc|cpp|cxx|h|hh|hpp|cu|cuh|rs|go|java|kt|kts|swift|rb|php|pl|lua|r|jl|scala|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|diff|patch|gradle|cmake|mk|dockerfile|gitignore|proto|graphql)$/i;
const MAX_TEXT_FILE = 512 * 1024;
function isTextFile(f) {
  return f.type.startsWith("text/") || /json|xml|javascript|yaml|toml|x-sh|x-python/.test(f.type) ||
         TEXT_EXT.test(f.name) || /(^|[\\/])(makefile|dockerfile|readme|license)$/i.test(f.name);
}
function addFiles(files) {
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      if (!health.images) { toast("warn", "Pictures are off", "This model was set up for text only."); continue; }
      if (f.size > 20e6) { toast("warn", "Picture too large", `${f.name} is over 20 MB.`); continue; }
      const r = new FileReader();
      r.onload = () => { attachments.push({kind: "image", name: f.name || "pasted image", url: r.result}); renderAttachments(); };
      r.readAsDataURL(f);
      continue;
    }
    if (!isTextFile(f)) { toast("warn", "Not a text file", `${f.name}: attach text files (code, notes, logs, data)${health.images ? " or pictures" : ""}.`); continue; }
    if (f.size > MAX_TEXT_FILE) { toast("warn", "File too large", `${f.name} is over 512 KB.`); continue; }
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      if (text.includes("\u0000")) { toast("warn", "Not a text file", `${f.name} looks like a binary file.`); return; }
      attachments.push({kind: "file", name: f.name, text});
      renderAttachments();
    };
    r.readAsText(f);
  }
}
// a file's text in the message, fenced with more backticks than it contains itself
function fileBlock(f) {
  const longest = Math.max(2, ...(f.text.match(/`+/g) || []).map((s) => s.length));
  const fence = "`".repeat(longest + 1);
  return `File: ${f.name}\n${fence}\n${f.text}\n${fence}`;
}
function userText(m) {
  const files = (m.files || []).filter((f) => f.text != null);
  return [m.text, ...files.map(fileBlock)].filter((s) => s).join("\n\n");
}
function renderAttachments() {
  const box = $("attachments");
  box.hidden = !attachments.length;
  box.innerHTML = "";
  attachments.forEach((a, i) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = icon(a.kind === "file" ? "attach" : "image", "st-icon st-icon--sm");
    c.append(a.name);
    const x = document.createElement("button");
    x.type = "button"; x.className = "st-btn st-btn--icon"; x.setAttribute("aria-label", "Remove");
    x.innerHTML = icon("trash");
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    c.appendChild(x);
    box.appendChild(c);
  });
}
$("attach-btn").onclick = () => $("file").click();
// drop files on the chat or the message box
for (const id of ["chat", "composer"]) {
  const el = $(id);
  el.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer || {}).types || []].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dragging");
  });
  el.addEventListener("dragleave", () => $("composer").classList.remove("dragging"));
  el.addEventListener("drop", (e) => {
    $("composer").classList.remove("dragging");
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
    focusInput();
  });
}
$("file").onchange = () => { addFiles($("file").files); $("file").value = ""; };
$("input").addEventListener("paste", (e) => {
  if (!health.images) return;
  const files = [...(e.clipboardData || {}).files || []].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ------------------------------------------------------------------ the sampling drawer
function openDrawer(open) {
  $("drawer").dataset.open = String(open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) { loadDrawer(); loadShared(); loadMcp(); }
}
function loadDrawer(s = settings) {
  for (const b of $("s-thinking").children) b.setAttribute("aria-checked", String(b.dataset.v === s.thinking));
  $("s-temp").value = s.temperature; $("s-topp").value = s.top_p; $("s-topk").value = s.top_k;
  $("s-max").value = s.max; $("s-seed").value = s.seed;
  $("s-show").setAttribute("aria-checked", String(!!s.show));
  $("s-esp").setAttribute("aria-checked", String(s.esp !== false));
  $("esp-row").hidden = !projectionLoaded();
  $("s-mcp").setAttribute("aria-checked", String(s.mcp !== false));
  $("s-share").setAttribute("aria-checked", String(sharedOn));
  outputs();
}
// "Use for other apps too": the server keeps these settings as every client's defaults (GET/POST /settings)
let sharedOn = false;
async function loadShared() {
  try {
    const r = await fetch("settings", {headers: headers()});
    if (r.ok) sharedOn = !!(await r.json()).shared;
  } catch (e) { /* an older server: the switch just stays off */ }
  $("s-share").setAttribute("aria-checked", String(sharedOn));
}
function sharedDefaults(s) {
  const d = {reasoning_effort: s.thinking, temperature: +s.temperature};
  if (+s.temperature > 0) Object.assign(d, {top_p: +s.top_p, top_k: +s.top_k});
  if (s.seed) d.seed = +s.seed;
  if (s.max) d.max_tokens = +s.max;
  if (projectionLoaded()) d.experimental_speed_projection = s.esp !== false;
  return d;
}
async function saveShared(on, s) {
  const r = await fetch("settings", {method: "POST", headers: headers(true),
                                      body: JSON.stringify({defaults: on ? sharedDefaults(s) : null})});
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  sharedOn = !!(await r.json()).shared;
}
// the engine was started with the experimental-speed-projection control vector (INFO cvec=...)
function projectionLoaded() {
  const c = lastMetrics && lastMetrics.engine ? lastMetrics.engine.cvec : 0;
  return !!c && c !== "0";
}
function outputs() {
  const t = +$("s-temp").value;
  $("o-temp").textContent = t === 0 ? "0 · greedy" : t.toFixed(2);
  $("o-topp").textContent = (+$("s-topp").value).toFixed(2);
  $("o-topk").textContent = $("s-topk").value;
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  $("o-thinking").textContent = sel ? {none: "answers right away", low: "short", medium: "medium", high: "thorough (default)"}[sel.dataset.v] : "";
  for (const id of ["s-topp", "s-topk"]) $(id).disabled = t === 0;
}
for (const b of $("s-thinking").children) b.onclick = () => { for (const x of $("s-thinking").children) x.setAttribute("aria-checked", String(x === b)); outputs(); };
for (const id of ["s-temp", "s-topp", "s-topk"]) $(id).oninput = outputs;
$("s-show").onclick = () => $("s-show").setAttribute("aria-checked", String($("s-show").getAttribute("aria-checked") !== "true"));
$("s-esp").onclick = () => $("s-esp").setAttribute("aria-checked", String($("s-esp").getAttribute("aria-checked") !== "true"));
$("s-mcp").onclick = () => $("s-mcp").setAttribute("aria-checked", String($("s-mcp").getAttribute("aria-checked") !== "true"));
$("s-share").onclick = () => $("s-share").setAttribute("aria-checked", String($("s-share").getAttribute("aria-checked") !== "true"));
$("s-reset").onclick = () => loadDrawer(DEFAULTS);
$("s-apply").onclick = async () => {
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  settings = {thinking: sel ? sel.dataset.v : "high", temperature: +$("s-temp").value, top_p: +$("s-topp").value,
              top_k: +$("s-topk").value, max: $("s-max").value.trim(), seed: $("s-seed").value.trim(),
              show: $("s-show").getAttribute("aria-checked") === "true",
              esp: $("s-esp").getAttribute("aria-checked") === "true",
              mcp: $("s-mcp").getAttribute("aria-checked") === "true"};
  store.set("sampling", settings);
  const share = $("s-share").getAttribute("aria-checked") === "true";
  openDrawer(false);
  if (share || sharedOn) {
    try {
      await saveShared(share, settings);
      toast("success", "Sampling saved", share ? "Other apps (omp, API clients) use these settings from their next request."
                                               : "Other apps use their own settings again.");
    } catch (e) {
      toast("error", "Saved here, but not for other apps", e.message, 6000);
    }
    return;
  }
  toast("success", "Sampling saved", settings.temperature === 0 ? "Greedy: the same question gives the same answer." : "");
};
$("sampling-btn").onclick = () => openDrawer(true);
$("drawer-close").onclick = () => openDrawer(false);
$("scrim").onclick = () => openDrawer(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").dataset.open === "true") openDrawer(false); });

// ------------------------------------------------------------------ shared with the dashboard's own scripts
// manage.js (loaded first, runs on DOMContentLoaded) formats with these and hands over each /api/stats answer.
window.dash = {
  fmt, kfmt, gb, esc, icon, subHtml, spark, timeout,
  paintEmpty, goTo, TEMP_BANDS,
  setStats(s) {
    stats = s; statsAt = s ? Date.now() : statsAt;
    updatePill();
    if (tab === "monitor" && !lastMetrics) render(null);     // the status bar follows the pill
    // H3 renders but the Studio has no running job yet (started elsewhere, e.g. by Hermes): let it look
    const e = s && s.engine;
    if (e && e.active === "h3" && e.state === "rendering" && !videoJob()) window.dispatchEvent(new CustomEvent("dash:video-poll"));
  },
  stats: () => stats,
  metrics: () => lastMetrics,
};
// the engine or its model changed (manage.js sees it first): the chat's model name, pictures and context follow
// the Studio's job list changed: the pill and the status bar show the render's progress
window.addEventListener("dash:video", () => updatePill());
window.addEventListener("dash:engine", () => {
  loadHealth();
  if (tab === "about") { aboutKey = ""; loadConfig(); }
});

// ------------------------------------------------------------------ start
setBusy(false);
renderChat();
const startQuestion = new URLSearchParams(location.search).get("q");   // /?q=... starts a chat (a shortcut)
if (startQuestion) history.replaceState(null, "", location.pathname + location.hash);
loadHealth().then(loadMcp).then(() => { if (startQuestion) { $("input").value = startQuestion; send(); } });
showTab(location.hash.slice(1) || "chat");
poll();
