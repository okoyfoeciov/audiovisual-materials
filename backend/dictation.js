"use strict";

/**
 * Dictation — session selection & grading.
 *
 * Two core pieces:
 *   1. Turning a transcript's per-word array into 1-2 sentence (≈ 3 if short)
 *      audio sessions, with persistence so "Next" never repeats a finished one.
 *   2. A WER-based checker that mirrors the ASR literature's definition.
 *
 * Research notes
 * ──────────────
 * WER is defined everywhere as:
 *
 *     WER = (S + D + I) / N
 *
 * where S = substitutions, D = deletions (words in reference missing from
 * hypothesis), I = insertions (extra words), N = words in reference —
 * see Kuhn et al. 2024 "Beyond Levenshtein" (§2.5.1) for the standard
 * closed form, and galileo.ai / Towards Data Science overviews. The corpus
 * is lower-cased and stripped of punctuation before alignment, so "Hello."
 * and "hello" are not counted as errors when grading spoken content — the
 * same normalisation Speechmatics and jiwer's default benchmark pipeline
 * use. Accuracy is reported as `max(0, 1 - WER)` (clamped, since insertions
 * can push WER > 1).
 *
 * Field (2008) + Thorn/Cauldwell's cycle argues for a short chunk
 * (Field's own experiment: a single 10-second authentic segment with
 * contractions/modals) followed by gist → detail → transcript support, and
 * the decoding meta-analysis cited by the user finds the useful band is
 * ~60–70% correct on first listen, 90%+ after replays. The target session
 * shape here (≈ 15–25 words / 8–16 s, 1–2 sentences) is sized to land in
 * that band after 2–3 loops on authentic PBS NewsHour speech.
 */

const fs = require("fs");
const path = require("path");
const db = require("./db");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DICTATION_PATH = path.join(__dirname, "..", "library", "dictation.json");

function loadDictation() {
  try {
    return JSON.parse(fs.readFileSync(DICTATION_PATH, "utf8"));
  } catch {
    return { completed: [], completedSet: {} };
  }
}

function saveDictation(data) {
  const dir = path.dirname(DICTATION_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // keep legacy completedSet in sync
  const set = {};
  for (const c of (data.completed || [])) set[c.sessionId] = true;
  data.completedSet = set;
  const tmp = DICTATION_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DICTATION_PATH);
}

function getCompletedSet() {
  const d = loadDictation();
  // migrate old shape: completedSet was source of truth, completed was array of ids
  if (d.completedSet && !d.completed.length && Object.keys(d.completedSet).length) {
    // old file where completed was empty but set had keys — shouldn't happen
  }
  if (Array.isArray(d.completed) && d.completed.length && typeof d.completed[0] === "string") {
    // migration: old array of string ids → array of objects
    d.completed = d.completed.map((id) => ({ sessionId: id, completedAt: 0 }));
  }
  const set = new Set();
  for (const c of (d.completed || [])) set.add(c.sessionId);
  // also include legacy set
  for (const k of Object.keys(d.completedSet || {})) set.add(k);
  return { data: d, set };
}

function markCompleted(sessionId, entryId, meta) {
  const { data, set } = getCompletedSet();
  if (set.has(sessionId)) return false;
  data.completed = data.completed || [];
  data.completed.push({
    sessionId,
    entryId,
    wordStart: meta.wordStart,
    wordEnd: meta.wordEnd,
    text: meta.text,
    start: meta.start,
    end: meta.end,
    completedAt: Date.now(),
    score: meta.score,
  });
  saveDictation(data);
  return true;
}

function isCompleted(sessionId) {
  const { set } = getCompletedSet();
  return set.has(sessionId);
}

// ---------------------------------------------------------------------------
// Transcript → sentences → sessions
// ---------------------------------------------------------------------------

// Sentence boundary: word ends with . ! ? … possibly followed by closing
// quote/paren/bracket. Mirrors app-listen.js buildChunksFromWords.
const SENT_END_RE = /[.!?…]['")\]]?$/;

function sentencesFromWords(words) {
  const out = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = String(w.text || "").trim();
    if (!text) continue;
    cur.push({ text, start: Number(w.start) || 0, end: Number(w.end) || Number(w.start) || 0, idx: i });
    if (SENT_END_RE.test(text)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// Split a single long sentence (too many words / too long) into ~2 halves.
// Try to split at a natural pause near the middle: a comma, semicolon,
// colon, dash, or conjunction boundary. Falls back to hard half.
function splitLongSentence(sWords) {
  const n = sWords.length;
  if (n <= 25) return [sWords];
  // also check duration
  const dur = sWords[n - 1].end - sWords[0].start;
  if (n <= 28 && dur <= 16) return [sWords];

  const mid = Math.floor(n / 2);
  let best = mid;
  // search window ±4 around midpoint for a word ending with , ; : — —
  let found = -1;
  let bestDist = Infinity;
  for (let d = -4; d <= 4; d++) {
    const k = mid + d;
    if (k < 1 || k >= n - 1) continue;
    const t = sWords[k].text;
    if (/[,;:\-–—]$/.test(t)) {
      const dist = Math.abs(d);
      if (dist < bestDist) { bestDist = dist; found = k; }
    }
  }
  if (found >= 0) best = found;
  // also prefer splitting before a conjunction if near middle
  if (found < 0) {
    for (let d = -3; d <= 3; d++) {
      const k = mid + d;
      if (k < 1 || k >= n - 1) continue;
      const nxt = (sWords[k + 1].text || "").toLowerCase();
      if (nxt === "and" || nxt === "but" || nxt === "or" || nxt === "so" || nxt === "because" || nxt === "that") {
        const dist = Math.abs(d);
        if (dist < bestDist) { bestDist = dist; found = k; }
      }
    }
    if (found >= 0) best = found;
  }

  const splitIdx = best + 1; // first part includes the pause word
  const a = sWords.slice(0, splitIdx);
  const b = sWords.slice(splitIdx);
  // guard: avoid creating a tiny fragment <5 words
  if (a.length < 5 || b.length < 5) {
    const half = Math.floor(n / 2);
    return [sWords.slice(0, half), sWords.slice(half)];
  }
  return [a, b];
}

/**
 * Partition the sentence list into dictation sessions.
 * Each session is 1–2 sentences (3 if all short), total 8–30 words,
 * 3–18 s. Long single sentences are split in half.
 *
 * Returns array of { wordStart, wordEnd, sentStart, sentEnd, text, wordCount, start, end }
 * where wordStart/wordEnd are indices into the original flat words array.
 */
function partitionTranscript(words) {
  const sents = sentencesFromWords(words);
  if (!sents.length) return [];

  // Expand long single sentences into two pseudo-sentences so the greedy
  // loop can treat them uniformly.
  const expanded = [];
  for (const s of sents) {
    const parts = splitLongSentence(s);
    for (const p of parts) expanded.push(p);
  }

  const sessions = [];
  let i = 0;
  while (i < expanded.length) {
    const s0 = expanded[i];
    const s1 = expanded[i + 1] || null;
    const s2 = expanded[i + 2] || null;

    const wc0 = s0.length;
    const wc1 = s1 ? wc0 + s1.length : null;
    const wc2 = s2 && wc1 != null ? wc1 + s2.length : null;

    const dur0 = s0[s0.length - 1].end - s0[0].start;
    const dur1 = s1 ? s1[s1.length - 1].end - s0[0].start : null;
    const dur2 = s2 ? s2[s2.length - 1].end - s0[0].start : null;

    let take = 1;

    // Very short single (filler like "Thanks." 2w) → try to bundle
    if ((wc0 < 8 || dur0 < 3.0) && s1) {
      if (wc1 != null && wc1 <= 30 && dur1 != null && dur1 <= 18) {
        take = 2;
        // still very short (e.g., three 4-word pleasantries) → allow 3
        if (wc1 < 12 && s2 && wc2 != null && wc2 <= 30 && dur2 != null && dur2 <= 18) {
          const maxLen = Math.max(s0.length, s1.length, s2.length);
          if (maxLen <= 10) take = 3;
        }
      }
    } else if (wc0 >= 12 && wc0 <= 28 && dur0 >= 4 && dur0 <= 14) {
      take = 1; // ideal single
    } else {
      // single is either medium-long (kept as 1) or short but bundled above;
      // if single is within 8-30 and next would still fit, prefer 2 for ~20w target
      if (s1 && wc1 != null && wc1 >= 14 && wc1 <= 30 && dur1 != null && dur1 <= 18) {
        // if single is 13w and pair is 26w in ~8s, pair is nicer
        if (wc0 < 14) take = 2;
      }
    }

    // If 2 is still tiny, extend to 3 short sentences
    if (take === 2 && s2 && wc1 != null && wc1 < 14 && wc2 != null && wc2 <= 28 && dur2 != null && dur2 <= 18) {
      const lens = [s0.length, s1.length, s2.length];
      if (Math.max(...lens) <= 10) take = 3;
    }

    take = Math.min(take, expanded.length - i);

    // Filter/merge ultra-short filler sessions (<6 words): merge forward
    let totalWc = 0;
    for (let k = i; k < i + take; k++) totalWc += expanded[k].length;
    if (totalWc < 6 && i + take < expanded.length) {
      // absorb next sentence
      take += 1;
      totalWc += expanded[i + take - 1].length;
      if (take > 3) take = 3; // cap
    }
    // If still <6 and at very end, just keep it (avoid dropping content)
    // but such micro sessions will be filtered by isSessionValid later.

    const chunkSents = expanded.slice(i, i + take);
    const flat = chunkSents.flat();
    const wordStart = flat[0].idx;
    const wordEnd = flat[flat.length - 1].idx;
    const text = chunkSents.map((s) => s.map((w) => w.text).join(" ")).join(" ");
    const wordCount = flat.length;
    const start = flat[0].start;
    const end = flat[flat.length - 1].end;
    // skip empty or ultra-short
    sessions.push({ wordStart, wordEnd, sentStart: i, sentEnd: i + take - 1, text, wordCount, start, end, duration: end - start });
    i += take;
  }
  return sessions;
}

function isSessionValid(s) {
  if (!s) return false;
  if (s.wordCount < 6) return false;
  if (s.wordCount > 38) return false;
  if (s.duration < 2.0) return false;
  if (s.duration > 22) return false;
  // skip sessions that are just filler like "Um Yeah." combined but still 2w
  // already covered by wordCount; also skip if text is trivially short
  if (s.text.trim().length < 12) return false;
  return true;
}

function getPBSEntries() {
  const all = db.listEntries();
  // PBS NewsHour segments are movies with a sourceId (YouTube id) under a
  // pbs-newshour collection. Be permissive: any entry of type movie that is
  // under the pbs-newshour tree, or has sourceId.
  const byId = new Map(all.map((e) => [e.id, e]));
  function isUnderPBS(e) {
    if (e.sourceId) return true;
    let cur = e;
    while (cur && cur.parentId) {
      if (cur.parentId === "pbs-newshour") return true;
      cur = byId.get(cur.parentId);
      if (!cur) break;
      if (cur.id === "pbs-newshour") return true;
    }
    return false;
  }
  return all.filter((e) => e.type === "movie" && isUnderPBS(e) && e.transcriptStatus === "ready" && e.transcriptPath);
}

function getAllSessionsDetailed() {
  const entries = getPBSEntries();
  const out = [];
  for (const e of entries) {
    try {
      const data = JSON.parse(fs.readFileSync(e.transcriptPath, "utf8"));
      const words = Array.isArray(data.words) ? data.words : [];
      if (!words.length) continue;
      const sessions = partitionTranscript(words).filter(isSessionValid);
      for (let idx = 0; idx < sessions.length; idx++) {
        const s = sessions[idx];
        const sessionId = `${e.id}:${s.wordStart}-${s.wordEnd}`;
        out.push({
          sessionId,
          entryId: e.id,
          entryTitle: e.title,
          wordStart: s.wordStart,
          wordEnd: s.wordEnd,
          text: s.text,
          wordCount: s.wordCount,
          start: s.start,
          end: s.end,
          duration: s.duration,
          partitionIndex: idx,
          totalPartitions: sessions.length,
        });
      }
    } catch {}
  }
  return out;
}

/**
 * The session's own words, with their ASR timings — the slice
 * [wordStart..wordEnd] of the entry's flat word array that the session was cut
 * from. The reference TEXT alone carries no timings, so without this the client
 * can only replay the whole segment; with it, a learner can right-drag a phrase
 * inside the segment and loop just that (mirroring the Watch caption's A-B loop).
 * Interpolating the timings client-side from the segment's start/end was the
 * alternative and would drift worst on exactly the fast, crowded speech that is
 * worth replaying.
 *
 * Returns [] when the transcript is missing or unreadable — the caller degrades
 * to a segment-only replay rather than failing the whole session.
 */
function getSessionWords(session) {
  if (!session) return [];
  try {
    const entry = db.getEntry(session.entryId);
    if (!entry || !entry.transcriptPath) return [];
    const data = JSON.parse(fs.readFileSync(entry.transcriptPath, "utf8"));
    const words = Array.isArray(data.words) ? data.words : [];
    return words.slice(session.wordStart, session.wordEnd + 1).map((w) => ({
      text: String(w.text || "").trim(),
      start: Number(w.start) || 0,
      end: Number(w.end) || Number(w.start) || 0,
    }));
  } catch {
    return [];
  }
}

function pickNextSession() {
  const all = getAllSessionsDetailed();
  if (!all.length) return null;
  const { set } = getCompletedSet();
  const remaining = all.filter((s) => !set.has(s.sessionId));
  const pool = remaining.length ? remaining : all; // if exhausted, recycle
  const exhausted = remaining.length === 0;
  // Uniform random. To keep distribution even across entries, we already
  // have uniform across sessions; long episodes naturally have more sessions,
  // which is intended (more material).
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { session: pick, exhausted, total: all.length, remaining: remaining.length };
}

function getSessionById(sessionId) {
  const all = getAllSessionsDetailed();
  return all.find((s) => s.sessionId === sessionId) || null;
}

// ---------------------------------------------------------------------------
// Grading — WER
// ---------------------------------------------------------------------------

function normalizeWords(text) {
  // Tokenize like the app's WORD_RE, then normalize for scoring:
  // lower-case, strip surrounding punctuation, drop empty.
  // For dictation scoring we follow the benchmark convention of ignoring
  // case and punctuation, so "Hello." == "hello".
  // Implementation: remove apostrophes without splitting (can't -> cant),
  // then extract \p{L}\p{N} tokens. This keeps "America's" -> "americas"
  // matching forgivingly; if you want strict apostrophe handling, keep the
  // original token.
  const s = String(text || "")
    .toLowerCase()
    // normalize curly quotes
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  // Remove apostrophes without creating a split: can't -> cant
  const noApos = s.replace(/['']/g, "");
  // Now split on anything that isn't a letter/number. Unicode-aware.
  // Equivalent to tokenizing and dropping punctuation tokens.
  const tokens = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(noApos)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function levenshteinWords(refTokens, hypTokens) {
  const n = refTokens.length;
  const m = hypTokens.length;

  // dp[i][j] = edit distance for ref[0..i) vs hyp[0..j)
  // Use 2 rows to save memory, but we also need backtrace for S/D/I —
  // so keep full matrix for small N (dictation sessions are <40 words, trivial).
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const bt = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));

  for (let i = 0; i <= n; i++) { dp[i][0] = i; if (i > 0) bt[i][0] = "D"; }
  for (let j = 0; j <= m; j++) { dp[0][j] = j; if (j > 0) bt[0][j] = "I"; }
  bt[0][0] = null;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1;
      const sub = dp[i - 1][j - 1] + cost;
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      let best = sub; let op = cost === 0 ? "C" : "S";
      if (del < best) { best = del; op = "D"; }
      if (ins < best) { best = ins; op = "I"; }
      // tie-break: prefer C/S over D/I for more natural alignment
      dp[i][j] = best;
      bt[i][j] = op;
    }
  }

  // backtrace
  let i = n, j = m;
  const ops = [];
  let S = 0, D = 0, I = 0, C = 0;
  while (i > 0 || j > 0) {
    const op = bt[i][j];
    if (op === "C") { C++; ops.push({ op: "C", ref: refTokens[i - 1], hyp: hypTokens[j - 1] }); i--; j--; }
    else if (op === "S") { S++; ops.push({ op: "S", ref: refTokens[i - 1], hyp: hypTokens[j - 1] }); i--; j--; }
    else if (op === "D") { D++; ops.push({ op: "D", ref: refTokens[i - 1], hyp: null }); i--; }
    else if (op === "I") { I++; ops.push({ op: "I", ref: null, hyp: hypTokens[j - 1] }); j--; }
    else break;
  }
  ops.reverse();
  const dist = dp[n][m];
  const wer = n === 0 ? (m === 0 ? 0 : 1) : dist / n;
  const accuracy = Math.max(0, 1 - wer);
  const score = Math.round(accuracy * 100);
  return { refTokens, hypTokens, n, m, S, D, I, C, dist, wer, accuracy, score, ops };
}

function gradeDictation(reference, hypothesis) {
  const refTokens = normalizeWords(reference);
  const hypTokens = normalizeWords(hypothesis);
  const result = levenshteinWords(refTokens, hypTokens);
  return result;
}

module.exports = {
  DICTATION_PATH,
  loadDictation,
  saveDictation,
  getCompletedSet,
  markCompleted,
  isCompleted,
  sentencesFromWords,
  splitLongSentence,
  partitionTranscript,
  isSessionValid,
  getPBSEntries,
  getAllSessionsDetailed,
  getSessionWords,
  pickNextSession,
  getSessionById,
  normalizeWords,
  levenshteinWords,
  gradeDictation,
};
