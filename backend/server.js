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

app.use(express.json());

app.get("/api/library", (req, res) => {
  res.json(
    db.listEntries().map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      hasVideo: e.hasVideo,
      durationSec: e.durationSec,
      progressSec: e.progressSec || 0,
      transcriptStatus: e.transcriptStatus,
    }))
  );
});

app.get("/api/library/:id/stream", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry || !fs.existsSync(entry.filePath)) return res.sendStatus(404);
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
app.get("/api/library/:id/poster", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry) return res.sendStatus(404);
  const posterPath = path.join(path.dirname(entry.filePath), "poster.jpg");
  if (!fs.existsSync(posterPath)) return res.sendStatus(404);
  res.sendFile(posterPath);
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
