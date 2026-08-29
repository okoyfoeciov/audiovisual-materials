"use strict";

// Bring a media file into the library, or create a bare "collection" entry
// to group segments under. Used both as a CLI:
//   node backend/import.js <sourcePath> --type=<movie|audio|podcast> --title="<title>" [--parent=<collectionId>]
//   node backend/import.js --collection --title="<title>" [--id=<slug>] [--parent=<collectionId>]
// ...and as a library by backend/pbs-sync.js, which imports segments
// programmatically instead of one at a time by hand — collections can nest
// (a "day" collection's parentId points at a "show" collection), since
// nothing here or in db.js/server.js assumes only one level.
//
// importMedia() copies the source into library/<type>s/<slug>/ (the
// original is never moved or deleted), probes it with ffprobe for
// duration/video-stream presence, registers it in the DB, looks up cover
// art, then transcribes it once via comart's Parakeet-backed pipeline and
// stores the transcript alongside the file.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("./db");
const { transcribe, sha256File } = require("./transcribe");
const { fetchPoster } = require("./poster");

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

function ffprobe(filePath) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(out.toString("utf8"));
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

  console.log("Probing with ffprobe...");
  const probe = ffprobe(destPath);
  const durationSec = Math.round(parseFloat(probe.format?.duration || "0"));
  const hasVideoStream = (probe.streams || []).some((s) => s.codec_type === "video");
  const hasVideo = type === "movie" && hasVideoStream;

  console.log("Hashing copied file...");
  const sha256 = await sha256File(destPath);

  const entry = db.upsertEntry({
    id: slug,
    type,
    title,
    filename,
    filePath: destPath,
    dir: destDir,
    hasVideo,
    durationSec,
    sha256,
    transcriptStatus: "pending",
    progressSec: 0,
    ...(parentId ? { parentId } : {}),
  });
  console.log(`Registered entry "${entry.id}" (durationSec=${durationSec}, hasVideo=${hasVideo}).`);

  console.log("Looking up cover art...");
  const posterPath = path.join(destDir, "poster.jpg");
  const gotPoster = await fetchPoster(title, type, posterPath);
  console.log(gotPoster ? `Cover art saved: ${posterPath}` : "No cover art found — will use a placeholder.");

  const transcriptPath = path.join(destDir, "transcript.json");
  db.upsertEntry({ id: slug, transcriptStatus: "processing", transcriptPath });

  console.log("Starting transcription (this can take a while for large files)...");
  try {
    const transcript = await transcribe(destPath, {
      sha256,
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

/* ---------- CLI wrapper ---------- */

const USAGE =
  'Usage:\n' +
  '  node backend/import.js <sourcePath> --type=<movie|audio|podcast> --title="<title>" [--parent=<collectionId>]\n' +
  '  node backend/import.js --collection --title="<title>" [--id=<slug>] [--parent=<collectionId>]';

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.collection) {
    if (!args.title) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    try {
      const entry = await createCollection({ title: args.title, id: args.id, parentId: args.parent });
      console.log(`Registered collection "${entry.id}". Drop a poster.jpg into ${entry.dir} for cover art (optional) — automatic lookup is skipped for collections since iTunes/Wikipedia won't have a match.`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
    return;
  }

  const sourcePath = args._[0];
  const type = args.type;
  const title = args.title;
  if (!sourcePath || !["movie", "audio", "podcast"].includes(type) || !title) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    await importMedia({ sourcePath, type, title, parentId: args.parent });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { importMedia, createCollection, slugify };
