// app-base.js — the ONE file here that is not [A]'s. Resolves the base URL of
// this app's own local media-library backend (a Node/Express server, exposed
// on the tailnet via `tailscale serve`), the same shape as comart's original
// app-base.js used for its Go server: one DEFAULT_BASE, one localStorage
// override, one function.
//
// This page has no server of its own, so every one of app-listen.js's
// apiBase() call sites gets that prefixed on: the library endpoints
// (/api/library/*) plus the three surviving explain-panel endpoints
// (/api/explain, /api/pron, /api/credits). The renderer no longer talks to
// comart directly for anything — transcription now happens once, server-side,
// at import time, not per playback session.
//
// localStorage is synchronous, so BASE resolves at call time with no async
// race to guard against — still a function, not a captured constant, just for
// parity of shape with comart's original. Nothing writes the "media-base" key
// today; set it from this page's devtools console to point at a non-default
// backend (e.g. http://127.0.0.1:8768 when developing directly on the NUC).
//
// UNVERIFIED: comart's app-base.js exists because chrome-extension:// pages are
// exempt from Chrome's Private Network Access checks and a normal origin is
// not — see comart's NOTES.md §1. Whether the shell wrapping this page (Electron
// or otherwise) enforces that same restriction against the tailnet host has not
// been tested yet. If apiBase() calls start failing with a network error
// instead of an HTTP error, this is the first thing to check.

(() => {
  "use strict";

  const DEFAULT_BASE = "https://nuc-15-pro.taile4fb34.ts.net/av-materials";

  window.apiBase = () => {
    let override = null;
    try { override = localStorage.getItem("media-base"); } catch {}
    return override ? override.replace(/\/$/, "") : DEFAULT_BASE;
  };
})();
