"use strict";

// Transcription clients for the two self-hosted STT services, run once
// server-side at import time (backend/import.js, backend/pbs-sync.js) instead
// of once per playback session.
//
//   transcribe()         — clean transcript via Parakeet (127.0.0.1:8790),
//                          chunked-upload protocol. Used for manual CLI imports.
//   transcribeVerbatim() — verbatim transcript via CrisperWhisper 2.0 medium
//                          (127.0.0.1:8789 — keeps "you know", "um"), single-shot
//                          multipart POST, suited to small PBS clips. Used by
//                          pbs-sync, since the dictation checker scores against
//                          the verbatim reference.
//
// Both services are gated by the same bearer token. Error bodies are the
// services' own FastAPI shape ({detail: "..."}), since nothing here renders
// to a browser.
//
// No result cache here: every transcript produced is persisted permanently at
// library/<type>s/<slug>/transcript.json, so a second content-addressed cache
// in front of that would only help re-importing byte-identical media under a
// new entry — not worth a database db.js deliberately refuses to become (see
// its header: plain JSON by design).

const fs = require("fs/promises");
const { createReadStream, statSync } = require("fs");
const crypto = require("crypto");

const TX_CHUNK = 48 * 1024 * 1024;
const TX_MAX = 2 * 1024 * 1024 * 1024;
const TX_POLL_MS = 4000;
const TX_PROCESSING_LIMIT = 450; // ~30 min of actual processing
const TX_QUEUED_LIMIT = 3600;    // ~4 h queued — matches the service's queue TTL

const PARAKEET_URL = process.env.PARAKEET_URL || "http://127.0.0.1:8790";

// Daily dictation uses CrisperWhisper 2.0 medium verbatim (keeps "you know",
// "um") on 8789 directly (same token).
const CRISPER_URL = process.env.CRISPER_URL || "http://127.0.0.1:8789";
const CRISPER_TOKEN = process.env.CRISPER_TOKEN || (() => {
  try { return require("fs").readFileSync("/home/james/crisper-whisper/service.env","utf8").match(/PARAKEET_TOKEN=(.*)/)[1].trim(); } catch { return process.env.PARAKEET_TOKEN || ""; }
})();
// Parakeet (8790) and Crisper (8789) are gated by the same bearer token —
// confirmed byte-identical in both services' service.env — so the
// resolution above authenticates both; no separate PARAKEET_TOKEN plumbing.
const PARAKEET_TOKEN = CRISPER_TOKEN;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Calls an STT endpoint directly, authenticated with the shared bearer
// token. A non-2xx body is the service's FastAPI {detail: "..."} shape.
async function parakeetCall(url, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${PARAKEET_TOKEN}` },
    });
  } catch {
    throw new Error("Could not reach the transcription service.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body, e.g. an empty 202/201 */ }
  if (!res.ok) {
    const err = new Error(data?.detail || `Parakeet ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- transcript sanitising (coerce every field). The services' raw output
// has occasionally carried non-finite numbers or non-string text, so every
// transcript is cleaned on the way in.
function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return 0;
}
function toFiniteNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return [v, true];
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return [f, true];
  }
  return [0, false];
}
function sanitizeTranscript(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const lines = [];
  for (const l of Array.isArray(src.lines) ? src.lines : []) {
    const text = String(l?.text ?? "").trim();
    if (!text) continue;
    lines.push({ text, start: toNum(l?.start) });
  }
  const words = [];
  for (const w of Array.isArray(src.words) ? src.words : []) {
    const text = String(w?.text ?? "").trim();
    if (!text) continue;
    const start = toNum(w?.start);
    const [end, ok] = toFiniteNum(w?.end);
    words.push({ text, start, end: ok ? end : start });
  }
  return { lines, words };
}

// Retry policy for polling: network blips, 5xx, and busy/not-ready (409/429)
// are worth retrying; other 4xx means the request itself is wrong.
function retryable(e) {
  return !e.status || e.status >= 500 || e.status === 409 || e.status === 429;
}

async function readChunk(fd, start, len) {
  const buf = Buffer.allocUnsafe(len);
  await fd.read(buf, 0, len, start);
  return buf;
}

// Transcribes a file already on disk via Parakeet directly (clean).
// For verbatim dictation, use transcribeVerbatim() which hits Crisper 8789 directly.
// Returns {lines, words}. Calls onProgress(message) as it goes.
async function transcribe(filePath, { onProgress = () => {} } = {}) {
  const size = statSync(filePath).size;
  if (size > TX_MAX) throw new Error("File is too large to transcribe (over 2 GB).");
  if (!PARAKEET_TOKEN) throw new Error("PARAKEET_TOKEN not configured for transcription.");

  onProgress("starting upload...");
  const begin = await parakeetCall(`${PARAKEET_URL}/v1/uploads`, { method: "POST" });
  const upload = begin.upload_id;

  const totalChunks = Math.ceil(size / TX_CHUNK);
  const fd = await fs.open(filePath, "r");
  try {
    for (let n = 0; n * TX_CHUNK < size; n++) {
      const start = n * TX_CHUNK;
      const len = Math.min(TX_CHUNK, size - start);
      const buf = await readChunk(fd, start, len);
      onProgress(`uploading chunk ${n + 1}/${totalChunks}...`);
      const chunkUrl = `${PARAKEET_URL}/v1/uploads/${upload}/chunks/${n}`;
      try {
        await parakeetCall(chunkUrl, { method: "PUT", body: buf });
      } catch (e) {
        if (!retryable(e)) throw e;
        await sleep(2000);
        await parakeetCall(chunkUrl, { method: "PUT", body: buf });
      }
    }
  } finally {
    await fd.close();
  }

  onProgress("finishing upload...");
  let fin;
  for (let a = 0; ; a++) {
    try {
      fin = await parakeetCall(`${PARAKEET_URL}/v1/uploads/${upload}/complete`, { method: "POST" });
      break;
    } catch (e) {
      if (a >= 4 || !retryable(e)) throw e;
      await sleep(3000 * (a + 1));
    }
  }

  onProgress("waiting for transcription...");
  let data, fails = 0, processing = 0, queued = 0;
  for (;;) {
    await sleep(TX_POLL_MS);
    try {
      data = await parakeetCall(`${PARAKEET_URL}/v1/jobs/${fin.job_id}`);
      fails = 0;
    } catch (e) {
      if (e.status === 404 || !retryable(e) || ++fails >= 5) throw e;
      continue;
    }
    if (data.status === "error") {
      throw new Error(typeof data.error === "string" && data.error ? data.error : "Could not transcribe this file.");
    }
    if (data.status === "done") break;
    if (data.status === "processing" && ++processing >= TX_PROCESSING_LIMIT) {
      throw new Error("Transcription timed out.");
    }
    if (data.status === "queued" && ++queued >= TX_QUEUED_LIMIT) {
      throw new Error("The transcription queue is overloaded — try again later.");
    }
    onProgress(`status: ${data.status}...`);
  }

  const t = sanitizeTranscript(data.result);
  if (!t.lines.length) throw new Error("No speech could be transcribed from this file.");
  return t;
}

// Verbatim variant for daily dictation — CrisperWhisper 2.0 medium on 8789
// directly (same bearer token) instead of Parakeet. Same polling, but a
// single-shot multipart POST instead of the chunked protocol: PBS clips are
// small (<100 MB) and this avoids chunk bookkeeping for them.
async function transcribeVerbatim(filePath, { onProgress = () => {} } = {}) {
  const size = statSync(filePath).size;
  if (size > TX_MAX) throw new Error("File is too large to transcribe (over 2 GB).");
  if (!CRISPER_TOKEN) throw new Error("CRISPER_TOKEN/PARAKEET_TOKEN not configured for verbatim transcription.");
  // Direct Crisper: single-shot POST /v1/jobs (multipart) is simpler than
  // chunked for PBS clips (<100MB). For larger files we could reuse the
  // chunked protocol above, but PBS segments are small.
  onProgress("uploading to Crisper (verbatim)...");
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([buf]), require("path").basename(filePath));
  let data = await (async () => {
    const res = await fetch(`${CRISPER_URL}/v1/jobs`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${CRISPER_TOKEN}` },
      body: form,
    });
    let j = null; try { j = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(j?.error || `Crisper POST ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return j;
  })();
  const jobId = data.job_id;
  if (!jobId) throw new Error("Crisper did not return a job_id");
  onProgress("waiting for verbatim transcription...");
  let fails = 0, processing = 0, queued = 0;
  for (;;) {
    await sleep(TX_POLL_MS);
    try {
      const r = await fetch(`${CRISPER_URL}/v1/jobs/${jobId}`, {
        headers: { "Authorization": `Bearer ${CRISPER_TOKEN}` },
      });
      let j = null; try { j = await r.json(); } catch {}
      if (!r.ok) {
        const err = new Error(j?.error || `Crisper status ${r.status}`);
        err.status = r.status;
        throw err;
      }
      fails = 0;
      if (j.status === "error") throw new Error(j.error || "Crisper job error");
      if (j.status === "done") {
        if (!j.result || !j.result.lines) throw new Error("Crisper returned no transcript");
        return { lines: j.result.lines, words: j.result.words || [] };
      }
      if (j.status === "processing" && ++processing >= TX_PROCESSING_LIMIT) throw new Error("Verbatim transcription timed out.");
      if (j.status === "queued" && ++queued >= TX_QUEUED_LIMIT) throw new Error("Crisper queue overloaded — try again later.");
      onProgress(`status: ${j.status}...`);
    } catch (e) {
      if (e.status === 404 || !retryable(e) || ++fails >= 5) throw e;
    }
  }
}

module.exports = { transcribe, transcribeVerbatim, sha256File };
