"use strict";

// Plain-JSON metadata store for the media library. No SQLite: avoids
// Electron/native-module ABI rebuild pain, and a personal library is small
// enough that a JSON file is genuinely adequate.

const fs = require("fs");
const path = require("path");

const LIBRARY_DIR = path.join(__dirname, "..", "library");
const DB_PATH = path.join(LIBRARY_DIR, "db.json");

function ensureLibraryDir() {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
}

function load() {
  ensureLibraryDir();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function save(data) {
  ensureLibraryDir();
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
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

function getProgress(id) {
  const entry = getEntry(id);
  return entry ? entry.progressSec || 0 : 0;
}

function setProgress(id, positionSec) {
  const data = load();
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) return false;
  entry.progressSec = positionSec;
  entry.updatedAt = Date.now();
  save(data);
  return true;
}

function setTranscriptStatus(id, status) {
  const data = load();
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) return false;
  entry.transcriptStatus = status;
  entry.updatedAt = Date.now();
  save(data);
  return true;
}

function deleteEntry(id) {
  const data = load();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  save(data);
  return data.entries.length !== before;
}

module.exports = {
  LIBRARY_DIR,
  DB_PATH,
  listEntries,
  getEntry,
  listChildren,
  upsertEntry,
  deleteEntry,
  getProgress,
  setProgress,
  setTranscriptStatus,
};
