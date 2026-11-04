// The dashboard's additions to Strata's page: the Manage tab (engine, chat target, power, monitors, lighting,
// wake, Hermes tokens) and the chat target switch in the composer. Loaded BEFORE app.js, so the fetch hook below
// is in place for app.js' first request. Everything here talks to the dashboard's own /api/* endpoints.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  // app.js' formatting (window.dash), so both halves of the page print numbers the same way. app.js loads after
  // this file, but everything here that formats runs on DOMContentLoaded or later.
  const D = () => window.dash;
  const esc = (s) => D().esc(s);
  const icon = (n, cls = "st-icon st-icon--sm") => D().icon(n, cls);
  const num = (n) => D().kfmt(n);
  const fmt = (n, d) => D().fmt(n, d);
  const tmo = (ms) => (window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  const dur = (s) => { s = Math.max(0, Math.round(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };

  // ---------------------------------------------------------------- chat target
  // Who answers the chat: the model on the PC (Strata or Ollama, whichever holds the GPU) or the Hermes agent
  // (tools, memory, terminal on the Mac). The dashboard server routes on this header; app.js never knows.
  let target = store.get("dash.chat-target", "model");
  let preferredModel = store.get("dash.chat-model", ""), selectedModel = "", modelEngine = "";
  let modelList = [], strataModels = [], modelsLoading = false, modelsError = "", modelRefreshAt = 0;
  let engineLoading = false, engineSwitching = false;
  let modelsKey = "";       // the engine (active|model) the installed models were last asked for, success or not
  let gpuNote = "";         // why there are no models right now ("GPU busy: making a video", asleep)
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (typeof url === "string" && url.replace(/^\//, "").startsWith("v1/chat/completions")) {
      opts = Object.assign({}, opts);
      opts.headers = Object.assign({}, opts.headers, {"X-Chat-Target": target});
      if (selectedModel && modelEngine && !modelsError) {
        opts.headers["X-Chat-Model"] = selectedModel;
        opts.headers["X-Chat-Engine"] = modelEngine;
        const body = JSON.parse(opts.body);
        body.model = selectedModel;
        opts.body = JSON.stringify(body);
      }
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
.chat-model-trigger{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:210px;height:32px;padding:0 9px;border:0;border-radius:8px;background:var(--st-surface-2);color:var(--st-ink);font:500 var(--st-fs-sm)/1 var(--st-font);cursor:pointer;flex-shrink:1}
.chat-model-trigger span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.chat-model-trigger .st-icon{width:14px;height:14px;flex:none}
.chat-model-trigger[aria-expanded="true"] .st-icon{transform:rotate(180deg)}
.chat-model-trigger:hover,.chat-model-trigger[aria-expanded="true"]{background:var(--st-line-soft)}
.chat-model-trigger:focus-visible,.chat-model-menu button:focus-visible{outline:2px solid var(--st-accent);outline-offset:1px}
.chat-model-trigger:disabled{opacity:.65;cursor:default}
.chat-model-menu{position:fixed;z-index:20;display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid var(--st-line);border-radius:14px;background:var(--st-surface);color:var(--st-ink);box-shadow:var(--st-sh-pop);overflow:hidden}
.chat-model-menu__head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-left:8px;font-size:var(--st-fs-xs);color:var(--st-ink-muted);flex:none}
.chat-model-menu__head .st-btn--icon{width:30px;height:30px}
.chat-model-list{overflow-y:auto;overscroll-behavior:contain;min-height:0;scroll-padding:4px}
.chat-model-option{display:flex;align-items:center;gap:12px;width:100%;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--st-ink);text-align:left;font:500 var(--st-fs-md)/1.3 var(--st-font);cursor:pointer}
.chat-model-option:hover,.chat-model-option:focus-visible{background:var(--st-surface-2)}
.chat-model-option__label{flex:1;min-width:0}
.chat-model-option small{display:block;margin-top:3px;color:var(--st-ink-muted);font-size:var(--st-fs-xs);font-weight:400;overflow-wrap:anywhere}
.chat-model-check{width:16px;flex:none;color:var(--st-accent);visibility:hidden}
.chat-model-option[aria-checked="true"] .chat-model-check{visibility:visible}
.chat-model-menu__foot{border-top:1px solid var(--st-line);padding-top:5px;flex:none}
.chat-model-status{font-size:var(--st-fs-xs);color:var(--st-ink-muted);overflow-wrap:anywhere;padding:4px 8px}
.chat-model-status:empty{display:none}
@media(max-width:640px){.chat-model-trigger{flex:1;max-width:190px;height:34px;padding:0 8px}.st-composer__bar .spacer{display:none}}
.chat-model-list{min-height:96px}
/* Model engine: one tile per engine with what it is for; Video (H3) shows only while it holds the GPU */
.mg-opts{display:flex;flex-direction:column;gap:6px}
.mg-opt{display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:8px;row-gap:4px;padding:10px 12px;border:1.5px solid var(--st-line);border-radius:var(--st-r-md);background:var(--st-surface);color:var(--st-ink);text-align:left;font:500 var(--st-fs-md)/1.25 var(--st-font);cursor:pointer}
.mg-opt:hover:not(:disabled){background:var(--st-surface-2)}
.mg-opt[aria-pressed="true"]{border-color:var(--st-accent);background:var(--st-accent-tint);cursor:default}
.mg-opt[aria-pressed="true"] .mg-opt__name{font-weight:700}
.mg-opt:disabled{opacity:.45;cursor:not-allowed}
.mg-opt[data-eng="h3"]:disabled{opacity:1;cursor:default}
.mg-opt[data-eng="h3"][aria-pressed="true"]{border-color:var(--st-warn);background:var(--st-warn-tint)}
.mg-opt__sub{grid-column:2;font-size:var(--st-fs-xs);font-weight:400;color:var(--st-ink-muted)}
.mg-btn.danger:not(.armed){color:var(--st-danger-text);border-color:var(--st-danger)}
.mg-btn.danger:not(.armed):hover:not(:disabled){background:var(--st-danger-tint)}
/* Hermes tokens: the four numbers people look at, the rest folded away */
.mg-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--st-s-3)}
.mg-tile{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid var(--st-line-soft);border-radius:var(--st-r-md);background:var(--st-surface-2);min-width:0}
.mg-tile span{font-size:var(--st-fs-xs);color:var(--st-ink-muted)}
.mg-tile strong{font-size:var(--st-fs-xl);font-weight:900;line-height:1.1;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.mg-tok-more .st-collapse__body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--st-s-6);font-size:var(--st-fs-md);color:var(--st-ink)}
.mg-tok-more .st-collapse__body>div{min-width:0}
.mg-tok-more summary .muted{font-weight:400}
.mg-tok-more summary .muted:empty{display:none}
.chat-model-option[aria-disabled="true"] small{color:var(--st-danger-text)}
@media(max-width:600px){.mg-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.mg-tok-more .st-collapse__body{grid-template-columns:1fr}}
@media(max-width:860px){.manage{grid-template-columns:1fr;padding:var(--st-s-4)}}`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  const SW = {red: "#ff2d2d", purple: "#8000ff", blue: "#2d6bff", green: "#2ddd6b"};

  function build() {
    $("manage").innerHTML = `
      <div class="st-card wide" id="mg-asleep" tabindex="-1" hidden>
        <span class="card-title">__PC_NAME__ is asleep or off</span>
        <p class="muted">Chat and the model are not available until it wakes. Waking takes about 10 seconds from sleep.</p>
        <div class="mg-row"><button class="st-btn st-btn--primary" id="mg-wake">${icon("bolt")}Wake __PC_NAME__</button></div>
        <div class="mg-msg" id="mg-wake-msg"></div>
      </div>
      <div class="st-card" id="mg-eng-card" tabindex="-1">
        <span class="card-title">Model engine</span>
        <p class="muted small">Only one runs at a time — each needs the whole GPU.</p>
        <div class="mg-opts" id="mg-eng">
          <button class="mg-opt" data-eng="ollama"><span class="mg-dot"></span><span class="mg-opt__name">Ollama</span>
            <small class="mg-opt__sub">Everyday models · fastest · lets the PC sleep when idle</small></button>
          <button class="mg-opt" data-eng="strata" data-model="qwen3.8-flash-next-q2_0"><span class="mg-dot"></span><span class="mg-opt__name">Strata Q2_0</span>
            <small class="mg-opt__sub">The full 125B model · loads in 1–3 min · keeps the PC awake</small></button>
          <button class="mg-opt" data-eng="strata" data-model="qwen3.8-flash-next-coder-iq1_m"><span class="mg-dot"></span><span class="mg-opt__name">Strata Coder</span>
            <small class="mg-opt__sub">Smaller coding variant · loads in 1–3 min · keeps the PC awake</small></button>
          <button class="mg-opt" data-eng="h3" disabled hidden aria-pressed="false"><span class="mg-dot"></span><span class="mg-opt__name">Video (H3)</span>
            <small class="mg-opt__sub" id="mg-h3-sub"></small></button>
        </div>
        <div class="mg-msg" id="mg-eng-msg"></div>
      </div>
      <div class="st-card" id="mg-power" tabindex="-1">
        <span class="card-title">Power</span>
        <div class="mg-status"><span class="mg-dot" id="mg-pc-dot"></span><span id="mg-pc-text">–</span></div>
        <div class="mg-row">
          <button class="st-btn st-btn--secondary mg-btn" data-act="suspend">Suspend</button>
          <button class="st-btn st-btn--secondary mg-btn danger" data-act="poweroff">Shut down</button>
        </div>
        <div class="toggle-row"><span>Monitors<br><span class="muted small" id="mg-mon-sub">–</span></span>
          <button class="st-toggle" id="mg-mon" role="switch" aria-checked="false" aria-label="Monitors" disabled></button></div>
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
      <div class="st-card" id="mg-settings" tabindex="-1">
        <span class="card-title">Settings</span>
        <div class="st-field">
          <label class="st-label" for="api-key">API key <output>only if the server was started with one</output></label>
          <input class="st-input" id="api-key" type="password" autocomplete="off" placeholder="Not needed">
        </div>
        <p class="muted small">The key, the theme and the sampling settings are kept in this browser; chats are kept on the
          dashboard server. Light / dark: the button at the top right.
          <a href="https://github.com/Niko1221/Strata" target="_blank" rel="noopener noreferrer">Strata on GitHub</a></p>
      </div>
      <div class="st-card wide" id="mg-tokens" hidden>
        <span class="card-title" id="mg-tok-title">Hermes tokens</span>
        <div class="mg-tiles" id="mg-tok-tiles"></div>
        <details class="st-collapse mg-tok-more"><summary>Details <span class="muted" id="mg-tok-sum"></span>
          ${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body" id="mg-tok-body"></div></details>
      </div>`;

    for (const b of $("mg-eng").querySelectorAll("button:not([data-eng=h3])")) b.onclick = () => doEngine(b);
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
    if (!bar || $("chat-model")) return;
    bar.insertAdjacentHTML("afterend", `<button type="button" class="chat-model-trigger" id="chat-model" aria-label="Choose model" aria-haspopup="menu" aria-expanded="false" aria-controls="chat-model-menu"><span>Loading models…</span>${icon("chevron")}</button>`);
    document.body.insertAdjacentHTML("beforeend", `<div class="chat-model-menu" id="chat-model-menu" role="menu" aria-label="Models and chat mode" hidden>
      <div class="chat-model-menu__head"><span id="chat-model-label">Installed models</span>
        <button type="button" class="st-btn st-btn--icon" id="chat-model-refresh" role="menuitem" aria-label="Refresh installed models" title="Refresh installed models">${icon("refresh")}</button></div>
      <div class="chat-model-list" id="chat-model-list" role="group" aria-label="Installed models"></div>
      <div class="chat-model-menu__foot" id="chat-target" role="group" aria-label="Chat goes to">
        <div class="chat-model-menu__head"><span>Chat goes to</span></div>
        <button type="button" class="chat-model-option" data-t="model" role="menuitemradio" aria-checked="false">
        <span class="chat-model-option__label">Model on the PC<small>Answers directly — fast, no tools</small></span><span class="chat-model-check" aria-hidden="true">✓</span></button>
        <button type="button" class="chat-model-option" data-t="agent" role="menuitemradio" aria-checked="false">
        <span class="chat-model-option__label">Hermes agent<small id="chat-agent-sub">Tools, memory and a terminal on the PC</small></span><span class="chat-model-check" aria-hidden="true">✓</span></button>
        <button type="button" class="chat-model-option" data-t="builder" role="menuitemradio" aria-checked="false">
        <span class="chat-model-option__label">Builder<small>Builds apps in ~/Projects · needs Strata</small></span><span class="chat-model-check" aria-hidden="true">✓</span></button></div>
      <div class="chat-model-status" id="chat-model-status" role="status"></div></div>`);
    $("chat-model").onclick = () => toggleModels($("chat-model-menu").hidden);
    $("chat-model").onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); toggleModels(true); }
    };
    $("chat-model-list").onclick = (e) => {
      const option = e.target.closest("[data-model]"); if (!option) return;
      if (option.disabled || (typeof busy !== "undefined" && busy)) return;
      if (option.dataset.engine === "strata" && (modelEngine !== "strata" || selectedModel !== option.dataset.model)) {
        toggleModels(false, true); switchEngine("strata", option.dataset.model); return;
      }
      selectedModel = option.dataset.model;
      if (modelEngine === "ollama") { preferredModel = selectedModel; store.set("dash.chat-model", selectedModel); }
      toggleModels(false, true); paintModels(); paintTarget();
      if (typeof saveChat === "function") saveChat();
    };
    for (const b of $("chat-target").querySelectorAll("button")) b.onclick = () => { chooseTarget(b.dataset.t); toggleModels(false, true); };
    $("chat-model-refresh").onclick = () => loadModels();
    $("chat-model-menu").onkeydown = (e) => {
      const buttons = [...$("chat-model-menu").querySelectorAll("button:not(:disabled)")];
      const at = buttons.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
          : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus({preventScroll: true});
        buttons[next]?.scrollIntoView({block: "nearest"});
      }
      if (e.key === "Escape") { e.preventDefault(); toggleModels(false, true); }
      if (e.key === "Tab") toggleModels(false, true);
    };
    document.addEventListener("pointerdown", (e) => {
      if (!$("chat-model-menu").contains(e.target) && !$("chat-model").contains(e.target)) toggleModels(false);
    });
    window.addEventListener("resize", positionModels);
    window.visualViewport?.addEventListener("resize", positionModels);
    window.visualViewport?.addEventListener("scroll", positionModels);
  }
  function modelName(model) {
    if (!model) return "Choose model";
    if (model.label) return model.label;
    const id = model.id.toLowerCase(), params = id.match(/(?:[-:])(\d+(?:\.\d+)?)b/)?.[1];
    let name = id.includes("ministral-3") ? `Ministral 3 ${params || ""}B`
      : id.includes("qwen3.5") ? `Qwen 3.5 ${params || "9"}B`
      : id.includes("gemma4") || id.includes("gemma-4") ? `Gemma 4 ${params || "12"}B`
      : model.id.split("/").pop().replace(/:latest$/, "");
    if (id.includes("abl")) name += " Abl";
    const context = id.match(/-(\d+)k/)?.[1];
    return name + (context ? ` · ${context}K` : "");
  }
  function toggleModels(open, restoreFocus = false) {
    const menu = $("chat-model-menu"), trigger = $("chat-model"); if (!menu) return;
    menu.hidden = !open; trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      positionModels();
      const option = menu.querySelector('.chat-model-list [aria-checked="true"]') || menu.querySelector("button:not(:disabled)");
      option?.focus({preventScroll: true}); option?.scrollIntoView({block: "nearest"});
    } else if (restoreFocus) trigger.focus({preventScroll: true});
  }
  function positionModels() {
    const menu = $("chat-model-menu"); if (!menu || menu.hidden) return;
    const rect = $("chat-model").getBoundingClientRect(), v = window.visualViewport;
    const x = v?.offsetLeft || 0, y = v?.offsetTop || 0, w = v?.width || innerWidth, h = v?.height || innerHeight;
    const width = Math.min(360, w - 24), above = rect.top - y > 180;
    const available = above ? rect.top - y - 20 : y + h - rect.bottom - 20;
    menu.style.width = `${width}px`; menu.style.maxHeight = `${Math.max(80, Math.min(w <= 640 ? 360 : 420, available))}px`;
    menu.style.left = `${Math.max(x + 12, Math.min(rect.right - width, x + w - width - 12))}px`;
    menu.style.top = `${Math.max(y + 8, above ? rect.top - menu.offsetHeight - 8 : rect.bottom + 8)}px`;
  }
  async function loadModels() {
    if (modelsLoading) return;
    modelsLoading = true; modelRefreshAt = Date.now(); paintModels();
    try {
      const r = await realFetch("/api/models", {cache: "no-store", signal: tmo(10000)});
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || "Could not read installed models.");
      modelEngine = data.engine; modelList = data.data || []; modelsError = "";
      strataModels = data.strata_models || []; engineLoading = data.state === "loading" || data.state === "error";
      const wanted = modelEngine === "ollama" ? preferredModel : selectedModel;
      selectedModel = modelEngine === "strata" ? data.default : modelList.some((m) => m.id === wanted) ? wanted
        : modelList.some((m) => m.id === data.default) ? data.default : modelList[0]?.id || "";
      if (modelEngine === "ollama" && selectedModel) {
        preferredModel = selectedModel; store.set("dash.chat-model", selectedModel);
      }
    } catch (e) {
      modelsError = e.name === "TimeoutError" ? "The PC did not answer in time." : e.message;
      selectedModel = ""; modelList = [];
    } finally { modelsLoading = false; }
    paintModels(); paintTarget();
  }
  function paintModels() {
    const trigger = $("chat-model"); if (!trigger) return;
    const working = (typeof busy !== "undefined" && !!busy) || engineSwitching;
    const option = (m, engine) => `<button type="button" class="chat-model-option" role="menuitemradio" aria-checked="${engine === modelEngine && m.id === selectedModel}" data-model="${esc(m.id)}" data-engine="${engine}" ${working ? "disabled" : ""}>
      <span class="chat-model-option__label">${esc(modelName(m))}<small>${esc(m.id)}</small></span><span class="chat-model-check" aria-hidden="true">✓</span></button>`;
    const options = modelList.map((m) => option(m, modelEngine)).join("") + (modelEngine !== "strata" && strataModels.length
      ? `<div class="chat-model-menu__head">Strata · switches the GPU</div>` + strataModels.map((m) => option(m, "strata")).join("") : "");
    if ($("chat-model-list").innerHTML !== options) $("chat-model-list").innerHTML = options;
    const name = gpuNote && !selectedModel ? gpuNote : selectedModel ? modelName(modelList.find((m) => m.id === selectedModel))
      : modelsLoading ? "Loading models…" : modelsError ? "Models unavailable" : "Choose model";
    trigger.querySelector("span").textContent = (target === "agent" ? "Hermes · " : target === "builder" ? "Builder · " : "") + (engineSwitching ? "Switching…" : name + (engineLoading ? " · loading…" : ""));
    trigger.disabled = working;
    trigger.title = `${modelEngine === "strata" ? "Strata" : "Ollama"} · ${selectedModel || modelsError || "Choose model"}`;
    trigger.setAttribute("aria-label", `Choose model: ${target === "agent" ? "Hermes agent, " : ""}${selectedModel || name}`);
    if (trigger.disabled) toggleModels(false);
    $("chat-model-refresh").disabled = modelsLoading || working;
    $("chat-model-label").textContent = modelEngine === "strata" ? "Strata" : "Installed Ollama models";
    $("chat-model-status").textContent = (gpuNote && !selectedModel ? (modelsError || gpuNote) : modelsError) || (engineLoading ? "Loading the model — Send becomes available when it is ready." : modelEngine === "strata" ? "Switch to Ollama under Manage" : "");
    const send = $("send-btn");
    if (send) send.disabled = working || engineLoading || (target === "builder" ? modelEngine !== "strata"
      : target !== "agent" && (modelsLoading || !!modelsError || !selectedModel));
    if (target === "builder" && modelEngine && modelEngine !== "strata" && !modelsLoading)
      $("chat-model-status").textContent = "Builder thinks with Strata — switch the engine to Strata under Manage.";
    positionModels();
  }
  window.dashModelBusy = paintModels;
  window.dashGetModel = () => selectedModel || preferredModel;
  window.dashSetModel = (model) => {
    if (strataModels.some((m) => m.id === model)) return;
    preferredModel = typeof model === "string" ? model : "";
    store.set("dash.chat-model", preferredModel);
    if (modelEngine === "ollama") {
      if (modelList.some((m) => m.id === preferredModel)) { selectedModel = preferredModel; paintModels(); paintTarget(); }
      else loadModels();
    }
  };
  function setTarget(t) { target = t; store.set("dash.chat-target", t); paintTarget(); }
  // The user picks a target. A Builder chat is tied to its agent session, so switching into or out of
  // Builder with messages on screen starts a new chat instead of mixing the two.
  function chooseTarget(t) {
    if (t === target || (typeof busy !== "undefined" && busy && !busy.builder)) return;
    const crossing = (t === "builder") !== (target === "builder");
    if (crossing && typeof messages !== "undefined" && messages.length && window.dashNewChat) window.dashNewChat();
    setTarget(t);
    if (!crossing && typeof saveChat === "function") saveChat();
  }
  window.dashSetTarget = setTarget;   // chats.js: an opened chat brings back who it talked to
  window.dashGetTarget = () => target;
  function paintTarget() {
    for (const b of document.querySelectorAll("#chat-target button")) b.setAttribute("aria-checked", String(target === b.dataset.t));
    paintModels();
    if (D() && D().paintEmpty) D().paintEmpty();      // the chat's empty line follows who answers (Builder writes its own)
    if (window.dashBuilder) window.dashBuilder.targetChanged();
  }

  // ---------------------------------------------------------------- actions
  async function post(url, body, msgId, ms = 20000) {
    const m = $(msgId);
    try {
      const r = await (await realFetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
                                             signal: tmo(ms)})).json();
      if (m) m.textContent = r.message;
      return r;
    } catch (e) { if (m) m.textContent = "Could not reach the dashboard server."; return {ok: false}; }
  }
  let engBusy = 0;
  async function doEngine(b) {
    if (b.disabled || b.getAttribute("aria-pressed") === "true") return;
    await switchEngine(b.dataset.eng, b.dataset.model || "");
  }
  async function switchEngine(engine, model) {
    if (engineSwitching || (typeof busy !== "undefined" && busy)) return;
    engineSwitching = true; engBusy = Date.now(); paintModels();
    for (const b of $("mg-eng").querySelectorAll("button")) b.disabled = true;
    const result = await post("/api/engine", {engine, model}, "mg-eng-msg", 60000);
    try {
      if (!result.ok) throw new Error(result.message || "Could not switch the model.");
      for (let n = 0; n < 15; n++) {
        let s = null;
        try { s = await (await realFetch("/api/stats", {cache: "no-store", signal: tmo(5000)})).json(); } catch (e) { /* try again */ }
        if (s && s.engine?.active === engine && (!model || s.engine.model === model)) {
          paint(s); modelsKey = engineKey(s); await loadModels(); return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("The switch is still pending. Refresh the models in a moment.");
    } catch (e) { if (typeof toast === "function") toast("error", "Model switch", e.message); }
    finally { engineSwitching = false; engBusy = 0; paintModels(); }
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
    const on = b.dataset.state === "off";
    b.setAttribute("aria-checked", String(on));
    $("mg-mon-sub").textContent = on ? "turning on…" : "turning off…";
    await post("/api/display", {action: on ? "on" : "off"}, "mg-pw-msg");
  }
  async function doWake() {
    const b = $("mg-wake"); b.disabled = true;
    const r = await post("/api/wake", {}, "mg-wake-msg");
    setTimeout(() => { b.disabled = false; }, r.ok ? 20000 : 0);
  }

  // ---------------------------------------------------------------- state
  const ENG = {loading: "loading…", idle: "ready", reading: "reading", generating: "generating", ready: "ready", error: "not answering"};
  let asleepToasted = false;
  const engineKey = (s) => (s && s.engine ? `${s.engine.active}|${s.engine.model || ""}` : "");
  let lastEngineKey = null;
  function paint(s) {
    // asleep / awake. A server that is still starting answers ok:false with nothing probed yet: that is not
    // "asleep", just no news.
    const starting = s.ok === false && s.online == null;
    const asleep = !starting && !s.online;
    $("mg-asleep").hidden = !asleep;
    if (asleep && !asleepToasted && typeof toast === "function") {
      asleepToasted = true;
      toast("warn", "__PC_NAME__ is asleep", "Wake it under Manage.", 6000);
    }
    if (s.online) asleepToasted = false;
    const p = s.pc || {};
    $("mg-pc-dot").className = "mg-dot " + (starting ? "" : asleep ? "off" : s.host_stats ? "on" : "warn");
    $("mg-pc-text").textContent = starting ? "Waiting for the first reading…" : asleep ? "Asleep or off"
      : !s.host_stats ? "Online — no host metrics (SSH probe not answering)"
      : ["Online", p.uptime != null ? `up ${dur(p.uptime)}` : "", p.total_watts != null ? `${Math.round(p.total_watts)} W (est.)` : ""]
          .filter(Boolean).join(" · ");
    for (const b of document.querySelectorAll(".mg-btn")) if (!b.classList.contains("armed")) b.disabled = !s.host_stats;

    // engine. A change (another engine, another Strata model) also reloads the chat's model info in app.js.
    const e = s.engine;
    const ek = asleep ? "asleep" : engineKey(s);
    if (lastEngineKey !== null && ek !== lastEngineKey) window.dispatchEvent(new CustomEvent("dash:engine", {detail: e || null}));
    lastEngineKey = ek;
    gpuNote = asleep ? "__PC_NAME__ is asleep" : e && e.active === "h3" ? (e.state === "rendering" ? "GPU busy: making a video" : "GPU held by the video engine")
      : e && e.active == null && e.state === "none" ? "No engine: pick one under Manage" : "";
    engineLoading = e?.active === "strata" && (e.state === "loading" || e.state === "error");
    strataModels = s.strata_models || strataModels;
    if (!engBusy) for (const b of $("mg-eng").querySelectorAll("button:not([data-eng=h3])")) {
      const name = b.dataset.eng === "strata" ? (b.dataset.model.endsWith("q2_0") ? "Strata Q2_0" : "Strata Coder") : "Ollama";
      const on = !!e && e.active === b.dataset.eng && (!b.dataset.model || e.model === b.dataset.model);
      b.disabled = !e || engineSwitching || (typeof busy !== "undefined" && !!busy)
        || (b.dataset.eng === "strata" && !strataModels.some((m) => m.id === b.dataset.model));
      b.setAttribute("aria-pressed", String(on));
      b.querySelector(".mg-dot").className = "mg-dot" + (on ? (e.state === "loading" || e.state === "error" ? " warn" : " on") : "");
      b.querySelector(".mg-opt__name").textContent = on ? `${name} · ${ENG[e.state] || e.state}` : name;
    }
    // H3 is no choice here (a video borrows the GPU by itself): shown, lit and not clickable while it holds the GPU
    const h3 = $("mg-eng").querySelector("[data-eng=h3]"), h3on = !!e && e.active === "h3";
    h3.hidden = !h3on;
    h3.setAttribute("aria-pressed", String(h3on));
    h3.querySelector(".mg-dot").className = "mg-dot" + (h3on ? " warn" : "");
    h3.querySelector(".mg-opt__name").textContent = h3on ? `Video (H3) · ${e.state === "rendering" ? "rendering" : "idle"}` : "Video (H3)";
    $("mg-h3-sub").textContent = !h3on ? "" : e.state === "rendering"
      ? "Making a video — switching waits until it is done (or cancel it in the Studio)"
      : "Holds the GPU for quick follow-ups and gives it back by itself — pick an engine to take it back now";
    paintModels();

    // chat target: is the agent reachable? (said in the composer's "Chat goes to" list)
    const as = $("chat-agent-sub"), ab = as && as.closest("button");
    if (as) {
      as.textContent = s.agent === false ? "Not reachable right now (Mac asleep?)" : "Tools, memory and a terminal on the PC";
      ab.setAttribute("aria-disabled", String(s.agent === false));
    }

    // monitors: a switch that shows what the displays do now (mixed = some on, some off)
    const mb = $("mg-mon");
    if (!monBusy || Date.now() - monBusy > 2500) {
      monBusy = 0;
      const m = s.monitors;
      mb.dataset.state = m || "na"; mb.disabled = !m;
      mb.setAttribute("aria-checked", String(m === "on" || m === "mixed"));
      $("mg-mon-sub").textContent = !m ? "not available (PC off, Windows, or no display)" : m === "off" ? "off" : m === "mixed" ? "some on, some off" : "on";
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
      const tile = (k, v) => `<div class="mg-tile"><span>${esc(k)}</span><strong>${v}</strong></div>`;
      const c = t.current;
      const tiles = tile("Input", num(t.in)) + tile("Output", num(t.out)) + tile("API calls", fmt(t.calls)) +
                    tile("Last activity", c && c.idle != null ? `${dur(c.idle)} ago` : "–");
      if ($("mg-tok-tiles").innerHTML !== tiles) $("mg-tok-tiles").innerHTML = tiles;
      $("mg-tok-sum").textContent = `${fmt(t.sessions)} sessions · ${(t.models || []).length} models`;
      let h = `<div>${kv("Cached", num(t.cache_read))}${t.reasoning ? kv("Reasoning", num(t.reasoning)) : ""}${kv("Sessions", t.sessions)}` +
              `${(t.models || []).slice(0, 4).map((x) => kv(x.name, `${num(x.out)} out · ${x.calls} calls`)).join("")}</div>`;
      const sid = String(c ? c.id : "");
      const shortId = sid.length > 16 ? `${sid.slice(0, 10)}…${sid.slice(-4)}` : sid;
      h += `<div>${c ? kv("Current session", `<code title="${esc(sid)}">${esc(shortId)}</code>`) + kv("Model", `<code>${esc(c.model)}</code>`) +
            kv("In / Out", `${num(c.in)} / ${num(c.out)}`) : ""}</div>`;
      if ($("mg-tok-body").dataset.h !== h) { $("mg-tok-body").innerHTML = h; $("mg-tok-body").dataset.h = h; }
    }
  }

  // ---------------------------------------------------------------- Monitor layout
  // Which metric cards the Monitor shows, in which order, and which of its sections. Kept per browser (a
  // viewing preference). Strata's own cards are found by their value element (mv-<key>); the extra cards below
  // come from this dashboard's probe, which also sees what Strata cannot (CPU temperature, system draw, fan).
  const CARDS = {
    speed: "Speed", gpu: "GPU load", vram: "VRAM", temp: "GPU temp", sysw: "System draw", cpu: "CPU",
    cputemp: "CPU temp", ram: "RAM", power: "GPU power", fan: "GPU fan", disk: "Disk read", pcie: "PCIe"};
  const EXTRA = {
    sysw: {icon: "bolt", max: 750}, cputemp: {icon: "thermometer", max: 95},
    ram: {icon: "memory", max: 100}, fan: {icon: "activity", max: 3300, tone: "info"}};
  // the Monitor's two headings; a card moves only within its own (order and drag stay per group)
  const GROUPS = {gpu: "GPU", sys: "System"};
  const GROUP = {speed: "gpu", gpu: "gpu", vram: "gpu", temp: "gpu", power: "gpu", fan: "gpu", pcie: "gpu",
                 cpu: "sys", cputemp: "sys", ram: "sys", sysw: "sys", disk: "sys"};
  // the server's history series for each extra card (/metrics history); the local buffer H only stands in
  // for an older server that does not send them
  const SERIES = {sysw: "total_watts", cputemp: "cpu_temp", ram: "ram_pct", fan: "gpu_fan"};
  const MIN = {cputemp: 30};
  const SECTIONS = {state: ["Status", ".state-card"], ctx: ["Context and memory", ".ctx-card"],
                    req: ["Recent requests", ".req-card"], cc: ["Conversation cache", "#cc-card"]};
  // PCIe stays empty on AMD cards (Strata reads it through NVML), so it starts hidden; GPU power is folded into
  // System draw's line, disk reads matter only when experts stream from the SSD.
  const DEFAULT_LAYOUT = {order: ["speed", "gpu", "vram", "temp", "power", "fan", "pcie", "cpu", "cputemp", "ram", "sysw", "disk"],
                          hidden: ["power", "fan", "disk", "pcie"], sections: {state: true, ctx: true, req: true, cc: true}};
  let layout;
  try { layout = JSON.parse(store.get("dash.monitor-layout", "null")); } catch (e) { layout = null; }
  // a saved layout from an older page (or a broken one): known cards only, each once; new cards are added hidden
  function cleanLayout(l) {
    const fresh = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    if (!l || typeof l !== "object" || !Array.isArray(l.order)) return fresh;
    const order = [...new Set(l.order.filter((k) => k in CARDS))];
    const hidden = [...new Set((Array.isArray(l.hidden) ? l.hidden : fresh.hidden).filter((k) => k in CARDS))];
    for (const k of Object.keys(CARDS)) if (!order.includes(k)) { order.push(k); if (!hidden.includes(k)) hidden.push(k); }
    // a layout from before the groups: the GPU cards first, then the System ones, each in its saved order
    const g = Object.keys(GROUPS);
    order.sort((a, b) => g.indexOf(GROUP[a]) - g.indexOf(GROUP[b]));
    const sections = Object.assign({}, fresh.sections);
    if (l.sections && typeof l.sections === "object") for (const k of Object.keys(SECTIONS)) if (k in l.sections) sections[k] = !!l.sections[k];
    return {order, hidden, sections};
  }
  layout = cleanLayout(layout);
  const saveLayout = () => store.set("dash.monitor-layout", JSON.stringify(layout));
  const H = {sysw: [], cputemp: [], ram: [], fan: []};

  function cardEl(key) { const v = $(`mv-${key}`); return v ? v.closest(".metric-card") : null; }
  function buildExtraCards() {
    if (!$("metrics")) return;
    for (const [key, x] of Object.entries(EXTRA)) {
      if ($(`mv-${key}`)) continue;
      $(`metrics-${GROUP[key]}`).insertAdjacentHTML("beforeend", `<div class="st-card metric-card"><div class="st-metric">
        <span class="st-metric__label">${icon(x.icon)}${esc(CARDS[key])}</span>
        <span class="st-metric__value" id="mv-${key}">–</span><span class="st-metric__sub" id="ms-${key}"></span>
        <svg class="st-metric__spark" id="sp-${key}" viewBox="0 0 100 32" preserveAspectRatio="none"${x.tone ? ` data-tone="${x.tone}"` : ""}>
          <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg></div></div>`);
    }
    const pw = cardEl("power"); if (pw) { const l = pw.querySelector(".st-metric__label"); if (l) l.lastChild.textContent = "GPU power"; }
  }
  function applyLayout() {
    layout.order.forEach((k, i) => { const c = cardEl(k); if (c) { c.style.order = i; c.classList.toggle("dash-off", layout.hidden.includes(k)); } });
    // a heading whose cards are all hidden goes with them
    for (const g of Object.keys(GROUPS)) {
      const el = $(`mgroup-${g}`);
      if (el) el.classList.toggle("dash-off", layout.order.every((k) => GROUP[k] !== g || layout.hidden.includes(k)));
    }
    for (const [k, [, sel]] of Object.entries(SECTIONS)) { const el = document.querySelector(sel); if (el) el.classList.toggle("dash-off", !layout.sections[k]); }
    const row = document.querySelector(".monitor-row");
    if (row) row.classList.toggle("dash-single", !layout.sections.ctx || !layout.sections.req);
  }
  function setVal(key, value, unit, sub) {
    const v = $(`mv-${key}`); if (!v) return;
    v.innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
    $(`ms-${key}`).innerHTML = D().subHtml(sub);
  }
  // The four extra cards. Values only the probe has (fan, CPU temperature, system draw) come from /api/stats; RAM
  // and the GPU temperature come from the same /metrics answer app.js shows, so two cards never disagree.
  let lastStats = null;
  function paintExtra(fresh) {          // fresh: a new /api/stats answer (only those go into the local buffer)
    const s = lastStats, m = D() ? D().metrics() : null;
    const p = s && s.online ? s.pc : null;
    if (!p) {                                       // asleep, starting or unreachable: nothing to show, nothing to keep
      for (const k of Object.keys(EXTRA)) { setVal(k, null, "", ""); H[k] = []; spark(k, []); }
      return;
    }
    const hw = (m && m.hardware) || {}, hist = (m && m.history) || {};
    const push = (k, v) => { if (!fresh) return; H[k].push(v == null || Number.isNaN(+v) ? null : +v); if (H[k].length > 120) H[k].shift(); };
    const W = (w) => (w == null ? null : `${fmt(w)} W`);
    // an estimate (CPU package + GPU board + a fixed rest): "est." sits with the unit, not alone on a line
    setVal("sysw", p.total_watts != null ? fmt(p.total_watts) : null, "W est.",
           p.total_watts == null ? "" : [p.cpu_watts != null ? `CPU ${W(p.cpu_watts)}` : "", p.power != null ? `GPU ${W(p.power)}` : ""]);
    push("sysw", p.total_watts);
    const peak = p.cpu_freq_max, avg = p.cpu_freq;
    setVal("cputemp", p.cpu_temp != null ? fmt(p.cpu_temp) : null, "°C", [
      peak != null ? `${fmt(peak, 2)} GHz peak` : avg != null ? `${fmt(avg, 2)} GHz` : "",
      peak != null && avg != null ? `${fmt(avg, 1)} avg` : "",
      p.load != null ? `load ${fmt(p.load, 2)}` : ""]);
    push("cputemp", p.cpu_temp);
    const used = hw.ram_used != null ? hw.ram_used : p.mem_used, total = hw.ram_total || p.mem_total;
    const rp = total && used != null ? 100 * used / total : null;
    setVal("ram", used != null ? D().gb(used) : null, total ? `/ ${fmt(total / 1073741824)} GB` : "GB",
           [rp != null ? `${fmt(rp)}% used` : "", p.uptime != null ? `up ${dur(p.uptime)}` : ""]);
    push("ram", rp);
    const junction = hw.gpu_temp != null ? hw.gpu_temp : p.temp;
    setVal("fan", p.fan != null ? fmt(p.fan) : null, "rpm", junction != null ? `GPU ${fmt(junction)} °C` : "");
    push("fan", p.fan);
    for (const [k, x] of Object.entries(EXTRA)) {
      const server = hist[SERIES[k]];
      spark(k, Array.isArray(server) ? server : H[k], x.max, MIN[k], k === "cputemp" ? D().TEMP_BANDS.cpu : null);
    }
  }
  const spark = (k, values, max, min, bands) => { if (D() && $(`sp-${k}`)) D().spark(`sp-${k}`, values, max, min || 0, bands); };
  function buildLayoutCard() {
    $("manage").insertAdjacentHTML("beforeend", `<div class="st-card wide" id="mg-layout">
      <div class="mg-row" style="justify-content:space-between"><span class="card-title">Monitor layout</span>
        <button class="st-btn st-btn--secondary" id="mg-layout-reset">Reset</button></div>
      <p class="muted small">Tick what the Monitor shows. Drag to reorder within GPU or System — here or straight on the Monitor (on a phone: hold a card, then drag). Kept in this browser.</p>
      <div class="mg-layout" id="mg-cards"></div>
      <span class="card-title" style="font-size:var(--st-fs-md)">Sections</span>
      <div class="mg-layout" id="mg-sections"></div></div>`);
    $("mg-layout-reset").onclick = () => { layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); saveLayout(); paintLayoutCard(); applyLayout(); };
    paintLayoutCard();
  }
  function paintLayoutCard() {
    const chev = (dir) => `<svg class="st-icon st-icon--sm" style="transform:rotate(${dir === "up" ? 180 : 0}deg)"><use href="web/sprite.svg#i-chevron"/></svg>`;
    // per group: a card moves up or down only next to cards of its own group
    const same = (i, j) => j >= 0 && j < layout.order.length && GROUP[layout.order[i]] === GROUP[layout.order[j]];
    $("mg-cards").innerHTML = Object.entries(GROUPS).map(([g, title]) => `<span class="mg-layout__group">${esc(title)}</span>` +
      layout.order.map((k, i) => GROUP[k] !== g ? "" : `<div class="mg-item">
      <label><input type="checkbox" data-k="${k}"${layout.hidden.includes(k) ? "" : " checked"}> ${esc(CARDS[k])}</label>
      <span><button class="st-btn st-btn--icon" data-mv="${i}" data-d="-1" aria-label="Move ${esc(CARDS[k])} up"${same(i, i - 1) ? "" : " disabled"}>${chev("up")}</button>
      <button class="st-btn st-btn--icon" data-mv="${i}" data-d="1" aria-label="Move ${esc(CARDS[k])} down"${same(i, i + 1) ? "" : " disabled"}>${chev("down")}</button></span></div>`).join("")).join("");
    $("mg-sections").innerHTML = Object.entries(SECTIONS).map(([k, [label]]) => `<div class="mg-item">
      <label><input type="checkbox" data-s="${k}"${layout.sections[k] ? " checked" : ""}> ${esc(label)}</label></div>`).join("");
    for (const c of $("mg-cards").querySelectorAll("input")) c.onchange = () => {
      layout.hidden = layout.hidden.filter((x) => x !== c.dataset.k); if (!c.checked) layout.hidden.push(c.dataset.k);
      saveLayout(); applyLayout(); };
    for (const b of $("mg-cards").querySelectorAll("button[data-mv]")) b.onclick = () => {
      const i = +b.dataset.mv, j = i + +b.dataset.d; [layout.order[i], layout.order[j]] = [layout.order[j], layout.order[i]];
      saveLayout(); paintLayoutCard(); applyLayout(); };
    for (const c of $("mg-sections").querySelectorAll("input")) c.onchange = () => { layout.sections[c.dataset.s] = c.checked; saveLayout(); applyLayout(); };
  }
  // Drag and drop. Pointer events rather than HTML5 drag-and-drop, which iOS Safari does not do: a mouse drags
  // after a few pixels; a finger has to hold still for 350 ms first, so an ordinary swipe still scrolls the page.
  // The order changes live while dragging (the cards reflow through CSS order) and is saved on release.
  function sortable(container, itemSel, keyOf, onDone) {
    let drag = null;
    const keyAt = (x, y) => { const el = document.elementFromPoint(x, y); const it = el && el.closest(itemSel);
      return it && container.contains(it) ? keyOf(it) : null; };
    const move = (x, y) => {
      const k = keyAt(x, y);
      if (!k || k === drag.key || GROUP[k] !== GROUP[drag.key]) return;      // within its own group only
      const o = layout.order, from = o.indexOf(drag.key), to = o.indexOf(k);
      o.splice(from, 1); o.splice(to, 0, drag.key);
      applyLayout(); if (container.id === "mg-cards") paintLayoutCard(drag.key);
    };
    const end = () => {
      if (!drag) return;
      document.querySelectorAll(".dash-dragging").forEach((e) => e.classList.remove("dash-dragging"));
      document.body.classList.remove("dash-drag-active");
      clearTimeout(drag.timer);
      if (drag.active) {
        saveLayout(); onDone();
        // the release must not also count as a click (it would tick a checkbox under the pointer)
        const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener("click", eat, {capture: true, once: true});
        setTimeout(() => window.removeEventListener("click", eat, {capture: true}), 50);
      }
      drag = null;
    };
    container.addEventListener("pointerdown", (e) => {
      const it = e.target.closest(itemSel);
      if (!it || !container.contains(it) || e.button > 0 || e.target.closest("button, input, a")) return;
      drag = {key: keyOf(it), x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== "mouse", el: it};
      const start = () => { if (!drag) return; drag.active = true; drag.el.classList.add("dash-dragging");
                            document.body.classList.add("dash-drag-active"); };
      if (drag.touch) drag.timer = setTimeout(start, 350);
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
      if (!drag.active) {
        if (drag.touch) { if (far) { clearTimeout(drag.timer); drag = null; } return; }   // a swipe: let it scroll
        if (!far) return;
        drag.active = true; drag.el.classList.add("dash-dragging"); document.body.classList.add("dash-drag-active");
      }
      e.preventDefault();
      move(e.clientX, e.clientY);
      const cur = [...container.querySelectorAll(itemSel)].find((x) => keyOf(x) === drag.key);
      if (cur && cur !== drag.el) { drag.el.classList.remove("dash-dragging"); drag.el = cur; cur.classList.add("dash-dragging"); }
    }, {passive: false});
    // a finger that is dragging must not scroll the page underneath
    window.addEventListener("touchmove", (e) => { if (drag && drag.active) e.preventDefault(); }, {passive: false});
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  document.head.insertAdjacentHTML("beforeend", `<style>
.dash-off{display:none!important}
#metrics .metric-card{cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.mg-item{cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.dash-dragging{opacity:.55;outline:2px dashed var(--st-accent);outline-offset:2px;cursor:grabbing}
body.dash-drag-active,body.dash-drag-active *{cursor:grabbing!important}
.monitor-row.dash-single{grid-template-columns:1fr}
.mg-layout{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px 16px}
.mg-layout__group{grid-column:1/-1;font-size:var(--st-fs-sm);font-weight:700;color:var(--st-ink-soft);margin-top:4px}
.mg-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 4px 4px 10px;border:1px solid var(--st-line-soft);border-radius:10px;font-size:var(--st-fs-md)}
.mg-item label{display:flex;align-items:center;gap:8px;cursor:pointer}
.mg-item input{accent-color:var(--st-accent);width:16px;height:16px}
.mg-item .st-btn--icon{width:30px;height:30px}</style>`);

  let tabNow = "chat";
  window.manageShown = (t) => { const was = tabNow; tabNow = t; if (t !== was && (t === "manage" || t === "monitor")) poll(); };
  // /api/stats: every 2 s on Manage and the Monitor, every 5 s elsewhere, paused while the page is hidden
  let pollTimer = 0, polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    clearTimeout(pollTimer);
    try {
      const s = await (await realFetch("/api/stats", {cache: "no-store", signal: tmo(5000)})).json();
      lastStats = s;
      D().setStats(s);
      paint(s);
      paintExtra(true);
      // the installed models: again when the engine changes, else every 30 s - but never while H3 holds the GPU
      // or the PC sleeps (it can only fail), and a failed engine is not asked again on every poll
      const key = s.online ? engineKey(s) : "asleep";
      if (gpuNote) {
        if (selectedModel || modelList.length || modelsError) { selectedModel = ""; modelList = []; modelsError = ""; paintModels(); }
        modelsKey = key;
      } else if (key !== modelsKey || Date.now() - modelRefreshAt > 30000) {
        modelsKey = key;
        loadModels();
      }
    } catch (e) {
      lastStats = null;           // dashboard server restarting or unreachable
      D().setStats(null);
      paintExtra();
    }
    polling = false;
    if (!document.hidden) pollTimer = setTimeout(poll, tabNow === "manage" || tabNow === "monitor" ? 2000 : 5000);
  }
  document.addEventListener("visibilitychange", () => { clearTimeout(pollTimer); if (!document.hidden) poll(); });
  // app.js has new /metrics: the RAM and fan cards and the server's history follow it
  window.addEventListener("dash:metrics", () => paintExtra());
  document.addEventListener("DOMContentLoaded", () => {
    build(); buildLayoutCard(); buildExtraCards(); applyLayout();
    sortable($("metrics"), ".metric-card", (it) => it.querySelector(".st-metric__value").id.slice(3), () => paintLayoutCard());
    sortable($("mg-cards"), ".mg-item", (it) => it.querySelector("input").dataset.k, () => {});
    buildComposerSwitch(); paintTarget(); poll();
  });
})();
