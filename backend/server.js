"use strict";

// The media-library backend. Serves the entry list, streams media files
// (range-request capable, for seeking), serves pre-computed transcripts, and
// persists per-entry playback progress. Runs standalone — not spawned by
// Electron's main.js — since the Electron client (this same repo) may run on
// any device on the tailnet while the backend and its library stay on this
// machine (nuc-15-pro). Reached over the network via app-base.js's resolved
// URL, same as the app used to reach comart directly.

const fs = require("fs");
const path = require("path");
const express = require("express");
const db = require("./db");

const PORT = process.env.PORT || 8768;
// This machine already is nuc-15-pro — comart runs locally.
const COMART_BASE = "http://127.0.0.1:8770";
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// The explain panel (word/phrase explanations, MW pronunciation badges,
// credit warnings) is existing functionality that survived the library
// rewrite unchanged on the frontend, but now resolves against this backend's
// base URL instead of comart directly — so those three routes need to be
// transparently proxied through to comart here. Raw body passthrough (not
// express.json()) so arbitrary request shapes forward untouched.
const EXPLAIN_PATHS = ["/api/explain", "/api/pron", "/api/credits"];
app.all(EXPLAIN_PATHS, express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  try {
    const upstream = await fetch(`${COMART_BASE}${req.originalUrl}`, {
      method: req.method,
      headers: req.get("Content-Type") ? { "Content-Type": req.get("Content-Type") } : {},
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch {
    res.status(502).json({ error: "Could not reach the explain service." });
  }
});

// The floating microphone button's transcription call (mic.js) — a single
// short recording POSTed as a raw audio blob, proxied straight through to
// comart's own /api/transcribe (same service backend/transcribe.js's chunked
// long-file protocol talks to, different endpoint: this one is comart's
// one-shot short-clip path, capped client-side at 60s). Raw body passthrough,
// same shape as the EXPLAIN_PATHS proxy above, sized for a ~60s opus clip
// (well under 1MB) with headroom.
app.post("/api/transcribe", express.raw({ type: () => true, limit: "20mb" }), async (req, res) => {
  try {
    const upstream = await fetch(`${COMART_BASE}/api/transcribe`, {
      method: "POST",
      headers: req.get("Content-Type") ? { "Content-Type": req.get("Content-Type") } : {},
      body: req.body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch {
    res.status(502).json({ error: "Could not reach the transcription service." });
  }
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Dictation — daily dictation sessions from PBS NewsHour (audio-only, 1-2
// sentences per session, looped). See backend/dictation.js for the algorithm
// and WER definition.
// ---------------------------------------------------------------------------
const dictation = require("./dictation");

app.get("/api/dictation/stats", (req, res) => {
  try {
    const all = dictation.getAllSessionsDetailed();
    const { set } = dictation.getCompletedSet();
    res.json({
      total: all.length,
      completed: set.size,
      remaining: Math.max(0, all.length - set.size),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/dictation/session", (req, res) => {
  try {
    const pick = dictation.pickNextSession();
    if (!pick || !pick.session) return res.status(404).json({ error: "No dictation sessions available." });
    const s = pick.session;
    const entry = db.getEntry(s.entryId);
    res.json({
      sessionId: s.sessionId,
      entryId: s.entryId,
      entryTitle: s.entryTitle,
      hasVideo: !!(entry && entry.hasVideo),
      start: s.start,
      end: s.end,
      duration: s.duration,
      wordCount: s.wordCount,
      // Per-word ASR timings for this segment, so the client can loop a phrase
      // inside it (right-click / right-drag on a reference word). [] when the
      // transcript can't be read — the client falls back to segment-only replay.
      words: dictation.getSessionWords(s),
      // Reference text is intentionally included so the client can display it
      // *after* checking — the grading itself is server-side on /api/dictation/check,
      // so a client that peeks early gains nothing.
      reference: s.text,
      exhausted: pick.exhausted,
      stats: { total: pick.total, remaining: pick.remaining },
    });
  } catch (e) {
    console.error("dictation session error", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/dictation/check", (req, res) => {
  const { sessionId, hypothesis } = req.body || {};
  if (!sessionId || typeof hypothesis !== "string") {
    return res.status(400).json({ error: "sessionId and hypothesis (string) required." });
  }
  try {
    const session = dictation.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const reference = session.text;
    const result = dictation.gradeDictation(reference, hypothesis);
    res.json({
      sessionId,
      reference,
      hypothesis,
      score: result.score,
      wer: result.wer,
      accuracy: result.accuracy,
      n: result.n,
      S: result.S,
      D: result.D,
      I: result.I,
      C: result.C,
      dist: result.dist,
      refTokens: result.refTokens,
      hypTokens: result.hypTokens,
      ops: result.ops,
    });
  } catch (e) {
    console.error("dictation check error", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/dictation/complete", (req, res) => {
  const { sessionId, score } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required." });
  try {
    const session = dictation.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const ok = dictation.markCompleted(sessionId, session.entryId, {
      wordStart: session.wordStart,
      wordEnd: session.wordEnd,
      text: session.text,
      start: session.start,
      end: session.end,
      score: typeof score === "number" ? score : null,
    });
    res.json({ ok, alreadyCompleted: !ok });
  } catch (e) {
    console.error("dictation complete error", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

function toLibrarySummary(e) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    hasVideo: e.hasVideo,
    durationSec: e.durationSec,
    progressSec: e.progressSec || 0,
    transcriptStatus: e.transcriptStatus,
  };
}

// Top-level entries only — a segment (an entry with a parentId, e.g. one
// PBS NewsHour clip belonging to an episode "collection" entry) is reached
// via its parent's /children route below, not listed here.
app.get("/api/library", (req, res) => {
  res.json(db.listEntries().filter((e) => !e.parentId).map(toLibrarySummary));
});

// Segments belonging to a "collection" entry (see toLibrarySummary above).
// Ordinary entries just have no children — an empty array, not an error.
app.get("/api/library/:id/children", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry) return res.sendStatus(404);
  res.json(db.listChildren(req.params.id).map(toLibrarySummary));
});

app.get("/api/library/:id/stream", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) return res.sendStatus(404);
  // res.sendFile (built on the `send` package) already implements HTTP
  // Range + conditional GET, so this is seekable video/audio for free.
  res.sendFile(entry.filePath, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Cover art, looked up at import time (see backend/poster.js) and cached
// alongside the media file. Not every entry has one (an obscure title or a
// personal recording won't match anything on iTunes) — a 404 here is normal,
// and the frontend falls back to a generated placeholder card on image error.
// A nested collection with no cover art of its own (e.g. a day within a
// show) falls back to its parent's poster, walking up the chain — most days
// won't have individually fetched art, but the show usually does.
app.get("/api/library/:id/poster", (req, res) => {
  let entry = db.getEntry(req.params.id);
  if (!entry) return res.sendStatus(404);
  while (entry) {
    // entry.dir is set at import time for every entry, media or collection.
    // Older entries imported before that field existed only have filePath,
    // so fall back to its directory for them.
    const dir = entry.dir || (entry.filePath && path.dirname(entry.filePath));
    const posterPath = dir && path.join(dir, "poster.jpg");
    if (posterPath && fs.existsSync(posterPath)) return res.sendFile(posterPath);
    entry = entry.type === "collection" && entry.parentId ? db.getEntry(entry.parentId) : null;
  }
  return res.sendStatus(404);
});

app.get("/api/library/:id/transcript", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry) return res.sendStatus(404);
  if (entry.transcriptStatus === "ready") {
    try {
      const data = JSON.parse(fs.readFileSync(entry.transcriptPath, "utf8"));
      return res.json(data);
    } catch {
      return res.sendStatus(404);
    }
  }
  if (entry.transcriptStatus === "pending" || entry.transcriptStatus === "processing") {
    return res.status(202).json({ status: entry.transcriptStatus });
  }
  return res.sendStatus(404);
});

app.get("/api/library/:id/progress", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry) return res.sendStatus(404);
  res.json({ positionSec: entry.progressSec || 0 });
});

app.post("/api/library/:id/progress", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry) return res.sendStatus(404);
  const positionSec = Number(req.body && req.body.positionSec);
  if (!Number.isFinite(positionSec) || positionSec < 0) return res.sendStatus(400);
  db.setProgress(req.params.id, positionSec);
  res.sendStatus(204);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`av-materials backend listening on http://127.0.0.1:${PORT}`);
});
