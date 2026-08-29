(function () {
  "use strict";

  /* Listen — a synced 3-sentence transcript window and word-by-word
     explanations over media served from this app's own local media-library
     backend. Pick an entry from the library and it streams straight from
     /api/library/:id/stream (range-requested, so seeking works); the backend
     transcribes new imports once, up front, via the self-hosted Parakeet STT
     service, and this page just polls /api/library/:id/transcript until it's
     ready. Playback position is saved server-side per entry, so a relaunch
     resumes where you left off. Wrapped in its own IIFE so it can't collide
     with the exscriptor script above. */

  /* ---------- render helpers ---------- */

  const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu;
  const PRON_BRACKET_RE = /\[\[PRON\b([^\]]*?)\]\]/g;
  const PRON_WORD_ATTR_RE = /\bword="([^"]*)"/;
  const PRON_POS_ATTR_RE = /\bpos="([^"]*)"/;
  // ipa="…" is the LLM's own best-effort respelling, used as the fallback badge
  // when Merriam-Webster has no pronunciation for the word (see badgeHtml).
  const PRON_IPA_ATTR_RE = /\bipa="([^"]*)"/;
  // [[SENSE p="N"]] — how likely this reading of the passage is, as a whole
  // percent. The model emits one per sense ONLY when a passage genuinely leaves
  // the sense open and the answer therefore carries more than one (the prompt's
  // Ambiguity rule); an unambiguous item gets none.
  const SENSE_BRACKET_RE = /\[\[SENSE\b([^\]]*?)\]\]/g;
  const SENSE_P_ATTR_RE = /\bp="\s*(\d{1,3})\s*%?"/;
  // Any placeholder tag, half-streamed or whole — used to hide a tag that is
  // still arriving so half of one never flashes on screen.
  const ANY_TAG_OPENERS = ["[[PRON", "[[SENSE"];

  const POS_ABBREV = {
    noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.",
    preposition: "prep.", conjunction: "conj.",
    interjection: "interj.", pronoun: "pron.",
  };

  function tokenize(text) {
    const re = new RegExp(WORD_RE.source, WORD_RE.flags);
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ type: "sep", value: text.slice(last, m.index) });
      out.push({ type: "word", value: m[0] });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ type: "sep", value: text.slice(last) });
    return out;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // The POS "head": the bare part of speech with MW's "(1)" / "(2)" sense
  // suffix and any trailing words ("transitive verb") dropped — so "noun (2)"
  // and "noun" both reduce to "noun" for matching.
  function posHead(pos) {
    return String(pos || "").toLowerCase().split(/[\s(]/)[0];
  }

  function posAbbrev(pos) {
    if (!pos) return "";
    const head = posHead(pos);
    return POS_ABBREV[head] || head;
  }

  // The LLM is told to give a bare MW-style respelling, but tolerate stray
  // wrapping (\…\, /…/, [ … ]) or whitespace so a slip never shows up in a badge.
  function normIpa(s) {
    return String(s || "").trim().replace(/^[\\/\[]+|[\\/\]]+$/g, "").trim();
  }

  // Reduce a respelling to its bare letters — stress marks, syllable hyphens,
  // dots and spaces stripped — so two transcriptions of the SAME sound compare
  // equal even if one omits a stress mark. Used only to line up the LLM's own
  // ipa against Merriam-Webster's, to disambiguate same-POS homographs.
  function ipaSkeleton(s) {
    return normIpa(s).toLowerCase().replace(/[ˈˌ.\-\s]/g, "");
  }

  function badgeKey({ word, pos }) {
    return `${word.toLowerCase()}|${(pos || "").toLowerCase()}`;
  }

  function dedupeItems(items) {
    const seen = new Set(); const out = [];
    for (const it of items) {
      const key = (it.phrase || "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(it);
    }
    return out;
  }

  function parsePronAttrs(body) {
    const w = PRON_WORD_ATTR_RE.exec(body);
    const p = PRON_POS_ATTR_RE.exec(body);
    if (!w || !p) return null;
    const i = PRON_IPA_ATTR_RE.exec(body);
    return { word: w[1], pos: p[1], ipa: i ? normIpa(i[1]) : "" };
  }

  // Odds of one reading, as the model rated it. Deliberately not a button: the
  // pronunciation badge is clickable (it plays audio), and a chip that looks
  // interactive but isn't is worse than one that plainly isn't.
  function senseOddsHtml(pct) {
    const lead = pct >= 50 ? " lead" : "";
    const title = `About ${pct} readers in 100 would read the passage this way` +
      " — the model's own estimate, not a dictionary fact";
    return `<span class="sense-odds${lead}" title="${escapeHtml(title)}" ` +
      `aria-label="${escapeHtml(title)}">${pct}%</span>`;
  }

  // Placeholders are lifted out BEFORE escaping/markdown so their attributes are
  // never mangled, then dropped back in afterwards. The sentinel is wrapped in
  // U+0001 rather than spaces: a space-delimited sentinel could not match two
  // placeholders separated by a single space (the first match ate the space the
  // second one needed), which silently printed a raw "PH1" into the answer. The
  // optional " ?" on each side keeps the old spacing — a tag between two words
  // still collapses to zero gap, and the chips carry their own margins.
  function inline(s, renderBadge) {
    const placeholders = [];
    const stash = (html) => {
      const i = placeholders.length;
      placeholders.push(html);
      return `\u0001${i}\u0001`;
    };
    s = s.replace(PRON_BRACKET_RE, (_, body) => {
      const attrs = parsePronAttrs(body);
      if (!attrs) return " ";
      return stash(renderBadge ? renderBadge(attrs) : "");
    });
    s = s.replace(SENSE_BRACKET_RE, (_, body) => {
      const m = SENSE_P_ATTR_RE.exec(body);
      if (!m) return " ";
      const pct = Number(m[1]);
      if (!(pct >= 1 && pct <= 100)) return " ";
      return stash(senseOddsHtml(pct));
    });
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/ ?\u0001(\d+)\u0001 ?/g, (_, i) => placeholders[Number(i)] || "");
    return s;
  }

  function renderMarkdownPure(src, renderBadge) {
    const blocks = src.split(/\n{2,}/).map((b) => b.replace(/\s+$/, "")).filter(Boolean);
    const out = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      let bufP = [], bufQ = [];
      const flushP = () => { if (bufP.length) { out.push(`<p>${inline(bufP.join(" "), renderBadge)}</p>`); bufP = []; } };
      const flushQ = () => { if (bufQ.length) { out.push(`<blockquote>${bufQ.map((b) => inline(b, renderBadge)).join("<br>")}</blockquote>`); bufQ = []; } };
      for (const ln of lines) {
        const m = /^>\s?(.*)$/.exec(ln);
        if (m) { flushP(); bufQ.push(m[1]); }
        else { flushQ(); bufP.push(ln); }
      }
      flushP(); flushQ();
    }
    return out.join("");
  }
  function renderMarkdown(src) { return renderMarkdownPure(src, badgeHtml); }

  /* ---------- DOM ---------- */

  const nowWindow = document.getElementById("ln-now");
  const bandEl = document.getElementById("ln-explain-band");
  const bandLoadingEl = document.getElementById("ln-band-loading");

  // The explanation band is the page's always-on main region (it fills the area
  // above the player), so it's never hidden — only its contents change. This
  // helper just manages the caption by playback state:
  //   idle    — nothing loaded: caption empty (open a file via the bar button).
  //   loading — file opened, transcript generating: spinner in the caption spot.
  //   active  — transcript ready: caption shows the current line (buildWindow).
  function setListen(state) {
    bandLoadingEl.hidden = true;   // retired: the spinner now lives in the caption
    libraryViewEl.hidden = state !== "idle";
    if (state === "idle") {
      nowWindow.innerHTML = "";
      renderLibraryGrid(libraryViewEl, libraryEntries);
    } else if (state === "loading") {
      showWindowStatus("", "loading");   // spinner at the current-line spot
    }
  }
  const warnEl = document.getElementById("ln-warn");
  const playerEl = document.getElementById("ln-player");
  const bar = document.getElementById("ln-bar");
  const openBtn = document.getElementById("ln-open");      // bar's "Library" button
  const libraryViewEl = document.getElementById("ln-library-view");
  const playBtn = document.getElementById("ln-play");
  const backBtn = document.getElementById("ln-back");   // mobile ←: jump −5s
  const fwdBtn = document.getElementById("ln-fwd");      // mobile →: jump +5s
  const collapseBtn = document.getElementById("ln-collapse"); // mobile: hide the player
  const fabEl = document.getElementById("ln-fab");            // mobile: floating "show player" button
  const BASE_TITLE = document.title;   // restored when no file is loaded
  const trackEl = document.getElementById("ln-track");
  const fillEl = document.getElementById("ln-fill");
  const timeEl = document.getElementById("ln-time");
  const audioEl = document.getElementById("ln-audio");

  /* ---------- state ---------- */

  let currentEntry = null;         // the loaded library entry (for the tab title, progress URL, …)
  let transcriptToken = 0;
  let ticker = null;
  // While a programmatic seek (arrow keys / track click) is in flight, Chrome
  // keeps reporting the OLD audioEl.currentTime until the seek actually lands.
  // Reading it to drive the caption made the transcript lag the audio when
  // seeking fast, and reading it as the base for the next ±5s jump made rapid
  // presses under-shoot. Track the intended target and treat it as the source
  // of truth until 'seeked' confirms the audio caught up. null = not seeking.
  let seekTarget = null;
  function effPos() { return seekTarget != null ? seekTarget : (audioEl.currentTime || 0); }

  // An A-B LOOP over the caption: right-click a word to loop just that word, or
  // right-press-and-drag across words to loop the phrase. loopStart/loopEnd are
  // plain numbers (SECONDS), NOT DOM nodes — the caption repaints every 150ms and
  // shows only two lines, so a looped word's span is transient; the timestamps are
  // stable. While a loop is set and the clip is playing, a requestAnimationFrame
  // watcher (loopTick) seeks back to loopStart each time playback reaches loopEnd.
  // Both null = no loop. Only settable in reveal mode, where each word span carries
  // a data-start/data-end (see paintWindow). This supersedes the older manual
  // "checkpoint" (which pinned one word so ← replayed it) — the loop does it
  // automatically. Cleared by right-clicking off a word, right-clicking the same
  // looped word again, Esc, forward-seeking past it, or loading a new clip.
  let loopStart = null, loopEnd = null;
  // Small pads so a word loop doesn't clip its own onset or bleed the next word's
  // attack — ASR word boundaries are estimates. Tunable.
  const LOOP_LEAD_IN = 0.03;    // begin this many seconds before loopStart (don't clip the onset)
  const LOOP_TAIL = 0.12;       // play this far PAST the word's end so the last syllable ("…tion") finishes
  const LOOP_MIN = 0.35;        // floor length when the ASR reports end == start (degenerate)

  // Word timestamps from any ASR are an after-the-fact estimate, so on long audio
  // they can drift. One reader control softens that:
  //   syncOffset — nudge the timing (] earlier / [ later) to cancel a constant
  //               lead/lag. In SECONDS; positive lights words sooner. Persists.
  // The line-switching always runs off sentence starts; the offset shifts the
  // DISPLAY clock only (not the seek math, which stays on effPos).
  let syncOffset = Number(localStorage.getItem("zx-offset")) || 0;
  function syncTime() { return effPos() + syncOffset; }

  // transcript → sentence chunks + the 3-sentence window
  let chunks = [], chunkIndex = 0, synced = true;
  // True once a transcript carries per-word timings; drives the word-by-word
  // caption reveal (karaoke). Stays false for word-less transcripts, which show
  // whole lines because there is nothing to reveal against.
  let wordReveal = false;
  // The karaoke reveal is always on when the transcript HAS word timings — there
  // is no toggle to turn it off.
  function revealActive() { return wordReveal; }
  let tokens = [], windowLayout = [], frozen = false;

  // A single explanation panel off the caption (O). Each new O
  // selection refreshes it (overrides the previous one); inside it the answers
  // form a drill-down chain R1 → R2 → … (one round each). Picking a word/phrase
  // in round R_k regenerates R_(k+1) and drops every round after it, so the chain
  // only ever grows from the round you pick on. Resizable (see the resize block).
  const MAX_PANELS = 1;
  const panels = [];          // sparse: panels[slot] or undefined
  let oSelectionCount = 0;    // total caption selections so far

  // pronunciation cache
  const pronCache = new Map();
  const pronInflight = new Set();
  let pickedPosByWord = new Map();
  // word (lowercase) -> the LLM's own ipa from its [[PRON … ipa="…"]], used as
  // the fallback badge when Merriam-Webster has no pronunciation for the word.
  let llmIpaByWord = new Map();

  /* ---------- transcript → chunks ---------- */

  function buildChunks(lines) {
    const out = [];
    let cur = null;
    for (const ln of lines) {
      const txt = (ln.text || "").trim();
      if (!txt) continue;
      if (!cur) cur = { text: txt, start: ln.start || 0 };
      else cur.text += " " + txt;
      const ended = /[.!?…]['")\]]?$/.test(txt);
      if (ended || cur.text.split(/\s+/).length >= 30) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // When per-word timings are available, group the words themselves into the
  // same sentence chunks — so every chunk carries its words[] with start/end,
  // which the caption uses to reveal each word as it's spoken.
  function buildChunksFromWords(words) {
    const out = [];
    let cur = null;
    for (const w of words) {
      const value = String(w.text || "").trim();
      if (!value) continue;
      const start = Number(w.start) || 0;
      const end = Number(w.end) || start;
      if (!cur) cur = { start, words: [] };
      cur.words.push({ value, start, end });
      const ended = /[.!?…]['")\]]?$/.test(value);
      if (ended || cur.words.length >= 30) {
        cur.text = cur.words.map((x) => x.value).join(" ");
        out.push(cur);
        cur = null;
      }
    }
    if (cur) {
      cur.text = cur.words.map((x) => x.value).join(" ");
      out.push(cur);
    }
    return out;
  }

  function syncWindow() {
    if (!synced || !chunks.length) return;
    const t = syncTime();
    if (typeof t !== "number" || !isFinite(t)) return;
    let lo = 0, hi = chunks.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunks[mid].start <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx !== chunkIndex) { chunkIndex = idx; buildWindow(); }
  }

  // Tokenize ONE chunk into `tokens` and register it as a `windowLayout` part
  // under `cls`. Shared by the three displayed lines (the two preceding ones +
  // the current). Every word becomes a markable .word span, so the preceding
  // lines are now clickable too — not just passive context.
  function pushChunkTokens(ch, cls) {
    if (!ch) return;
    const from = tokens.length;
    if (revealActive() && ch.words) {
      // Render ONE span per timed word, with a single space between them.
      // This gives each word its exact start/end (no index drift) and keeps
      // any punctuation INSIDE the word's span — so a "$" or "." hides along
      // with its word instead of floating as an always-visible separator.
      ch.words.forEach((w, k) => {
        if (k > 0) tokens.push({ type: "sep", value: " " });
        tokens.push({ type: "word", value: w.value, marked: false, start: w.start, end: w.end });
      });
    } else {
      // Word-less transcript: split the sentence and show it all at once.
      for (const t of tokenize(ch.text)) {
        tokens.push(t.type === "word"
          ? { type: "word", value: t.value, marked: false, start: null, end: null }
          : { type: "sep", value: t.value });
      }
    }
    windowLayout.push({ cls, from, to: tokens.length });
  }

  function buildWindow() {
    // The caption shows two lines — the previous and the current — both markable.
    // The previous line is dimmed (see the .chunk.context CSS) but fully
    // interactive. The model receives the prev/current/next window — see
    // visibleChunkText.
    tokens = []; windowLayout = [];
    pushChunkTokens(chunks[chunkIndex - 1], "chunk context");
    pushChunkTokens(chunks[chunkIndex], "chunk current");
    paintWindow();
  }

  function paintWindow() {
    let html = "";
    for (const part of windowLayout) {
      let inner = "";
      for (let i = part.from; i < part.to; i++) {
        const t = tokens[i];
        if (t.type === "word") {
          const timing = t.start != null
            ? ` data-start="${t.start}" data-end="${t.end}"` : "";
          inner += `<span class="word${t.marked ? " marked" : ""}" data-i="${i}"${timing}>${escapeHtml(t.value)}</span>`;
        } else inner += escapeHtml(t.value);
      }
      html += `<p class="${part.cls}">${inner}</p>`;
    }
    const prevScroll = nowWindow.scrollTop;
    nowWindow.innerHTML = html;
    // Reveal mode hides unspoken words; toggle the class so word-less
    // transcripts keep showing the whole line at once.
    nowWindow.classList.toggle("reveal", revealActive());
    // updateReveal applies the .spoken classes, so in reveal mode the caption's
    // real height is only settled AFTER it runs — anchor the scroll afterwards,
    // not before (measuring earlier reads a collapsed, all-words-hidden box).
    updateReveal();
    applyLoopMark();         // re-mark the looped words after the rebuild
    // Bottom-anchor so the current line (at the bottom, with the context line
    // above) stays in view as the content changes. A no-op when it all fits.
    // But while the user is marking (frozen), a repaint only restyles the
    // SAME words — so restore their scroll instead of yanking it, otherwise a
    // drag over an overflowing caption would jump on every step. We set the
    // caption's OWN scrollTop (not scrollIntoView, which would jolt the page).
    nowWindow.scrollTop = frozen ? prevScroll : nowWindow.scrollHeight;
  }

  // Walk the rendered words and flip each to spoken / speaking based on the
  // current playback time. Cheap enough to run on the 150 ms ticker.
  function updateReveal() {
    if (!revealActive()) return;
    const t = syncTime();
    const spans = nowWindow.querySelectorAll(".word");
    for (const sp of spans) {
      const s = parseFloat(sp.dataset.start);
      if (isNaN(s)) { sp.classList.add("spoken"); continue; }
      if (t >= s) {
        const e = parseFloat(sp.dataset.end);
        sp.classList.add("spoken");
        sp.classList.toggle("speaking", !isNaN(e) && t < e);
      } else {
        sp.classList.remove("spoken", "speaking");
      }
    }
    // In reveal mode the line grows word-by-word between repaints, so paint-time
    // bottom-anchoring isn't enough — re-anchor here each tick to keep the newest
    // words in view if a long line overflows (likelier now that the context line
    // eats into the 26vh budget). A no-op when the caption fits. Skipped while
    // frozen so we don't fight the user's scroll as they hover to mark.
    if (!frozen) nowWindow.scrollTop = nowWindow.scrollHeight;
  }

  // Mark every on-screen word inside the active loop [loopStart, loopEnd) with the
  // .looping class (matched by start time, so it re-attaches to the freshly-rendered
  // spans after every repaint). A no-op when no loop is set, or when the looped line
  // has scrolled out of the two-line window — the loop still runs; it just isn't
  // visible until that line returns.
  function applyLoopMark() {
    const spans = nowWindow.querySelectorAll(".word");
    for (const sp of spans) {
      const s = parseFloat(sp.dataset.start);
      sp.classList.toggle("looping",
        loopStart != null && !isNaN(s) && s >= loopStart - 0.001 && s < loopEnd - 0.001);
    }
  }

  // ---- the loop engine ----
  // A requestAnimationFrame watcher (~16ms) — far finer than the 150ms caption
  // ticker or 'timeupdate' (~4/s), which would let a short word overshoot its end by
  // up to a beat before we caught it. It runs ONLY while a loop is set and the clip
  // is playing, and stops itself (returns without rescheduling) the moment the loop
  // is cleared or playback pauses; the 'play' listener restarts it on resume.
  let loopRAF = null;
  function loopTick() {
    loopRAF = null;
    if (loopStart == null || loopEnd == null) return;              // no loop → stop
    if (!audioEl.src || audioEl.paused || audioEl.error) return;   // not playing → stop (play restarts us)
    // Don't stack a second seek while one is still landing (seekTarget != null) —
    // effPos() already reads the pending target, so we'd re-fire every frame otherwise.
    if (seekTarget == null && effPos() >= loopEnd) {
      seekTo(Math.max(0, loopStart - LOOP_LEAD_IN));
    }
    loopRAF = requestAnimationFrame(loopTick);
  }
  function startLoopWatch() { if (loopRAF == null) loopRAF = requestAnimationFrame(loopTick); }

  // Set the loop to cover caption tokens [i0..i1] (a single word when i0===i1). Reads
  // the raw ASR start/end off the tokens (which survive repaints — read BEFORE any
  // seek/repaint below), jumps to the start, and starts playing so the loop is
  // audible at once. Returns false + hints if the range has no timings (a word-less
  // transcript can't be looped).
  function setLoopFromTokens(i0, i1) {
    const a = Math.min(i0, i1), b = Math.max(i0, i1);
    let s = Infinity, e = -Infinity;
    for (let k = a; k <= b; k++) {
      const t = tokens[k];
      if (!t || t.type !== "word" || t.start == null) continue;
      if (t.start < s) s = t.start;
      const te = (t.end != null && t.end > t.start) ? t.end : t.start;
      if (te > e) e = te;
    }
    if (!isFinite(s) || !isFinite(e)) { flashHint("This transcript has no word timings to loop"); return false; }
    // Start of the first timed word AFTER the selection (in the current window), so a
    // loop never bleeds into the next word — neither its audio nor its highlight.
    let nextStart = null;
    for (let k = b + 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (t && t.type === "word" && t.start != null) { nextStart = t.start; break; }
    }
    if (e - s < 0.05) e = s + LOOP_MIN;                     // ASR gave NO real end (end == start) → synthesize one
    e += LOOP_TAIL;                                         // let the final syllable finish before looping back
    if (nextStart != null) e = Math.min(e, nextStart);     // …but never reach into the next word
    loopStart = s; loopEnd = e;
    applyLoopMark();
    seekTo(Math.max(0, loopStart - LOOP_LEAD_IN));                          // jump to the loop…
    if (audioEl.paused) { const p = audioEl.play(); if (p && p.catch) p.catch(() => {}); }  // …and play it now
    startLoopWatch();
    return true;
  }
  function clearLoop() {
    if (loopStart == null && loopEnd == null) return;
    loopStart = null; loopEnd = null;
    applyLoopMark();     // the highlight vanishing is the feedback; loopTick self-stops next frame
  }

  function showWindowStatus(message, kind) {
    let html = '<div class="window-status' + (kind === "error" ? " error" : "") + '">';
    if (kind === "loading") html += '<div class="spinner"></div>';
    if (message) html += `<p>${escapeHtml(message)}</p>`;
    html += "</div>";
    nowWindow.innerHTML = html;
  }

  /* ---------- word marking → instant explain ---------- */

  // A click on a caption word, or a drag across several, fires an explanation
  // straight away (no more "mark, then move the mouse out"). While the gesture
  // is in progress we freeze the caption (the 150ms ticker skips syncWindow
  // when `frozen`) so playback can't rebuild the line mid-drag and lose marks.
  let dragState = null, overCaption = false;

  // ---- touch drag-select (mobile) ----
  // Desktop selects words by mouse drag. Touch has no equivalent: a finger drag
  // scrolls the page. So on touch we use press-and-hold then drag: hold a word
  // ~280ms to enter selection, then drag across words to extend, lift to fire —
  // the same gesture the user knows from native text selection. A plain TAP is
  // left untouched (it still rides the synthetic mouse click into the existing
  // handlers, so single-word lookups work exactly as before).
  //
  // Because a committed touch gesture also emits a trailing synthetic mouse
  // burst, finishing one stamps `suppressMouseUntil`; the three mousedown
  // handlers ignore mouse input until then so the selection can't double-fire.
  let suppressMouseUntil = 0;
  const mouseSuppressed = () => performance.now() < suppressMouseUntil;
  // opts.onPress/onRelease (optional): run the instant a finger lands on a word,
  // and when the gesture ends WITHOUT committing. The caption uses them to freeze
  // immediately on touch-down — otherwise the 150ms ticker could rebuild the line
  // (new token array) during the 280ms hold and the long-press would seed off a
  // stale span. (A committed gesture's own finish() handles unfreezing.)
  function enableTouchWordSelect(container, wordSel, begin, extend, finish, opts) {
    opts = opts || {};
    let timer = null, active = false, pressed = false, sx = 0, sy = 0, span0 = null;
    const HOLD_MS = 280, MOVE_TOL = 10;
    const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    // A committed drag stays frozen until it finishes — don't let a stray second
    // finger (pinch guard) unfreeze it mid-gesture.
    const release = () => { if (active || !pressed) return; pressed = false; if (opts.onRelease) opts.onRelease(); };
    container.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { cancelTimer(); release(); return; }   // a second finger = pinch
      const t = e.touches[0];
      const span = e.target.closest && e.target.closest(wordSel);
      if (!span) return;
      span0 = span; sx = t.clientX; sy = t.clientY; active = false;
      cancelTimer();
      pressed = true; if (opts.onPress) opts.onPress();
      timer = setTimeout(() => {
        timer = null;
        if (begin(span0) === false) return;   // nothing to select here
        active = true;
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }   // subtle "armed" cue
      }, HOLD_MS);
    }, { passive: true });
    container.addEventListener("touchmove", (e) => {
      const t = e.touches[0]; if (!t) return;
      if (!active) {
        // Still waiting on the hold: any real movement means the user is
        // scrolling, so drop the timer (and unfreeze) and let the page scroll.
        if (Math.abs(t.clientX - sx) > MOVE_TOL || Math.abs(t.clientY - sy) > MOVE_TOL) { cancelTimer(); release(); }
        return;
      }
      e.preventDefault();   // selecting now → stop the page from scrolling
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const span = el && el.closest && el.closest(wordSel);
      if (span && container.contains(span)) extend(span);
    }, { passive: false });
    const done = () => {
      cancelTimer();
      if (active) { active = false; pressed = false; suppressMouseUntil = performance.now() + 450; finish(); }
      else release();   // a tap or abandoned hold → undo the onPress (e.g. unfreeze)
      span0 = null;
    };
    container.addEventListener("touchend", done);
    container.addEventListener("touchcancel", done);
  }

  // Keep a touch-scroll that starts inside `scroller` from leaking to the page
  // behind it. On mobile the page itself scrolls and the explanation panel floats
  // over it (position:sticky), so a touch on the panel that the panel can't use
  // for its own scroll falls through and scrolls the article underneath instead.
  // CSS overscroll-behavior:contain covers this only on newer browsers AND only
  // when the panel's content actually overflows — older iOS Safari ignores it, and
  // a short explanation that fits the panel has nothing to scroll, so either way
  // the page scrolls through. This guard makes the panel always swallow vertical
  // touch scrolls: it lets the browser scroll the panel's own content when there's
  // room, and blocks the page (preventDefault) when there isn't — at the top/bottom
  // edge or when the content fits. Horizontal/multi-touch gestures are left alone.
  function keepScrollInside(scroller) {
    let lastY = 0;
    scroller.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) lastY = e.touches[0].clientY;
    }, { passive: true });
    scroller.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;       // pinch/zoom — not our gesture
      const y = e.touches[0].clientY;
      const dy = y - lastY;                      // >0: finger moved down (scroll toward the top)
      lastY = y;
      if (dy === 0) return;
      const canScroll = scroller.scrollHeight - scroller.clientHeight > 0;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      // Block the page only when the panel can't take this scroll itself; otherwise
      // let it through so the panel's own content scrolls normally.
      if ((!canScroll || (atTop && dy > 0) || (atBottom && dy < 0)) && e.cancelable) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  // Freeze the caption ONLY during an active click/drag (mousedown→mouseup), so a
  // pick can't drift under the cursor mid-gesture. Merely HOVERING must NOT
  // freeze it — that made the line stop following the audio (and look "stuck"
  // forever) whenever the mouse rested over the reading area. We still track
  // overCaption so a drag that slips outside doesn't lose its selection.
  nowWindow.addEventListener("mouseenter", () => { overCaption = true; });
  nowWindow.addEventListener("mouseleave", () => { overCaption = false; if (!dragState) frozen = false; });
  nowWindow.addEventListener("mousedown", (e) => {
    if (mouseSuppressed()) return;   // ignore the synthetic click trailing a touch gesture
    if (e.button !== 0 && e.button !== 2) return;
    const span = e.target.closest && e.target.closest(".word");
    // LEFT press → mark a word/phrase for an explanation lookup. Must start on a word.
    if (e.button === 0) {
      if (!span) return;
      e.preventDefault();
      frozen = true;
      const i = Number(span.dataset.i);
      dragState = { startIdx: i, currentIdx: i, moved: false, button: 0, snapshot: tokens.map((t) => !!t.marked) };
      return;
    }
    // RIGHT press → set an A-B loop; a right-DRAG extends it across words. Browsers
    // don't drag-select with the right button natively (it fires 'contextmenu', which
    // the handler below suppresses), so we drive the whole gesture off this
    // mousedown → mousemove → mouseup ourselves. Right-pressing OFF a word (startIdx
    // stays null) clears any loop in finishCaptionGesture.
    e.preventDefault();
    frozen = true;
    const i = span ? Number(span.dataset.i) : null;
    dragState = { startIdx: i, currentIdx: i, moved: false, button: 2, snapshot: tokens.map((t) => !!t.marked) };
    if (i != null) applyDragRange();   // live preview: highlight the word as it would loop
  });
  nowWindow.addEventListener("mousemove", (e) => {
    if (!dragState) return;
    if (e.buttons === 0) {   // a button-release we never saw — recover, don't stay frozen with marks
      dragState = null; frozen = false;
      for (const tk of tokens) if (tk.type === "word") tk.marked = false;
      repaintMarks();
      return;
    }
    const span = e.target.closest && e.target.closest(".word");
    if (!span) return;
    const i = Number(span.dataset.i);
    if (dragState.startIdx == null) {   // right-drag that began off a word: anchor it here
      dragState.startIdx = dragState.currentIdx = i;
      applyDragRange();
      return;
    }
    if (i === dragState.currentIdx) return;
    dragState.currentIdx = i;
    if (i !== dragState.startIdx) dragState.moved = true;
    applyDragRange();
  });
  function finishCaptionGesture() {
    if (!dragState) return;
    const ds = dragState; dragState = null;

    // RIGHT gesture → set / clear the A-B loop (no explanation lookup). Drop the drag
    // preview marks and unfreeze first, then read the range off the (still-current)
    // tokens.
    if (ds.button === 2) {
      for (const tk of tokens) if (tk.type === "word") tk.marked = false;
      frozen = false;
      if (ds.startIdx == null) { clearLoop(); paintWindow(); return; }   // right-clicked empty space → stop
      const t0 = tokens[ds.startIdx];
      // A single right-click on the word that's already looping toggles the loop OFF.
      if (!ds.moved && t0 && t0.type === "word" && loopStart != null &&
          t0.start != null && Math.abs(t0.start - loopStart) < 0.001) {
        clearLoop(); paintWindow(); return;
      }
      setLoopFromTokens(ds.startIdx, ds.currentIdx);
      paintWindow();
      return;
    }

    // LEFT gesture → mark words and fire an explanation (original behavior).
    if (ds.moved) applyDragRange(ds);             // final drag range → marked
    else {
      const t = tokens[ds.startIdx];
      if (t && t.type === "word") t.marked = true; // a plain click selects the word
    }
    const items = collectMarkedItems();
    // Clear the caption marks so the next click/drag starts a fresh selection
    // (which fills the next panel), then fire this one. The gesture is over, so
    // unfreeze and let the caption resume following the audio.
    for (const tk of tokens) if (tk.type === "word") tk.marked = false;
    frozen = false;
    paintWindow();
    if (items.length) startNewExplain(items);
  }
  window.addEventListener("mouseup", finishCaptionGesture);

  // The caption owns the right button — it drives the A-B loop, set/extended via the
  // mouse handlers above (right-click a word, or right-press-and-drag a phrase).
  // Suppress the browser context menu across the whole caption so a right-click or
  // right-drag never pops the native menu. The loop itself is set/cleared on
  // mousedown → mousemove → mouseup, since the right button doesn't drag-select text.
  nowWindow.addEventListener("contextmenu", (e) => { e.preventDefault(); });

  // Restore the original reflex: ANY press other than the right button (which sets or
  // extends the loop) clears it — click anywhere to stop looping, exactly as an outside
  // click used to clear the old checkpoint. Document-level, so a click anywhere on the
  // page counts, not just on the caption.
  document.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;        // the right button drives the loop itself
    if (mouseSuppressed()) return;     // ignore the synthetic click trailing a touch gesture
    clearLoop();                       // no-ops when nothing is looping
  });

  // Touch: hold a caption word, then drag across the line to select a phrase.
  enableTouchWordSelect(nowWindow, ".word",
    (span) => {
      frozen = true;
      const i = Number(span.dataset.i);
      dragState = { startIdx: i, currentIdx: i, moved: false, snapshot: tokens.map((t) => !!t.marked) };
      applyDragRange();
    },
    (span) => {
      if (!dragState) return;
      const i = Number(span.dataset.i);
      if (i === dragState.currentIdx) return;
      dragState.currentIdx = i;
      if (i !== dragState.startIdx) dragState.moved = true;
      applyDragRange();
    },
    finishCaptionGesture,
    // Freeze the caption the instant a finger lands so the ticker can't rebuild
    // the line during the hold; unfreeze if the gesture is abandoned (a scroll or
    // a plain tap) — a committed selection unfreezes in finishCaptionGesture.
    { onPress: () => { frozen = true; }, onRelease: () => { frozen = false; } });
  function applyDragRange(ds = dragState) {
    if (!ds) return;
    for (let i = 0; i < tokens.length; i++) tokens[i].marked = ds.snapshot[i];
    const a = Math.min(ds.startIdx, ds.currentIdx);
    const b = Math.max(ds.startIdx, ds.currentIdx);
    for (let i = a; i <= b; i++) {
      const t = tokens[i];
      if (t && t.type === "word") t.marked = !ds.snapshot[i];
    }
    // Repaint marks IN PLACE — never rebuild the caption mid-gesture. A full
    // paintWindow() (nowWindow.innerHTML = …) destroys and recreates the very
    // span the finger is holding, i.e. the touchstart target. On touch, once that
    // target is detached from the document the browser keeps dispatching
    // touchmove/touchend to the orphaned node — they no longer bubble to the
    // delegated listener on nowWindow, so extend() stops firing and a drag froze
    // at one word on mobile. (The text + explanation panels never hit this: they
    // toggle .marked on stable spans.) The gesture runs frozen, so the spans and
    // their data-i ↔ tokens mapping are stable; only the .marked class changes.
    repaintMarks();
  }

  // Toggle .marked on the live caption spans to match `tokens`, without rebuilding
  // the DOM — so the touchstart target survives a drag (see applyDragRange).
  function repaintMarks() {
    for (const sp of nowWindow.querySelectorAll(".word")) {
      const t = tokens[Number(sp.dataset.i)];
      if (t) sp.classList.toggle("marked", !!t.marked);
    }
  }

  // Group consecutive marked words into items from the caption's token array.
  function collectMarkedItems(tk = tokens) {
    const items = [];
    let i = 0;
    while (i < tk.length) {
      const t = tk[i];
      if (t.type === "word" && t.marked) {
        const words = [t.value];
        let j = i + 1;
        while (j < tk.length - 1) {
          const sep = tk[j], next = tk[j + 1];
          if (sep.type === "sep" && /^\s+$/.test(sep.value) && next.type === "word" && next.marked) {
            words.push(next.value); j += 2;
          } else break;
        }
        items.push({ phrase: words.join(" "), words });
        i = j;
      } else i++;
    }
    return dedupeItems(items);
  }

  /* ---------- panels: create / allocate / reset ---------- */

  // Build the panel: a top-edge resize handle + a scrolling content box, plus
  // its thread state. Anchored to the bottom of the band (nearest the caption).
  function makePanel(slot) {
    const el = document.createElement("div");
    el.className = "explain-panel";
    el.style.order = String(-slot);
    const handle = document.createElement("div");
    handle.className = "panel-resize";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Resize explanation panel");
    handle.tabIndex = 0;
    const content = document.createElement("div");
    content.className = "explain-content";
    el.appendChild(handle);
    el.appendChild(content);
    bandEl.appendChild(el);
    const panel = {
      slot, el, contentEl: content,
      rounds: [], streamItems: [], threadText: "",
      buffer: "", firstChunkSeen: false, streaming: false,
      errorMsg: "", inFlight: null, responseMarks: new Set(),
      liveRoundEl: null, liveRoundCount: -1,
    };
    wirePanelEvents(panel);
    wirePanelResize(handle);
    return panel;
  }

  // Clear a panel's thread back to empty and abort any in-flight request — used
  // when a slot is reused by a newer caption selection.
  function resetPanelThread(panel) {
    if (panel.inFlight) { try { panel.inFlight.abort(); } catch {} panel.inFlight = null; }
    panel.rounds = []; panel.streamItems = []; panel.threadText = "";
    panel.buffer = ""; panel.firstChunkSeen = false; panel.streaming = false;
    panel.errorMsg = ""; panel.responseMarks.clear();
    panel.liveRoundEl = null; panel.liveRoundCount = -1;
    panel.contentEl.innerHTML = "";
  }

  // Pick the panel a brand-new caption selection should fill: the next slot in
  // round-robin order, creating it the first time and reusing (resetting) it
  // afterwards.
  function nextPanelForSelection() {
    const slot = oSelectionCount % MAX_PANELS;
    oSelectionCount++;
    let panel = panels[slot];
    if (!panel) panel = panels[slot] = makePanel(slot);
    else resetPanelThread(panel);
    return panel;
  }

  function teardownAllPanels() {
    for (const p of panels) {
      if (!p) continue;
      if (p.inFlight) { try { p.inFlight.abort(); } catch {} }
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    panels.length = 0;
    oSelectionCount = 0;
  }

  function renderAllPanels() {
    for (const p of panels) if (p) renderExplain(p);
  }

  // A drag in progress inside an explanation panel — the same click-a-word /
  // drag-a-phrase gesture as the caption, adapted to the response's word spans
  // (which are keyed by rid, not a flat index array, so the range is computed
  // over the block's spans in document order). Shared module-wide because only
  // one mouse drags at a time; a single window-level mouseup (below) commits it
  // and fires, so a release outside the panel still finishes cleanly. mousedown
  // wipes every prior mark first, so the snapshot is a clean slate — one
  // contiguous word/phrase is ever live, exactly like O.
  let panelDrag = null;

  // Repaint the dragged run: every span outside [a,b] keeps its snapshot mark;
  // every span inside flips it. Mirrors the caption's applyDragRange.
  function applyPanelDragRange(ds) {
    const { panel, spans, snapshot, startIdx, currentIdx } = ds;
    const a = Math.min(startIdx, currentIdx), b = Math.max(startIdx, currentIdx);
    for (let i = 0; i < spans.length; i++) {
      const marked = (i >= a && i <= b) ? !snapshot[i] : snapshot[i];
      const rid = spans[i].dataset.rid;
      if (marked) panel.responseMarks.add(rid); else panel.responseMarks.delete(rid);
      spans[i].classList.toggle("marked", marked);
    }
  }

  function togglePanelWord(panel, span) {
    const rid = span.dataset.rid;
    if (panel.responseMarks.has(rid)) { panel.responseMarks.delete(rid); span.classList.remove("marked"); }
    else { panel.responseMarks.add(rid); span.classList.add("marked"); }
  }

  // Wipe every response mark across all rounds. A new pick starts from a clean
  // slate so only one contiguous word/phrase is ever selected — the same
  // one-highlight-at-a-time model as O (the caption).
  function clearResponseMarks(panel) {
    panel.responseMarks.clear();
    for (const sp of panel.contentEl.querySelectorAll(".response-word.marked")) sp.classList.remove("marked");
  }

  // Commit + fire on release, exactly like O: a click sends the one word, a drag
  // sends the one contiguous phrase, and it explains the instant the mouse comes
  // up — no "leave the block to ask" step. mousedown already cleared every other
  // mark, so only this single run is live; disjoint multi-word/phrase picks
  // aren't possible here, matching O.
  function finishPanelGesture() {
    if (!panelDrag) return;
    const ds = panelDrag; panelDrag = null;
    if (ds.moved) applyPanelDragRange(ds);
    else togglePanelWord(ds.panel, ds.spans[ds.startIdx]);   // a plain click marks the one word
    // One contiguous run, like O: gather the marked spans in document order into
    // a single item — even across bold/italic boundaries — so a drag is always
    // one phrase, never several disjoint picks.
    const words = ds.spans.filter((s) => ds.panel.responseMarks.has(s.dataset.rid)).map((s) => s.dataset.word);
    if (words.length) firePanelSelection(ds.panel, ds.block, [{ phrase: words.join(" "), words }]);
  }
  window.addEventListener("mouseup", finishPanelGesture);

  // Picking on round R_(k+1) — the answer rendered in `block` (data-round = k) —
  // regenerates the NEXT round and drops every round after it, so the answers
  // form a single drill-down chain instead of an ever-growing stack. slice keeps
  // rounds[0..k] (R1..R_(k+1)) as the model's history; triggerExplain then
  // appends the fresh next round below them, overriding the old R_(k+2) and
  // emptying everything past it.
  function firePanelSelection(panel, block, items) {
    const k = Number(block.dataset.round);
    if (Number.isInteger(k)) panel.rounds = panel.rounds.slice(0, k + 1);
    triggerExplain(panel, items);
  }

  // Per-panel picks: click a word, or drag across a contiguous run, inside a
  // response — it fires the instant you release (see the window mouseup above),
  // the same gesture as O, restricted to one word or one contiguous phrase.
  function wirePanelEvents(panel) {
    // mousedown starts the gesture; mousemove extends the run to the word under
    // the cursor. The range is taken over the spans of the block the drag began
    // in, so a phrase can't straddle two answers. Native text-drag is suppressed
    // (the words already carry user-select:none).
    // Begin a pick at `span`: clear prior marks, snapshot the block's spans, and
    // seed panelDrag. Shared by mousedown and the touch hold. Returns false if the
    // span isn't inside a round block (nothing to select).
    const beginPanelPick = (span) => {
      const block = span.closest(".round-block");
      if (!block) return false;
      // One pick at a time, like O: starting a new gesture clears every existing
      // response mark so two disjoint runs can never be live together.
      clearResponseMarks(panel);
      const spans = [...block.querySelectorAll(".response-word")];
      const idx = spans.indexOf(span);
      panelDrag = {
        panel, block, spans, startIdx: idx, currentIdx: idx, moved: false,
        snapshot: spans.map(() => false),
      };
      return true;
    };
    const extendPanelPick = (span) => {
      if (!panelDrag || panelDrag.panel !== panel) return;
      const idx = panelDrag.spans.indexOf(span);   // -1 when over another block
      if (idx === -1 || idx === panelDrag.currentIdx) return;
      panelDrag.currentIdx = idx;
      if (idx !== panelDrag.startIdx) panelDrag.moved = true;
      applyPanelDragRange(panelDrag);
    };
    panel.contentEl.addEventListener("mousedown", (e) => {
      if (mouseSuppressed()) return;   // ignore the synthetic click trailing a touch gesture
      const span = e.target.closest && e.target.closest(".response-word");
      if (!span || e.button !== 0) return;
      e.preventDefault();
      beginPanelPick(span);
    });
    panel.contentEl.addEventListener("mousemove", (e) => {
      if (!panelDrag || panelDrag.panel !== panel) return;
      if (e.buttons === 0) { panelDrag = null; return; }
      const span = e.target.closest && e.target.closest(".response-word");
      if (!span) return;
      extendPanelPick(span);
    });
    // Touch: hold a word in the answer, then drag across it to select a phrase.
    enableTouchWordSelect(panel.contentEl, ".response-word",
      (span) => beginPanelPick(span), extendPanelPick, finishPanelGesture);
    // Touch: scroll the answer without leaking the gesture to the article behind it.
    keepScrollInside(panel.contentEl);
  }

  // A fresh caption selection: route it to the next panel slot, anchor its
  // context window, and kick off the explanation.
  function startNewExplain(items) {
    const panel = nextPanelForSelection();
    panel.threadText = visibleChunkText();
    triggerExplain(panel, items);
  }

  function visibleChunkText() {
    // The model's context window: the previous line, the current line, and the
    // next one (P1, current, N1). The previous line is the one shown and markable
    // in the caption; the next line is sent for context but not displayed.
    return [chunks[chunkIndex - 1], chunks[chunkIndex], chunks[chunkIndex + 1]]
      .filter(Boolean).map((c) => c.text).join(" ");
  }

  /* ---------- explanation flow ---------- */

  // Start (or, for a follow-up, extend) one panel's thread. Each panel owns its
  // own AbortController, so the three panels stream in parallel — a new request
  // only aborts the SAME panel's previous one. For a fresh selection the panel's
  // rounds are already empty (history = []); for a follow-up the prior rounds
  // are sent as history and the new answer is appended below them.
  async function triggerExplain(panel, items) {
    if (panel.inFlight) { try { panel.inFlight.abort(); } catch {} }
    panel.streamItems = items;
    panel.buffer = ""; panel.errorMsg = ""; panel.firstChunkSeen = false; panel.streaming = true;
    renderExplain(panel);
    // Bring the panel (and its new live round) into view once — never resized.
    panel.el.scrollIntoView({ block: "nearest" });
    panel.contentEl.scrollTop = panel.contentEl.scrollHeight;
    const ctrl = new AbortController();
    panel.inFlight = ctrl;
    try {
      await streamExplain(panel, { text: panel.threadText, items, history: panel.rounds.map((r) => r.text) }, ctrl.signal);
    } catch (e) {
      if (e.name !== "AbortError") console.error("explain threw", e);
    } finally {
      if (ctrl === panel.inFlight) {
        panel.streaming = false; panel.inFlight = null;
        if (panel.buffer) panel.rounds.push({ text: panel.buffer, items: panel.streamItems });
        panel.buffer = "";
        renderExplain(panel);
        checkCredits();
      }
    }
  }

  async function streamExplain(panel, body, signal) {
    const res = await fetch(apiBase() + "/api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) { panel.errorMsg = `Could not reach the explainer (HTTP ${res.status}).`; renderExplain(panel); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", event = "", dataBuf = "";
    while (true) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (e) { if (e.name !== "AbortError") console.error("reader threw", e); break; }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") { if (event && dataBuf) handleSse(panel, event, dataBuf); event = ""; dataBuf = ""; continue; }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
        if (line.startsWith("data:")) dataBuf += (dataBuf ? "\n" : "") + line.slice(5).trim();
      }
    }
  }

  function handleSse(panel, event, data) {
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    if (event === "pron-data") {
      for (const [w, bundle] of Object.entries(obj.prons || {})) {
        const v0 = bundle.variants[0];
        pronCache.set(`${w}|`, {
          hword: bundle.hword,
          pos: (v0.posList && v0.posList[0]) || "",
          ipa: v0.ipa, mp3: v0.mp3, variants: bundle.variants,
        });
      }
      // The cache is shared, so refresh every panel that may show these words.
      renderAllPanels();
    } else if (event === "chunk") {
      panel.firstChunkSeen = true; panel.buffer += obj.text; renderExplain(panel, true);
    } else if (event === "error") {
      panel.errorMsg = obj.message || "Something went wrong."; renderExplain(panel);
    }
  }

  /* ---------- explanation rendering ---------- */

  // A tag still arriving over SSE is half-written ("…[[PRON word=\"cha"), so cut
  // the text back to where it opened rather than let a fragment flash on screen.
  // Both tag kinds count, and the LAST opener wins — an earlier, already-closed
  // one must not mask a later, still-open one.
  function hidePartialTag(s) {
    let open = -1;
    for (const t of ANY_TAG_OPENERS) open = Math.max(open, s.lastIndexOf(t));
    return open >= 0 && s.indexOf("]]", open) < 0 ? s.slice(0, open) : s;
  }

  function refreshPickedPosByWord(panel) {
    pickedPosByWord = new Map();
    llmIpaByWord = new Map();
    for (const src of [...panel.rounds.map((r) => r.text), panel.buffer]) {
      if (!src) continue;
      // Use the same lenient parser as inline() so any tag that renders a badge
      // also drives the highlight — order-/spacing-tolerant, never out of sync.
      for (const m of src.matchAll(PRON_BRACKET_RE)) {
        const attrs = parsePronAttrs(m[1]);
        if (!attrs) continue;
        const w = attrs.word.toLowerCase(), pos = attrs.pos;
        // FIRST occurrence wins for both maps, so the pron-only row and the
        // inline badge for the same word agree. First and not last matters now
        // that one word can carry two badges: under the Ambiguity rule a reply
        // may tag "charge" as both noun and verb, and the senses are written
        // most-likely-first — last-wins lit the LESS likely reading in the row.
        if (w && pos && !pickedPosByWord.has(w)) pickedPosByWord.set(w, pos);
        if (w && attrs.ipa && !llmIpaByWord.has(w)) llmIpaByWord.set(w, attrs.ipa);
      }
    }
  }

  function lemmaForUserWord(userWord) {
    const lw = userWord.toLowerCase();
    if (pickedPosByWord.has(lw)) return lw;
    for (const x of pickedPosByWord.keys()) {
      if (lw.startsWith(x) || x.startsWith(lw)) return x;
    }
    return userWord;
  }

  function pronOnlyBlock(words) {
    let inner = "";
    for (const w of words) {
      const lemma = lemmaForUserWord(w);
      inner += `<span class="pron-only-row"><strong>${escapeHtml(w)}</strong>${badgeHtml({ word: lemma, pos: "", multi: true })}</span>`;
    }
    return `<div class="pron-only">${inner}</div>`;
  }

  function renderExplain(panel, incremental) {
    refreshPickedPosByWord(panel);
    // Incremental fast-path for streaming chunks: each chunk only grows the live
    // answer's text, so rewrite just that one block in place. Rebuilding the whole
    // panel (contentEl.innerHTML) on every chunk resets the scroll container's
    // scrollTop and, on mobile, tears the container down under the user's finger —
    // which hands an in-progress touch-scroll off to the page, scrolling the
    // article instead of the panel (and only sorts itself out once streaming ends
    // and the rebuilds stop). Touching only the live block leaves the scroll
    // container, its scrollTop, and the committed rounds intact, so the panel
    // stays scrollable while text streams in.
    if (incremental && panel.streaming && panel.firstChunkSeen &&
        panel.liveRoundEl && panel.liveRoundCount === panel.rounds.length) {
      panel.liveRoundEl.innerHTML = renderMarkdown(hidePartialTag(panel.buffer));
      wirePronBadges(panel);
      return;
    }
    let html = "";
    for (let i = 0; i < panel.rounds.length; i++) html += roundBlockHtml(panel.rounds[i].text, panel.rounds[i].items, i > 0, false, i);
    if (panel.streaming) {
      html += roundBlockHtml(hidePartialTag(panel.buffer), panel.streamItems, panel.rounds.length > 0, true, panel.rounds.length);
    }
    if (panel.streaming && !panel.firstChunkSeen) {
      html += '<div class="thinking" aria-label="Loading"><span></span><span></span><span></span></div>';
    }
    if (panel.errorMsg) html += `<p class="err">${escapeHtml(panel.errorMsg)}</p>`;
    if (!html) { panel.contentEl.innerHTML = ""; panel.liveRoundEl = null; return; }
    panel.contentEl.innerHTML = html;
    wirePronBadges(panel);
    wrapResponseWords(panel);
    // Cache the live block so the streaming fast-path above can update it in place.
    panel.liveRoundEl = (panel.streaming && panel.firstChunkSeen)
      ? panel.contentEl.querySelector(`.round-block[data-round="${panel.rounds.length}"] .round.live`)
      : null;
    panel.liveRoundCount = panel.rounds.length;
  }

  function roundBlockHtml(text, items, divided, live, roundIdx) {
    let h = `<div class="round-block${divided ? " divided" : ""}" data-round="${roundIdx}">`;
    const seen = new Set(), pronWords = [];
    for (const it of items || []) {
      for (const w of it.words || []) {
        const k = w.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); pronWords.push(w);
      }
    }
    if (pronWords.length) h += pronOnlyBlock(pronWords);
    h += `<div class="round${live ? " live" : ""}">${renderMarkdown(text)}</div>`;
    return h + "</div>";
  }

  /* ---------- follow-ups: mark words inside an explanation ---------- */

  function wrapResponseWords(panel) {
    const walker = document.createTreeWalker(panel.contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentNode;
        if (!parent || !(parent instanceof Element)) return NodeFilter.FILTER_REJECT;
        // .sense-odds too: its "70%" is metadata about the answer, not a word of
        // the answer, so it must not become a clickable drill-down target.
        if (parent.closest(".round.live") || parent.closest(".pron-badge") ||
            parent.closest(".pron-only") || parent.closest(".response-word") ||
            parent.closest(".sense-odds")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    const counter = new Map();
    for (const tn of textNodes) {
      const text = tn.nodeValue;
      if (!text) continue;
      const re = new RegExp(WORD_RE.source, WORD_RE.flags);
      let m, frag = null, last = 0;
      while ((m = re.exec(text)) !== null) {
        if (!frag) frag = document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const w = m[0], lower = w.toLowerCase();
        const occ = counter.get(lower) || 0;
        counter.set(lower, occ + 1);
        const rid = `${lower}#${occ}`;
        const span = document.createElement("span");
        span.className = "word response-word";
        span.dataset.word = w; span.dataset.rid = rid;
        if (panel.responseMarks.has(rid)) span.classList.add("marked");
        span.textContent = w;
        frag.appendChild(span);
        last = re.lastIndex;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      }
    }
  }

  /* ---------- pronunciation badges ---------- */

  function speakerSvg() {
    return '<svg class="speaker" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M11 5 7 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l4 4z" fill="currentColor"/>' +
      '<path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function warnSvg() {
    return '<svg class="warn" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 4 2.5 20h19L12 4z" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M12 10v4.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="17.6" r="1.15" fill="currentColor"/></svg>';
  }

  function singleBadgeHtml({ key, ipa, mp3, label, hword, pos, fallbackPos, picked }) {
    const cls = picked ? "pron-badge is-picked" : "pron-badge";
    const title = `${hword} (${pos || fallbackPos || ""})`.trim().replace(/\s*\(\)$/, "");
    return `<button type="button" class="${cls}" data-key="${escapeHtml(key)}" ` +
      `data-mp3="${escapeHtml(mp3)}" title="${escapeHtml(title)}" ` +
      `aria-label="Play pronunciation ${escapeHtml(ipa)}">` +
      (label ? `<span class="badge-pos">${escapeHtml(label)}</span>` : "") +
      `<span class="ipa">${escapeHtml(ipa)}</span>${speakerSvg()}</button>`;
  }

  // Fallback badge for a word Merriam-Webster has no pronunciation for: the
  // LLM's own best-effort respelling, marked unmistakably as AI-made (violet,
  // dashed, leading "≈", trailing "AI"). There is no recording, so it isn't
  // playable — the IPA text itself is the value. The pos is picked up from the
  // LLM's placeholder so the label matches the real badges.
  function aiBadgeHtml({ word, ipa, pos }) {
    const labelPos = pos || pickedPosByWord.get(word.toLowerCase()) || "";
    const label = posAbbrev(labelPos);
    const title = `Approximate pronunciation for "${word}"`
      + (labelPos ? ` (${labelPos})` : "")
      + " — generated by AI, not from Merriam-Webster";
    return `<button type="button" class="pron-badge ai-made" disabled ` +
      `title="${escapeHtml(title)}" ` +
      `aria-label="AI-made approximate pronunciation ${escapeHtml(ipa)}, not from a dictionary">` +
      (label ? `<span class="badge-pos">${escapeHtml(label)}</span>` : "") +
      `<span class="approx" aria-hidden="true">≈</span>` +
      `<span class="ipa">${escapeHtml(ipa)}</span>` +
      `<span class="ai-tag" aria-hidden="true">AI</span></button>`;
  }

  // Pick which MW variant a badge should show, given the committed POS head and
  // the LLM's own context-aware respelling. POS narrows first; the ipa then
  // breaks ties between same-POS homographs — Merriam-Webster lists *tear* as
  // both a "verb (1)"/"noun (1)" pair pronounced ˈter (to rip) AND a
  // "noun (2)"/"verb (2)" pair pronounced ˈtir (the eye kind), so "noun" alone
  // matches both and would always grab the first (ˈter). The LLM, which knows
  // the sense from the passage, supplies ˈtir, so we follow it. Returns an index
  // into `variants`; falls back to the first POS match (then 0) when nothing
  // disambiguates, i.e. the old behaviour for ordinary single-pron words.
  function chooseVariantIdx(variants, head, llmIpa) {
    if (!variants.length) return 0;
    const all = variants.map((_, i) => i);
    const posPool = head
      ? all.filter((i) => (variants[i].posList || []).some((p) => posHead(p) === head))
      : [];
    const pool = posPool.length ? posPool : all;
    if (pool.length === 1) return pool[0];
    const want = ipaSkeleton(llmIpa);
    if (want) {
      const exact = pool.find((i) => ipaSkeleton(variants[i].ipa) === want);
      if (exact != null) return exact;
    }
    return pool[0];
  }

  // The server pre-fetches each selected word's MW pron in the form the USER
  // picked (its surface form, e.g. "flyers") and pushes it as pron-data keyed
  // "<word>|". The LLM, told to tag the dictionary base form, writes the same
  // word as "flyer" — a different key — and for a few words (variant spellings
  // like flyer/flier) that base form has no MW pron of its own. So before a badge
  // re-fetches or drops to the AI respelling, reuse a real pron already in hand
  // for the same word under a related spelling. Prefer an exact word match (any
  // pos); else a prefix-related form — the same loose pairing lemmaForUserWord
  // uses — guarded to 3+ char stems so a tiny fragment can't grab a stranger.
  function prefetchedRealFor(word) {
    const lw = word.toLowerCase();
    let near = null;
    for (const [k, v] of pronCache) {
      if (!v || v.error || !Array.isArray(v.variants)) continue;
      const bar = k.indexOf("|");
      const w = bar < 0 ? k : k.slice(0, bar);
      if (!w) continue;
      if (w === lw) return v;
      if (!near && Math.min(w.length, lw.length) >= 3 &&
          (w.startsWith(lw) || lw.startsWith(w))) near = v;
    }
    return near;
  }

  function badgeHtml({ word, pos, ipa, multi = false }) {
    const key = badgeKey({ word, pos });
    let cached = pronCache.get(key);
    const safeWord = escapeHtml(word);
    const safePos = escapeHtml(pos);
    // The LLM's fallback respelling: the one passed inline on this placeholder,
    // else the one captured for this word from anywhere in the reply. Doubles as
    // the tie-breaker between same-POS variants below.
    const llmIpa = (ipa && normIpa(ipa)) || llmIpaByWord.get(word.toLowerCase()) || "";
    // No real pron of its own yet (never fetched, or MW had none for this exact
    // spelling) — reuse one already fetched for the same word under a related
    // surface form rather than re-fetch or fall to the AI badge.
    if (!cached || cached.error) {
      const reuse = prefetchedRealFor(word);
      if (reuse) cached = reuse;
    }
    if (cached && !cached.error) {
      const variants = Array.isArray(cached.variants) && cached.variants.length
        ? cached.variants
        : [{ ipa: cached.ipa, mp3: cached.mp3, posList: cached.pos ? [cached.pos] : [] }];
      const committedPos = pos ||
        pickedPosByWord.get(word.toLowerCase()) ||
        pickedPosByWord.get((cached.hword || "").toLowerCase()) || "";
      const head = posHead(committedPos);
      const pickedIdx = chooseVariantIdx(variants, head, llmIpa);
      if (!multi || variants.length <= 1) {
        const v = variants[pickedIdx] || variants[0];
        const posList = v.posList || [];
        const labelPos = (head && posList.find((p) => posHead(p) === head)) || posList[0] || cached.pos;
        return singleBadgeHtml({ key, ipa: v.ipa, mp3: v.mp3, label: posAbbrev(labelPos), hword: cached.hword, pos: labelPos, fallbackPos: pos });
      }
      const html = variants.map((v, i) => {
        const labelPos = (v.posList && v.posList[0]) || cached.pos;
        return singleBadgeHtml({ key: `${key}#${i}`, ipa: v.ipa, mp3: v.mp3, label: posAbbrev(labelPos), hword: cached.hword, pos: labelPos, fallbackPos: pos, picked: !!committedPos && i === pickedIdx });
      }).join("");
      return `<span class="pron-variants">${html}</span>`;
    }
    if (cached && cached.error) {
      // Two distinct failure reasons, handled differently:
      //   notfound    — MW served the page but has NO pronunciation for this
      //                 word (e.g. "suddenly"). Permanent, so show the LLM's
      //                 fallback respelling, clearly marked as AI-made.
      //   unavailable — we couldn't REACH MW (the Cloudflare 403, a 5xx, or a
      //                 network blip). MW may well have a real pronunciation,
      //                 so don't paper a transient outage over with a guess —
      //                 keep the loud, retryable red badge instead.
      const unreachable = cached.reason !== "notfound";
      if (!unreachable && llmIpa) return aiBadgeHtml({ word, ipa: llmIpa, pos });
      // No usable AI fallback (the outage case above, the LLM omitted ipa, or
      // this is an old reply): surface the failure EXPLICITLY — never the bare
      // word, which reads like a real result. Red "pron unavailable" = couldn't
      // reach MW; amber "no pron" = MW answered but has none for this word.
      const cls = unreachable ? "pron-badge failed err-mw" : "pron-badge failed err-none";
      const label = unreachable ? "pron unavailable" : "no pron";
      const title = unreachable
        ? `Couldn't reach Merriam-Webster for "${word}" — pronunciation unavailable, try again later`
        : `Merriam-Webster has no pronunciation for "${word}"`;
      return `<button type="button" class="${cls}" disabled title="${escapeHtml(title)}">` +
        `${warnSvg()}<span class="err-label">${escapeHtml(label)}</span></button>`;
    }
    return `<button type="button" class="pron-badge loading" data-key="${escapeHtml(key)}" ` +
      `data-word="${safeWord}" data-pos="${safePos}" disabled><span class="dot-loader">…</span></button>`;
  }

  function wirePronBadges(panel) {
    for (const btn of panel.contentEl.querySelectorAll(".pron-badge.loading")) {
      const key = btn.dataset.key;
      if (!key || pronInflight.has(key)) continue;
      const word = btn.dataset.word, pos = btn.dataset.pos;
      pronInflight.add(key);
      fetch(`${apiBase()}/api/pron?word=${encodeURIComponent(word)}&pos=${encodeURIComponent(pos)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data) => { pronCache.set(key, data); renderAllPanels(); })
        .catch((status) => {
          // 404 = MW has no pronunciation for this word; anything else (502 from
          // a Cloudflare block, or a thrown network error with no status) = MW
          // was unreachable. badgeHtml renders a distinct, explicit badge for
          // each. Caching the error (not clearing it) also stops a re-render →
          // re-fetch loop when MW keeps refusing.
          const reason = status === 404 ? "notfound" : "unavailable";
          pronCache.set(key, { error: true, reason });
          renderAllPanels();
        })
        .finally(() => pronInflight.delete(key));
    }
    for (const btn of panel.contentEl.querySelectorAll(".pron-badge:not(.loading):not(.failed):not(.ai-made)")) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";
      btn.addEventListener("click", (e) => {
        // A mouse click leaves focus on the badge, where it has no use and only
        // invites the browser to re-activate it. Hand focus back to the document
        // so the player's keys own the keyboard again. e.detail is 0 for a
        // keyboard-driven click — those keep focus, as a keyboard user expects.
        if (e.detail > 0) btn.blur();
        playBadge(btn);
      });
    }
  }

  let currentBadgeAudio = null;
  function playBadge(btn) {
    if (!btn.dataset.mp3) return;                 // no clip URL → nothing to play
    if (currentBadgeAudio) {
      try { currentBadgeAudio.audio.pause(); } catch {}
      currentBadgeAudio.btn.classList.remove("is-playing");
      currentBadgeAudio = null;
    }
    const audio = new Audio(btn.dataset.mp3);
    const token = { audio, btn };
    currentBadgeAudio = token;
    btn.classList.add("is-playing");
    // Identity-checked so a superseded clip's late 'ended'/'error' can't clear the
    // button a newer click is now playing.
    const stop = () => { if (currentBadgeAudio !== token) return; currentBadgeAudio = null; btn.classList.remove("is-playing"); };
    audio.addEventListener("ended", stop);
    audio.addEventListener("error", stop);
    audio.play().catch(stop);
  }

  /* ---------- credit balance hint ---------- */

  async function checkCredits() {
    try {
      const r = await fetch(apiBase() + "/api/credits");
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.low) {
        const amount = typeof data.remaining === "number" ? `$${data.remaining.toFixed(2)}` : "low";
        warnEl.textContent = `SkyDeck credits ${amount}`;
        warnEl.hidden = false;
      } else { warnEl.textContent = ""; warnEl.hidden = true; }
    } catch {}
  }

  /* ---------- reset helpers ---------- */

  function resetTranscriptState() {
    chunks = []; chunkIndex = 0; tokens = []; windowLayout = []; frozen = false;
    wordReveal = false;
    loopStart = null; loopEnd = null;   // drop any A-B loop from the previous clip
  }
  function resetThread() {
    // Tear down every panel and reset the round-robin counter — a new episode
    // starts with a clean, empty band.
    teardownAllPanels();
  }

  /* ---------- transcript ---------- */

  // Transcripts are computed once, server-side, at import time (the backend
  // talks to the self-hosted Parakeet STT service via comart) — this just
  // polls GET /api/library/:id/transcript until it's ready and feeds the
  // resulting {lines, words} into the same chunk-building/reveal path as before.
  const TX_POLL_MS = 5000;
  const TX_POLL_MAX = 10;   // ~50s of live polling before giving up

  async function loadTranscript(entry, signal) {
    const token = ++transcriptToken;
    if (entry.transcriptStatus === "none") return;   // no transcript for this entry; playback still works
    for (let attempt = 0; ; attempt++) {
      if (token !== transcriptToken) return;
      let res;
      try {
        res = await fetch(`${apiBase()}/api/library/${encodeURIComponent(entry.id)}/transcript`, { signal });
      } catch {
        return;
      }
      if (token !== transcriptToken) return;
      if (res.status === 202) {
        if (attempt === 0) showWindowStatus("Transcript is being prepared…", "loading");
        if (attempt >= TX_POLL_MAX) { showWindowStatus("Transcript isn't ready yet — check back later.", "error"); return; }
        await new Promise((r) => setTimeout(r, TX_POLL_MS));
        continue;
      }
      if (!res.ok) { showWindowStatus("Couldn't load the transcript.", "error"); return; }
      let data;
      try { data = await res.json(); } catch { return; }
      if (!data || !data.lines || !data.lines.length) { showWindowStatus("No speech could be transcribed from this file.", "error"); return; }
      const words = Array.isArray(data.words) ? data.words : [];
      wordReveal = words.length > 0;
      // With word timings, build chunks straight from the words so each carries
      // its own timing; otherwise fall back to the segment-line grouping.
      chunks = wordReveal ? buildChunksFromWords(words) : buildChunks(data.lines);
      synced = chunks.some((c) => c.start > 0);
      chunkIndex = 0;
      setListen("active");
      buildWindow();
      return;
    }
  }

  /* ---------- time formatting ---------- */

  // Playback-time format (h:mm:ss / m:ss) for the audio bar and library rows.
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  /* ---------- library ---------- */

  let srcAbort = null, srcToken = 0;

  let libraryEntries = [];
  // Stack of {entry, children} frames for nested collections (e.g. a show
  // entry containing day entries, each containing segment entries) — the
  // last frame is the list currently shown. Empty means the top grid.
  let collectionStack = [];

  const MOVIE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/></svg>';
  const AUDIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  // A "collection" entry (e.g. a news episode grouping several individually-
  // imported segments) has no media of its own to hint at with MOVIE/AUDIO_ICON.
  const COLLECTION_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/></svg>';

  async function loadLibrary() {
    try {
      const res = await fetch(`${apiBase()}/api/library`);
      libraryEntries = await res.json();
    } catch {
      libraryEntries = [];
    }
    return libraryEntries;
  }

  // A stable, arbitrary hue per entry (from its id) so fallback cards — shown
  // when an entry has no cover art, e.g. a personal recording — read as a
  // deliberate set of colors rather than looking broken.
  function hueFor(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  }

  function iconFor(entry) {
    return entry.type === "collection" ? COLLECTION_ICON : entry.hasVideo ? MOVIE_ICON : AUDIO_ICON;
  }

  // Cover art for a grid card. The <img> sits over a gradient+icon fallback
  // that's just always there — no probing needed, a poster.jpg 404 (most
  // entries won't have one; see backend/poster.js) simply hides the <img>
  // and the fallback shows through.
  function libraryThumbHtml(entry) {
    const icon = iconFor(entry);
    return `<span class="lib-thumb" style="--hue:${hueFor(entry.id)}">` +
      `<img src="${apiBase()}/api/library/${encodeURIComponent(entry.id)}/poster" alt="" loading="lazy" onerror="this.style.display='none'">` +
      `<span class="lib-thumb-fallback">${icon}</span></span>`;
  }

  // Grid card for the idle-state home view — cover, title, kind, and a
  // continue-watching line (mirrors comart's own book-library cards: title /
  // author / "Chapter 8 · 71%"). A "collection" entry (e.g. a news episode
  // grouping several segments) has no playback progress of its own, so its
  // line just says how it opens.
  function libraryCardHtml(entry) {
    const kind = entry.type === "collection" ? "Collection"
      : entry.type === "podcast" ? "Podcast" : entry.type === "movie" ? "Movie" : "Audio";
    const pct = entry.durationSec > 0 ? Math.round((entry.progressSec / entry.durationSec) * 100) : 0;
    const progressLine = entry.type === "collection" ? "View segments"
      : entry.transcriptStatus === "processing" || entry.transcriptStatus === "pending"
      ? "Transcribing…"
      : entry.transcriptStatus === "error" ? "Transcript failed"
      : pct > 0 ? `${fmt(entry.progressSec)} · ${pct}%` : fmt(entry.durationSec);
    return `<button class="lib-card lib-item" type="button" data-id="${escapeHtml(entry.id)}">` +
      libraryThumbHtml(entry) +
      `<span class="lib-card-title">${escapeHtml(entry.title || "Untitled")}</span>` +
      `<span class="lib-card-kind">${kind}</span>` +
      `<span class="lib-card-progress">${progressLine}</span></button>`;
  }

  // Shared by every clickable entry — grid cards and list rows alike. A
  // collection (whatever level it's nested at — a show, a day within it,
  // etc.) opens its children; anything else plays.
  function onEntryActivate(entry) {
    if (!entry) return;
    if (entry.type === "collection") openCollection(entry);
    else setSource(entry);
  }

  const EMPTY_LIBRARY_HTML = '<div class="window-status"><p>Nothing in the library yet.</p></div>';

  function wireEntryClicks(container, entries) {
    container.querySelectorAll(".lib-item").forEach((btn) => {
      btn.addEventListener("click", () => onEntryActivate(entries.find((e) => e.id === btn.dataset.id)));
    });
  }

  // Every level — the root library, or (with backLabel) a collection's
  // children one level down — renders as the exact same card grid. A
  // nested view's only visual difference from the root is the back button
  // spanning the top of the grid (see .lib-list-back in app.html).
  function renderGrid(container, entries, backLabel) {
    const back = backLabel ? `<button class="lib-list-back" type="button">← ${escapeHtml(backLabel)}</button>` : "";
    container.innerHTML = back + (entries.length ? entries.map(libraryCardHtml).join("") : EMPTY_LIBRARY_HTML);
    if (backLabel) container.querySelector(".lib-list-back").addEventListener("click", backOneLevel);
    wireEntryClicks(container, entries);
  }

  // The home view: a poster grid.
  function renderLibraryGrid(container, entries) {
    collectionStack = [];
    renderGrid(container, entries, null);
  }

  // The current collection frame's children, with a back button labeled for
  // wherever "back" goes: the parent collection one level up, or "Library"
  // at the top of the stack.
  function renderCollectionView() {
    const depth = collectionStack.length;
    const frame = collectionStack[depth - 1];
    const backLabel = depth > 1 ? collectionStack[depth - 2].entry.title : "Library";
    renderGrid(libraryViewEl, frame.children, backLabel);
  }

  async function openCollection(entry) {
    let children = [];
    try {
      const res = await fetch(`${apiBase()}/api/library/${encodeURIComponent(entry.id)}/children`);
      children = await res.json();
    } catch {
      children = [];
    }
    collectionStack.push({ entry, children });
    renderCollectionView();
  }

  function backOneLevel() {
    collectionStack.pop();
    if (collectionStack.length) renderCollectionView();
    else renderLibraryGrid(libraryViewEl, libraryEntries);
  }

  // The library button always returns to the home view — stop wherever we
  // are and show the grid, exactly like a fresh launch (BASE_TITLE, disabled
  // transport, no video). Re-picking the same entry resumes from its saved
  // position (restoreProgress in setSource), so nothing is lost by leaving.
  function goHome() {
    if (currentEntry) flushProgress();
    currentEntry = null;
    srcToken++;
    transcriptToken++;
    if (srcAbort) { try { srcAbort.abort(); } catch {} }
    audioEl.pause();
    audioEl.removeAttribute("src");
    try { audioEl.load(); } catch {}
    // audioEl's own 'pause' event is async and can be dropped by the
    // load() right above (which resets the element's state machine) before
    // it dispatches — paint the stopped state directly rather than hope it
    // survives.
    paintPlay();
    setVideoCapability(null);
    playBtn.disabled = true;
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    document.title = BASE_TITLE;
    setListen("idle");
    loadLibrary().then(() => { if (!currentEntry) renderLibraryGrid(libraryViewEl, libraryEntries); });
  }
  openBtn.addEventListener("click", () => goHome());

  /* --- playback progress, saved server-side per entry --- */

  const PROGRESS_SAVE_MS = 5000;
  let lastProgressSave = 0;

  function progressURL(entry) {
    return `${apiBase()}/api/library/${encodeURIComponent(entry.id)}/progress`;
  }
  async function restoreProgress(entry, signal) {
    let data;
    try {
      const r = await fetch(progressURL(entry), { signal });
      if (!r.ok) return;
      data = await r.json();
    } catch {
      return;
    }
    if (currentEntry !== entry) return;   // superseded mid-fetch
    const pos = Number(data && data.positionSec) || 0;
    if (pos <= 0) return;
    const doSeek = () => { seekTo(pos); audioEl.removeEventListener("loadedmetadata", doSeek); };
    if (audioEl.readyState >= 1) doSeek(); else audioEl.addEventListener("loadedmetadata", doSeek);
  }
  function flushProgress() {
    if (!currentEntry || !audioEl.src) return;
    const body = JSON.stringify({ positionSec: effPos() });
    const url = progressURL(currentEntry);
    if (navigator.sendBeacon) {
      try { navigator.sendBeacon(url, new Blob([body], { type: "application/json" })); return; } catch {}
    }
    try { fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }); } catch {}
  }
  audioEl.addEventListener("pause", flushProgress);
  window.addEventListener("pagehide", flushProgress);
  window.addEventListener("beforeunload", flushProgress);

  /* --- load a library entry --- */

  // Point the player at a library entry, streamed straight from the backend —
  // no blob, no object URL, the same URL the video element uses when the entry
  // has a picture (see setVideoCapability). Restores saved progress before
  // playing, so there's no audible jump.
  async function setSource(entry) {
    if (!entry) return;
    const token = ++srcToken;
    if (srcAbort) { try { srcAbort.abort(); } catch {} }
    const ctl = (srcAbort = new AbortController());

    flushProgress();   // persist the outgoing entry's position first
    transcriptToken++;
    setVideoCapability(null);   // withdraw the toggle until confirmed

    currentEntry = entry;
    document.title = `${entry.title || "audio"} · ${BASE_TITLE}`;
    resetTranscriptState();
    resetThread();
    playBtn.disabled = true;
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    setListen("loading");

    audioEl.src = `${apiBase()}/api/library/${encodeURIComponent(entry.id)}/stream`;
    try { audioEl.load(); } catch {}
    playBtn.disabled = false;
    backBtn.disabled = false;
    fwdBtn.disabled = false;
    // Opening an entry is always a deliberate user action, so move focus onto
    // play (it never draws a focus ring — see the .ab-play CSS comment).
    try { playBtn.focus({ preventScroll: true }); } catch {}

    // Movies show video, audio/podcasts don't — automatic, per entry (see
    // applyVideoMode: no manual toggle, video mode just tracks hasVideo).
    setVideoCapability(entry.hasVideo ? entry.id : null);
    await restoreProgress(entry, ctl.signal);
    if (token !== srcToken) return;
    loadTranscript(entry, ctl.signal);

    const p = audioEl.play();
    if (p && p.catch) p.catch((e) => {
      paintPlay();   // never leave the bar showing "playing" when it isn't
      if (e && e.name === "NotSupportedError") showWindowStatus("This audio can't be played in your browser.", "error");
    });
  }

  /* ---------- audio bar wiring ---------- */

  function togglePlay() {
    if (!audioEl.src) return;
    if (audioEl.paused) {
      if (audioEl.ended) audioEl.currentTime = 0;   // resume after the end restarts from the top
      const p = audioEl.play();
      if (p && p.catch) p.catch(() => { paintPlay(); });   // keep the button truthful if play() is refused
    } else audioEl.pause();
  }
  // Seek to an ABSOLUTE time (clamped to the clip). Owns the seek-in-flight
  // machinery: set seekTarget so a rapid follow-up jump reads the pending target
  // rather than the stale audioEl.currentTime, arm the failsafe, then repaint.
  function seekTo(t) {
    if (!audioEl.src) return;
    t = Math.max(0, t);
    const d = audioEl.duration;
    if (isFinite(d) && d > 0) t = Math.min(t, d);
    seekTarget = t;
    try { audioEl.currentTime = t; } catch {}
    // Failsafe: if 'seeked' never fires, don't strand the caption on the target.
    setTimeout(() => { if (seekTarget === t) seekTarget = null; }, 1000);
    paintTime();
    syncWindow();   // refresh the caption to the new position immediately
    updateReveal(); // and re-evaluate which words are now "spoken"
  }
  function seekBy(delta) {
    if (!audioEl.src) return;
    // Base the jump on the pending target (effPos), not audioEl.currentTime, so
    // mashing ← / → fast accumulates the full distance instead of stalling.
    seekTo(effPos() + delta);
  }
  playBtn.addEventListener("click", () => { togglePlay(); });
  // Mobile ← / → buttons: same ±5s jump as the arrow keys (which touch devices
  // lack). seekBy already no-ops when nothing is loaded.
  // The loop (if any) is already cleared by the document mousedown above, so these are
  // plain ±5s jumps.
  backBtn.addEventListener("click", () => seekBy(-5));
  fwdBtn.addEventListener("click", () => seekBy(5));
  // Play/pause drive the real-time clock: start it advancing on play, freeze the
  // accumulated position on pause.
  audioEl.addEventListener("play", paintPlay);
  audioEl.addEventListener("pause", paintPlay);
  // The loop watcher stops itself while paused; restart it on resume.
  audioEl.addEventListener("play", () => { if (loopStart != null) startLoopWatch(); });
  // Safari can fire a spurious 'ended' when currentTime is set during a seek;
  // only repaint for a real end-of-track.
  audioEl.addEventListener("ended", () => {
    const d = audioEl.duration;
    if (isFinite(d) && d > 0 && audioEl.currentTime < d - 0.5) return;
    // A loop whose end sits at the very end of the clip would hit 'ended' before the
    // rAF watcher could seek back — restart it here instead of stopping.
    if (loopStart != null) {
      seekTo(Math.max(0, loopStart - LOOP_LEAD_IN));
      const p = audioEl.play(); if (p && p.catch) p.catch(() => {});
      startLoopWatch();
      return;
    }
    paintPlay();
  });
  audioEl.addEventListener("timeupdate", paintTime);
  audioEl.addEventListener("loadedmetadata", paintTime);
  // Drop the seek override only once the audio has actually reached the target —
  // a 'seeked' from an earlier jump (while the user is still mashing) must NOT
  // clear a newer, still-pending target.
  audioEl.addEventListener("seeked", () => {
    // Tight tolerance: a 0.5s slop could clear the override after the audio had
    // drifted onto a different caption chunk; 0.15s still absorbs normal seek
    // inaccuracy, and the 1s failsafe covers a keyframe-snapped landing.
    if (seekTarget != null && Math.abs((audioEl.currentTime || 0) - seekTarget) < 0.15) {
      seekTarget = null;
      if (!frozen) syncWindow();   // re-anchor the caption to the real position at once
      updateReveal();
    }
  });
  // If the file can't be decoded/played (unsupported codec, corrupt bytes, a
  // revoked URL) the element fires 'error'. Without this the caption ticker would
  // keep scrolling against a dead clock with no sound and no explanation. The
  // 150ms ticker self-pauses on audioEl.error; here we just tell the user.
  audioEl.addEventListener("error", () => {
    if (!audioEl.src) return;                          // ignore the empty-src reset
    const code = audioEl.error && audioEl.error.code;
    if (code === 1) return;                            // MEDIA_ERR_ABORTED — benign (load replaced)
    seekTarget = null;
    paintPlay();
    showWindowStatus(
      code === 4 ? "This audio can't be played in your browser (unsupported format)."
      : code === 3 ? "Playback failed while decoding this file."
      : code === 2 ? "A network error interrupted playback."
      : "This file couldn't be played.",
      "error");
  });
  // Some containers (WebM/Ogg, especially MediaRecorder output) report duration
  // as Infinity/NaN until the element has seen the end of the stream — which
  // would leave the seek bar dead and the total time stuck at 0:00. Force it to
  // resolve once, on load, by seeking to the end and snapping straight back. A
  // guard stops the timeupdate we cause from re-triggering the seek.
  let fixingDuration = false;
  audioEl.addEventListener("loadedmetadata", () => {
    if (isFinite(audioEl.duration) && audioEl.duration > 0) return;
    fixingDuration = true;
    const onTU = () => {
      if (!fixingDuration) return;
      fixingDuration = false;
      audioEl.removeEventListener("timeupdate", onTU);
      if (seekTarget == null) { try { audioEl.currentTime = 0; } catch {} }   // don't clobber a user seek
      paintTime();
    };
    audioEl.addEventListener("timeupdate", onTU);
    try { audioEl.currentTime = 1e101; } catch { audioEl.removeEventListener("timeupdate", onTU); fixingDuration = false; }
  });

  // ---- Firefox / macOS silent-audio workaround ----
  // On Apple Silicon, Firefox tears down its CoreAudio output stream on pause
  // and rebuilds it from scratch on every seek (Mozilla bug 1134263; the M1
  // Mac-mini symptom match is bug 1876668). That rebuild sometimes fails
  // SILENTLY: currentTime keeps advancing — so the caption ticker keeps
  // scrolling — but no sound comes out, until another seek forces a fresh
  // rebuild. Users hit it after resume or an arrow-key jump and fix it by hand
  // by clicking elsewhere on the seek bar. We do that automatically: after a
  // resume or a seek, give the output a sub-perceptible currentTime "nudge"
  // (~10 ms) to force the stream to re-arm. It's well under the 150 ms caption
  // tick and inaudible, but it is a REAL new seek target — assigning currentTime
  // to itself is a no-op in Firefox and would not rebuild the stream. It can't
  // be a 100% guarantee (the defect is in Firefox), but it makes the silence
  // rare instead of routine. Gated to Firefox so it never adds a stray seek on
  // Chrome/Safari/other engines, which don't have this bug.
  const isFirefox = /firefox/i.test(navigator.userAgent || "");
  let nudging = false;   // guard: a nudge's own 'seeked' must not re-trigger one
  function wakeAudioOutput() {
    if (nudging || fixingDuration) return;            // don't fight the duration probe
    // Bail on a dead element or while a user seek is still pending — a nudge mid-seek
    // would fight the in-flight ± jumps and could strand the caption override.
    if (!audioEl.src || audioEl.error || audioEl.paused || audioEl.seeking || seekTarget != null) return;
    const d = audioEl.duration;
    if (!isFinite(d) || d <= 0) return;               // need a known duration to clamp
    const t = audioEl.currentTime || 0;
    const eps = 0.01;                                 // ~10 ms: inaudible, sub-tick
    let target = (t + eps < d - 0.05) ? t + eps : t - eps;  // back off near the very end
    target = Math.max(0, Math.min(target, d));
    if (Math.abs(target - t) < 1e-4) return;          // too small to count as a seek
    nudging = true;
    try { audioEl.currentTime = target; } catch {}
    const p = audioEl.play(); if (p && p.catch) p.catch(() => { nudging = false; });   // re-assert output
    setTimeout(() => { nudging = false; }, 400);       // failsafe if 'seeked' never fires
  }
  // A resume fires 'play'; a real seek (arrow keys or a track click) fires
  // 'seeked'. In both cases wake the output a beat later, so the nudge is a
  // fresh rebuild and isn't coalesced with the transition that just happened.
  if (isFirefox) {
    audioEl.addEventListener("play", () => { if (seekTarget == null) setTimeout(wakeAudioOutput, 80); });
    audioEl.addEventListener("seeked", () => {
      if (nudging) { nudging = false; return; }        // this 'seeked' was our own nudge
      // Wait until the user's seek run has fully settled (seekTarget cleared)
      // so a mid-mash nudge can't fight the in-flight ± jumps.
      if (fixingDuration || audioEl.paused || seekTarget != null) return;
      setTimeout(wakeAudioOutput, 60);
    });
  }

  trackEl.addEventListener("click", (e) => {
    const d = audioEl.duration;
    if (!d || !isFinite(d)) return;
    const r = trackEl.getBoundingClientRect();
    let frac = (e.clientX - r.left) / r.width;
    frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const t = frac * d;
    seekTarget = t;   // the loop (if any) was already cleared by the document mousedown
    try { audioEl.currentTime = t; } catch {}
    setTimeout(() => { if (seekTarget === t) seekTarget = null; }, 1000);
    paintTime();
    syncWindow();   // sync the caption to the clicked point even while frozen
    updateReveal();
  });
  function paintPlay() {
    const on = !audioEl.paused && !audioEl.ended;
    bar.classList.toggle("playing", on);
    playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
  }
  function paintTime() {
    const d = isFinite(audioEl.duration) ? audioEl.duration : 0;
    const p = effPos();
    fillEl.style.width = (d ? (p / d) * 100 : 0) + "%";
    timeEl.textContent = fmt(p) + " / " + fmt(d);
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      // Loop boundary is checked FIRST, even in a hidden tab: requestAnimationFrame
      // (the primary, ~16ms loop watcher) is paused while the tab is backgrounded, but
      // the audio keeps playing — so without this a backgrounded loop would run straight
      // past its end. setInterval is only throttled (~1/s) in the background, not paused,
      // so it keeps the loop repeating (coarsely) until the tab is focused again. When
      // focused, rAF fires first and this is a no-op (the seekTarget guard blocks a double seek).
      if (loopStart != null && !audioEl.paused && !audioEl.error && seekTarget == null &&
          effPos() >= loopEnd) {
        seekTo(Math.max(0, loopStart - LOOP_LEAD_IN));
      }
      // Persist playback progress every few seconds, independent of tab visibility —
      // a backgrounded tab still plays audio and should still checkpoint it.
      if (!audioEl.paused && !audioEl.error && performance.now() - lastProgressSave >= PROGRESS_SAVE_MS) {
        lastProgressSave = performance.now();
        flushProgress();
      }
      // Skip the caption sync when there's nothing to sync, the clip errored, or the tab
      // is hidden (background tabs throttle setInterval, so this would just churn).
      if (document.hidden || !audioEl.src || audioEl.error) return;
      if (!frozen) syncWindow();
      updateReveal();
      // Video mode rides this tick rather than owning a timer: keep the muted
      // picture on the audio's clock. A no-op (one property read) when off.
      syncVideoClock(false);
    }, 150);
  }
  // A backgrounded tab throttles the ticker, so the caption can fall behind the
  // audio; snap it back the moment the tab is shown again.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !audioEl.src) return;
    if (!frozen) syncWindow();
    updateReveal();
    paintTime();
    syncVideoClock(true);   // the picture drifts in a background tab too — snap it back
  });

  /* ---------- playback keyboard shortcuts ----------
     ← back 5s · → forward 5s · Space play/pause. Disabled while typing in a text
     field and while a resize handle is focused, so those keep
     their normal behaviour. */
  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" ||
           el.isContentEditable || el.getAttribute("role") === "separator";
  }
  /* ---------- reader timing controls ([ ] nudge · \ reset) ----------
     A brief hint shown in the warn slot above the bar; auto-clears. */
  let hintTimer = null;
  function flashHint(msg) {
    warnEl.textContent = msg;
    warnEl.hidden = false;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { warnEl.hidden = true; warnEl.textContent = ""; }, 1800);
  }
  function refreshTiming() {
    if (!chunks.length) return;
    syncWindow();    // may switch the current line
    updateReveal();  // re-light the words at the nudged time
  }
  function nudgeOffset(delta) {
    syncOffset = Math.round((syncOffset + delta) * 100) / 100;
    try { localStorage.setItem("zx-offset", String(syncOffset)); } catch {}
    refreshTiming();
    const s = (syncOffset >= 0 ? "+" : "") + syncOffset.toFixed(2) + "s";
    flashHint("Timing " + s + (syncOffset > 0 ? " (earlier)" : syncOffset < 0 ? " (later)" : ""));
  }
  function resetOffset() {
    syncOffset = 0;
    try { localStorage.setItem("zx-offset", "0"); } catch {}
    refreshTiming();
    flashHint("Timing reset (0.00s)");
  }

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditableTarget(document.activeElement)) return;
    if (!audioEl.src) return;
    if (e.key === "Escape") {
      if (loopStart != null) { e.preventDefault(); clearLoop(); }
      return;   // otherwise leave Escape for whatever else handles it
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      // With a loop set, ← restarts it from the top (a manual replay on demand);
      // otherwise the usual -5s jump.
      if (loopStart != null) seekTo(Math.max(0, loopStart - LOOP_LEAD_IN)); else seekBy(-5);
    }
    else if (e.key === "ArrowRight") {
      e.preventDefault();
      clearLoop();     // → means "move on": drop any loop, then jump ahead
      seekBy(5);
    }
    else if (e.key === "]") { e.preventDefault(); nudgeOffset(0.1); }
    else if (e.key === "[") { e.preventDefault(); nudgeOffset(-0.1); }
    else if (e.key === "\\") { e.preventDefault(); resetOffset(); }
    else if (e.key === " " || e.key === "Spacebar") {
      // Space belongs to the player, full stop. A button keeps focus after being
      // clicked, so the browser's native "Space activates the focused button"
      // would re-fire it — click a pronunciation badge, hit Space, and the clip
      // replays instead of the episode pausing. Buttons stay reachable with
      // Enter. The recorder modal is the one exception: it has its own clip
      // player, so a button inside it keeps native Space.
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest("#ex-modal")) return;
      e.preventDefault();
      togglePlay();
    }
  });

  /* ---------- resizable panel height ----------
     The explanation panel's height (--panel-h, set on the band) is dragged via
     the handle on its top edge — it grows upward, its bottom pinned near the
     caption. Desktop only; pointer events cover mouse + touch, arrow keys nudge
     for a11y. Persisted to localStorage. */
  const isDesktopBand = () => window.matchMedia("(min-width: 761px)").matches;
  // Desktop and mobile each remember their own panel height — a height that feels
  // right on a wide screen would swamp a phone, and vice-versa.
  const panelHKey = () => isDesktopBand() ? "zx-panel-h" : "zx-panel-h-mobile";
  const clampPanelH = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const MIN_PANEL_H = 140;
  // Desktop: most of the viewport. Mobile: keep the panel within the band by
  // leaving the fixed player's reserved height (--player-h) plus a small margin
  // free, so dragging to the max can't overflow the band and re-cover the screen.
  const maxPanelH = () => {
    if (isDesktopBand()) return Math.round(window.innerHeight * 0.85);
    const playerH = parseFloat(getComputedStyle(bandEl).getPropertyValue("--player-h")) || 130;
    return Math.max(MIN_PANEL_H, Math.round(window.innerHeight - playerH - 24));
  };
  function applyPanelH(px) {
    const h = clampPanelH(Math.round(px), MIN_PANEL_H, maxPanelH());
    bandEl.style.setProperty("--panel-h", h + "px");
    return h;
  }
  function curPanelH() {
    const v = parseFloat(getComputedStyle(bandEl).getPropertyValue("--panel-h"));
    return v > 0 ? v : Math.round(window.innerHeight * 0.6);
  }
  (function initPanelH() {
    const stored = parseFloat(localStorage.getItem(panelHKey()));
    applyPanelH(stored > 0 ? stored : Math.round(window.innerHeight * 0.6));
  })();

  /* ---------- mobile: reserve the player's real height ----------
     On desktop the player is in normal flow, so it pushes the band up and never
     overlaps it. On mobile the player is position:fixed (so it stays put while
     the page scrolls), which means we must reserve its height ourselves —
     otherwise a tall current-line caption makes the dark player float up over
     the text. We measure the player's real height (it already includes its
     safe-area padding) and feed it to the band as --player-h; the mobile rules
     size the band around it. Kept in sync as the caption grows and shrinks.
     Harmless on desktop, where the CSS doesn't read --player-h. */
  function syncPlayerReserve() {
    const h = Math.ceil(playerEl.getBoundingClientRect().height);
    bandEl.style.setProperty("--player-h", h + "px");
  }
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(syncPlayerReserve);
    ro.observe(playerEl);
  } else {
    window.addEventListener("resize", syncPlayerReserve);
  }
  window.addEventListener("orientationchange", syncPlayerReserve);
  syncPlayerReserve();

  /* ---------- mobile: collapse the player to a floating broadcast button ----------
     Mobile only (the CSS gates every rule to the max-width:760px media query).
     Collapsing hides the whole player — caption, controls and seek — and floats
     a broadcast button (.ln-fab, bottom-right, styled like the record button) to
     bring it back. The page boots collapsed (body.player-collapsed in the markup)
     so the reader gets the full screen until they want the controls. */
  function setPlayerCollapsed(collapsed) {
    document.body.classList.toggle("player-collapsed", collapsed);
    // aria-expanded reflects the player's visibility on both toggles.
    if (collapseBtn) collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    if (fabEl) fabEl.setAttribute("aria-expanded", String(!collapsed));
    // The player's measured height feeds the band's reserved space (--player-h):
    // collapsing drops it to 0 so the band reclaims the screen; reopening restores
    // it. (getBoundingClientRect forces the reflow, so this reads the new height.)
    syncPlayerReserve();
  }
  if (collapseBtn) collapseBtn.addEventListener("click", function () { setPlayerCollapsed(true); });
  if (fabEl) fabEl.addEventListener("click", function () { setPlayerCollapsed(false); });

  function wirePanelResize(handle) {
    // Drag to resize works on both desktop and mobile (the handle is touch-action:
    // none, so a touch-drag on it resizes instead of scrolling the page).
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("resizing");
      const startY = e.clientY, startH = curPanelH();
      // Drag up (smaller clientY) → taller panel.
      const move = (ev) => applyPanelH(startH + (startY - ev.clientY));
      const up = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        localStorage.setItem(panelHKey(), String(curPanelH()));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("keydown", (e) => {
      const cur = curPanelH();
      const next = e.key === "ArrowUp" ? cur + 24 : e.key === "ArrowDown" ? cur - 24 : null;
      if (next === null) return;
      e.preventDefault();
      localStorage.setItem(panelHKey(), String(applyPanelH(next)));
    });
  }
  // Re-apply on viewport change, re-deriving from the SAVED height (not the live,
  // possibly already-clamped value). Otherwise a transient innerHeight dip — the
  // mobile URL bar showing/hiding fires resize repeatedly — would ratchet a tall
  // panel permanently smaller, since clamping the live value down can't recover
  // when the viewport grows back. Reading the stored target also restores each
  // form factor's own height when the 760px breakpoint is crossed (panelHKey
  // flips). rAF-coalesced so the URL-bar resize stream doesn't thrash layout.
  let reclampQueued = false;
  window.addEventListener("resize", () => {
    if (reclampQueued) return;
    reclampQueued = true;
    requestAnimationFrame(() => {
      reclampQueued = false;
      const stored = parseFloat(localStorage.getItem(panelHKey()));
      // Fall back to the 60%-of-viewport default (re-derived from innerHeight, like
      // initPanelH) rather than the live value, so a never-dragged panel can't
      // ratchet on a tiny viewport either.
      applyPanelH(stored > 0 ? stored : Math.round(window.innerHeight * 0.6));
      // Video mode is desktop-only: crossing the 761px breakpoint hides the toggle
      // and releases the picture (idempotent, so the other resize frames are free).
      applyVideoMode();
    });
  });

  /* ---------- video mode (any hasVideo library entry · desktop only) ----------

     A movie entry streams the SAME file to both elements: the <audio> element is
     always the clock the transcript's word timings are aligned to, and — when the
     entry has a picture — a MUTED <video> plays the identical /stream URL slaved
     to it. The audio element stays the single clock, so no amount of picture
     buffering, stalling or keyframe-snapping can drag the caption out of sync —
     the worst a bad video stream can do is look choppy.

     Nothing here is allowed to accumulate over a session — the whole point of
     keeping the video tab-local:
       · no blob, no object URL: the element streams a plain src URL (range-
         requested), so the BROWSER owns the buffer and fetches only what's
         actually watched.
       · ONE <video> element, in the markup, reused forever, with its listeners
         attached exactly once here — so toggling a hundred times adds none.
       · turning video mode off (or loading any other source, or crossing to a
         phone-width viewport, or leaving the page) runs releaseVideo(): pause,
         drop the src ATTRIBUTE, load() — the spec's recipe for making the element
         let go of the decoder, the network stream and every buffered range.
       · drift correction rides the caption's existing 150 ms ticker, so the
         feature owns no timer of its own.

     Desktop only: the band is a fixed-height flex column there, and a phone has no
     room for a picture above the panel and the player. The toggle is CSS-hidden
     below 761px and crossing that breakpoint releases the video. */

  const videoWrap = document.getElementById("ln-video");
  const videoEl = document.getElementById("ln-video-el");
  const videoStatusEl = document.getElementById("ln-video-status");

  // Drift bands against the audio clock, in seconds. Below RATE the picture is
  // left alone; between RATE and SEEK we trim playbackRate and let it coast back
  // into line; above SEEK — an arrow-key jump, a track click, an A-B loop
  // wrapping — only a seek can land it.
  const VIDEO_DRIFT_RATE = 0.12;
  const VIDEO_DRIFT_SEEK = 0.5;
  const VIDEO_RATE_TRIM = 0.06;   // ±6% on a MUTED picture is invisible; a seek stutters
  const VIDEO_SEEK_EPS = 0.08;    // even a forced resync skips a jump smaller than this

  let videoSourceId = null; // id of the loaded entry, when it has a picture (null = audio-only)
  let videoState = "idle";  // idle | loading | ready | error
  let videoToken = 0;       // bumped by every attach/release; a stale callback bails

  const videoCapable = () => isDesktopBand();
  const videoShown = () => !videoWrap.hidden;

  // The overlay: spinner while preparing, a sentence on failure, nothing once the
  // first frame is on screen. Idempotent, so the reconcilers can call it freely.
  function videoStatus(message, kind) {
    if (!message && kind !== "loading") {
      if (!videoStatusEl.hidden) { videoStatusEl.hidden = true; videoStatusEl.innerHTML = ""; }
      return;
    }
    let html = '<div class="window-status' + (kind === "error" ? " error" : "") + '">';
    if (kind === "loading") html += '<div class="spinner"></div>';
    if (message) html += "<p>" + escapeHtml(message) + "</p>";
    html += "</div>";
    videoStatusEl.innerHTML = html;
    videoStatusEl.hidden = false;
  }

  // Let go of everything the stage holds. Safe to call at any time, any number of
  // times — the reconcilers below lean on that.
  function releaseVideo() {
    const hadSrc = videoEl.hasAttribute("src");
    videoState = "idle";
    videoToken++;             // any callback still in flight is now stale
    if (hadSrc) {
      try { videoEl.pause(); } catch {}
      try { videoEl.playbackRate = 1; } catch {}
      // removeAttribute, NOT src = "": an empty src is a relative URL that
      // resolves to the page itself, which the element would try to load and then
      // report as an unsupported source. The load() after it is what actually
      // frees the decoder and the buffered ranges.
      videoEl.removeAttribute("src");
      try { videoEl.load(); } catch {}
    }
    videoStatus("", null);
  }

  // Reconcile the stage with (source, viewport). No manual toggle — video mode
  // just tracks whether the loaded entry has a picture. Idempotent, so it can
  // be called freely from a resize or a source change.
  function applyVideoMode() {
    const on = !!videoSourceId && videoCapable();
    // Video mode flag on <body> (see the body.video-on rules — the record button
    // gets a drop-shadow so its glyph stays legible over the picture).
    document.body.classList.toggle("video-on", on);
    if (!on) {
      releaseVideo();
      videoWrap.hidden = true;
      return;
    }
    videoWrap.hidden = false;
    if (videoState === "idle") attachVideo();   // otherwise it's already loading/ready/failed
  }

  // Declare the loaded source's video capability: the entry id when it has a
  // picture, null for an audio-only entry or a failed open. EVERY open path
  // calls this, so the stage and the toggle can never outlive the source they
  // belong to. The mode itself survives a switch between two video entries (the
  // reader is still watching), and applyVideoMode then prepares the new one.
  function setVideoCapability(id) {
    videoSourceId = id || null;
    releaseVideo();      // the previous picture's stream and decoder go now, not later
    applyVideoMode();
  }

  // Attach the picture: the SAME /stream URL the audio element uses for this
  // entry — muted, so the doubled range-read is silent. No probe needed (unlike
  // a cold YouTube download, an imported file has no server-side prep step);
  // failures surface through the element's own 'error' listener below.
  function attachVideo() {
    if (!videoSourceId) return;
    videoToken++;
    videoState = "loading";
    videoStatus("", "loading");   // spinner only, until 'loadeddata' clears it
    videoEl.src = `${apiBase()}/api/library/${encodeURIComponent(videoSourceId)}/stream`;
    try { videoEl.load(); } catch {}
  }

  // Slave the muted picture to the audio clock. Called from the caption's 150 ms
  // ticker, on play/pause/seek, and when the tab is shown again. force=true
  // re-seeks regardless of the drift band (a fresh attach, a confirmed seek).
  function syncVideoClock(force) {
    if (!videoShown() || !videoEl.hasAttribute("src")) return;
    const vd = videoEl.duration;
    if (!isFinite(vd) || vd <= 0) return;   // metadata hasn't landed yet
    // effPos(), not syncTime(): the picture follows the REAL audio position. The
    // reader's [ ] nudge shifts only the caption's display clock.
    const want = Math.min(effPos(), vd);
    // A picture track shorter than the audio (a truncated download): park on the
    // last frame instead of hammering seeks, and never play() at the end — Chrome
    // treats play()-when-ended as "start over", which would loop the video.
    const atEnd = want >= vd - 0.05;
    const drift = (videoEl.currentTime || 0) - want;
    const off = Math.abs(drift);
    if (force ? off > VIDEO_SEEK_EPS : off > VIDEO_DRIFT_SEEK) {
      try { videoEl.currentTime = want; } catch {}
      if (videoEl.playbackRate !== 1) { try { videoEl.playbackRate = 1; } catch {} }
    } else if (!atEnd && !audioEl.paused && off > VIDEO_DRIFT_RATE) {
      // Coast back into line instead of seeking: behind → speed up, ahead → slow
      // down. Converges in a second or two and is invisible without sound. Only
      // while playing — a trimmed rate on a paused element just never converges.
      const rate = drift > 0 ? 1 - VIDEO_RATE_TRIM : 1 + VIDEO_RATE_TRIM;
      if (videoEl.playbackRate !== rate) { try { videoEl.playbackRate = rate; } catch {} }
    } else if (videoEl.playbackRate !== 1) {
      try { videoEl.playbackRate = 1; } catch {}
    }
    // Mirror the transport. The picture is muted, so autoplay policy never blocks
    // this play() — but catch anyway, since a rejected promise is unhandled noise.
    const shouldPlay = !audioEl.paused && !audioEl.ended && !audioEl.error && !atEnd;
    if (shouldPlay) {
      if (videoEl.paused) { const p = videoEl.play(); if (p && p.catch) p.catch(() => {}); }
    } else if (!videoEl.paused) {
      try { videoEl.pause(); } catch {}
    }
  }

  // ---- element + transport wiring (attached ONCE, at load) ----
  videoEl.addEventListener("loadedmetadata", () => { syncVideoClock(true); });
  videoEl.addEventListener("loadeddata", () => {
    if (!videoEl.hasAttribute("src")) return;
    videoState = "ready";
    videoStatus("", null);     // first frame decoded → reveal the picture
    syncVideoClock(true);
  });
  videoEl.addEventListener("error", () => {
    if (!videoEl.hasAttribute("src")) return;              // our own release, not a failure
    if (videoEl.error && videoEl.error.code === 1) return; // MEDIA_ERR_ABORTED — benign
    videoState = "error";
    videoStatus("The video couldn't be played here.", "error");
  });
  // Click the picture to play/pause — the one gesture a video invites. (It drives
  // the AUDIO element; the picture follows, like every other transport action.)
  // preventDefault on mousedown stops the click from moving focus onto the video
  // at all, so focus stays on the player's own controls where it belongs — and no
  // later keypress can raise a focus ring around the picture. The click event
  // still fires, and the document-level mousedown (which clears an A-B loop) is
  // untouched: preventDefault doesn't stop propagation.
  videoEl.addEventListener("mousedown", (e) => { e.preventDefault(); });
  videoEl.addEventListener("click", () => { togglePlay(); });
  audioEl.addEventListener("play", () => syncVideoClock(false));
  audioEl.addEventListener("pause", () => syncVideoClock(false));
  audioEl.addEventListener("seeked", () => syncVideoClock(true));
  // Leaving the page: let go before the tab is frozen or discarded, so a
  // back-forward-cached page never sits on a decoder and a live stream. Coming
  // back from that cache, the stage is still up but empty (release left the state
  // idle), so reconcile — which re-attaches if video mode was on.
  window.addEventListener("pagehide", releaseVideo);
  window.addEventListener("pageshow", () => { applyVideoMode(); });

  /* ---------- boot ---------- */

  playerEl.hidden = false;
  startTicker();
  checkCredits();
  applyVideoMode();  // no source yet → stage down (one source of truth)
  loadLibrary().then(() => { if (!currentEntry) renderLibraryGrid(libraryViewEl, libraryEntries); });
  setListen("idle");   // show the library grid; the caption stays empty
})();
