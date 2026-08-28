"use strict";

// Ports the chunked-upload protocol app-listen.js used to run client-side
// against comart's /api/transcript/* endpoints (which proxy the self-hosted
// Parakeet STT service), now run once server-side at import time instead of
// once per session. Constants match app-listen.js:1483-1488 exactly so this
// stays protocol-compatible with what comart expects.

const fs = require("fs/promises");
const { createReadStream, statSync } = require("fs");
const crypto = require("crypto");

const TX_CHUNK = 48 * 1024 * 1024;
const TX_MAX = 2 * 1024 * 1024 * 1024;
const TX_POLL_MS = 4000;
const TX_PROCESSING_LIMIT = 450; // ~30 min of actual processing
const TX_QUEUED_LIMIT = 3600;    // ~4 h queued — matches the service's queue TTL

// This machine already is nuc-15-pro on the tailnet — comart runs locally.
const COMART_BASE = "http://127.0.0.1:8770";

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

async function call(url, init = {}) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Could not reach the transcription service.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error(data?.error || "Could not transcribe this file.");
    err.status = res.status;
    throw err;
  }
  if (!data) throw new Error("Transcription service returned an unexpected response.");
  return data;
}

// Same retry policy as app-listen.js's txRetryable: network blips, 5xx, and
// busy/not-ready (409/429) are worth retrying; other 4xx means the request
// itself is wrong.
function retryable(e) {
  return !e.status || e.status >= 500 || e.status === 409 || e.status === 429;
}

async function readChunk(fd, start, len) {
  const buf = Buffer.allocUnsafe(len);
  await fd.read(buf, 0, len, start);
  return buf;
}

// Transcribes a file already on disk. Returns {lines, words}. Calls
// onProgress(message) as it goes, since a multi-GB upload can take a while.
// Pass a precomputed `sha256` if the caller already hashed the file (e.g. for
// its own DB record) to avoid hashing a multi-GB file twice.
async function transcribe(filePath, { onProgress = () => {}, sha256 } = {}) {
  const size = statSync(filePath).size;
  if (size > TX_MAX) throw new Error("File is too large to transcribe (over 2 GB).");

  if (!sha256) {
    onProgress("hashing file...");
    sha256 = await sha256File(filePath);
  }

  onProgress("checking for a cached transcript...");
  let data = await call(`${COMART_BASE}/api/transcript/begin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha256, size }),
  });

  if (!data.transcript) {
    const upload = data.upload_id;
    const totalChunks = Math.ceil(size / TX_CHUNK);
    const fd = await fs.open(filePath, "r");
    try {
      for (let n = 0; n * TX_CHUNK < size; n++) {
        const start = n * TX_CHUNK;
        const len = Math.min(TX_CHUNK, size - start);
        const buf = await readChunk(fd, start, len);
        onProgress(`uploading chunk ${n + 1}/${totalChunks}...`);
        const chunkUrl = `${COMART_BASE}/api/transcript/chunk?upload=${upload}&n=${n}`;
        try {
          await call(chunkUrl, { method: "PUT", body: buf });
        } catch (e) {
          if (!retryable(e)) throw e;
          await sleep(2000);
          await call(chunkUrl, { method: "PUT", body: buf });
        }
      }
    } finally {
      await fd.close();
    }

    onProgress("finishing upload...");
    let fin;
    for (let a = 0; ; a++) {
      try {
        fin = await call(`${COMART_BASE}/api/transcript/finish?upload=${upload}`, { method: "POST" });
        break;
      } catch (e) {
        if (a >= 4 || !retryable(e)) throw e;
        await sleep(3000 * (a + 1));
      }
    }

    onProgress("waiting for transcription...");
    let fails = 0, processing = 0, queued = 0;
    for (;;) {
      await sleep(TX_POLL_MS);
      try {
        data = await call(`${COMART_BASE}/api/transcript/status?job=${fin.job_id}`);
        fails = 0;
      } catch (e) {
        if (e.status === 404 || !retryable(e) || ++fails >= 5) throw e;
        continue;
      }
      if (data.status === "error") throw new Error(data.error || "Could not transcribe this file.");
      if (data.status === "done") break;
      if (data.status === "processing" && ++processing >= TX_PROCESSING_LIMIT) {
        throw new Error("Transcription timed out.");
      }
      if (data.status === "queued" && ++queued >= TX_QUEUED_LIMIT) {
        throw new Error("The transcription queue is overloaded — try again later.");
      }
      onProgress(`status: ${data.status}...`);
    }
  } else {
    onProgress("found a cached transcript, skipping upload.");
  }

  const t = data.transcript;
  if (!t || !t.lines || !t.lines.length) throw new Error("No speech could be transcribed from this file.");
  return { lines: t.lines, words: Array.isArray(t.words) ? t.words : [] };
}

module.exports = { transcribe, sha256File };
