"use strict";

// Plain-JSON metadata store for the media library. No SQLite: avoids
// Electron/native-module ABI rebuild pain, and a personal library is small
// enough that a JSON file is genuinely adequate.

const fs = require("fs");
const paths = require("./paths");

function ensureLibraryDir() {
  fs.mkdirSync(paths.getLibraryDir(), { recursive: true });
}

function load() {
  ensureLibraryDir();
  try {
    return JSON.parse(fs.readFileSync(paths.getDbPath(), "utf8"));
  } catch {
    return { entries: [] };
  }
}

function save(data) {
  ensureLibraryDir();
  const dbPath = paths.getDbPath();
  const tmp = dbPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dbPath);
}

function listEntries() {
  return load().entries;
}

function getEntry(id) {
  return load().entries.find((e) => e.id === id) || null;
}

function listChildren(parentId) {
  return load().entries.filter((e) => e.parentId === parentId);
}

function upsertEntry(entry) {
  const data = load();
  const i = data.entries.findIndex((e) => e.id === entry.id);
  const now = Date.now();
  if (i >= 0) data.entries[i] = { ...data.entries[i], ...entry, updatedAt: now };
  else data.entries.push({ addedAt: now, updatedAt: now, ...entry });
  save(data);
  return getEntry(entry.id);
}

function deleteEntry(id) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  save(data);
  return data.entries.length !== before;
}

module.exports = {
  // A dynamic getter so a setLibraryDir() call (packaged app pointing at
  // <userData>/library) takes effect even though db.js was already required.
  // import.js reads db.LIBRARY_DIR at import time per call, so this stays correct.
  get LIBRARY_DIR() { return paths.getLibraryDir(); },
  listEntries,
  getEntry,
  listChildren,
  upsertEntry,
  deleteEntry,
};
