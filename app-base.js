// app-base.js — the ONE file here that is not [A]'s. Resolves the base URL of
// this app's own media-library backend: the Express server main.js starts
// embedded in this same app process on loopback, the same shape as comart's
// original app-base.js used for its Go server: one DEFAULT_BASE, one function.
//
// This page has no server of its own, so every apiBase() call site gets that
// prefixed on: the dictation endpoints (/api/dictation/*), the segment stream
// (/api/library/:id/stream), the explanation/pronunciation/credit proxies
// (/api/explain, /api/pron, /api/credits), and the mic transcription proxy
// (/api/transcribe). The renderer no longer talks to comart directly for
// anything — transcription now happens once, server-side, at import time,
// not per playback session.
//
// localStorage is synchronous, so BASE resolves at call time with no async
// race to guard against — still a function, not a captured constant, just for
// parity of shape with comart's original.
//
// UNVERIFIED: comart's app-base.js exists because chrome-extension:// pages are
// exempt from Chrome's Private Network Access checks and a normal origin is
// not — see comart's NOTES.md §1. Whether the shell wrapping this page (Electron
// or otherwise) enforces that same restriction against a loopback host has not
// been tested yet. If apiBase() calls start failing with a network error
// instead of an HTTP error, this is the first thing to check.

(() => {
  "use strict";

  const DEFAULT_BASE = "http://127.0.0.1:8768";

  window.apiBase = () => DEFAULT_BASE;
})();
