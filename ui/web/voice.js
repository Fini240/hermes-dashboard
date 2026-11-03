// Voice mode: talk to Strata from the chat composer. Audio goes straight to the strata-voice server on the PC
// (VAD + whisper.cpp + Strata + Kokoro/Piper); what is said lands in the open chat as normal messages.
// Uses app.js globals: messages, renderChat, saveChat, updateAssistant, scrollDown, apiMessages, busy.
(() => {
  const $ = (id) => document.getElementById(id);
  const ls = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
               set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const VOICES = { af_heart: "Heart (US, female)", af_bella: "Bella (US, female)", am_michael: "Michael (US, male)",
                   am_fenrir: "Fenrir (US, male)", bf_emma: "Emma (UK, female)", bm_george: "George (UK, male)" };
  const pref = () => ({ lang: ls.get("dash.voice.lang", "auto"), voice: ls.get("dash.voice.voice", "af_heart"),
                        speed: +ls.get("dash.voice.speed", "1"), web: ls.get("dash.voice.web", "1") === "1" });
  let voiceUrl = "";

  // ---------- markup: a mic button in the composer, a voice bar that takes the composer's place
  const bar = document.querySelector("#composer .st-composer__bar");
  const send = $("send-btn");
  const mic = document.createElement("button");
  mic.type = "button"; mic.id = "voice-btn"; mic.hidden = true;
  mic.className = "st-btn st-btn--icon"; mic.title = "Talk to Strata"; mic.setAttribute("aria-label", "Talk to Strata");
  mic.innerHTML = `<svg class="st-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/>
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
  bar.insertBefore(mic, $("stop-btn"));

  const vb = document.createElement("div");
  vb.className = "voice-bar"; vb.hidden = true;
  vb.innerHTML = `
    <button type="button" class="voice-orb" id="voice-orb" aria-label="Interrupt"><span></span></button>
    <div class="voice-text"><div class="voice-label" id="voice-label">Connecting…</div>
      <div class="voice-hint" id="voice-hint"></div></div>
    <button type="button" class="st-btn st-btn--icon" id="voice-set" title="Voice settings" aria-label="Voice settings"
      aria-expanded="false"><svg class="st-icon"><use href="web/sprite.svg#i-settings"/></svg></button>
    <button type="button" class="st-btn st-btn--secondary" id="voice-mute">Mute</button>
    <button type="button" class="st-btn st-btn--primary voice-end" id="voice-end">End</button>`;
  $("composer").after(vb);

  const pop = document.createElement("div");
  pop.className = "voice-pop"; pop.hidden = true;
  pop.innerHTML = `
    <label>Language I speak<select id="voice-lang">
      <option value="auto">Auto (English or German)</option><option value="en">English only</option>
      <option value="de">German only</option></select></label>
    <label>English voice<select id="voice-voice"></select></label>
    <label>Speed <span id="voice-speed-val"></span><input type="range" id="voice-speed" min="0.8" max="1.3" step="0.05"></label>
    <label class="voice-check"><input type="checkbox" id="voice-web"> Web search (looks things up when needed)</label>
    <p>German answers always use the Thorsten voice.</p>`;
  vb.appendChild(pop);
  for (const [id, name] of Object.entries(VOICES)) $("voice-voice").add(new Option(name, id));
  const p0 = pref();
  $("voice-lang").value = p0.lang; $("voice-voice").value = p0.voice; $("voice-speed").value = p0.speed;
  $("voice-speed-val").textContent = p0.speed.toFixed(2) + "×";
  $("voice-web").checked = p0.web;
  function pushPrefs() {
    ls.set("dash.voice.lang", $("voice-lang").value); ls.set("dash.voice.voice", $("voice-voice").value);
    ls.set("dash.voice.speed", $("voice-speed").value);
    ls.set("dash.voice.web", $("voice-web").checked ? "1" : "0");
    $("voice-speed-val").textContent = (+$("voice-speed").value).toFixed(2) + "×";
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "config", ...pref() }));
  }
  ["voice-lang", "voice-voice", "voice-web"].forEach((id) => $(id).onchange = pushPrefs);
  $("voice-speed").oninput = pushPrefs;
  function togglePop(on) {
    pop.hidden = !(on ?? pop.hidden);
    $("voice-set").setAttribute("aria-expanded", String(!pop.hidden));
  }
  $("voice-set").onclick = (e) => { e.stopPropagation(); togglePop(); };
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) togglePop(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") togglePop(false); });

  fetch("api/voice", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).then((j) => {
    voiceUrl = (j && j.url) || "";
    mic.hidden = !voiceUrl;
  }).catch(() => {});

  // ---------- state
  let ws, ctx, micStream, worklet, analyser, outGain, wakeLock;
  let live = false, muted = false, state = "idle", chatRef = null;
  let cur = null, curEl = null, sources = new Set(), playHead = 0, micLevel = 0;

  const LABELS = { listening: "Listening", user: "Hearing you", thinking: "Thinking", speaking: "Speaking",
                   searching: "Searching the web" };
  function setState(s, hint) {
    state = s;
    vb.dataset.state = s;
    $("voice-label").textContent = muted ? "Muted" : (LABELS[s] || s);
    $("voice-hint").textContent = hint != null ? hint
      : s === "speaking" ? "Talk to interrupt, or tap the circle" : s === "listening" ? "English or German" : "";
  }

  // ---------- audio (same as the strata-voice page)
  const WORKLET = `
  class Mic extends AudioWorkletProcessor {
    constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.prev = 0;
      this.out = new Int16Array(512); this.n = 0; this.sum = 0; this.cnt = 0; }
    process(inputs) {
      const ch = inputs[0][0]; if (!ch) return true;
      while (this.pos < ch.length) {
        const i = Math.floor(this.pos), f = this.pos - i;
        const a = i === 0 ? this.prev : ch[i - 1], b = ch[i], s = a + (b - a) * f;
        this.out[this.n++] = Math.max(-32768, Math.min(32767, s * 32768));
        this.sum += s * s; this.cnt++;
        if (this.n === 512) {
          this.port.postMessage({ pcm: this.out.buffer, lvl: Math.sqrt(this.sum / this.cnt) }, [this.out.buffer]);
          this.out = new Int16Array(512); this.n = 0; this.sum = 0; this.cnt = 0;
        }
        this.pos += this.ratio;
      }
      this.pos -= ch.length; this.prev = ch[ch.length - 1];
      return true;
    }
  }
  registerProcessor("mic", Mic);`;

  async function startAudio() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await ctx.resume();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    worklet = new AudioWorkletNode(ctx, "mic");
    ctx.createMediaStreamSource(micStream).connect(worklet);
    worklet.port.onmessage = (e) => {
      micLevel = e.data.lvl;
      if (!muted && ws && ws.readyState === 1) ws.send(e.data.pcm);
    };
    outGain = ctx.createGain(); analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    outGain.connect(analyser); analyser.connect(ctx.destination);
    requestAnimationFrame(animate);
  }
  function playPcm(buf) {
    const i16 = new Int16Array(buf), f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
    const src = ctx.createBufferSource(); src.buffer = ab; src.connect(outGain);
    playHead = Math.max(playHead, ctx.currentTime + 0.04);
    src.start(playHead); playHead += ab.duration;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      if (!sources.size && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "played" }));
    };
  }
  function stopPlayback() {
    for (const s of sources) { s.onended = null; try { s.stop(); } catch {} }
    sources.clear(); playHead = 0;
  }
  const tbuf = new Uint8Array(512);
  function animate() {
    if (!ctx) return;
    let lvl = 0;
    if (state === "speaking" && sources.size) {
      analyser.getByteTimeDomainData(tbuf);
      let s = 0; for (const v of tbuf) s += (v - 128) ** 2; lvl = Math.sqrt(s / tbuf.length) / 128;
    } else if (!muted) lvl = micLevel;
    vb.style.setProperty("--lvl", (1 + Math.min(1, lvl * 6) * 0.45).toFixed(3));
    requestAnimationFrame(animate);
  }


  function toolArg(x) {          // the search words or the page a tool call is about (arguments: object or JSON text)
    let a = x.arguments;
    if (typeof a === "string") {
      try { a = JSON.parse(a); }
      catch { const q = a.match(/["'](?:query|url)["']\s*:\s*["']([^"']+)/); return q ? q[1] : ""; }
    }
    const v = (a && (a.query || a.url)) || "";
    return v.startsWith("ref://") ? "a search result" : v;
  }

  // ---------- chat: what is said becomes normal chat messages
  function chatHistory() {
    try {
      return apiMessages().filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
                                         && !m.tool_calls);
    } catch { return []; }
  }
  function sameChat() {
    if (messages === chatRef) return true;
    stop("The chat changed, voice ended.");      // another chat was opened: do not write into it
    return false;
  }
  function finish(meta) {
    if (!cur) return;
    if (meta) cur.meta = meta;
    updateAssistant(curEl, cur, false);
    saveChat();
    cur = curEl = null;
  }

  function onMessage(e) {
    if (typeof e.data !== "string") { if (live) playPcm(e.data); return; }
    const m = JSON.parse(e.data);
    if (m.type === "state") setState(m.state);
    else if (m.type === "greeting") cur = curEl = null;          // the hello is spoken, not written into the chat
    else if (m.type === "user") {
      if (!sameChat()) return;
      finish();
      messages.push({ role: "user", text: m.text, images: [], files: [], time: Date.now(), voice: true });
      cur = { role: "assistant", text: "", reasoning: "", time: Date.now(), meta: "Voice", voice: true };
      messages.push(cur);
      renderChat();
      curEl = $("chat").lastElementChild;
      updateAssistant(curEl, cur, true);
    }
    else if (m.type === "delta" && cur) {
      if (!sameChat()) return;
      cur.text += m.text;
      updateAssistant(curEl, cur, true);
      scrollDown();
    }
    else if (m.type === "first_audio" && cur) cur.meta = `Voice · answered in ${(m.ms / 1000).toFixed(1)} s`;
    else if (m.type === "interrupt") {
      stopPlayback();
      if (cur) { cur.text = cur.text.trim() + " …"; finish("Voice · interrupted"); }
    }
    else if (m.type === "done") finish();
    else if (m.type === "tool") {
      const x = m.data;
      if (x.event === "call") {
        $("voice-hint").textContent = (x.tool === "search" ? "Searching: " : "Reading: ") + (toolArg(x) || x.tool);
      }
      if (cur && typeof onTool === "function" && sameChat()) {   // same tool blocks as a typed chat
        try { onTool(cur, x); updateAssistant(curEl, cur, true); } catch {}
      }
    }
    else if (m.type === "error") {
      const off = /Strata HTTP|Connect|refused|ClientConnector/i.test(m.text);
      setState("listening", off ? "Strata isn't running. Switch the engine under Manage." : m.text);
      if (cur) { cur.error = m.text; finish(); }
    }
  }

  function connect() {
    ws = new WebSocket(voiceUrl.replace(/^http/, "ws") + "/ws");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", history: chatHistory(), ...pref() }));
      setState("thinking", "Connecting to Strata…");
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      if (!live) return;
      setState("thinking", "Reconnecting…");
      setTimeout(() => live && connect(), 1200);
    };
  }

  // ---------- start / stop
  async function start() {
    if (busy) return;
    if (!window.isSecureContext) {
      alert("The microphone only works when the dashboard is opened over https:// (its Tailscale address).");
      return;
    }
    vb.hidden = false; $("composer").hidden = true;
    setState("thinking", "Asking for the microphone…");
    try { await startAudio(); }
    catch (err) { stop("Microphone blocked: " + err.message); return; }
    live = true; muted = false; chatRef = messages;
    $("voice-mute").textContent = "Mute"; $("voice-mute").classList.remove("on");
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
    connect();
  }
  function stop(note) {
    live = false;
    stopPlayback();
    if (cur) finish(cur.text ? "Voice · ended" : undefined);
    try { ws && ws.close(); } catch {}
    ws = null;
    micStream?.getTracks().forEach((t) => t.stop());
    try { ctx?.close(); } catch {}
    ctx = null;
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
    vb.hidden = true; $("composer").hidden = false; togglePop(false);
    if (note) $("composer-hint").textContent = note;
  }

  mic.onclick = () => start();
  $("voice-end").onclick = () => stop();
  $("voice-mute").onclick = () => {
    muted = !muted;
    $("voice-mute").textContent = muted ? "Unmute" : "Mute";
    $("voice-mute").classList.toggle("on", muted);
    setState(state);
  };
  $("voice-orb").onclick = () => {
    if (live && ws && ws.readyState === 1 && (state === "speaking" || state === "thinking"))
      ws.send(JSON.stringify({ type: "stop" }));
  };
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && live) {
      try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
      ctx?.resume();
    }
  });
  window.dashVoiceStop = stop;
})();
