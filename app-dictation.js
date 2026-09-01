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
  const dictEmptyEl = document.getElementById("dictation-empty");
  const dictEmptyMsg = document.getElementById("dictation-empty-msg");
  const dictRetryBtn = document.getElementById("dictation-retry");

  // Same <audio> the Watch feature drives — we loop a small window inside it.
  const audioEl = document.getElementById("ln-audio");
  const playerEl = document.getElementById("ln-player");
  const playBtn = document.getElementById("ln-play");
  const bandEl = document.getElementById("ln-explain-band");

  let currentFeature = FEATURE_WATCH;
  let currentSession = null; // {sessionId, entryId, entryTitle, start, end, duration, wordCount, reference}
  let lastGrade = null;
  let hasCheckedThisSession = false;

  // Dedicated dictation loop — independent from the A-B word loop's
  // loopStart/loopEnd so clicks that clear that loop never clear this one.
  let dLoopStart = null, dLoopEnd = null;
  let dLoopRAF = null;
  const D_LOOP_LEAD_IN = 0.03;
  const D_LOOP_TAIL = 0.15;

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

  async function loadNextSession({ autoplay = true } = {}) {
    if (dictStatsEl) { dictStatsEl.textContent = ""; dictStatsEl.hidden = true; }
    dictCheckBtn.disabled = true;
    dictNextBtn.disabled = true;
    dictResultEl.hidden = true;
    dictResultEl.innerHTML = "";
    dictRefEl.hidden = true;
    dictRefEl.innerHTML = "";
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
    if (dLoopStart == null || dLoopEnd == null) return;
    if (!audioEl.src || audioEl.paused || audioEl.error) return;
    const pos = audioEl.currentTime || 0;
    if (pos >= dLoopEnd - 0.02) {
      // Auto-loop disabled: play the segment once then pause at the end
      // instead of seeking back to the start. User must press Replay.
      try { audioEl.pause(); } catch {}
      try { audioEl.currentTime = dLoopEnd; } catch {}
      return;
    }
    dLoopRAF = requestAnimationFrame(dictLoopTick);
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
    audioEl.addEventListener("play", () => { if (currentFeature === FEATURE_DICTATION && dLoopStart != null) startDictLoop(); });
    audioEl.addEventListener("ended", () => {
      if (currentFeature !== FEATURE_DICTATION || dLoopStart == null) return;
      stopDictLoop();
    });
    audioEl.addEventListener("seeked", () => {
      if (currentFeature !== FEATURE_DICTATION || dLoopStart == null) return;
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

    // Reference paragraph — hidden until Reveal
    dictRefEl.innerHTML = `<strong>Reference:</strong> ${escapeHtml(reference)}`;
    dictRevealBtn.hidden = false;
    // Auto-scroll the result into view
    dictResultEl.scrollIntoView({ block: "nearest" });
  }

  function showRef() {
    dictRefEl.hidden = false;
    dictRefEl.scrollIntoView({ block: "nearest" });
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
    dictRefEl.hidden = true;
    dictRefEl.innerHTML = "";
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
  // Boot
  // ---------------------------------------------------------------------------

  initFeature();
  if (currentFeature === FEATURE_DICTATION && !currentSession) {
    loadNextSession();
  } else {
    refreshDictationView();
  }

  // Expose for console debugging
  window.__dictation = {
    get session() { return currentSession; },
    get feature() { return currentFeature; },
    setFeature,
    loadNextSession,
    checkCurrent,
    completeAndNext,
  };
})();
