// The Video tab: MiniMax H3 (picture + sound) on the PC through h3-engine. The dashboard server proxies
// /api/video/* and adds the key. A video borrows the GPU from Strata/Ollama; h3-engine gives it back by
// itself a few minutes after the last one. Clips stay on the PC (newest first); this page only lists them.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const icon = (n, cls = "st-icon st-icon--sm") => `<svg class="${cls}" aria-hidden="true"><use href="web/sprite.svg#i-${n}"/></svg>`;
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const say = (kind, title, text) => (typeof toast === "function" ? toast(kind, title, text) : null);
  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`; };
  const ago = (t) => { const s = Date.now() / 1000 - t; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago`
    : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t * 1000).toLocaleDateString(); };

  const css = `
.view--video{overflow-y:auto}
.vid{max-width:1240px;width:100%;margin:0 auto;padding:var(--st-s-6);display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:var(--st-s-4);align-items:start}
.vid .st-card{display:flex;flex-direction:column;gap:var(--st-s-3);min-width:0}
.vid p{margin:0}
.vid-form{position:sticky;top:0}
.vid-field{display:flex;flex-direction:column;gap:6px}
.vid-label{font-size:var(--st-fs-sm);font-weight:500;color:var(--st-ink-soft)}
.vid textarea{min-height:120px;resize:vertical;padding:10px 14px;border-radius:var(--st-r-md);border:1.5px solid var(--st-line);background:var(--st-surface);color:var(--st-ink);font:400 var(--st-fs-md)/1.5 var(--st-font)}
.vid textarea:focus{outline:0;border-color:var(--st-focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--st-focus) 20%,transparent)}
.vid-seg{display:flex;gap:4px;padding:4px;background:var(--st-surface-2);border:1px solid var(--st-line);border-radius:var(--st-r-md);flex-wrap:wrap}
.vid-seg button{flex:1 1 auto;height:34px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--st-ink-muted);font:500 var(--st-fs-sm)/1 var(--st-font);cursor:pointer;white-space:nowrap}
.vid-seg button:hover:not(:disabled){color:var(--st-ink)}
.vid-seg button[aria-pressed="true"]{background:var(--st-surface);color:var(--st-ink);font-weight:700;box-shadow:var(--st-sh-card)}
.vid-seg button:disabled{opacity:.4;cursor:not-allowed}
.vid-two{display:grid;grid-template-columns:1fr 1fr;gap:var(--st-s-3)}
.vid-pic{display:flex;gap:12px;align-items:center}
.vid-pic img{width:96px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--st-line);background:var(--st-surface-2)}
.vid-pic .st-btn{flex:none}
.vid details summary{cursor:pointer;font-size:var(--st-fs-sm);color:var(--st-ink-soft)}
.vid details[open] summary{margin-bottom:var(--st-s-3)}
.vid-go{display:flex;gap:var(--st-s-3);align-items:center;flex-wrap:wrap}
.vid-go .st-btn--primary{min-width:150px}
.vid-est{font-size:var(--st-fs-sm);color:var(--st-ink-soft);flex:1;min-width:160px}
.vid-gpu{display:flex;gap:10px;align-items:flex-start;font-size:var(--st-fs-sm);color:var(--st-ink-soft)}
.vid-gpu .mg-dot{margin-top:6px}
.vid-list{display:flex;flex-direction:column;gap:var(--st-s-4)}
.vid-head{display:flex;align-items:center;justify-content:space-between;gap:var(--st-s-3)}
.vid-clip{padding:0!important;overflow:hidden;gap:0!important}
.vid-media{position:relative;background:#000;aspect-ratio:var(--ar,16/9);display:flex;align-items:center;justify-content:center;max-height:70vh}
.vid-media video,.vid-media img{width:100%;height:100%;object-fit:contain;display:block}
.vid-media>a{display:block;width:100%;height:100%}
.vid-wait{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#e8e8e8;font-size:var(--st-fs-sm);padding:16px;text-align:center;background:#111}
.vid-bar{width:min(320px,80%);height:6px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden}
.vid-bar i{display:block;height:100%;background:var(--st-accent);transition:width .6s linear}
.vid-body{padding:var(--st-s-4);display:flex;flex-direction:column;gap:var(--st-s-2)}
.vid-prompt{font-size:var(--st-fs-md);line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.vid-prompt.full{-webkit-line-clamp:unset}
.vid-meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:var(--st-fs-xs);color:var(--st-ink-muted)}
.vid-err{font-size:var(--st-fs-sm);color:var(--st-danger-text)}
.vid-acts{display:flex;gap:var(--st-s-2);flex-wrap:wrap}
.vid-acts .st-btn{height:34px;padding:0 12px;font-size:var(--st-fs-sm)}
.vid-empty{color:var(--st-ink-muted);font-size:var(--st-fs-sm)}
@media (max-width:900px){
  .vid{grid-template-columns:minmax(0,1fr);padding:var(--st-s-4) 16px}
  .vid-form{position:static}
  .vid-two{grid-template-columns:1fr}
}`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  // ---------------------------------------------------------------- form state (remembered per browser)
  const form = {
    mode: store.get("vid.mode", "text"), size: store.get("vid.size", "medium"), aspect: store.get("vid.aspect", "landscape"),
    length: store.get("vid.length", "2.3"), quality: store.get("vid.quality", "standard"), encoder: store.get("vid.encoder", "stock"),
    seed: "", image: null, imageName: "",
    kind: store.get("vid.kind", "video"), pmodel: store.get("vid.pmodel", "flux3"), paspect: store.get("vid.paspect", "square"),
  };
  // 03.11.: Standard replaced Fast as the default (4 steps morph fine detail). Move a remembered "fast" once.
  if (form.quality === "fast" && !store.get("vid.q-migrated", "")) { form.quality = "standard"; store.set("vid.quality", "standard"); }
  store.set("vid.q-migrated", "1");
  let presets = null, jobs = [], health = null, offline = false, error = "", shown = false, timer = 0, sending = false;
  const seen = {};      // job id -> last status, to announce finished clips

  const MODES = [["text", "Text"], ["image", "Start picture"], ["ref", "Reference"]];
  const MODE_NOTE = {
    text: "Describe what happens and what it sounds like — H3 makes the picture and the sound together.",
    image: "The video starts from your picture (cropped to the chosen shape). Describe the motion and the sound.",
    ref: "Put the person, animal or thing from your picture into a new scene. Say “the cat from <Picture 1>” in the prompt.",
  };
  const ASPECTS = [["landscape", "Landscape"], ["portrait", "Portrait"], ["square", "Square"]];

  function dims(size, aspect) {
    const s = presets?.sizes?.[size] || [640, 384];
    let [w, h] = s;
    if (aspect === "portrait") [w, h] = [h, w];
    else if (aspect === "square") w = h = Math.floor(Math.sqrt(w * h) / 32) * 32;
    return [w, h];
  }
  // object keys like "1" and "3" would come first in JS order: sort by the number
  function lengthKeys() { return Object.keys(presets.lengths).sort((a, b) => parseFloat(a) - parseFloat(b)); }
  function maxFrames(size) { return presets?.limits?.[size]?.max_frames || Infinity; }
  // same formula as h3-engine's estimate(): measured 15.3 s/step at 640x384x56 on the RX 6700 XT
  function estimate() {
    if (!presets) return 0;
    const [w, h] = dims(form.size, form.aspect);
    const frames = presets.lengths[form.length] || 56;
    const q = presets.quality[form.quality] || {steps: 8, sps: 15.3};
    const ref = form.mode === "ref";
    const steps = ref && form.quality === "fast" ? 8 : q.steps, sps = ref ? 15.5 : (q.sps || 15.3);
    const tokens = (w * h) / (640 * 384) * ((frames + 3) / 59);
    return 55 + steps * sps * Math.pow(Math.max(tokens, 0.15), 1.15) + 35 * Math.max(tokens, 0.3);
  }

  function seg(id, items, value, disabledFn) {
    return `<div class="vid-seg" id="${id}" role="radiogroup">${items.map(([v, label]) =>
      `<button type="button" role="radio" data-v="${esc(v)}" aria-pressed="${v === value}" aria-checked="${v === value}" ${disabledFn && disabledFn(v) ? "disabled" : ""}>${esc(label)}</button>`).join("")}</div>`;
  }

  // ---------------------------------------------------------------- render
  const KINDS = [["video", "Video"], ["picture", "Picture"]];
  const P_ASPECTS = [["square", "Square"], ["landscape", "Landscape"], ["portrait", "Portrait"]];
  function renderPictureForm(root, keepPrompt) {
    const pm = presets.pictures || {models: {}, sizes: {}};
    const models = Object.entries(pm.models).map(([k, v]) => [k, `${v.label.replace(/ \(.*/, "")} · ~${mmss(v.secs)}`]);
    const note = (pm.models[form.pmodel] || {}).label?.match(/\((.*)\)/)?.[1] || "";
    const canEdit = !!(pm.models[form.pmodel] || {}).edit;
    if (!canEdit) form.image = null;
    root.innerHTML = `
      <span class="card-title">New picture</span>
      <div class="vid-field">${seg("vid-kind", KINDS, form.kind)}</div>
      <div class="vid-field"><label class="vid-label" for="vid-prompt">Prompt</label>
        <textarea id="vid-prompt" maxlength="4000" placeholder="A cozy bakery window at dusk with a hand-painted sign that says &quot;FINN BAKES&quot;, warm light, photorealistic">${esc(keepPrompt)}</textarea></div>
      <div class="vid-field"><span class="vid-label">Model</span>${seg("vid-pmodel", models, form.pmodel)}
        <p class="muted small">${esc(note)}</p></div>
      <div class="vid-field"><span class="vid-label">Shape</span>${seg("vid-paspect", P_ASPECTS.map(([k, l]) => [k, `${l} ${(pm.sizes[k] || []).join("×")}`]), form.paspect)}</div>
      <div class="vid-field" ${canEdit ? "" : "hidden"}>
        <span class="vid-label">Change a picture (optional)</span>
        <div class="vid-pic">${form.image ? `<img src="${form.image}" alt="">` : ""}
          <button type="button" class="st-btn st-btn--secondary" id="vid-pick">${icon("image")}${form.image ? "Change" : "Choose a picture"}</button>
          ${form.image ? `<button type="button" class="st-btn st-btn--icon" id="vid-unpick" title="Remove the picture" aria-label="Remove the picture">${icon("trash")}</button>` : ""}
          <input type="file" id="vid-file" accept="image/png,image/jpeg,image/webp" hidden></div>
        <p class="muted small">With a picture, the prompt says what to change (“make it winter”, “replace the sign text with …”).</p>
      </div>
      <details id="vid-adv" ${store.get("vid.adv", "") ? "open" : ""}><summary>More settings</summary>
        <div class="vid-field"><label class="vid-label" for="vid-seed">Seed</label>
          <input class="st-input" id="vid-seed" type="number" min="1" step="1" placeholder="Random" value="${esc(form.seed)}">
          <span class="muted small">Same seed + same settings = the same picture.</span></div>
      </details>
      <div class="vid-go">
        <button type="button" class="st-btn st-btn--primary" id="vid-go" ${sending ? "disabled" : ""}>${icon("image")}${sending ? "Sending…" : "Make picture"}</button>
        <span class="vid-est" id="vid-est"></span>
      </div>
      <div class="vid-gpu" id="vid-gpu"></div>`;
    wireForm();
    paintEstimate();
    paintGpu();
  }

  function renderForm() {
    const root = $("vid-form");
    if (!root) return;
    if (presets && form.kind === "picture") return renderPictureForm(root, $("vid-prompt")?.value ?? store.get("vid.prompt", ""));
    if (!presets) { root.innerHTML = `<span class="card-title">New video</span><p class="vid-empty">${esc(offline ? "The PC is asleep — wake it under Manage to make videos." : error || "Connecting to the video engine…")}</p>`; return; }
    const sizes = Object.keys(presets.sizes).map((k) => { const [w, h] = dims(k, form.aspect); return [k, `${k[0].toUpperCase() + k.slice(1)} ${w}×${h}`]; });
    const lengths = lengthKeys().map((k) => [k, `${k} s`]);
    const quals = Object.entries(presets.quality).map(([k, v]) => [k, v.label.replace(/ \(.*/, "")]);
    const qnote = Object.entries(presets.quality).map(([k, v]) => `${v.label.replace(/ \(.*/, "")}: ${v.label.match(/\((.*)\)/)?.[1] || v.steps + " steps"}`).join(" · ");
    const keepPrompt = $("vid-prompt")?.value ?? store.get("vid.prompt", "");
    root.innerHTML = `
      <span class="card-title">New video</span>
      <div class="vid-field">${seg("vid-kind", KINDS, form.kind)}</div>
      <div class="vid-field">${seg("vid-mode", MODES, form.mode)}<p class="muted small">${esc(MODE_NOTE[form.mode])}</p></div>
      <div class="vid-field" id="vid-picrow" ${form.mode === "text" ? "hidden" : ""}>
        <span class="vid-label">Picture</span>
        <div class="vid-pic">${form.image ? `<img src="${form.image}" alt="">` : ""}
          <button type="button" class="st-btn st-btn--secondary" id="vid-pick">${icon("image")}${form.image ? "Change" : "Choose a picture"}</button>
          ${form.image ? `<button type="button" class="st-btn st-btn--icon" id="vid-unpick" title="Remove the picture" aria-label="Remove the picture">${icon("trash")}</button>` : ""}
          <input type="file" id="vid-file" accept="image/png,image/jpeg,image/webp" hidden></div>
      </div>
      <div class="vid-field"><label class="vid-label" for="vid-prompt">Prompt</label>
        <textarea id="vid-prompt" maxlength="4000" placeholder="A red fox trots through falling snow at dusk, cinematic. Soft crunching footsteps and wind.">${esc(keepPrompt)}</textarea></div>
      <div class="vid-field"><span class="vid-label">Quality</span>${seg("vid-quality", quals, form.quality)}
        ${form.quality === "fast" ? `<p class="muted small">Draft: a quick look at the idea. Fine details like text, faces or small figures can change from frame to frame.</p>` : ""}</div>
      <div class="vid-field"><span class="vid-label">Shape</span>${seg("vid-aspect", ASPECTS, form.aspect)}</div>
      <div class="vid-field"><span class="vid-label">Size</span>${seg("vid-size", sizes, form.size)}</div>
      <div class="vid-field"><span class="vid-label">Length</span>${seg("vid-length", lengths, form.length, (v) => presets.lengths[v] > maxFrames(form.size))}</div>
      <details id="vid-adv" ${store.get("vid.adv", "") ? "open" : ""}><summary>More settings</summary>
        <div class="vid-two">
          <div class="vid-field"><label class="vid-label" for="vid-seed">Seed</label>
            <input class="st-input" id="vid-seed" type="number" min="1" step="1" placeholder="Random" value="${esc(form.seed)}">
            <span class="muted small">Same seed + same settings = the same clip.</span></div>
          <div class="vid-field"><span class="vid-label">Text encoder</span>${seg("vid-encoder", [["stock", "Stock"], ["uncensored", "Uncensored"]], form.encoder)}
            <span class="muted small">Uncensored: the Sakura encoder (no refusals baked in).</span></div>
        </div>
        <p class="muted small" style="margin-top:8px">${esc(qnote)}. Reference mode always uses 8 steps.</p>
      </details>
      <div class="vid-go">
        <button type="button" class="st-btn st-btn--primary" id="vid-go" ${sending ? "disabled" : ""}>${icon("film")}${sending ? "Sending…" : "Make video"}</button>
        <span class="vid-est" id="vid-est"></span>
      </div>
      <div class="vid-gpu" id="vid-gpu"></div>`;
    wireForm();
    paintEstimate();
    paintGpu();
  }

  function paintEstimate() {
    const el = $("vid-est");
    if (!el || !presets) return;
    if (form.kind === "picture") {
      const m = (presets.pictures?.models || {})[form.pmodel] || {secs: 60};
      const [pw, ph] = presets.pictures?.sizes?.[form.paspect] || [1024, 1024];
      el.textContent = `${pw}×${ph} · about ${mmss(m.secs * pw * ph / (1024 * 1024) + (form.image ? 20 : 0))}`;
      return;
    }
    const [w, h] = dims(form.size, form.aspect);
    const ahead = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    el.textContent = `${w}×${h} · ${form.length} s · about ${mmss(estimate())}` + (ahead ? ` after the ${ahead} before it` : "");
  }

  function paintGpu() {
    const el = $("vid-gpu");
    if (!el || !health) return;
    const g = health.gpu || {};
    let dot = "", text;
    if (health.busy) { dot = "warn"; text = "Making a video now. Chat with the model on the PC waits until the GPU is given back."; }
    else if (g.held) { dot = "on"; text = `The video engine still holds the GPU (fast follow-ups). It goes back to the chat model in ${mmss(g.release_in_s)}. `; }
    else { text = `The GPU is with the chat model. Making a video borrows it (about 20 s) and gives it back ${mmss(g.hold_s || 300)} after the last video.`; }
    if (g.note) text += " " + g.note;
    el.innerHTML = `<span class="mg-dot ${dot}"></span><span>${esc(text)}${g.held && !health.busy && !health.queued ? ` <a href="#" id="vid-release">Give it back now</a>` : ""}</span>`;
    const r = $("vid-release");
    if (r) r.onclick = async (ev) => { ev.preventDefault(); await api("POST", "release"); refresh(); };
  }

  function clipHtml(j) {
    const ar = `${j.width}/${j.height}`;
    const files = `api/video/files/${encodeURIComponent(j.id)}`;
    let media;
    const pic = j.kind === "picture";
    if (j.status === "done" && pic) {
      media = `<a href="${files}/image.png" target="_blank" rel="noopener"><img src="${files}/poster.jpg" alt="" loading="lazy"></a>`;
    } else if (j.status === "done") {
      media = `<video controls playsinline preload="none" poster="${files}/poster.jpg" src="${files}/video.mp4"></video>`;
    } else {
      const pos = jobs.filter((x) => x.status === "queued" && x.created < j.created).length;
      const msg = j.status === "running" ? `${esc(j.phase || "Working")}${j.step ? ` · step ${j.step} of ${j.steps}` : ""} · ${mmss(Date.now() / 1000 - j.started)} of about ${mmss(j.estimate_s)}`
        : j.status === "queued" ? (pos ? `Waiting — ${pos} before it` : "Waiting for the GPU")
        : j.status === "cancelled" ? "Cancelled" : "Failed";
      media = `<div class="vid-wait">${j.status === "running" ? `<div class="vid-bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>` : ""}<span>${msg}</span></div>`;
    }
    const meta = pic ? [`${j.width}×${j.height}`, ((presets?.pictures?.models || {})[j.model]?.label || j.model).replace(/ \(.*/, ""),
      j.mode === "edit" ? "edited picture" : "", `seed ${j.seed}`, j.status === "done" && j.elapsed ? `made in ${mmss(j.elapsed)}` : "", ago(j.created)].filter(Boolean)
      : [`${j.width}×${j.height}`, `${j.seconds} s`, (presets?.quality?.[j.quality]?.label || j.quality).replace(/ \(.*/, ""),
      j.mode === "image" ? "from picture" : j.mode === "ref" ? "reference" : "", j.encoder === "uncensored" ? "uncensored" : "",
      `seed ${j.seed}`, j.status === "done" && j.elapsed ? `made in ${mmss(j.elapsed)}` : "", ago(j.created)].filter(Boolean);
    const busy = j.status === "queued" || j.status === "running";
    return `<article class="st-card vid-clip" data-id="${esc(j.id)}">
      <div class="vid-media" style="--ar:${ar}">${media}</div>
      <div class="vid-body">
        <div class="vid-prompt" title="Show all">${esc(j.prompt)}</div>
        <div class="vid-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
        ${j.status === "failed" ? `<div class="vid-err">${esc(j.error || "Failed")}</div>` : ""}
        <div class="vid-acts">
          ${j.status === "done" ? (pic ? `<a class="st-btn st-btn--secondary" href="${files}/image.png" download="picture-${esc(j.id)}.png">${icon("download")}Download</a>`
            : `<a class="st-btn st-btn--secondary" href="${files}/video.mp4" download="h3-${esc(j.id)}.mp4">${icon("download")}Download</a>`) : ""}
          ${j.status === "done" && pic ? `<button type="button" class="st-btn st-btn--secondary" data-act="animate">${icon("film")}Animate</button>` : ""}
          <button type="button" class="st-btn st-btn--secondary" data-act="reuse">${icon("refresh")}Use these settings</button>
          <button type="button" class="st-btn st-btn--secondary" data-act="del">${icon(busy ? "stop" : "trash")}${busy ? "Cancel" : "Delete"}</button>
        </div>
      </div></article>`;
  }

  function renderList() {
    const root = $("vid-list");
    if (!root) return;
    const head = `<div class="vid-head"><span class="card-title">Clips</span><span class="muted small">${jobs.length ? `${jobs.length} on the PC` : ""}</span></div>`;
    if (!jobs.length) { root.innerHTML = head + `<p class="vid-empty">${offline ? "" : "No videos yet. They are kept on the PC and listed here."}</p>`; return; }
    root.querySelector(".vid-empty")?.remove();
    // keep playing videos untouched: only re-render clips whose state changed
    const existing = new Map([...root.querySelectorAll(".vid-clip")].map((el) => [el.dataset.id, el]));
    if (!root.querySelector(".vid-head")) root.innerHTML = head;
    else root.querySelector(".vid-head").outerHTML = head;
    let prev = root.querySelector(".vid-head");
    for (const j of jobs) {
      const key = `${j.status}|${j.phase}|${j.step}|${Math.round((j.progress || 0) * 100)}|${j.status === "running" ? Math.floor(Date.now() / 5000) : ""}|${(presets ? 1 : 0)}`;
      let el = existing.get(j.id);
      if (!el || el.dataset.key !== key) {
        const tmp = document.createElement("div");
        tmp.innerHTML = clipHtml(j);
        const fresh = tmp.firstElementChild;
        fresh.dataset.key = key;
        if (el) el.replaceWith(fresh); else prev.after(fresh);
        el = fresh;
      } else if (el.previousElementSibling !== prev) prev.after(el);
      existing.delete(j.id);
      prev = el;
    }
    for (const el of existing.values()) el.remove();
  }

  function render() {
    const root = $("vid");
    if (!root) return;
    if (!root.firstChild) {
      root.innerHTML = `<div class="st-card vid-form" id="vid-form"></div><div class="vid-list" id="vid-list"></div>`;
      $("vid-list").addEventListener("click", onListClick);
    }
    if (!$("vid-form").dataset.ready || !$("vid-prompt")) { renderForm(); if (presets) $("vid-form").dataset.ready = "1"; }
    else { paintEstimate(); paintGpu(); }
    renderList();
  }

  // ---------------------------------------------------------------- events
  function pick(groupId, key, after) {
    const g = $(groupId);
    if (!g) return;
    g.onclick = (ev) => {
      const b = ev.target.closest("button[data-v]");
      if (!b || b.disabled) return;
      form[key] = b.dataset.v;
      store.set("vid." + key, form[key]);
      if (after) after();
      renderForm();
    };
  }
  function fitLength() {
    if (presets && presets.lengths[form.length] > maxFrames(form.size)) {
      const ok = lengthKeys().filter((k) => presets.lengths[k] <= maxFrames(form.size));
      form.length = ok[ok.length - 1] || "1";
    }
  }
  function wireForm() {
    pick("vid-mode", "mode");
    pick("vid-aspect", "aspect");
    pick("vid-quality", "quality");
    pick("vid-size", "size", fitLength);
    pick("vid-length", "length");
    pick("vid-encoder", "encoder");
    pick("vid-kind", "kind");
    pick("vid-pmodel", "pmodel");
    pick("vid-paspect", "paspect");
    $("vid-prompt").oninput = (ev) => { store.set("vid.prompt", ev.target.value); };
    $("vid-prompt").onkeydown = (ev) => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) submit(); };
    $("vid-seed").oninput = (ev) => { form.seed = ev.target.value; };
    if ($("vid-adv")) $("vid-adv").ontoggle = (ev) => store.set("vid.adv", ev.target.open ? "1" : "");
    $("vid-go").onclick = submit;
    if ($("vid-pick")) {
      $("vid-pick").onclick = () => $("vid-file").click();
      $("vid-file").onchange = (ev) => { const f = ev.target.files[0]; if (f) readImage(f); };
    }
    if ($("vid-unpick")) $("vid-unpick").onclick = () => { form.image = null; renderForm(); };
  }
  function readImage(f) {
    if (f.size > 15 * 1024 * 1024) return say("error", "Picture too large", "15 MB at most.");
    const r = new FileReader();
    r.onload = () => { form.image = r.result; form.imageName = f.name; renderForm(); };
    r.readAsDataURL(f);
  }

  async function api(method, path, body) {
    const r = await fetch("/api/video/" + path, {method, headers: body ? {"Content-Type": "application/json"} : {},
                                                  body: body ? JSON.stringify(body) : undefined});
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) throw Object.assign(new Error((data && (data.error?.message || data.error)) || `HTTP ${r.status}`), {status: r.status});
    return data;
  }

  async function submit() {
    if (sending || !presets) return;
    const prompt = $("vid-prompt").value.trim();
    if (!prompt) { $("vid-prompt").focus(); return say("warn", "Write a prompt first"); }
    if (form.kind === "video" && form.mode !== "text" && !form.image) return say("warn", "Choose a picture", form.mode === "ref" ? "Reference mode needs one." : "Start-picture mode needs one.");
    sending = true; renderForm();
    try {
      const j = form.kind === "picture"
        ? await api("POST", "jobs", {kind: "picture", prompt, model: form.pmodel, aspect: form.paspect,
                                     image: form.image || undefined, seed: form.seed ? +form.seed : undefined})
        : await api("POST", "jobs", {prompt, mode: form.mode, image: form.mode === "text" ? undefined : form.image,
        size: form.size, aspect: form.aspect, length: form.length, quality: form.quality, encoder: form.encoder,
        seed: form.seed ? +form.seed : undefined});
      seen[j.id] = j.status;
      jobs.unshift(j);
      say("success", j.kind === "picture" ? "Picture queued" : "Video queued", `About ${mmss(j.estimate_s)}. You can leave this page — it keeps going on the PC.`);
    } catch (e) { say("error", "Could not start the video", e.message); }
    finally { sending = false; renderForm(); refresh(); }
  }

  async function onListClick(ev) {
    const p = ev.target.closest(".vid-prompt");
    if (p) { p.classList.toggle("full"); return; }
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest(".vid-clip").dataset.id;
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    if (b.dataset.act === "animate" || (b.dataset.act === "reuse" && j.kind === "picture")) {
      const animate = b.dataset.act === "animate";
      try {
        const blob = await (await fetch(`api/video/files/${encodeURIComponent(j.id)}/${animate ? "image.png" : "input.png"}`)).blob();
        form.image = (animate || j.has_input) ? await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }) : null;
      } catch (e) { form.image = null; }
      if (animate) {             // the picture becomes the first frame of a video
        Object.assign(form, {kind: "video", mode: "image", aspect: j.aspect === "portrait" ? "portrait" : j.aspect === "square" ? "square" : "landscape", seed: ""});
        store.set("vid.kind", "video"); store.set("vid.mode", "image"); store.set("vid.aspect", form.aspect);
        if ($("vid-prompt")) $("vid-prompt").value = "";
        store.set("vid.prompt", "");
        say("info", "Picture ready as the first frame", "Describe the motion and the sound, then Make video.");
      } else {
        Object.assign(form, {kind: "picture", pmodel: j.model, paspect: j.aspect, seed: String(j.seed)});
        for (const k of ["kind", "pmodel", "paspect"]) store.set("vid." + k, form[k]);
        store.set("vid.prompt", j.prompt);
        if ($("vid-prompt")) $("vid-prompt").value = j.prompt;
        say("info", "Settings copied", "Same seed — change the prompt or the seed for a variation.");
      }
      renderForm();
      $("vid-form").scrollIntoView({behavior: "smooth", block: "start"});
      return;
    }
    if (b.dataset.act === "reuse") {
      Object.assign(form, {kind: "video"});
      store.set("vid.kind", "video");
      Object.assign(form, {mode: j.mode, size: j.size, aspect: j.aspect, length: j.length, quality: j.quality, encoder: j.encoder, seed: String(j.seed)});
      for (const k of ["mode", "size", "aspect", "length", "quality", "encoder"]) store.set("vid." + k, form[k]);
      store.set("vid.prompt", j.prompt);
      if (j.has_input && j.mode !== "text") {
        try {
          const blob = await (await fetch(`api/video/files/${encodeURIComponent(j.id)}/input.png`)).blob();
          form.image = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
        } catch (e) { form.image = null; }
      }
      if ($("vid-prompt")) $("vid-prompt").value = j.prompt;
      store.set("vid.adv", "1");
      renderForm();
      $("vid-form").scrollIntoView({behavior: "smooth", block: "start"});
      say("info", "Settings copied", "Same seed — change the prompt or the seed for a variation.");
      return;
    }
    if (b.dataset.act === "del") {
      const busy = j.status === "queued" || j.status === "running";
      if (!busy && !b.classList.contains("armed")) {         // two taps to delete a finished clip
        b.classList.add("armed"); b.lastChild.textContent = "Tap again to delete";
        setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.lastChild.textContent = "Delete"; } }, 3000);
        return;
      }
      try { await api("DELETE", "jobs/" + encodeURIComponent(id)); } catch (e) { say("error", "Could not do that", e.message); }
      refresh();
    }
  }

  // ---------------------------------------------------------------- polling
  async function refresh() {
    clearTimeout(timer);
    try {
      const d = await api("GET", "jobs");
      offline = false; error = "";
      const hadPresets = !!presets;
      presets = d.presets; health = d; jobs = d.jobs || [];
      fitLength();
      for (const j of jobs) {
        if (seen[j.id] && seen[j.id] !== j.status && j.status === "done") say("success", "Video ready", j.prompt.slice(0, 80));
        if (seen[j.id] && seen[j.id] !== j.status && j.status === "failed") say("error", "Video failed", j.error);
        seen[j.id] = j.status;
      }
      if (!hadPresets && $("vid-form")) delete $("vid-form").dataset.ready;
    } catch (e) {
      offline = e.status === 503 && /asleep/.test(e.message);
      error = e.message;
      if (!presets && $("vid-form")) delete $("vid-form").dataset.ready;
    }
    if (shown) render();
    const active = jobs.some((j) => j.status === "queued" || j.status === "running");
    // fast while something renders; otherwise slow, and not at all while the tab is hidden and idle
    const next = active ? (shown ? 2000 : 8000) : (shown ? 15000 : 0);
    if (next) timer = setTimeout(refresh, document.hidden ? Math.max(next, 15000) : next);
  }

  const prevShown = window.manageShown;
  window.manageShown = (t) => {
    if (prevShown) prevShown(t);
    const was = shown;
    shown = t === "video";
    if (shown && !was) { render(); refresh(); }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && shown) refresh(); });
  // app.js may already have opened #video before this file loaded
  shown = !!$("view-video") && !$("view-video").hidden;
  if (shown) render();
  // pick up running jobs on load so a finished video is announced even from another tab
  refresh();
})();
