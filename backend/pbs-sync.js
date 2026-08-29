"use strict";

// Daily sync: pulls new PBS NewsHour segments into the library as
// video, under a "PBS NewsHour" collection grouped by day (see
// backend/import.js's header for how collections nest).
//
//   node backend/pbs-sync.js
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
const KEEP_DAYS = 7;
const YT_DLP_FORMAT = "bv*[height<=720]+ba/b[height<=720]";

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
  execFileSync("yt-dlp", [
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

// importMedia()'s built-in cover-art lookup (backend/poster.js) searches
// iTunes by title, which is built for looking up actual movies/podcasts/
// albums — a news-segment headline like "National parks under strain from
// Trump's..." either finds nothing or, worse, a plausible-looking but
// wrong match (a movie or podcast that happens to share keywords). The
// video's own YouTube thumbnail is always the correct image for it, so
// fetch that directly and overwrite whatever iTunes found (or didn't).
async function downloadYoutubeThumbnail(videoId, destPath) {
  const res = await fetch(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
  if (!res.ok) throw new Error(`thumbnail fetch failed: HTTP ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
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
  // Import order becomes display order (db.listChildren returns entries in
  // insertion order — see server.js), so sort by broadcast time explicitly
  // rather than relying on however the YouTube feed happened to list them.
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
        const entry = await importMedia({ sourcePath: filePath, type: "movie", title: seg.title, parentId: dayId });
        db.upsertEntry({ id: entry.id, sourceId: seg.videoId });
        try {
          await downloadYoutubeThumbnail(seg.videoId, path.join(entry.dir, "poster.jpg"));
        } catch (err) {
          console.error(`  thumbnail fetch failed for "${seg.title}": ${err.message}`);
        }
        console.log(`Imported "${seg.title}" as "${entry.id}".`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`  failed to import "${seg.title}": ${err.message}`);
    }
  }

  pruneOldDays();
}

if (require.main === module) {
  sync({ dryRun: process.argv.includes("--dry-run") }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { sync, normalizeTitle, parseSegmentsRss, parseYoutubeFeed };
