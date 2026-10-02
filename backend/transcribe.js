"use strict";

// Transcription client for Azure Speech Fast Transcription with
// MAI-Transcribe-2, run once server-side at import time
// (backend/import.js, backend/pbs-sync.js) instead of once per
// playback session.
//
//   transcribeVerbatim() — verbatim transcript via MAI-Transcribe-2
//                          (modelOptions.timestamps=word,
//                          transcribeStyle=verbatim — keeps "you know",
//                          "um"), single-shot synchronous multipart POST,
//                          suited to PBS clips up to ~2 h / 300 MB.
//                          Used by pbs-sync, since the dictation checker
//                          scores against the verbatim reference.
//
// Returns the repo's own shape { lines, words } so dictation.js,
// import.js and pbs-sync.js are untouched:
//   lines: [{ text, start }]          start in seconds
//   words: [{ text, start, end }]     seconds
//
// Auth: AZURE_SPEECH_KEY (or AZURE_KEY_1 / AZURE_KEY_2) plus
// AZURE_SPEECH_ENDPOINT (or AZURE_SPEECH_REGION), read from the
// environment or the repo-root .env (parsed, never executed).
// Error bodies are Azure's own shape; nothing here renders to a browser.
//
// No result cache here: every transcript produced is persisted permanently at
// library/<type>s/<slug>/transcript.json, so a second content-addressed cache
// in front of that would only help re-importing byte-identical media under a
// new entry — not worth a database db.js deliberately refuses to become (see
// its header: plain JSON by design).

const fs = require("fs/promises");
const { statSync, readFileSync, existsSync } = require("fs");
const path = require("path");

// Azure Fast Transcription caps: ~300 MB / ~2 h per file.
const AZ_MAX_BYTES = 300 * 1024 * 1024;
const AZ_API_VERSION = "2025-10-15";
const AZ_TIMEOUT_MS = 600 * 1000;
const AZ_RETRIES = 3;

// Minimal .env parser (KEY=VALUE, one per line). The repo's .env is the
// single source of truth for local secrets and is gitignored.
let envCache = null;
function loadDotEnv() {
  if (envCache) return envCache;
  envCache = {};
  try {
    const p = path.join(__dirname, "..", ".env");
    if (!existsSync(p)) return envCache;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      envCache[m[1]] = v;
    }
  } catch { /* no .env: fall through to real env */ }
  return envCache;
}

function env(name) {
  if (process.env[name]) return process.env[name].trim();
  const dot = loadDotEnv();
  return (dot[name] || "").trim();
}

function azureKey() {
  return (
    env("AZURE_SPEECH_KEY") ||
    env("AZURE_KEY_1") ||
    env("AZURE_KEY_2") ||
    ""
  );
}

function azureEndpoint() {
  const explicit = env("AZURE_SPEECH_ENDPOINT");
  if (explicit) return explicit.replace(/\/+$/, "");
  const region = env("AZURE_SPEECH_REGION") || env("AZURE_LOCATION") || "eastus";
  return `https://${region}.api.cognitive.microsoft.com`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retryable: network blips, 5xx, and busy/not-ready (409/429).
// Other 4xx means the request itself is wrong.
function retryable(status) {
  return !status || status >= 500 || status === 409 || status === 429;
}

const msToSec = (ms) => (Number(ms) || 0) / 1000;

// Azure Fast Transcription response:
// { phrases: [{ offsetMilliseconds, durationMilliseconds, text,
//               words: [{ text, offsetMilliseconds, durationMilliseconds }] }] }
// mapped onto the repo shape { lines: [{text,start}], words: [{text,start,end}] }.
function toRepoShape(azure) {
  const phrases = Array.isArray(azure.phrases) ? azure.phrases : [];
  const sorted = [...phrases].sort(
    (a, b) => (Number(a.offsetMilliseconds) || 0) - (Number(b.offsetMilliseconds) || 0),
  );
  const lines = [];
  const words = [];
  for (const p of sorted) {
    const text = String(p.text || "").trim();
    if (text) lines.push({ text, start: msToSec(p.offsetMilliseconds) });
    const ws = Array.isArray(p.words) ? p.words : [];
    for (const w of ws) {
      const wt = String(w.text || "").trim();
      if (!wt) continue;
      const start = msToSec(w.offsetMilliseconds);
      words.push({ text: wt, start, end: start + msToSec(w.durationMilliseconds) });
    }
  }
  return { lines, words };
}

// The verbatim transcriber for daily dictation — Azure MAI-Transcribe-2.
// A single-shot synchronous multipart POST: PBS clips fit the 300 MB / 2 h
// Fast Transcription cap, so there is no chunked upload protocol and no
// polling loop. Diarization stays off: it shortens the supported length
// and dictation scores single-track verbatim references.
async function transcribeVerbatim(filePath, { onProgress = () => {} } = {}) {
  const size = statSync(filePath).size;
  if (size > AZ_MAX_BYTES) throw new Error("File is too large to transcribe (over 300 MB).");
  const key = azureKey();
  if (!key) throw new Error("AZURE_SPEECH_KEY (or AZURE_KEY_1) not configured for verbatim transcription.");
  const endpoint = azureEndpoint();

  onProgress("uploading to Azure (MAI-Transcribe-2 verbatim)...");
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append("audio", new Blob([buf]), path.basename(filePath));
  form.append(
    "definition",
    JSON.stringify({
      locales: ["en"],
      enhancedMode: {
        enabled: true,
        model: "MAI-Transcribe-2",
        modelOptions: { timestamps: "word", transcribeStyle: "verbatim" },
      },
      diarization: { enabled: false },
    }),
  );

  onProgress("waiting for verbatim transcription...");
  let lastErr = null;
  for (let attempt = 0; attempt < AZ_RETRIES; attempt++) {
    let res = null;
    try {
      res = await fetch(
        `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${AZ_API_VERSION}`,
        {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": key },
          body: form,
          signal: AbortSignal.timeout(AZ_TIMEOUT_MS),
        },
      );
    } catch (e) {
      lastErr = e;
      onProgress(`retrying after network error (${attempt + 1}/${AZ_RETRIES})...`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    let j = null;
    try { j = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (j && (j.message || j.error)) || `Azure status ${res.status}`;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = res.status;
      if (!retryable(res.status) || attempt === AZ_RETRIES - 1) throw err;
      lastErr = err;
      onProgress(`retrying after Azure ${res.status} (${attempt + 1}/${AZ_RETRIES})...`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const out = toRepoShape(j || {});
    if (!out.lines.length || !out.words.length) {
      throw new Error("Azure returned no transcript");
    }
    return out;
  }
  throw lastErr || new Error("Azure transcription failed");
}

module.exports = { transcribeVerbatim };
