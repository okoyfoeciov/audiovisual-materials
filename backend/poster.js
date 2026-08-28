"use strict";

// Cover art via the iTunes Search API — free, no key, no signup. Covers
// movies, music and podcasts reasonably well; misses are expected for
// obscure titles or personal recordings, and callers should treat a null
// result as normal, not an error (the frontend falls back to a placeholder
// card).

const fs = require("fs");

const MEDIA_BY_TYPE = { movie: "movie", podcast: "podcast", audio: "music" };

// iTunes artwork URLs end in e.g. "100x100bb.jpg" — bump that to a poster-
// sized image. Not all results honor arbitrary sizes, but this is the
// documented convention and degrades gracefully (iTunes just serves its
// closest size) if a given asset doesn't have one that large.
function upsizeArtwork(url) {
  return url.replace(/\d+x\d+bb\.(jpg|png)$/, "600x900bb.$1");
}

async function findItunesPosterUrl(title, type) {
  const media = MEDIA_BY_TYPE[type] || "music";
  const url = `https://itunes.apple.com/search?media=${media}&limit=1&term=${encodeURIComponent(title)}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }
  const hit = data.results && data.results[0];
  const art = hit && (hit.artworkUrl100 || hit.artworkUrl60);
  return art ? upsizeArtwork(art) : null;
}

// iTunes only lists what's actually sold in the Apple ecosystem, which misses
// plenty of real films (e.g. Nightcrawler (2014) isn't there at all) — for
// movies specifically, fall back to the poster image on the film's Wikipedia
// article. No key needed here either; the tradeoff is resolution, since
// English Wikipedia intentionally caps non-free poster images small under its
// fair-use policy (typically ~200-300px on the long side).
async function findWikipediaPosterUrl(title) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title + " film")}&format=json&srlimit=1`;
  let page;
  try {
    const res = await fetch(searchUrl);
    if (!res.ok) return null;
    const data = await res.json();
    page = data.query && data.query.search && data.query.search[0];
  } catch {
    return null;
  }
  if (!page) return null;
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.title)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.originalimage && data.originalimage.source) || (data.thumbnail && data.thumbnail.source) || null;
  } catch {
    return null;
  }
}

async function findPosterUrl(title, type) {
  const itunes = await findItunesPosterUrl(title, type);
  if (itunes) return itunes;
  if (type === "movie") return findWikipediaPosterUrl(title);
  return null;
}

async function downloadPoster(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`poster fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

// Best-effort: looks up and saves a poster next to destPath, returns true on
// success, false on any miss/failure (never throws — a missing poster is not
// an import failure).
async function fetchPoster(title, type, destPath) {
  try {
    const url = await findPosterUrl(title, type);
    if (!url) return false;
    await downloadPoster(url, destPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { findPosterUrl, downloadPoster, fetchPoster };
