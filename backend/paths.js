"use strict";

// Central resolver for where the media library lives on disk.
//
// Dev (`electron .` / `node backend/*` from source): <repo>/library —
// unchanged, so existing checkouts, cron-driven pbs-sync, and CLI imports
// keep working with no env vars.
//
// Packaged app (.deb/.dmg): the asar bundle is read-only and carries no
// library, so main.js sets this to <userData>/library before requiring
// db/dictation/server. AV_LIBRARY_DIR env overrides everything (tests,
// one-off CLI runs against a scratch dir).

const path = require("path");

let overrideDir = process.env.AV_LIBRARY_DIR || null;

function setLibraryDir(dir) {
  overrideDir = dir;
}

function getLibraryDir() {
  if (overrideDir) return overrideDir;
  return path.join(__dirname, "..", "library");
}

function getDbPath() {
  return path.join(getLibraryDir(), "db.json");
}

function getDictationPath() {
  return path.join(getLibraryDir(), "dictation.json");
}

module.exports = {
  setLibraryDir,
  getLibraryDir,
  getDbPath,
  getDictationPath,
};
