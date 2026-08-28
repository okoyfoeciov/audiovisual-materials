// app-base.js — the ONE file here that is not [A]'s. Adapted from comart's
// (chrome-extension) app-base.js for a standalone page: same DEFAULT_BASE,
// same comartAPI() contract, chrome.storage.local swapped for localStorage.
//
// [A] IS ITS OWN SERVER, so every request it makes is same-origin and written
// as a bare path: fetch("/api/explain"). This page has no server of its own,
// so each of app-listen.js's twelve comartAPI() call sites gets that prefixed
// on — the same Go server on the tailnet comart's extension talks to.
//
// comart's version had to resolve BASE at call time because chrome.storage is
// async and would otherwise lose a race against its own boot-time fetches.
// localStorage is synchronous, so that whole mechanism collapses to a plain
// read — still a function, not a captured constant, just for parity of shape.
// Nothing writes the "comart-base" key today; set it from this page's devtools
// console to point at a non-default backend.
//
// UNVERIFIED: comart's app-base.js exists because chrome-extension:// pages are
// exempt from Chrome's Private Network Access checks and a normal origin is
// not — see comart's NOTES.md §1. Whether the shell wrapping this page (Electron
// or otherwise) enforces that same restriction against the tailnet host has not
// been tested yet. If comartAPI() calls start failing with a network error
// instead of an HTTP error, this is the first thing to check.

(() => {
  "use strict";

  const DEFAULT_BASE = "https://nuc-15-pro.taile4fb34.ts.net/comart";

  window.comartAPI = () => {
    let override = null;
    try { override = localStorage.getItem("comart-base"); } catch {}
    return override ? override.replace(/\/$/, "") : DEFAULT_BASE;
  };
})();
