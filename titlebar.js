// titlebar.js — Electron-shell-only, like main.js/preload.js. Wires up the
// custom title bar in app.html for Linux/Windows (main.js goes frame:false
// there and exposes window.electronWindow via preload.js). macOS instead uses
// a native hiddenInset title bar with real traffic lights and never runs the
// branch below, so the bar stays hidden and nothing here fires.

(() => {
  "use strict";

  const api = window.electronWindow;
  if (!api) return;
  if (api.platform === "darwin") {
    document.documentElement.classList.add("is-darwin");
    return;
  }

  const bar = document.getElementById("electron-titlebar");
  const maxBtn = document.getElementById("electron-titlebar-max");
  if (!bar || !maxBtn) return;

  bar.hidden = false;

  document.getElementById("electron-titlebar-min").addEventListener("click", () => api.minimize());
  maxBtn.addEventListener("click", () => api.toggleMaximize());
  document.getElementById("electron-titlebar-close").addEventListener("click", () => api.close());

  // Double-clicking the drag region is the native title-bar convention for
  // toggling maximize; frameless windows don't get it for free.
  bar.addEventListener("dblclick", (event) => {
    if (event.target.closest(".electron-titlebar-controls")) return;
    api.toggleMaximize();
  });

  const setMaximized = (isMaximized) => maxBtn.classList.toggle("is-maximized", isMaximized);
  api.isMaximized().then(setMaximized);
  api.onMaximizedChange(setMaximized);

  // F11 fullscreen is native OS chrome; this bar is just a <div> in the page
  // that has no idea it happened. Window controls (minimize included) are
  // meaningless with no window to see, so hide the whole bar for the duration.
  api.onFullscreenChange((isFullScreen) => { bar.hidden = isFullScreen; });
})();
