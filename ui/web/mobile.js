// Keep the composer inside the visible phone viewport, including Safari's keyboard.
// Desktop layout and browser pinch zoom stay under the browser's control.
(() => {
  "use strict";
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const chat = document.getElementById("chat-scroll");
  const input = document.getElementById("input");
  let frame = 0, pinned = true, resizing = false, resizeEnd = 0;
  // Following is a reader's choice. A larger viewport can bring the bottom
  // within the threshold without the reader actually scrolling there.
  window.dashChatPinned = () => root.hasAttribute("data-mobile-viewport") ? pinned : nearBottom();
  window.dashChatPin = () => { pinned = true; };
  chat.addEventListener("scroll", () => {
    if (!resizing) pinned = nearBottom();
  }, {passive: true});

  function update() {
    frame = 0;
    const mobile = innerWidth <= 900 || matchMedia("(pointer: coarse)").matches;
    if (!mobile) {
      root.removeAttribute("data-mobile-viewport");
      root.style.removeProperty("--dash-viewport-height");
      root.style.removeProperty("--dash-viewport-top");
      resizing = false;
      return;
    }
    if (viewport && Math.abs(viewport.scale - 1) > 0.05) { resizing = false; return; }
    const follow = pinned;
    root.setAttribute("data-mobile-viewport", "");
    root.style.setProperty("--dash-viewport-height", `${viewport?.height || innerHeight}px`);
    root.style.setProperty("--dash-viewport-top", `${viewport?.offsetTop || 0}px`);
    autosize();
    if (follow) scrollDown(true);
    // Layout-induced scroll events arrive after the resize frame.
    cancelAnimationFrame(resizeEnd);
    resizeEnd = requestAnimationFrame(() => { resizing = false; });
  }
  function schedule() { resizing = true; if (!frame) frame = requestAnimationFrame(update); }
  window.addEventListener("resize", schedule);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  input.addEventListener("focus", schedule);
  input.addEventListener("blur", schedule);

  // Tapping Send or Stop must not blur the editor and collapse the phone keyboard.
  let handledTouch = false, resetTouch;
  document.addEventListener("pointerdown", () => { handledTouch = false; }, true);
  document.addEventListener("keydown", () => { handledTouch = false; }, true);
  document.addEventListener("click", (e) => {
    if (e.isTrusted && handledTouch) {
      handledTouch = false;
      e.preventDefault();
      // After Send swaps to Stop, Chromium can target that replacement.
      e.stopImmediatePropagation();
    }
  }, true);
  for (const id of ["send-btn", "stop-btn"]) {
    const button = document.getElementById(id);
    let touchPointer = null;
    button.addEventListener("pointerdown", (e) => {
      handledTouch = false;
      touchPointer = e.pointerType === "touch" && document.activeElement === input ? e.pointerId : null;
      if (touchPointer !== null) e.preventDefault();
    });
    button.addEventListener("pointercancel", () => { touchPointer = null; });
    button.addEventListener("pointerup", (e) => {
      if (e.pointerId !== touchPointer) return;
      touchPointer = null;
      e.preventDefault();
      // WebKit suppresses the native click after a cancelled pointerdown.
      // Activate explicitly, and consume Chromium's following native click.
      handledTouch = true;
      clearTimeout(resetTouch);
      resetTouch = setTimeout(() => { handledTouch = false; }, 500);
      button.click();
    });
  }
  update();
})();
