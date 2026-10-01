"use strict";

// Transcription client for the self-hosted STT service, run once server-side
// at import time (backend/import.js, backend/pbs-sync.js) instead of once per
// playback session.
//
//   transcribeVerbatim() — verbatim transcript via CrisperWhisper 2.0 medium
//                          (127.0.0.1:8789 — keeps "you know", "um"), single-shot
//                          multipart POST, suited to small PBS clips. Used by
//                          pbs-sync, since the dictation checker scores against
//                          the verbatim reference.
//
// The service is gated by a bearer token. Error bodies are the service's own
// FastAPI shape ({detail: "..."}), since nothing here renders to a browser.
//
// No result cache here: every transcript produced is persisted permanently at
// library/<type>s/<slug>/transcript.json, so a second content-addressed cache
// in front of that would only help re-importing byte-identical media under a
// new entry — not worth a database db.js deliberately refuses to become (see
// its header: plain JSON by design).

const fs = require("fs/promises");
const { statSync } = require("fs");

const TX_MAX = 2 * 1024 * 1024 * 1024;
const TX_POLL_MS = 4000;
const TX_PROCESSING_LIMIT = 450; // ~30 min of actual processing
const TX_QUEUED_LIMIT = 3600;    // ~4 h queued — matches the service's queue TTL

// Daily dictation uses CrisperWhisper 2.0 medium verbatim (keeps "you know",
// "um") on 8789 directly. The shared service token lives under the
// PARAKEET_TOKEN key in that service's service.env.
const CRISPER_URL = process.env.CRISPER_URL || "http://127.0.0.1:8789";
const CRISPER_TOKEN = process.env.CRISPER_TOKEN || (() => {
  try { return require("fs").readFileSync("/home/james/crisper-whisper/service.env","utf8").match(/PARAKEET_TOKEN=(.*)/)[1].trim(); } catch { return process.env.PARAKEET_TOKEN || ""; }
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry policy for polling: network blips, 5xx, and busy/not-ready (409/429)
// are worth retrying; other 4xx means the request itself is wrong.
function retryable(e) {
  return !e.status || e.status >= 500 || e.status === 409 || e.status === 429;
}

// The verbatim transcriber for daily dictation — CrisperWhisper 2.0 medium on
// 8789 directly. A single-shot multipart POST: PBS clips are small (<100 MB),
// so there is no need for a chunked upload protocol.
async function transcribeVerbatim(filePath, { onProgress = () => {} } = {}) {
  const size = statSync(filePath).size;
  if (size > TX_MAX) throw new Error("File is too large to transcribe (over 2 GB).");
  if (!CRISPER_TOKEN) throw new Error("CRISPER_TOKEN not configured for verbatim transcription.");
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

module.exports = { transcribeVerbatim };
