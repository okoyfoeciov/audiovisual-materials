// titlebar.js — Electron-shell-only, like main.js/preload.js. Wires up the
// custom title bar in app.html for Linux/Windows/macOS (main.js goes
// frame:false on all platforms and exposes window.electronWindow via
// preload.js). Previously macOS used a native hiddenInset bar and never ran
// this branch; per feedback it now uses the same custom right-side bar as
// Linux, so the branch runs on darwin too (we still tag the root for any
// future darwin-only tweaks).

(() => {
  "use strict";

  const api = window.electronWindow;
  if (!api) return;
  if (api.platform === "darwin") {
    document.documentElement.classList.add("is-darwin");
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
