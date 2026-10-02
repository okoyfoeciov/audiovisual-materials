"use strict";

// Bring a media file into the library, or create a bare "collection" entry
// to group segments under. Used as a library by backend/pbs-sync.js, which
// imports segments programmatically — collections can nest (a "day"
// collection's parentId points at a "show" collection), since nothing here
// or in db.js/server.js assumes only one level.
//
// importMedia() copies the source into library/<type>s/<slug>/ (the
// original is never moved or deleted), registers it in the DB, then
// transcribes it once — verbatim via llm-service (see backend/transcribe.js)
// — and stores the transcript alongside the file.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { transcribeVerbatim } = require("./transcribe");

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

// A bare "collection" entry — no media file of its own, just a title, to
// group segments (or nested collections) imported separately with a
// matching parentId.
async function createCollection({ title, id, parentId } = {}) {
  if (!title) throw new Error("createCollection: title is required");
  if (parentId && !db.getEntry(parentId)) {
    throw new Error(`Parent entry "${parentId}" not found — create it first.`);
  }
  const slug = id || slugify(title);
  const destDir = path.join(db.LIBRARY_DIR, "collections", slug);
  fs.mkdirSync(destDir, { recursive: true });
  return db.upsertEntry({
    id: slug,
    type: "collection",
    title,
    dir: destDir,
    ...(parentId ? { parentId } : {}),
  });
}

async function importMedia({ sourcePath, type, title, id, parentId } = {}) {
  if (!sourcePath || !["movie", "audio", "podcast"].includes(type) || !title) {
    throw new Error("importMedia requires sourcePath, type (movie|audio|podcast), and title");
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  if (parentId && !db.getEntry(parentId)) {
    throw new Error(`Parent entry "${parentId}" not found — create it first.`);
  }

  const slug = id || slugify(title);
  const destDir = path.join(db.LIBRARY_DIR, `${type}s`, slug);
  fs.mkdirSync(destDir, { recursive: true });

  const filename = path.basename(sourcePath);
  const destPath = path.join(destDir, filename);

  console.log(`Copying "${filename}" into ${destPath} ...`);
  fs.copyFileSync(sourcePath, destPath);

  const entry = db.upsertEntry({
    id: slug,
    type,
    title,
    filePath: destPath,
    dir: destDir,
    transcriptStatus: "pending",
    ...(parentId ? { parentId } : {}),
  });
  console.log(`Registered entry "${entry.id}".`);

  const transcriptPath = path.join(destDir, "transcript.json");
  db.upsertEntry({ id: slug, transcriptStatus: "processing", transcriptPath });

  console.log("Starting transcription (llm-service verbatim — single-shot, up to ~2 h)...");
  try {
    const transcript = await transcribeVerbatim(destPath, {
      onProgress: (msg) => console.log(`  [transcribe] ${msg}`),
    });
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript));
    console.log(`Transcript ready: ${transcriptPath}`);
    return db.upsertEntry({ id: slug, transcriptStatus: "ready", transcriptPath });
  } catch (err) {
    db.upsertEntry({ id: slug, transcriptStatus: "error" });
    throw new Error(`Transcription failed for "${title}": ${err.message}`);
  }
}

module.exports = { importMedia, createCollection, slugify };
