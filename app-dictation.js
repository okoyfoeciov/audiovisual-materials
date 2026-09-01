(() => {
  "use strict";

  // Daily Dictation — isolated from app-listen.js (shares only the <audio>
  // element and the bottom player bar). See backend/dictation.js for the
  // session partition algorithm and the WER grading contract.

  const LS_FEATURE = "av-feature";
  const FEATURE_WATCH = "watch";
  const FEATURE_DICTATION = "dictation";

  // DOM — created in app.html
  const tabsEl = document.getElementById("ln-tabs");
  const tabWatch = document.getElementById("tab-watch");
  const tabDict = document.getElementById("tab-dictation");
  const libraryViewEl = document.getElementById("ln-library-view");
  const videoWrap = document.getElementById("ln-video");
  const dictView = document.getElementById("dictation-view");
  const dictStatsEl = document.getElementById("dictation-stats");
  const dictMetaEl = document.getElementById("dictation-session-meta");
  const dictTitleEl = document.getElementById("dictation-title");
  const dictLoopHint = document.getElementById("dictation-loop-hint");
  const dictLoopRange = document.getElementById("dictation-loop-range");
  const dictWrap = document.getElementById("dictation-notepad-wrap");
  const dictInput = document.getElementById("dictation-input");
  const dictCheckBtn = document.getElementById("dictation-check");
  const dictRevealBtn = document.getElementById("dictation-reveal");
  const dictReplayBtn = document.getElementById("dictation-replay");
  const dictNextBtn = document.getElementById("dictation-next");
  const dictScoreEl = document.getElementById("dictation-score");
  const dictPctEl = document.getElementById("dictation-pct");
  const dictDetailEl = document.getElementById("dictation-detail");
  const dictResultEl = document.getElementById("dictation-result");
  const dictRefEl = document.getElementById("dictation-ref");
  const dictRefPanel = document.getElementById("dictation-ref-panel");
  const dictRefScroll = document.getElementById("dictation-ref-scroll");
  const dictEmptyEl = document.getElementById("dictation-empty");
  const dictEmptyMsg = document.getElementById("dictation-empty-msg");
  const dictRetryBtn = document.getElementById("dictation-retry");

  // Same <audio> the Watch feature drives — we loop a small window inside it.
  const audioEl = document.getElementById("ln-audio");
  const playerEl = document.getElementById("ln-player");
  const playBtn = document.getElementById("ln-play");

  let currentFeature = FEATURE_WATCH;
  let currentSession = null; // {sessionId, entryId, entryTitle, start, end, duration, wordCount, reference, words}
  let lastGrade = null;
  let hasCheckedThisSession = false;

  // Dedicated dictation loop — independent from the A-B word loop's
  // loopStart/loopEnd so clicks that clear that loop never clear this one.
  let dLoopStart = null, dLoopEnd = null;
  let dLoopRAF = null;
  const D_LOOP_LEAD_IN = 0.03;
  const D_LOOP_TAIL = 0.15;

  // An A-B LOOP over a phrase INSIDE the segment — right-click a reference word to
  // loop that word, right-press-and-drag across words to loop the phrase. The same
  // gesture, pads and toggle semantics as the Watch caption's loop (app-listen.js,
  // "the caption owns the right button"), on the one word-level surface dictation
  // has. It is deliberately a THIRD loop, distinct from both Watch's loopStart/
  // loopEnd and the segment window above: Watch's outside-click handler nulls only
  // its own, and the segment plays once and stops where this one repeats until
  // cleared. Both null = no A-B loop, and the segment behaves exactly as before.
  let abStart = null, abEnd = null;
  const AB_LEAD_IN = 0.03;   // start this far before the first word, so its onset isn't clipped
  const AB_TAIL = 0.12;      // …and this far past the last, so its final syllable finishes
  const AB_MIN = 0.35;       // floor length when the ASR reports end == start (degenerate)

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const DICT_WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu;

  // Strip leading/trailing punctuation, so a span reading "problem." still asks
  // the explanation panel about "problem" (what the old regex renderer captured).
  const DICT_WORD_TRIM_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

  // Reference paragraph, rendered FROM the session's ASR word array so every span
  // carries its own data-start/data-end — that is what makes a right-click or
  // right-drag loopable, exactly as the Watch caption's word spans are. The
  // session's reference text is precisely these words joined by single spaces
  // (backend/dictation.js partitionTranscript), so this reproduces it verbatim.
  function renderDictationReferenceFromWords(words) {
    let html = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const shown = String(w.text || "");
      const bare = shown.replace(DICT_WORD_TRIM_RE, "");
      html += (i ? " " : "") +
        `<span class="word dictation-ref-word" data-i="${i}" data-start="${w.start}" data-end="${w.end}"` +
        ` data-word="${escapeHtml(bare)}">${escapeHtml(shown)}</span>`;
    }
    return `<p>${html}</p>`;
  }

  // Fallback for a session the backend sent no timings for (unreadable transcript,
  // or an older backend): the words are still clickable for an explanation, they
  // just can't be looped — a right-click says so rather than dying silently.
  function renderDictationReference(reference, words) {
    if (Array.isArray(words) && words.length) return renderDictationReferenceFromWords(words);
    const text = String(reference || "");
    const re = new RegExp(DICT_WORD_RE.source, DICT_WORD_RE.flags);
    let html = '';
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) html += escapeHtml(text.slice(last, m.index));
      const w = m[0];
      html += `<span class="word dictation-ref-word" data-word="${escapeHtml(w)}">${escapeHtml(w)}</span>`;
      last = re.lastIndex;
    }
    if (last < text.length) html += escapeHtml(text.slice(last));
    return `<p>${html}</p>`;
  }

  // ---------------------------------------------------------------------------
  // Feature switch
  // ---------------------------------------------------------------------------

  function setFeature(feat, { store = true } = {}) {
    currentFeature = feat === FEATURE_DICTATION ? FEATURE_DICTATION : FEATURE_WATCH;
    const isDict = currentFeature === FEATURE_DICTATION;
    if (store) { try { localStorage.setItem(LS_FEATURE, currentFeature); } catch {} }

    // Tabs
    for (const btn of [tabWatch, tabDict]) {
      const active = btn.dataset.feature === currentFeature;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    }
    document.body.classList.toggle("dictation-on", isDict);

    // Main region ownership
    dictView.hidden = !isDict;
    if (isDict) {
      // Hide Watch-owned surfaces while preserving the explanation panel
      // (the panel stays across both features — see spec).
      // Library/video visibility is additionally forced off via body.dictation-on.
      // Make sure the player bar is visible in dictation too (audio-only).
      if (playerEl) playerEl.hidden = false;
      // Pause any Watch playback that was in progress? No — keep the same <audio>
      // but the dictation loop will take over when a session is loaded.
      refreshDictationView();
      if (!currentSession) loadNextSession({ autoplay: false });
      else ensureDictationAudio({ autoplay: false });
    } else {
      // Leaving dictation: stop its loop, but keep its session in memory so
      // returning is instant (re-press Dictation to resume same clip).
      stopDictLoop();
      clearAbLoop();
      // Let Watch decide its own library/video visibility (goHome / setSource
      // already manage hidden). Ensure dictation-only chrome is hidden from
      // the band's flex layout.
      dictView.hidden = true;
    }
    // Resize observer in Watch measures player height for --player-h; a feature
    // switch changes band content height, so nudge it.
    requestAnimationFrame(() => {
      try { window.dispatchEvent(new Event("resize")); } catch {}
    });
  }

  function initFeature() {
    let saved = null;
    try { saved = localStorage.getItem(LS_FEATURE); } catch {}
    setFeature(saved === FEATURE_DICTATION ? FEATURE_DICTATION : FEATURE_WATCH, { store: false });
  }

  if (tabWatch) tabWatch.addEventListener("click", () => setFeature(FEATURE_WATCH));
  if (tabDict) tabDict.addEventListener("click", () => setFeature(FEATURE_DICTATION));

  // Guard the Watch feature's global A-B loop clear on outside mousedown:
  // that handler calls clearLoop() on any left-click outside the caption.
  // In dictation we don't want a notepad click to kill the dictation loop.
  // The Watch code lives in a closure we can't patch directly, but we can
  // defensively re-arm our loop after its clearLoop fires (it nulls only its
  // own loopStart). Our dLoopStart is separate, so no action needed — the
  // dictation loop survives that handler by design. This comment is the
  // invariant.

  // ---------------------------------------------------------------------------
  // Dictation — stats + session loading
  // ---------------------------------------------------------------------------

  async function fetchDictStats() {
    return null;
  }

  async function refreshDictationView() {
    if (dictStatsEl) { dictStatsEl.textContent = ""; dictStatsEl.hidden = true; }
  }

  function showDictEmpty(msg) {
    dictEmptyMsg.textContent = msg || "No dictation sessions available.";
    dictEmptyEl.hidden = false;
    dictWrap.hidden = true;
    dictMetaEl.hidden = true;
    dictLoopHint.hidden = true;
  }

  function showDictReady() {
    dictEmptyEl.hidden = true;
    dictWrap.hidden = false;
    dictMetaEl.hidden = false;
  }

  function hideDictRef() {
    clearAbLoop();   // the looped words are gone, so the loop goes with them
    if (dictRefEl) { dictRefEl.hidden = true; dictRefEl.innerHTML = ""; }
    if (dictRefPanel) dictRefPanel.hidden = true;
    if (dictRefScroll) dictRefScroll.scrollTop = 0;
  }
  function showDictRef() {
    if (dictRefEl) dictRefEl.hidden = false;
    if (dictRefPanel) dictRefPanel.hidden = false;
    // Scroll the panel's content to top and bring panel into view
    if (dictRefPanel) dictRefPanel.scrollIntoView({ block: "nearest" });
    if (dictRefScroll) dictRefScroll.scrollTop = 0;
  }

  async function loadNextSession({ autoplay = true } = {}) {
    if (dictStatsEl) { dictStatsEl.textContent = ""; dictStatsEl.hidden = true; }
    dictCheckBtn.disabled = true;
    dictNextBtn.disabled = true;
    dictResultEl.hidden = true;
    dictResultEl.innerHTML = "";
    hideDictRef();
    dictScoreEl.hidden = true;
    lastGrade = null;
    hasCheckedThisSession = false;
    dictInput.value = "";
    dictRevealBtn.hidden = true;

    try {
      const r = await fetch(apiBase() + "/api/dictation/session");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      currentSession = {
        sessionId: data.sessionId,
        entryId: data.entryId,
        entryTitle: data.entryTitle,
        start: Number(data.start) || 0,
        end: Number(data.end) || 0,
        duration: Number(data.duration) || 0,
        wordCount: Number(data.wordCount) || 0,
        reference: String(data.reference || ""),
        // Per-word ASR timings for this segment — the raw material for the A-B
        // loop below. [] from a backend that couldn't read the transcript.
        words: Array.isArray(data.words) ? data.words.map((w) => ({
          text: String(w.text || ""),
          start: Number(w.start) || 0,
          end: Number(w.end) || Number(w.start) || 0,
        })) : [],
      };
      // Update header
      dictTitleEl.textContent = currentSession.entryTitle || currentSession.entryId;
      dictTitleEl.title = currentSession.entryTitle || "";
      dictLoopRange.textContent = `${fmt(currentSession.start)} – ${fmt(currentSession.end)}  ·  ${currentSession.wordCount} words`;
      dictLoopHint.hidden = false;
      showDictReady();
      dictCheckBtn.disabled = false;
      dictNextBtn.disabled = false;
      await ensureDictationAudio({ autoplay });
      if (dictStatsEl) { dictStatsEl.textContent = ""; dictStatsEl.hidden = true; }
      refreshDictationView();
    } catch (e) {
      console.error("dictation next failed", e);
      showDictEmpty(e && e.message ? String(e.message) : "Could not load a session.");
      if (dictStatsEl) { dictStatsEl.textContent = ""; dictStatsEl.hidden = true; }
      dictNextBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Dictation — audio (loop whole file, play window [dLoopStart, dLoopEnd))
  // ---------------------------------------------------------------------------

  function stopDictLoop() {
    dLoopStart = null; dLoopEnd = null;
    if (dLoopRAF != null) { cancelAnimationFrame(dLoopRAF); dLoopRAF = null; }
  }

  function startDictLoop() {
    if (dLoopRAF == null) dLoopRAF = requestAnimationFrame(dictLoopTick);
  }

  function dictLoopTick() {
    dLoopRAF = null;
    if (!audioEl.src || audioEl.paused || audioEl.error) return;
    // An A-B loop takes precedence over the segment window, and REPEATS where the
    // segment deliberately plays once and stops (the pause branch below).
    if (abStart != null && abEnd != null) {
      if ((audioEl.currentTime || 0) >= abEnd) {
        try { audioEl.currentTime = Math.max(0, abStart - AB_LEAD_IN); } catch {}
      }
      dLoopRAF = requestAnimationFrame(dictLoopTick);
      return;
    }
    if (dLoopStart == null || dLoopEnd == null) return;
    const pos = audioEl.currentTime || 0;
    if (pos >= dLoopEnd - 0.02) {
      // Auto-loop disabled: play once then pause and reset to start for
      // next manual play. Previous code left playhead at dLoopEnd, so the
      // next click on Play immediately hit this condition again and appeared
      // to "switch off" instantly.
      try { audioEl.pause(); } catch {}
      try { audioEl.currentTime = Math.max(0, dLoopStart - D_LOOP_LEAD_IN); } catch {}
      return;
    }
    dLoopRAF = requestAnimationFrame(dictLoopTick);
  }

  // ---------------------------------------------------------------------------
  // A-B loop over a phrase inside the segment (right-click / right-drag)
  // ---------------------------------------------------------------------------

  // Momentary message in the header's loop-range slot, restored after a beat.
  // Dictation has no access to Watch's flashHint() — it lives in that closure.
  let loopHintTimer = null;
  function flashLoopHint(msg) {
    if (!dictLoopRange) return;
    dictLoopRange.textContent = msg;
    if (loopHintTimer) clearTimeout(loopHintTimer);
    loopHintTimer = setTimeout(() => {
      loopHintTimer = null;
      if (!currentSession) return;
      dictLoopRange.textContent =
        `${fmt(currentSession.start)} \u2013 ${fmt(currentSession.end)}  \u00b7  ${currentSession.wordCount} words`;
    }, 1800);
  }

  // Mark every reference word inside [abStart, abEnd) with .looping. Matched by
  // start time rather than index, so it survives a re-render of the paragraph.
  function applyAbLoopMark() {
    if (!dictRefEl) return;
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) {
      const s = parseFloat(sp.dataset.start);
      sp.classList.toggle("looping",
        abStart != null && !isNaN(s) && s >= abStart - 0.001 && s < abEnd - 0.001);
    }
  }

  // Always repaints, even when nothing was looping — it doubles as the way a
  // drag PREVIEW is wiped when the gesture ends without setting a loop.
  function clearAbLoop() {
    abStart = null; abEnd = null;
    applyAbLoopMark();
  }

  // Loop reference words [i0..i1] (one word when i0 === i1): jump to the phrase and
  // play it at once, so the loop is audible without touching the transport.
  function setAbLoopFromWords(i0, i1) {
    const words = (currentSession && currentSession.words) || [];
    const a = Math.min(i0, i1), b = Math.max(i0, i1);
    let s = Infinity, e = -Infinity;
    for (let k = a; k <= b; k++) {
      const w = words[k];
      if (!w || !isFinite(w.start)) continue;
      if (w.start < s) s = w.start;
      const we = (isFinite(w.end) && w.end > w.start) ? w.end : w.start;
      if (we > e) e = we;
    }
    if (!isFinite(s) || !isFinite(e)) { flashLoopHint("No word timings to loop"); return false; }
    if (e - s < 0.05) e = s + AB_MIN;                    // ASR gave no real end → synthesize one
    e += AB_TAIL;
    const next = words[b + 1];                           // …but never reach into the next word
    if (next && isFinite(next.start)) e = Math.min(e, next.start);
    abStart = s; abEnd = e;
    applyAbLoopMark();
    try { audioEl.currentTime = Math.max(0, abStart - AB_LEAD_IN); } catch {}
    if (audioEl.paused) { const p = audioEl.play(); if (p && p.catch) p.catch(() => {}); }
    startDictLoop();
    return true;
  }

  async function ensureDictationAudio({ autoplay = true } = {}) {
    if (!currentSession) return;
    const src = apiBase() + "/api/library/" + encodeURIComponent(currentSession.entryId) + "/stream";
    const dStart = currentSession.start;
    const dEnd = currentSession.end;

    // If the <audio> already points at this entry, just move the loop window
    // and seek (don't reload the stream — that would re-buffer).
    const currentSrc = audioEl.getAttribute("src") || audioEl.src || "";
    const sameEntry = currentSrc.includes("/api/library/" + encodeURIComponent(currentSession.entryId) + "/");

    dLoopStart = dStart;
    dLoopEnd = dEnd + D_LOOP_TAIL; // let final syllable finish

    if (sameEntry && audioEl.src) {
      try { audioEl.currentTime = Math.max(0, dStart - D_LOOP_LEAD_IN); } catch {}
      if (currentFeature === FEATURE_DICTATION) startDictLoop();
      if (autoplay) {
        if (audioEl.paused) {
          const p = audioEl.play();
          if (p && p.catch) p.catch(() => {});
        }
      } else {
        try { audioEl.pause(); } catch {}
      }
      return;
    }

    // New entry: point the shared <audio> at it. The Watch feature's
    // currentEntry stays as-is — we deliberately don't call setSource() which
    // would trigger a transcript fetch and video toggle.
    audioEl.src = src;
    try { audioEl.load(); } catch {}
    // Wait for metadata to know duration before seeking
    const seekToLoop = () => {
      try { audioEl.currentTime = Math.max(0, dStart - D_LOOP_LEAD_IN); } catch {}
      if (currentFeature === FEATURE_DICTATION) startDictLoop();
      if (autoplay) {
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => {});
      }
      audioEl.removeEventListener("loadedmetadata", seekToLoop);
    };
    if (audioEl.readyState >= 1) seekToLoop();
    else audioEl.addEventListener("loadedmetadata", seekToLoop);

    // Ensure player bar is enabled (Watch may have left it disabled when idle)
    if (playBtn) playBtn.disabled = false;
    const backBtn = document.getElementById("ln-back");
    const fwdBtn = document.getElementById("ln-fwd");
    if (backBtn) backBtn.disabled = false;
    if (fwdBtn) fwdBtn.disabled = false;
    if (playerEl) playerEl.hidden = false;
  }

  // Dictation segment monitor — play once then pause at segment end
  // (auto-loop disabled). Keep monitoring on play/seeked so we stop
  // precisely at dLoopEnd; do NOT restart on 'ended'.
  if (audioEl) {
    audioEl.addEventListener("play", () => {
      if (currentFeature === FEATURE_DICTATION && (dLoopStart != null || abStart != null)) startDictLoop();
    });
    audioEl.addEventListener("ended", () => {
      if (currentFeature !== FEATURE_DICTATION) return;
      // An A-B loop whose end sits at the very end of the file reaches 'ended'
      // before the watcher catches it — send it round again rather than stopping.
      if (abStart != null) {
        try { audioEl.currentTime = Math.max(0, abStart - AB_LEAD_IN); } catch {}
        const p = audioEl.play(); if (p && p.catch) p.catch(() => {});
        startDictLoop();
        return;
      }
      if (dLoopStart == null) return;
      stopDictLoop();
    });
    audioEl.addEventListener("seeked", () => {
      if (currentFeature !== FEATURE_DICTATION || (dLoopStart == null && abStart == null)) return;
      if (!audioEl.paused) startDictLoop();
    });
  }

  if (dictReplayBtn) dictReplayBtn.addEventListener("click", () => {
    if (!currentSession) return;
    try { audioEl.currentTime = Math.max(0, currentSession.start - D_LOOP_LEAD_IN); } catch {}
    if (audioEl.paused) { const p = audioEl.play(); if (p && p.catch) p.catch(() => {}); }
    startDictLoop();
  });

  // The Watch ticker (150 ms) also re-arms a backgrounded loop; give
  // dictation the same safety via the same visibility hook (no extra work).

  // ---------------------------------------------------------------------------
  // Checker
  // ---------------------------------------------------------------------------

  function renderGrade(result) {
    const { score, wer, n, S, D, I, C, ops, reference } = result;
    lastGrade = result;
    hasCheckedThisSession = true;

    // Score badge
    dictPctEl.textContent = `${score}%`;
    dictPctEl.className = "pct " + (score >= 85 ? "good" : score >= 60 ? "mid" : "bad");
    const accPct = Math.round((1 - wer) * 100); // same as score but may be 0-100; show raw WER too
    const detail = `${C}/${n} correct · ${S} sub · ${D} del · ${I} ins · WER ${(wer * 100).toFixed(1)}%`;
    dictDetailEl.textContent = detail;
    dictScoreEl.hidden = false;

    // Alignment as a flowing paragraph of spans.
    // ops is in order; for dictation we render reference-side view:
    //  C = green, S = red striked + show hyp, D = amber dashed (missing), I = italic insertion.
    let html = "";
    for (const op of ops) {
      if (op.op === "C") {
        html += `<span class="word correct" title="Correct">${escapeHtml(op.ref)}</span> `;
      } else if (op.op === "S") {
        html += `<span class="word sub" title="Should be “${escapeHtml(op.ref)}”, you wrote “${escapeHtml(op.hyp)}”">${escapeHtml(op.hyp)}</span> `;
      } else if (op.op === "D") {
        html += `<span class="word missing" title="Missing: “${escapeHtml(op.ref)}”">${escapeHtml(op.ref)}</span> `;
      } else if (op.op === "I") {
        html += `<span class="word ins" title="Extra word">${escapeHtml(op.hyp)}</span> `;
      }
    }
    dictResultEl.innerHTML = html.trim() || `<span style="color:var(--text-dim)">No words to compare.</span>`;
    dictResultEl.hidden = false;

    // Reference paragraph — hidden until Reveal, words are clickable
    // to trigger the same explanation panel as Watch (via window.__dictationExplain)
    dictRefEl.innerHTML = renderDictationReference(reference, currentSession && currentSession.words);
    dictRevealBtn.hidden = false;
    // Auto-scroll the result into view
    dictResultEl.scrollIntoView({ block: "nearest" });
  }

  function showRef() {
    showDictRef();
  }

  async function checkCurrent() {
    if (!currentSession) return;
    const hypothesis = dictInput.value || "";
    if (!hypothesis.trim()) {
      dictInput.focus();
      // Brief hint via the score slot
      dictPctEl.textContent = "—";
      dictPctEl.className = "pct bad";
      dictDetailEl.textContent = "Type something first";
      dictScoreEl.hidden = false;
      return;
    }
    dictCheckBtn.disabled = true;
    dictCheckBtn.textContent = "Checking…";
    try {
      const r = await fetch(apiBase() + "/api/dictation/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSession.sessionId, hypothesis }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      renderGrade(data);
      // Also mark for persistence in header stats? Not yet completed — only on Next.
    } catch (e) {
      console.error("check failed", e);
      dictResultEl.hidden = false;
      dictResultEl.textContent = "Check failed: " + String(e.message || e);
    } finally {
      dictCheckBtn.disabled = false;
      dictCheckBtn.textContent = "Check";
    }
  }

  async function completeAndNext() {
    // Clear grading numbers instantly on Next — don't wait for /complete or
    // /session round-trips (previous behavior kept 85% / WER visible until
    // loadNextSession's fetch completed). Capture score before clearing.
    const scoreToSave = lastGrade && typeof lastGrade.score === "number" ? lastGrade.score : null;
    dictScoreEl.hidden = true;
    dictPctEl.textContent = "—";
    dictPctEl.className = "pct";
    dictDetailEl.textContent = "";
    dictResultEl.hidden = true;
    dictResultEl.innerHTML = "";
    hideDictRef();
    dictRevealBtn.hidden = true;
    lastGrade = null;
    hasCheckedThisSession = false;

    // Mark current session as done if the user at least interacted?
    // Spec: "We must track which sessions already exist" — don't re-pick
    // completed. Mark on Next regardless of whether they checked, so a
    // skipped session also doesn't come back. Include score when available.
    if (currentSession) {
      try {
        await fetch(apiBase() + "/api/dictation/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: currentSession.sessionId,
            score: scoreToSave,
          }),
        });
      } catch (e) {
        console.warn("complete mark failed", e);
      }
    }
    await loadNextSession();
    dictInput.focus();
  }

  if (dictCheckBtn) dictCheckBtn.addEventListener("click", checkCurrent);
  if (dictRevealBtn) dictRevealBtn.addEventListener("click", showRef);
  if (dictNextBtn) dictNextBtn.addEventListener("click", completeAndNext);
  if (dictRetryBtn) dictRetryBtn.addEventListener("click", loadNextSession);

  // Clicking a word in the Reference line triggers the explanation panel
  // (same panel as Watch, via window.__dictationExplain exposed by app-listen.js).
  if (dictRefEl) dictRefEl.addEventListener("click", (e) => {
    const span = e.target.closest && e.target.closest(".dictation-ref-word");
    if (!span) return;
    const word = span.dataset.word || span.textContent || "";
    const context = currentSession ? currentSession.reference : dictRefEl.textContent.replace(/^Reference:\s*/, "");
    if (window.__dictationExplain) window.__dictationExplain(word, context);
  });

  // Right-click a Reference word to loop it, right-press-and-drag across words to
  // loop the phrase — the Watch caption's gesture, on the dictation panel. The
  // right button doesn't drag-select natively (it fires 'contextmenu', suppressed
  // just below), so the whole gesture is driven off mousedown → mousemove → mouseup
  // ourselves, exactly as app-listen.js does for the caption.
  let abDrag = null;

  // Live preview while dragging: paint the range as it WOULD loop, without
  // committing it. Wiped by applyAbLoopMark() when the gesture ends.
  function paintAbDragRange() {
    if (!abDrag || abDrag.startIdx == null || !dictRefEl) return;
    const a = Math.min(abDrag.startIdx, abDrag.currentIdx);
    const b = Math.max(abDrag.startIdx, abDrag.currentIdx);
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) {
      const i = Number(sp.dataset.i);
      sp.classList.toggle("looping", !isNaN(i) && i >= a && i <= b);
    }
  }

  if (dictRefEl) {
    // The panel owns the right button, so the native menu never pops mid-gesture.
    dictRefEl.addEventListener("contextmenu", (e) => { e.preventDefault(); });

    dictRefEl.addEventListener("mousedown", (e) => {
      if (e.button !== 2) return;
      e.preventDefault();
      if (!currentSession || !(currentSession.words || []).length) {
        flashLoopHint("No word timings to loop");
        return;
      }
      const span = e.target.closest && e.target.closest(".dictation-ref-word");
      // Right-pressing OFF a word leaves startIdx null; mousemove can still anchor
      // the drag on the first word it crosses, and a release that never did clears.
      const i = span && span.dataset.i !== undefined ? Number(span.dataset.i) : null;
      abDrag = { startIdx: i, currentIdx: i, moved: false };
      if (i != null) paintAbDragRange();
    });

    dictRefEl.addEventListener("mousemove", (e) => {
      if (!abDrag) return;
      if (e.buttons === 0) {   // a release we never saw — recover, don't keep a stale preview
        abDrag = null;
        applyAbLoopMark();
        return;
      }
      const span = e.target.closest && e.target.closest(".dictation-ref-word");
      if (!span || span.dataset.i === undefined) return;
      const i = Number(span.dataset.i);
      if (abDrag.startIdx == null) { abDrag.startIdx = abDrag.currentIdx = i; paintAbDragRange(); return; }
      if (i === abDrag.currentIdx) return;
      abDrag.currentIdx = i;
      if (i !== abDrag.startIdx) abDrag.moved = true;
      paintAbDragRange();
    });
  }

  // Released anywhere, so a drag that slips off the panel still commits.
  window.addEventListener("mouseup", () => {
    if (!abDrag) return;
    const ds = abDrag; abDrag = null;
    if (ds.startIdx == null) { clearAbLoop(); return; }   // right-clicked empty space → stop
    // A single right-click on the word already looping toggles the loop OFF.
    const w0 = ((currentSession && currentSession.words) || [])[ds.startIdx];
    if (!ds.moved && w0 && abStart != null && Math.abs((Number(w0.start) || 0) - abStart) < 0.001) {
      clearAbLoop();
      return;
    }
    setAbLoopFromWords(ds.startIdx, ds.currentIdx);
  });

  // The same reflex Watch has: ANY press other than the right button (which sets or
  // extends the loop) stops it — click anywhere to stop looping. Scoped to the
  // dictation feature so it never touches Watch's own loop.
  document.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;
    if (currentFeature !== FEATURE_DICTATION) return;
    if (abStart == null) return;
    clearAbLoop();
  });

  // Esc stops the loop, mirroring Watch. Allowed while the notepad has focus —
  // Escape types nothing, and a learner mid-sentence is exactly who wants it.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (currentFeature !== FEATURE_DICTATION) return;
    if (e.key !== "Escape" || abStart == null) return;
    e.preventDefault();
    clearAbLoop();
  });

  // Keyboard: Ctrl/Cmd+Enter to check, Enter on next when focused, and
  // plain Enter in the textarea should NOT submit (learner needs newlines).
  if (dictInput) {
    dictInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        checkCurrent();
      }
    });
  }

  // Allow the player bar's global Space handler to control the shared <audio>
  // even in dictation — no need to suppress. But when the textarea is focused
  // Space must type, so that global handler already bails when document.activeElement
  // is a text field (see app-listen.js isEditableTarget) — no action needed.

  // ---------------------------------------------------------------------------
  // Reference panel — touch-scroll quarantine (mirrors keepScrollInside)
  // ---------------------------------------------------------------------------
  (function wireDictRefScroll() {
    if (dictRefScroll) {
      let lastY = 0;
      dictRefScroll.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) lastY = e.touches[0].clientY;
      }, { passive: true });
      dictRefScroll.addEventListener("touchmove", (e) => {
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const dy = y - lastY;
        lastY = y;
        if (dy === 0) return;
        const canScroll = dictRefScroll.scrollHeight - dictRefScroll.clientHeight > 0;
        const atTop = dictRefScroll.scrollTop <= 0;
        const atBottom = dictRefScroll.scrollTop + dictRefScroll.clientHeight >= dictRefScroll.scrollHeight - 1;
        if ((!canScroll || (atTop && dy > 0) || (atBottom && dy < 0)) && e.cancelable) e.preventDefault();
      }, { passive: false });
    }
  })();

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  initFeature();
  if (currentFeature === FEATURE_DICTATION && !currentSession) {
    loadNextSession({ autoplay: false });
  } else {
    refreshDictationView();
  }

  // Expose for console debugging
  window.__dictation = {
    get session() { return currentSession; },
    get feature() { return currentFeature; },
    get abLoop() { return abStart == null ? null : { start: abStart, end: abEnd }; },
    setFeature,
    loadNextSession,
    checkCurrent,
    completeAndNext,
  };
})();
