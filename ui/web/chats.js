// Chat history for the dashboard's copy of Strata's page: a list of conversations kept on the dashboard server
// (/api/chats), so the Mac and the phone see the same chats. Loaded AFTER app.js and works through app.js'
// own globals: `messages` (the open chat), saveChat() and renderChat(), and `busy` (an answer is streaming).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const icon = (n, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="web/sprite.svg#i-${n}"/></svg>`;
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
               set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const when = (t) => {
    const d = new Date(t * 1000), now = new Date(), s = (now - d) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    if (s < 6 * 86400) return d.toLocaleDateString([], {weekday: "short"});
    return d.toLocaleDateString([], {day: "numeric", month: "short"});
  };
  const group = (t) => {
    const s = (Date.now() / 1000 - t) / 86400, d = new Date(t * 1000);
    if (d.toDateString() === new Date().toDateString()) return "Today";
    if (s < 2) return "Yesterday"; if (s < 7) return "Previous 7 days"; if (s < 30) return "Previous 30 days";
    return "Older";
  };

  let current = ls.get("dash.chat-id", ""), list = [], offline = false, syncTimer = null, filter = "";

  async function api(method, path, body) {
    const r = await fetch(path, {method, headers: {"Content-Type": "application/json"}, body: body ? JSON.stringify(body) : undefined});
    if (r.status === 403) { offline = true; throw new Error("tailnet only"); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function refresh() {
    try { list = await api("GET", "/api/chats"); offline = false; } catch (e) { /* keep the last list */ }
    paintList();
  }

  // ---------------------------------------------------------------- layout
  function build() {
    const view = $("view-chat");
    const main = document.createElement("div");
    main.className = "chat-main";
    while (view.firstChild) main.appendChild(view.firstChild);
    main.insertAdjacentHTML("afterbegin", `<div class="chat-topbar">
      <button class="st-btn st-btn--icon" id="side-open" aria-label="Chats">${icon("activity")}</button>
      <span class="chat-topbar__title" id="chat-title">New chat</span>
      <button class="st-btn st-btn--icon" id="top-new" aria-label="New chat">${icon("new-chat")}</button></div>`);
    view.insertAdjacentHTML("afterbegin", `<aside class="chat-side" id="chat-side" aria-label="Chats">
      <div class="chat-side__head">
        <button class="st-btn st-btn--secondary chat-side__new" id="side-new">${icon("new-chat", "st-icon st-icon--sm")}New chat</button>
        <button class="st-btn st-btn--icon chat-side__close" id="side-close" aria-label="Close">${icon("chevron")}</button></div>
      <input class="st-input chat-side__search" id="side-search" type="search" placeholder="Search chats" autocomplete="off">
      <nav class="chat-side__list" id="side-list"></nav>
      <p class="muted small chat-side__foot" id="side-foot"></p></aside>
      <div class="chat-scrim" id="chat-scrim" hidden></div>`);
    view.appendChild(main);
    // the menu glyph: three lines (the sprite has no hamburger)
    $("side-open").innerHTML = `<svg class="st-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

    $("side-new").onclick = $("top-new").onclick = () => newChat();
    $("side-open").onclick = () => openSide(true);
    $("side-close").onclick = $("chat-scrim").onclick = () => openSide(false);
    $("side-search").oninput = (e) => { filter = e.target.value.trim().toLowerCase(); paintList(); };
    // Strata's own "new chat" button clears the one chat it has; here it starts a new one and keeps the old.
    const nb = $("new-btn"); if (nb) nb.onclick = () => newChat();
  }
  function openSide(on) {
    document.body.classList.toggle("side-open", on);
    $("chat-scrim").hidden = !on;
  }

  function paintList() {
    const nav = $("side-list"); if (!nav) return;
    if (offline) { nav.innerHTML = `<p class="muted small" style="padding:8px">Chat history is only available from a Tailscale device.</p>`; return; }
    const items = list.filter((c) => !filter || (c.title || "").toLowerCase().includes(filter));
    let h = "", last = "";
    for (const c of items) {
      const g = group(c.updated);
      if (g !== last) { h += `<div class="chat-side__group">${g}</div>`; last = g; }
      h += `<div class="chat-item${c.id === current ? " on" : ""}" data-id="${esc(c.id)}">
        <button class="chat-item__open" data-open="${esc(c.id)}"><span class="chat-item__title">${esc(c.title)}</span>
          <span class="chat-item__meta">${c.target === "agent" ? "Agent · " : c.target === "builder" ? `Builder${c.project ? " · " + esc(c.project) : ""} · ` : ""}${when(c.updated)}</span></button>
        <button class="st-btn st-btn--icon chat-item__act" data-rename="${esc(c.id)}" aria-label="Rename" title="Rename">
          <svg class="st-icon st-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button class="st-btn st-btn--icon chat-item__act" data-del="${esc(c.id)}" aria-label="Delete" title="Delete">${icon("trash", "st-icon st-icon--sm")}</button></div>`;
    }
    nav.innerHTML = h || `<p class="muted small" style="padding:8px">${filter ? "No chat matches." : "No chats yet."}</p>`;
    for (const b of nav.querySelectorAll("[data-open]")) b.onclick = () => openChat(b.dataset.open);
    for (const b of nav.querySelectorAll("[data-rename]")) b.onclick = () => rename(b.dataset.rename);
    for (const b of nav.querySelectorAll("[data-del]")) b.onclick = () => remove(b.dataset.del);
    $("side-foot").textContent = list.length ? `${list.length} chat${list.length > 1 ? "s" : ""} · kept on the dashboard, shared by your devices` : "";
    const cur = list.find((c) => c.id === current);
    $("chat-title").textContent = cur ? cur.title : "New chat";
    document.title = cur ? `${cur.title} · ${document.querySelector(".st-header__brand").textContent}` : document.querySelector(".st-header__brand").textContent;
  }

  // ---------------------------------------------------------------- open / new / rename / delete
  function stillBusy() {
    // a Builder run lives on the PC: leaving the chat only stops watching it
    if (typeof busy !== "undefined" && busy && busy.builder && window.dashBuilder) { window.dashBuilder.detach(); return false; }
    if (typeof busy !== "undefined" && busy) { toast("warn", "Still writing", "Stop the answer first."); return true; }
    return false;
  }
  function restore(c) {       // who an opened chat talked to, and its Builder session
    if (c.target && window.dashSetTarget) window.dashSetTarget(c.target);
    if (c.model && window.dashSetModel) window.dashSetModel(c.model);
    if (window.dashBuilder) window.dashBuilder.set(c.target === "builder" ? c.builder : null);
  }
  function show(msgs, id) {
    current = id; ls.set("dash.chat-id", id);
    messages = msgs;          // app.js' open chat
    origSave();               // its own localStorage copy, so a reload shows the same chat at once
    renderChat();
    paintList();
  }
  async function openChat(id) {
    if (stillBusy()) return;
    openSide(false);
    if (id === current) return;
    try {
      const c = await api("GET", `/api/chats/${encodeURIComponent(id)}`);
      show(c.messages || [], id);
      restore(c);
    } catch (e) { toast("error", "Could not open that chat", e.message); }
  }
  function newChat() {
    if (stillBusy()) return;
    openSide(false);
    if (window.dashBuilder) window.dashBuilder.set(null);
    show([], newId());       // saved on its first message, so empty chats never pile up
    focusInput();
  }
  window.dashNewChat = newChat;
  async function rename(id) {
    const c = list.find((x) => x.id === id);
    const t = prompt("Rename chat", c ? c.title : "");
    if (!t || !t.trim()) return;
    try { await api("PUT", `/api/chats/${encodeURIComponent(id)}`, {title: t.trim()}); await refresh(); }
    catch (e) { toast("error", "Rename failed", e.message); }
  }
  async function remove(id) {
    const c = list.find((x) => x.id === id);
    if (!confirm(`Delete "${c ? c.title : "this chat"}"?`)) return;
    try {
      await api("DELETE", `/api/chats/${encodeURIComponent(id)}`);
      if (id === current) { if (window.dashBuilder) window.dashBuilder.set(null); show([], newId()); }
      await refresh();
    } catch (e) { toast("error", "Delete failed", e.message); }
  }

  // ---------------------------------------------------------------- saving
  // app.js calls saveChat() after every answer (and on new / undo); each call now also goes to the server.
  const origSave = saveChat;
  saveChat = function () {
    origSave();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 600);
  };
  // A chat's title. The server takes the first question as it is, and a voice chat's first "question" is often a
  // greeting or a misheard fragment ("oins.", "Fine."). The title comes from the first question with a few words
  // instead, cut at a word boundary near 40 characters.
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const userTexts = (msgs) => msgs.filter((m) => m.role === "user" && clean(m.text)).map((m) => clean(m.text));
  function autoTitle(msgs) {
    const texts = userTexts(msgs);
    const t = texts.find((x) => x.split(" ").length >= 3 && x.length >= 12) || "";
    if (!t) return "";
    if (t.length <= 40) return t;
    const cut = t.slice(0, 41), sp = cut.lastIndexOf(" ");
    return (sp > 20 ? cut.slice(0, sp) : cut.slice(0, 40)).replace(/[\s,.;:–-]+$/, "") + "…";
  }
  // the title the server made on its own (chat_put): renamed titles never look like this, so only these are improved
  function serverTitle(msgs) {
    const first = userTexts(msgs)[0] || "";
    return first.slice(0, 60) + (first.length > 60 ? "…" : "");
  }
  function betterTitle(msgs) {
    const want = autoTitle(msgs);
    if (!want) return "";
    const entry = list.find((c) => c.id === current);
    if (!entry) return want;                                    // a new chat: name it well from the start
    return entry.title === serverTitle(msgs) && entry.title !== want ? want : "";
  }
  async function sync() {
    if (offline || !messages.length) return;
    if (!current) { current = newId(); ls.set("dash.chat-id", current); }
    const strip = messages.map((m) => ({...m, images: (m.images || []).map((i) => ({name: i.name})),
                                         files: (m.files || []).map((f) => ({name: f.name}))}));
    try {
      const body = {messages: strip, target: ls.get("dash.chat-target", "model"), model: window.dashGetModel ? window.dashGetModel() : "",
                    builder: window.dashBuilder ? window.dashBuilder.get() : null};
      const title = betterTitle(messages);
      if (title) body.title = title;
      await api("PUT", `/api/chats/${encodeURIComponent(current)}`, body);
      await refresh();
    } catch (e) { /* offline: the browser copy still has it */ }
  }

  // ---------------------------------------------------------------- start
  async function start() {
    build();
    await refresh();
    if (offline) return;
    if (current && list.some((c) => c.id === current)) {
      const c = await api("GET", `/api/chats/${encodeURIComponent(current)}`).catch(() => null);
      if (c) {
        messages = c.messages || []; origSave(); renderChat(); paintList();
        restore(c);
        return;
      }
    }
    // The chat Strata's page had in this browser before the history existed becomes the first entry.
    if (messages.length) { current = newId(); ls.set("dash.chat-id", current); await sync(); return; }
    if (!current) { current = newId(); ls.set("dash.chat-id", current); }
  }
  start();
  // another device may have added a chat: refresh the list when this tab comes back into view
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
