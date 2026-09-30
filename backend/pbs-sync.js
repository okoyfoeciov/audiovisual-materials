"use strict";

// Daily sync: pulls new PBS NewsHour segments into the library, grouped
// under a "PBS NewsHour" collection by day (see backend/import.js's header
// for how collections nest).
//
//   node backend/pbs-sync.js
//
// The downloads are video files, but the app only ever plays their audio
// track (dictation loops a 1–2 sentence window inside the segment).
//
// PBS NewsHour's own site only syndicates segments as audio
// (https://www.pbs.org/newshour/feeds/rss/podcasts/segments) — no video RSS
// exists. The video versions live on their YouTube channel instead, but
// that channel's upload feed also carries full broadcasts, YouTube Shorts,
// and other unrelated uploads. So: treat the audio RSS as the authoritative
// list of what's really a segment (title + publish date), and only pull
// from YouTube the videos whose title matches an RSS item. Anything in the
// YouTube feed with no RSS match is skipped and logged, not silently
// dropped — see the "skipped" log line below.
//
// Idempotent: each imported entry stores the source YouTube video id as
// sourceId; already-imported videos are skipped on the next run. After
// importing, days older than KEEP_DAYS are deleted (entries + files).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("./db");
const { importMedia, createCollection } = require("./import");

const PBS_SEGMENTS_RSS = "https://www.pbs.org/newshour/feeds/rss/podcasts/segments";
const YOUTUBE_CHANNEL_FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=UC6ZFN9Tx6xh-skXCuRHCDpQ";
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
// so the fastest possible path from first exposure to retirement is 7 days —
// exactly the old value here, which deleted the audio on the very day a flawless
// learner would have finished with it, and a day before anyone who slipped once.
// Failures cost almost nothing (they requeue in 20 minutes, same day); what
// actually stretches the window is practising irregularly, which is the normal
// case. 30 gives roughly 4x margin over that floor.
//
// Retirement is terminal, so the requirement is bounded: a mastered item never
// needs its audio again and is fine to prune. That is why a modest number works
// and no permanent per-session archive is needed. At ~226 MB per day this is
// ~7 GB steady state.
const KEEP_DAYS = 30;
const YT_DLP_FORMAT = "bv*[height<=720]+ba/b[height<=720]";

// yt-dlp resolved as an absolute path, not left to whatever PATH the caller
// happens to have.
//
// This script's whole job is to run unattended from cron, and cron's PATH is
// "/usr/bin:/bin" — which does not include /usr/local/bin, where yt-dlp
// installs by default. execFileSync("yt-dlp", …) therefore threw ENOENT on
// every download while working perfectly by hand. The same class of bug already
// bit the node binary once (the crontab carries an absolute nvm path for
// exactly that reason), so this resolves the path itself rather than leaving
// the next person to rediscover it.
//
// Set YT_DLP to override.
const YT_DLP_CANDIDATES = [
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  "/opt/homebrew/bin/yt-dlp",
  path.join(os.homedir(), ".local/bin/yt-dlp"),
];

function resolveYtDlp() {
  if (process.env.YT_DLP) return process.env.YT_DLP;
  for (const p of YT_DLP_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  // Last resort: let PATH try, so an install somewhere unusual still works.
  return "yt-dlp";
}

const YT_DLP_BIN = resolveYtDlp();

async function fetchText(url) {
  const res = await fetch(url);
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

// PBS's audio segments RSS (RSS 2.0): title + pubDate per <item>, used only
// as the authoritative "this is a real segment" list — the audio itself
// isn't touched.
function parseSegmentsRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = extractTag(block, "title");
    const pubDate = extractTag(block, "pubDate");
    if (title && pubDate) items.push({ title, pubDate });
  }
  return items;
}

// PBS NewsHour's YouTube channel feed (Atom): title + video id + link per
// <entry>. Mixed bag — full episodes, Shorts, segments, unrelated uploads —
// filtered down to real segments by parseSegmentsRss above.
function parseYoutubeFeed(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const title = extractTag(block, "title");
    const videoIdMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const linkMatch = block.match(/<link rel="alternate" href="([^"]+)"/);
    if (title && videoIdMatch) {
      const url = linkMatch ? linkMatch[1] : `https://www.youtube.com/watch?v=${videoIdMatch[1]}`;
      entries.push({ title, videoId: videoIdMatch[1], url });
    }
  }
  return entries;
}

function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Groups by the RSS item's own pubDate (PBS's editorial day), not
// YouTube's upload timestamp, so a segment lands under the broadcast day it
// actually belongs to. Both dateId and title are derived from the same UTC
// calendar day — forcing UTC on the title too (not just dateId's
// toISOString) keeps them from disagreeing when this runs on a machine
// whose local timezone is far from PBS's US Eastern time (late-evening ET
// items land after midnight UTC otherwise).
function dayInfoFromPubDate(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;
  const dateId = d.toISOString().slice(0, 10);
  const title = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return { dateId, title };
}

// Downloads to a fresh temp dir (caller must remove it) and returns the
// path to the single file yt-dlp produced.
function downloadWithYtDlp(url, videoId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-sync-"));
  const outTemplate = path.join(tmpDir, `${videoId}.%(ext)s`);
  execFileSync(YT_DLP_BIN, [
    "-f", YT_DLP_FORMAT,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "-o", outTemplate,
    url,
  ], { stdio: "inherit" });
  const files = fs.readdirSync(tmpDir);
  if (!files.length) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`yt-dlp produced no output file for ${url}`);
  }
  return { dir: tmpDir, filePath: path.join(tmpDir, files[0]) };
}

// Day ids are "<SHOW_ID>-YYYY-MM-DD", which sorts correctly as plain
// strings — no separate stored date field needed.
function pruneOldDays() {
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
  }
}

async function sync({ dryRun = false } = {}) {
  console.log("Fetching PBS segments RSS...");
  const rssItems = parseSegmentsRss(await fetchText(PBS_SEGMENTS_RSS));
  const rssByNormTitle = new Map(rssItems.map((item) => [normalizeTitle(item.title), item]));
  console.log(`  ${rssItems.length} item(s) in the segments RSS.`);

  console.log("Fetching PBS NewsHour YouTube channel feed...");
  const ytEntries = parseYoutubeFeed(await fetchText(YOUTUBE_CHANNEL_FEED));
  console.log(`  ${ytEntries.length} video(s) in the YouTube channel feed.`);

  const matched = [];
  const skipped = [];
  for (const entry of ytEntries) {
    const rssMatch = rssByNormTitle.get(normalizeTitle(entry.title));
    if (rssMatch) matched.push({ ...entry, pubDate: rssMatch.pubDate });
    else skipped.push(entry.title);
  }
  console.log(`  matched ${matched.length} segment(s) against the RSS feed.`);
  if (skipped.length) console.log(`  skipped (no RSS match, likely a full episode/Short/other upload): ${skipped.join(" | ")}`);

  const known = new Set(db.listEntries().map((e) => e.sourceId).filter(Boolean));
  // Import oldest-first so entry creation order follows broadcast time.
  const toImport = matched
    .filter((seg) => !known.has(seg.videoId))
    .sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
  console.log(`  ${matched.length - toImport.length} already imported, ${toImport.length} new.`);

  if (dryRun) {
    for (const seg of toImport) {
      const dayInfo = dayInfoFromPubDate(seg.pubDate);
      console.log(`  would import "${seg.title}" (${seg.url}) -> day ${dayInfo ? dayInfo.dateId : "?"}`);
    }
    console.log("Dry run — nothing downloaded, transcribed, or written to the library.");
    return;
  }

  if (toImport.length && !db.getEntry(SHOW_ID)) {
    await createCollection({ title: SHOW_TITLE, id: SHOW_ID });
    console.log(`Created show entry "${SHOW_ID}".`);
  }

  let failures = 0;
  for (const seg of toImport) {
    const dayInfo = dayInfoFromPubDate(seg.pubDate);
    if (!dayInfo) {
      console.log(`  skipping "${seg.title}" — unparseable pubDate "${seg.pubDate}"`);
      continue;
    }
    const dayId = `${SHOW_ID}-${dayInfo.dateId}`;
    try {
      if (!db.getEntry(dayId)) {
        await createCollection({ title: dayInfo.title, id: dayId, parentId: SHOW_ID });
        console.log(`Created day entry "${dayId}".`);
      }

      console.log(`Downloading "${seg.title}" (${seg.url}) ...`);
      const { dir, filePath } = downloadWithYtDlp(seg.url, seg.videoId);
      try {
        // Verbatim Crisper transcription keeps fillers ("you know", "um") in
        // the reference, which is what the dictation checker scores against.
        const entry = await importMedia({ sourcePath: filePath, type: "movie", title: seg.title, parentId: dayId, verbatim: true });
        db.upsertEntry({ id: entry.id, sourceId: seg.videoId });
        console.log(`Imported "${seg.title}" as "${entry.id}".`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`  failed to import "${seg.title}": ${err.message}`);
      failures++;
    }
  }

  pruneOldDays();

  // A run where every download failed still finished, so it used to exit 0 and
  // look like a success to cron. That is how the yt-dlp PATH bug above stayed
  // invisible: eleven segments failed in a single morning and nothing reported
  // it. Per-segment failures are survivable — one bad video should not abort the
  // run — but they must reach the exit code.
  if (failures) {
    console.error(`${failures} of ${toImport.length} segment(s) failed to import.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  sync({ dryRun: process.argv.includes("--dry-run") }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
