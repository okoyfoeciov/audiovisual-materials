"use strict";

// One-off CLI to bring a media file into the library:
//   node backend/import.js <sourcePath> --type=<movie|audio|podcast> --title="<title>"
//
// Copies the source into library/<type>s/<slug>/ (the original is never
// moved or deleted), probes it with ffprobe for duration/video-stream
// presence, registers it in the DB, looks up cover art, then transcribes it
// once via comart's Parakeet-backed pipeline and stores the transcript
// alongside the file.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("./db");
const { transcribe, sha256File } = require("./transcribe");
const { fetchPoster } = require("./poster");

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else out._.push(arg);
  }
  return out;
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args._[0];
  const type = args.type;
  const title = args.title;

  if (!sourcePath || !["movie", "audio", "podcast"].includes(type) || !title) {
    console.error('Usage: node backend/import.js <sourcePath> --type=<movie|audio|podcast> --title="<title>"');
    process.exit(1);
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  const slug = slugify(title);
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
    hasVideo,
    durationSec,
    sha256,
    transcriptStatus: "pending",
    progressSec: 0,
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
    db.upsertEntry({ id: slug, transcriptStatus: "ready", transcriptPath });
    console.log(`Transcript ready: ${transcriptPath}`);
  } catch (err) {
    db.upsertEntry({ id: slug, transcriptStatus: "error" });
    console.error(`Transcription failed: ${err.message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
