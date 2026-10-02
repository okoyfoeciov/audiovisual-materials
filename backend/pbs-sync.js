"use strict";

// Catch-up sync: pulls new PBS NewsHour segments into the library, grouped
// under a "PBS NewsHour" collection by day.
//
// Called by the embedded backend (backend/server.js) on app launch and every
// few hours while the app runs; also runnable standalone for debugging:
//
//   node backend/pbs-sync.js [--dry-run] [--limit=N]
//
// Source: PBS's own segments RSS. It is the authoritative list of what is a
// real segment (title + publish date) and every item carries a direct audio
// download link (the podcast file). Dictation only ever plays audio, so the
// RSS audio is the whole pipeline — no YouTube, no yt-dlp, no matching
// against a video feed that only carries the last ~15 uploads.
//
// Missing = an RSS item with no library entry under the same normalized
// title (or sourceId). Newest day first, so today's episode lands first and
// older gaps backfill behind it. Broken transcripts (interrupted writes,
// failed jobs) are re-transcribed from their media file in the same pass.
// Days beyond KEEP_DAYS are pruned (entries + files).
//
// Single-flight: a heartbeat lock in the library directory keeps a manual
// CLI run and the app's own check from overlapping.

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const paths = require("./paths");
const { importMedia, createCollection, slugify } = require("./import");
const { transcribeVerbatim } = require("./transcribe");

const PBS_SEGMENTS_RSS = "https://www.pbs.org/newshour/feeds/rss/podcasts/segments";
const SHOW_ID = "pbs-newshour";
const SHOW_TITLE = "PBS NewsHour";

// How many broadcast days of segments to keep before pruning.
//
// This number is coupled to the dictation scheduler — do not lower it without
// reading backend/dictation.js's applyAttemptSchedule. Dictation items are keyed
// to these entries, so pruning a day deletes the sessions cut from it and
// orphans every attempt logged against them.
//
// An item retires after three spaced passes, at SM-2 intervals of 1 then 6 days,
// so the fastest possible path from first exposure to retirement is 7 days.
// Failures requeue in 20 minutes; what actually stretches the window is
// practising irregularly, which is the normal case. 7 keeps the first-run
// backlog small (~15 segments, cents on Azure) at the cost of that margin:
// items still due past day 7 are pruned with their history, so irregular
// practicers re-meet material as unseen instead of as scheduled reviews —
// and a mastered item never needs its audio again, which is why a small
// number works and no permanent archive is needed.
const KEEP_DAYS = 7;

// A run heartbeats the lock before every item; a lock whose owner is gone, or
// that is older than this, belongs to a dead run and can be taken over.
const LOCK_STALE_MS = 15 * 60 * 1000;

const RSS_TIMEOUT_MS = 30 * 1000;
const ENCLOSURE_TIMEOUT_MS = 120 * 1000;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(RSS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  let text = m[1].trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return decodeEntities(text.trim());
}

// PBS's segments RSS (RSS 2.0): title + pubDate + audio enclosure per <item>.
// The enclosure is the segment's own audio, which is all dictation needs.
function parseSegmentsRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = extractTag(block, "title");
    const pubDate = extractTag(block, "pubDate");
    const guid = extractTag(block, "guid") || "";
    const enc = block.match(/<enclosure[^>]*url="([^"]+)"/);
    if (title && pubDate) {
      items.push({
        title,
        pubDate,
        guid,
        enclosure: enc ? decodeEntities(enc[1]) : "",
      });
    }
  }
  return items;
}

function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Groups by the RSS item's own pubDate (PBS's editorial day), not by when we
// fetched it, so a segment lands under the broadcast day it belongs to. Both
// dateId and title are derived from the same UTC calendar day — forcing UTC on
// the title too (not just dateId's toISOString) keeps them from disagreeing on
// a machine whose local timezone is far from PBS's US Eastern time.
function dayInfoFromPubDate(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;
  const dateId = d.toISOString().slice(0, 10);
  const title = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return { dateId, title };
}

// Downloads the segment audio to a fresh temp dir (caller must remove it) and
// returns the path to the file.
async function downloadEnclosure(url, title) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ENCLOSURE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET enclosure -> HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("enclosure returned an HTML page, not audio");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("enclosure came back empty");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-sync-"));
  const filePath = path.join(tmpDir, `${slugify(title)}.mp3`);
  fs.writeFileSync(filePath, buf);
  return { dir: tmpDir, filePath };
}

// Day ids are "<SHOW_ID>-YYYY-MM-DD", which sorts correctly as plain strings —
// no separate stored date field needed. Returns how many days were pruned.
function pruneOldDays() {
  let pruned = 0;
  const days = db.listChildren(SHOW_ID)
    .filter((e) => e.type === "collection")
    .sort((a, b) => b.id.localeCompare(a.id));
  for (const day of days.slice(KEEP_DAYS)) {
    for (const seg of db.listChildren(day.id)) {
      if (seg.dir) fs.rmSync(seg.dir, { recursive: true, force: true });
      db.deleteEntry(seg.id);
    }
    if (day.dir) fs.rmSync(day.dir, { recursive: true, force: true });
    db.deleteEntry(day.id);
    console.log(`Pruned old day "${day.id}" (${day.title}).`);
    pruned++;
  }
  return pruned;
}

// --- single-flight lock -----------------------------------------------------

function lockPath() {
  return path.join(paths.getLibraryDir(), ".pbs-sync.lock");
}

function acquireLock() {
  const p = lockPath();
  try {
    const st = fs.statSync(p);
    const pid = Number(fs.readFileSync(p, "utf8")) || 0;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* owner is gone */ } }
    if (alive && Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
  } catch { /* no lock held */ }
  try { fs.writeFileSync(p, String(process.pid)); } catch { /* unwritable: proceed without */ }
  return true;
}

function heartbeatLock() {
  try {
    const now = new Date();
    fs.utimesSync(lockPath(), now, now);
  } catch { /* lock gone; nothing to keep alive */ }
}

function releaseLock() {
  try {
    if (fs.readFileSync(lockPath(), "utf8") === String(process.pid)) {
      fs.rmSync(lockPath(), { force: true });
    }
  } catch { /* already gone */ }
}

// --- transcript health ------------------------------------------------------

// Ready means the file parses and carries lines. A crash can leave the
// metadata saying "ready" over a zero-filled or truncated file, which is
// exactly what the repair pass is for.
function transcriptIsReadable(entry) {
  if (entry.transcriptStatus !== "ready" || !entry.transcriptPath) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(entry.transcriptPath, "utf8"));
    return Array.isArray(parsed.lines) && parsed.lines.length > 0;
  } catch {
    return false;
  }
}

async function repairEntry(entry) {
  const transcriptPath = entry.transcriptPath || path.join(entry.dir, "transcript.json");
  db.upsertEntry({ id: entry.id, transcriptStatus: "processing", transcriptPath });
  try {
    const transcript = await transcribeVerbatim(entry.filePath, {
      onProgress: (msg) => console.log(`  [repair ${entry.id}] ${msg}`),
    });
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript));
    db.upsertEntry({ id: entry.id, transcriptStatus: "ready", transcriptPath });
  } catch (err) {
    db.upsertEntry({ id: entry.id, transcriptStatus: "error", transcriptPath });
    throw err;
  }
}

async function importOne(item) {
  const dayInfo = dayInfoFromPubDate(item.pubDate);
  if (!dayInfo) throw new Error(`unparseable pubDate "${item.pubDate}"`);
  const dayId = `${SHOW_ID}-${dayInfo.dateId}`;
  if (!db.getEntry(dayId)) {
    await createCollection({ title: dayInfo.title, id: dayId, parentId: SHOW_ID });
    console.log(`Created day entry "${dayId}".`);
  }
  const { dir, filePath } = await downloadEnclosure(item.enclosure, item.title);
  try {
    const entry = await importMedia({ sourcePath: filePath, type: "audio", title: item.title, parentId: dayId });
    db.upsertEntry({ id: entry.id, sourceId: item.guid || item.enclosure });
    console.log(`Imported "${item.title}" as "${entry.id}".`);
    return entry;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// sync()
//
// Returns { locked, missing, repairs, imported, repaired, failed, pruned }.
// onProgress receives { phase, current, total, title } with phases "fetch",
// "importing", "repairing", "prune", "done".
// ---------------------------------------------------------------------------
async function sync({ onProgress = () => {}, dryRun = false, limit = Infinity } = {}) {
  const report = (p) => {
    heartbeatLock();
    try { onProgress(p); } catch { /* a broken listener must not stop the run */ }
  };

  if (!dryRun && !acquireLock()) {
    console.log("pbs-sync: another run is already in progress — skipping.");
    return { locked: true, missing: 0, repairs: 0, imported: 0, repaired: 0, failed: 0, pruned: 0 };
  }

  try {
    report({ phase: "fetch" });
    console.log("Fetching PBS segments RSS...");
    const rss = parseSegmentsRss(await fetchText(PBS_SEGMENTS_RSS));
    console.log(`  ${rss.length} item(s) in the segments RSS.`);

    const known = new Set();
    const titles = new Set();
    const allEntries = db.listEntries();
    for (const e of allEntries) {
      if (e.sourceId) known.add(e.sourceId);
      if (e.type !== "collection") titles.add(normalizeTitle(e.title || ""));
    }

    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    const missing = [];
    for (const it of rss) {
      if (!it.enclosure) continue;
      const when = new Date(it.pubDate).getTime();
      if (isNaN(when) || when < cutoff) continue;   // older than we keep: never refetch
      if (known.has(it.guid) || known.has(it.enclosure) || titles.has(normalizeTitle(it.title))) continue;
      missing.push({ ...it, when });
    }
    missing.sort((a, b) => b.when - a.when);   // newest day first

    const repairs = [];
    for (const e of allEntries) {
      if (e.type === "collection") continue;
      if (transcriptIsReadable(e)) continue;
      if (e.filePath && fs.existsSync(e.filePath)) repairs.push(e);
      else console.warn(`pbs-sync: no media file for "${e.id}" — cannot repair.`);
    }

    console.log(`  ${missing.length} missing, ${repairs.length} to repair.`);

    if (dryRun) {
      for (const it of missing) console.log(`  would import "${it.title}" (${it.pubDate})`);
      for (const e of repairs) console.log(`  would repair "${e.id}"`);
      console.log("Dry run — nothing downloaded, transcribed, or written to the library.");
      return { locked: false, missing: missing.length, repairs: repairs.length, imported: 0, repaired: 0, failed: 0, pruned: 0 };
    }

    if (missing.length && !db.getEntry(SHOW_ID)) {
      await createCollection({ title: SHOW_TITLE, id: SHOW_ID });
      console.log(`Created show entry "${SHOW_ID}".`);
    }

    let imported = 0, repaired = 0, failed = 0;
    const toImport = missing.slice(0, limit);
    for (let i = 0; i < toImport.length; i++) {
      report({ phase: "importing", current: i + 1, total: toImport.length, title: toImport[i].title });
      try {
        await importOne(toImport[i]);
        imported++;
        titles.add(normalizeTitle(toImport[i].title));
      } catch (err) {
        failed++;
        console.error(`  failed to import "${toImport[i].title}": ${err.message}`);
      }
    }

    for (let i = 0; i < repairs.length; i++) {
      report({ phase: "repairing", current: i + 1, total: repairs.length, title: repairs[i].title || repairs[i].id });
      try {
        await repairEntry(repairs[i]);
        repaired++;
        console.log(`Repaired "${repairs[i].id}".`);
      } catch (err) {
        failed++;
        console.error(`  failed to repair "${repairs[i].id}": ${err.message}`);
      }
    }

    report({ phase: "prune" });
    const pruned = pruneOldDays();
    report({ phase: "done", imported, repaired, failed, pruned });
    return { locked: false, missing: missing.length, repairs: repairs.length, imported, repaired, failed, pruned };
  } finally {
    if (!dryRun) releaseLock();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) || Infinity : Infinity;
  sync({ dryRun, limit })
    .then((r) => console.log("sync result:", JSON.stringify(r)))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { sync, KEEP_DAYS };
