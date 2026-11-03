// "Builder" chat target: strata-agent, Finn's own coding agent on the PC (files, shell, web, previews).
// Loaded after app.js and chats.js. A Builder chat is tied to one agent session (and one project folder
// in ~/Projects on the PC). The session on the PC is the source of truth: the open chat is rebuilt from
// its event log and then follows it live, so a run keeps going when the phone locks and the chat picks
// it up again when it comes back. The dashboard server proxies /api/builder/* and adds the key.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
               set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const isBuilder = () => (window.dashGetTarget ? window.dashGetTarget() : ls.get("dash.chat-target", "model")) === "builder";

  let meta = {session: null, project: null};   // the open chat's session
  let follow = null;                           // {sid, ctrl, retry} while attached to a session's events
  let projects = [], lastSeq = 0, working = false;   // working: the open session was still running

  async function api(method, path, body) {
    const r = await fetch("/api/builder/" + path, {method, headers: {"Content-Type": "application/json"},
                                                    body: body ? JSON.stringify(body) : undefined});
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) throw new Error((data && (data.error?.message || data.error)) || `HTTP ${r.status}`);
    return data;
  }

  // ------------------------------------------------------------------ events -> page messages
  // The page's message shape: {role:"user", text, images, time} and
  // {role:"assistant", text, reasoning, tools:[{id,name,tool,arguments,result,ok,chars,ms,state,at}], meta}.
  function newCtx() { return {msgs: [], cur: null, base: null, rbase: null, steps: 0, prompt: 0, out: 0, secs: 0}; }
  function cur(ctx, t) {
    if (!ctx.cur) {
      ctx.cur = {role: "assistant", text: "", reasoning: "", tools: [], time: (t || Date.now() / 1000) * 1000};
      ctx.msgs.push(ctx.cur);
      ctx.steps = ctx.prompt = ctx.out = ctx.secs = 0;
    }
    return ctx.cur;
  }
  const sep = (s) => (s && !s.endsWith("\n\n") ? "\n\n" : "");
  // What the agent is doing right now, shown under the answer while it runs ("Step 3 · thinking · 12 s").
  function setPhase(c, phase, force) {
    if (!force && c.phase === phase) return;
    c.phase = phase; c.phaseAt = Date.now();
  }
  function liveMeta(c) {
    if (!c.cur || !c.phase) return;
    const secs = Math.round((Date.now() - c.phaseAt) / 1000);
    let text = (c.step ? `Step ${c.step} · ` : "") + c.phase + (secs >= 2 ? ` · ${secs} s` : "") ;
    if (c.phase === "waiting for the model" && secs >= 8) text += " — it is probably busy with another chat";
    c.cur.meta = text + "…";
  }
  function apply(ctx, ev) {
    const t = ev.type;
    if (t === "user") {
      ctx.msgs.push({role: "user", text: ev.text, images: (ev.images || []).map((n) => ({name: n})), time: ev.time * 1000});
      ctx.cur = null;
      return true;
    }
    if (t === "status" && ev.state === "running") { const had = !!ctx.cur; cur(ctx, ev.time); return !had; }
    const m = cur(ctx, ev.time);
    if (t === "delta" || t === "partial") {
      setPhase(ctx, t === "partial" ? "working" : ev.kind === "reasoning" ? "thinking" : "writing the answer");
      const parts = t === "partial" ? [["content", ev.content], ["reasoning", ev.reasoning]] : [[ev.kind, ev.text]];
      for (const [kind, text] of parts) {
        if (!text) continue;
        if (kind === "content") {
          if (ctx.base == null) { m.text += sep(m.text); ctx.base = m.text.length; }
          m.text += text;
        } else {
          if (ctx.rbase == null) { m.reasoning += sep(m.reasoning); ctx.rbase = m.reasoning.length; }
          m.reasoning += text;
        }
      }
    } else if (t === "step") {
      ctx.base = ctx.rbase = null;
      ctx.step = ev.n || ctx.step;
      setPhase(ctx, ev.phase === "compacting" ? "summarising older steps" : "waiting for the model", true);
    } else if (t === "tool_writing") {
      m.tools = m.tools.filter((x) => x.state !== "writing");
      m.tools.push({id: "writing", name: ev.name, tool: ev.name, state: "writing", at: m.text.length, rat: m.reasoning.length});
      setPhase(ctx, "writing " + ev.name);
    } else if (t === "tool_start") {
      const x = m.tools.find((y) => y.id === ev.id);
      if (x) x.state = "running";
      setPhase(ctx, "running " + (ev.name || "a tool"));
    } else if (t === "assistant") {                 // a finished model step replaces its live text
      if (ctx.base != null) m.text = m.text.slice(0, ctx.base);
      else if (ev.content) m.text += sep(m.text);
      m.text += ev.content || "";
      ctx.base = ctx.rbase = null;
      m.tools = m.tools.filter((x) => x.state !== "writing");
      for (const c of ev.tool_calls || []) {
        let args = c.arguments;
        try { args = JSON.parse(c.arguments); } catch (e) { /* keep the raw text */ }
        m.tools.push({id: c.id, name: c.name, tool: c.name, arguments: args, state: "running", at: m.text.length,
                      rat: m.reasoning.length});
      }
      const u = ev.usage || {};
      ctx.steps++; ctx.secs += ev.seconds || 0; ctx.prompt = u.prompt_tokens || ctx.prompt; ctx.out += u.completion_tokens || 0;
      if (ev.finish === "cancelled") m.stopped = true;
    } else if (t === "tool_result") {
      const x = m.tools.find((y) => y.id === ev.id);
      if (x) Object.assign(x, {result: ev.output, ok: ev.ok, chars: ev.chars, truncated: ev.chars > (ev.output || "").length,
                               ms: (ev.seconds || 0) * 1000, state: ev.ok ? "done" : "error"});
    } else if (t === "notice") {
      m.text += sep(m.text) + "> " + ev.text + "\n\n";
    } else if (t === "compacted") {
      m.text += sep(m.text) + "> Older steps were summarised to make room (" + Math.round((ev.before_tokens || 0) / 1000) + "K tokens).\n\n";
    } else if (t === "status") {                     // the run is over
      ctx.phase = null;
      for (const x of m.tools) if (x.state === "running" || x.state === "writing") { x.state = "skipped"; x.ms = null; }
      if (ev.state === "error") m.text += sep(m.text) + "> **The agent stopped with an error:** " + (ev.error || "unknown") + "\n\n";
      if (ev.state === "stopped") m.stopped = true;
      if (ev.state === "interrupted") m.text += sep(m.text) + "> The agent was restarted while working on this.\n\n";
      const ran = m.tools.filter((x) => x.state === "done" || x.state === "error").length;
      m.meta = [ctx.steps ? `${ctx.steps} step${ctx.steps > 1 ? "s" : ""}` : "", ran ? `${ran} tool call${ran > 1 ? "s" : ""}` : "",
                ctx.secs ? `${Math.round(ctx.secs)} s model time` : "", ctx.prompt ? `${Math.round(ctx.prompt / 100) / 10}K context` : "",
                m.stopped ? "stopped" : ""].filter(Boolean).join(" · ");
      ctx.cur = null;
    }
    return false;
  }

  // ------------------------------------------------------------------ painting
  let frame = 0, structural = false, ctx = newCtx();
  function paint() {
    frame = 0;
    const pinned = typeof followsChat === "function" ? followsChat() : true;
    const els = $("chat").querySelectorAll(".st-msg");
    if (structural || els.length !== messages.length) { structural = false; renderChat(); return; }
    const i = messages.length - 1, m = messages[i];
    if (m && m.role === "assistant") updateAssistant(els[i], m, !!follow && ctx.cur === m);
    if (typeof scrollDown === "function") scrollDown(pinned);
  }
  function schedule(struct) { structural = structural || struct; liveMeta(ctx); if (!frame) frame = requestAnimationFrame(paint); }
  setInterval(() => { if (follow && ctx.cur && ctx.phase) schedule(false); }, 1000);

  // ------------------------------------------------------------------ following a session
  function stopFollowing() {
    if (follow) { follow.dead = true; follow.ctrl.abort(); clearTimeout(follow.retry); follow = null; }
    if (busy && busy.builder) { busy = null; setBusy(false); }
  }
  async function attach(sid) {
    stopFollowing();
    const me = {sid, ctrl: new AbortController(), dead: false};
    follow = me;
    let full;
    try { full = await api("GET", "sessions/" + encodeURIComponent(sid)); }
    catch (e) { if (follow === me) follow = null; toast("error", "Builder session unavailable", e.message, 6000); return; }
    if (me.dead) return;
    ctx = newCtx();
    for (const ev of full.events || []) apply(ctx, ev);
    lastSeq = full.events && full.events.length ? full.events[full.events.length - 1].seq : 0;
    messages = ctx.msgs;
    renderChat();
    working = !!full.running;
    if (!full.running) { follow = null; finish(); return; }
    if (ctx.cur && !ctx.phase) setPhase(ctx, "working");
    busy = {builder: true, msg: ctx.cur, controller: {abort: stop}};
    setBusy(true);
    stream(me);
  }
  async function stream(me) {
    try {
      const r = await fetch(`/api/builder/sessions/${encodeURIComponent(me.sid)}/events?after=${lastSeq}`,
                            {signal: me.ctrl.signal, cache: "no-store"});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const line = block.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (ev.type === "ping") continue;
          if (ev.type === "end") { me.ended = true; continue; }
          if (ev.seq) lastSeq = ev.seq;
          if (ev.type === "partial") ctx.base = ctx.rbase = null;
          const s = apply(ctx, ev);
          messages = ctx.msgs;
          if (busy && busy.builder) busy.msg = ctx.cur;
          schedule(s);
        }
      }
    } catch (e) {
      if (me.dead || e.name === "AbortError") return;
    }
    if (me.dead) return;
    if (me.ended) { follow = null; finish(); return; }
    // the connection broke (phone locked, network change): pick it up again while the page is visible
    if (!document.hidden) me.retry = setTimeout(() => { if (follow === me) attach(me.sid); }, 2500);
  }
  function finish() {
    working = false;
    if (busy && busy.builder) { busy = null; setBusy(false); }
    schedule(true);
    saveChat();
  }
  async function stop() {
    if (!meta.session) return;
    try { await api("POST", `sessions/${encodeURIComponent(meta.session)}/stop`, {}); toast("info", "Stopping", "The agent stops after the current step.", 3000); }
    catch (e) { toast("error", "Could not stop", e.message); }
  }

  // ------------------------------------------------------------------ sending
  const plainSend = send;
  send = async function () {
    if (!isBuilder()) return plainSend();
    const text = $("input").value.trim();
    if ((!text && !attachments.length) || busy) return;
    const project = meta.project || $("builder-project").value;
    if (!project || project === "__new") { toast("warn", "Pick a project", "Choose the project folder the agent should work in."); return; }
    const images = attachments.filter((a) => a.kind !== "file").map((a) => ({name: a.name, url: a.url}));
    const full = userText({text, files: attachments.filter((a) => a.kind === "file")});
    $("send-btn").disabled = true;
    try {
      if (!meta.session) {
        const s = await api("POST", "sessions", {project});
        meta = {session: s.id, project: s.project};
        paintProject();
      }
      await api("POST", `sessions/${encodeURIComponent(meta.session)}/messages`, {text: full, images});
    } catch (e) {
      $("send-btn").disabled = false;
      toast("error", "Builder did not take the message", e.message, 6000);
      return;
    }
    attachments = []; renderAttachments();
    $("input").value = ""; autosize();
    await attach(meta.session);
    saveChat();
  };

  // ------------------------------------------------------------------ project picker
  function buildPicker() {
    if ($("builder-project")) return;
    const anchor = $("chat-model") || document.querySelector(".st-composer__bar .spacer");
    if (!anchor) return;
    anchor.insertAdjacentHTML("beforebegin", `<select class="builder-project" id="builder-project" aria-label="Project folder" title="Project folder on the PC (~/Projects)" hidden></select>`);
    document.head.insertAdjacentHTML("beforeend", `<style>
.builder-project{height:32px;max-width:150px;min-width:0;padding:0 8px;border:0;border-radius:8px;background:var(--st-surface-2);color:var(--st-ink);font:500 var(--st-fs-sm)/1 var(--st-font);cursor:pointer;flex-shrink:1;text-overflow:ellipsis}
.builder-project:disabled{opacity:.8;cursor:default}
@media(max-width:640px){.builder-project{max-width:110px;height:34px}}</style>`);
    $("builder-project").onchange = (e) => {
      if (e.target.value !== "__new") { ls.set("dash.builder-project", e.target.value); return; }
      const name = (prompt("New project folder name (in ~/Projects on the PC)") || "").trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
      if (!name) { e.target.value = ls.get("dash.builder-project", "") || ""; return; }
      if (!projects.includes(name)) projects.unshift(name);
      ls.set("dash.builder-project", name);
      paintProject();
    };
  }
  async function loadProjects() {
    try { projects = (await api("GET", "projects")).projects || []; } catch (e) { /* PC asleep: keep the last list */ }
    paintProject();
  }
  function paintProject() {
    buildPicker();
    const sel = $("builder-project"); if (!sel) return;
    sel.hidden = !isBuilder();
    const want = meta.project || ls.get("dash.builder-project", "") || projects[0] || "";
    const names = [...new Set([...(want ? [want] : []), ...projects])];
    const html = (names.length ? "" : `<option value="" disabled selected>Project…</option>`) +
      names.map((p) => `<option value="${esc(p)}">📁 ${esc(p)}</option>`).join("") + `<option value="__new">＋ New project…</option>`;
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    if (want) sel.value = want;
    sel.disabled = !!meta.session;       // a session stays in its project
    const sub = $("chat-empty-sub");
    if (sub && isBuilder() && !messages.length)
      sub.textContent = `Builder works in ~/Projects/${want || "…"} on the PC: it writes files, runs commands and serves apps you can open on your phone.`;
  }

  // ------------------------------------------------------------------ hooks for chats.js / manage.js
  window.dashBuilder = {
    get: () => (meta.session ? {...meta} : null),
    set(b) {                                       // an opened (or new) chat
      stopFollowing();
      meta = b && b.session ? {session: b.session, project: b.project} : {session: null, project: null};
      paintProject();
      if (meta.session) attach(meta.session);
    },
    detach: stopFollowing,
    targetChanged() { paintProject(); if (isBuilder()) loadProjects(); },
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && meta.session && isBuilder() && working && !follow) attach(meta.session);
  });
  buildPicker();
  if (isBuilder()) loadProjects(); else paintProject();
})();
