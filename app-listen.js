(function () {
  "use strict";

  /* Listen — YOUR audio with a synced 3-sentence transcript window and
     word-by-word explanations. You bring the data: open (or drop) an audio file
     and it plays locally from an object URL while the bytes are sliced and sent
     to the self-hosted Parakeet STT service via /api/transcript/* for the
     synced caption. Drift-prone VBR MP3/AAC uploads
     are rejected up front (they desync in the browser) with a convert command.
     No fixed data source — no feeds, no directory, no proxy. Wrapped in its own
     IIFE so it can't collide with the exscriptor script above. */

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
    if (state === "idle") {
      nowWindow.innerHTML = "";
    } else if (state === "loading") {
      showWindowStatus("", "loading");   // spinner at the current-line spot
    }
  }
  const warnEl = document.getElementById("ln-warn");
  const playerEl = document.getElementById("ln-player");
  const bar = document.getElementById("ln-bar");
  const openBtn = document.getElementById("ln-open");      // bar's open-file button
  const fileInput = document.getElementById("ln-file");
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

  let currentName = "";            // the loaded file's name (for the tab title)
  let currentObjectUrl = null;     // object URL of the loaded file (revoked on replace)
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

  // A single explanation panel off the caption / pasted text (O). Each new O
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
    // A caption lookup reuses the same single panel, so drop any pasted-text
    // highlight too — the lit word should always match what the panel explains.
    if (items.length) { clearTextMarks(); startNewExplain(items); }
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

  // Group consecutive marked words into items. Works on any word/sep token
  // array — the caption's `tokens` (default) or the pasted text's `textTokens`.
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
  // one-highlight-at-a-time model as O (the caption / pasted text).
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
    const res = await fetch(comartAPI() + "/api/explain", {
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
      fetch(`${comartAPI()}/api/pron?word=${encodeURIComponent(word)}&pos=${encodeURIComponent(pos)}`)
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
      const r = await fetch(comartAPI() + "/api/credits");
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

  /* ---------- transcript fetch ---------- */

  // Transcripts come from the self-hosted Parakeet service on the NUC, proxied
  // by comart. Large bodies are split to stay under proxy limits,
  // so the file is sliced and sent in chunks; the service reassembles and
  // transcribes (2 h of audio ≈ 3–4 min), and we poll until the job is done.
  const TX_CHUNK = 48 * 1024 * 1024;        // per-request slice, well under the cap
  const TX_MAX = 2 * 1024 * 1024 * 1024;    // service's total cap
  const TX_HASH_MAX = 128 * 1024 * 1024;    // hash in-memory only up to this size
  const TX_POLL_MS = 4000;
  const TX_PROCESSING_LIMIT = 450;          // ~30 min of actual processing
  const TX_QUEUED_LIMIT = 3600;             // ~4 h queued — matches the service's queue TTL

  // Opening a new file aborts the previous run's in-flight requests (the
  // token checks alone would let an abandoned upload keep burning bandwidth).
  let txAbort = null;

  // SHA-256 of the file so the server can answer instantly from its cache
  // without an upload. WebCrypto has no streaming digest, so large files skip
  // the probe (the result still gets cached server-side by content hash);
  // the cap also keeps the one-shot ArrayBuffer from OOMing mobile browsers.
  async function fileSha256(file) {
    if (file.size > TX_HASH_MAX) return null;
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }

  async function txCall(path, init) {
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new Error("Could not reach the transcription service.");
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error(data?.error || "Could not transcribe this file.");
      err.status = res.status;   // lets callers tell retryable from terminal
      throw err;
    }
    // 2xx but not JSON = the Access session expired and we got its login page
    if (!data) throw new Error("Your session has expired — please reload the page.");
    return data;
  }

  // Transient failures (network blips, 5xx, busy/not-ready) deserve retries —
  // the service keeps uploads for 6 h and `finish` is idempotent exactly so a
  // lost response doesn't strand a multi-GB upload. 4xx (other than 409/429)
  // means the request itself is wrong: don't retry those.
  function txRetryable(e) {
    return !e.status || e.status >= 500 || e.status === 409 || e.status === 429;
  }

  // Upload the file in slices and poll the transcription job. Each step checks
  // the token so opening another file abandons this run silently.
  async function fetchTranscript(file) {
    const token = ++transcriptToken;
    if (txAbort) txAbort.abort();
    const ctl = (txAbort = new AbortController());
    const call = (path, init = {}) => txCall(path, { ...init, signal: ctl.signal });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // No status text while loading — the band shows a spinner (see setListen).
    try {
      if (file.size > TX_MAX) throw new Error("This file is too large to transcribe (over 2 GB).");

      const sha = await fileSha256(file);
      if (token !== transcriptToken) return;
      let data = await call(comartAPI() + "/api/transcript/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256: sha, size: file.size }),
      });
      if (token !== transcriptToken) return;

      if (!data.transcript) {
        const upload = data.upload_id;
        for (let n = 0; n * TX_CHUNK < file.size; n++) {
          const slice = file.slice(n * TX_CHUNK, (n + 1) * TX_CHUNK);
          // one retry per chunk — a single blip shouldn't sink a long upload
          // (a re-PUT of the same chunk is safe: the service renames atomically)
          try {
            await call(`${comartAPI()}/api/transcript/chunk?upload=${upload}&n=${n}`, { method: "PUT", body: slice });
          } catch (e) {
            if (token !== transcriptToken) return;
            if (!txRetryable(e)) throw e;
            await sleep(2000);
            await call(`${comartAPI()}/api/transcript/chunk?upload=${upload}&n=${n}`, { method: "PUT", body: slice });
          }
          if (token !== transcriptToken) return;
        }

        // finish with backoff: it can 409 while a retried chunk is still
        // draining server-side, or lose its response to a proxy timeout —
        // repeating it returns the same job either way.
        let fin;
        for (let a = 0; ; a++) {
          try {
            fin = await call(`${comartAPI()}/api/transcript/finish?upload=${upload}`, { method: "POST" });
            break;
          } catch (e) {
            if (token !== transcriptToken) return;
            if (a >= 4 || !txRetryable(e)) throw e;
            await sleep(3000 * (a + 1));
          }
        }
        if (token !== transcriptToken) return;

        // poll until done: tolerate a few consecutive failed polls, and cap
        // queued time separately from processing time (a busy queue is the
        // service telling us to wait, not a hung job).
        let fails = 0, processing = 0, queued = 0;
        for (;;) {
          await sleep(TX_POLL_MS);
          if (token !== transcriptToken) return;
          try {
            data = await call(`${comartAPI()}/api/transcript/status?job=${fin.job_id}`);
            fails = 0;
          } catch (e) {
            if (token !== transcriptToken) return;
            if (e.status === 404 || !txRetryable(e) || ++fails >= 5) throw e;
            continue;
          }
          if (token !== transcriptToken) return;
          if (data.status === "error") throw new Error(data.error || "Could not transcribe this file.");
          if (data.status === "done") break;
          if (data.status === "processing" && ++processing >= TX_PROCESSING_LIMIT) {
            throw new Error("Transcription timed out — please try again.");
          }
          if (data.status === "queued" && ++queued >= TX_QUEUED_LIMIT) {
            throw new Error("The transcription queue is overloaded — please try again later.");
          }
        }
      }

      const t = data.transcript;
      if (!t || !t.lines || !t.lines.length) throw new Error("No speech could be transcribed from this file.");
      const words = Array.isArray(t.words) ? t.words : [];
      wordReveal = words.length > 0;
      // With word timings, build chunks straight from the words so each carries
      // its own timing; otherwise fall back to the segment-line grouping.
      chunks = wordReveal ? buildChunksFromWords(words) : buildChunks(t.lines);
      synced = chunks.some((c) => c.start > 0);
      chunkIndex = 0;
      setListen("active");
      buildWindow();
    } catch (err) {
      if (token !== transcriptToken) return;
      // On failure, surface the message in the caption (the band stays as the
      // always-on main region).
      bandLoadingEl.hidden = true;
      showWindowStatus(err.message, "error");
    }
  }

  /* ---------- open an uploaded file ---------- */

  // Playback-time format (h:mm:ss / m:ss) for the audio bar.
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  const AUDIO_NAME_RE = /\.(mp3|m4a|m4b|mp4|aac|ogg|oga|opus|wav|flac|webm)$/i;

  // Point the player at a local audio File — WITHOUT choosing how the caption is
  // sourced (that's the caller's job: Parakeet vs. a BYO transcript file).
  // opts.autoplay (default true) decides whether it starts on its own. The
  // YouTube import passes false: a video is something you start when you're ready
  // to watch it, not something that runs off while you're still deciding whether
  // to turn the picture on. Returns false if the file isn't audio.
  function loadAudio(file, opts) {
    const autoplay = !opts || opts.autoplay !== false;
    if (!file) return false;
    if (!/^audio\//i.test(file.type || "") && !AUDIO_NAME_RE.test(file.name || "")) {
      // Surface the rejection in the caption strip (next to the open button).
      showWindowStatus("That doesn't look like an audio file.", "error");
      return false;
    }
    currentName = file.name || "audio";
    document.title = `${currentName} · ${BASE_TITLE}`;
    playBtn.disabled = false;
    backBtn.disabled = false;
    fwdBtn.disabled = false;
    // Opening audio is always a deliberate user action, so move focus onto play.
    // Otherwise it stays on the source/open button, where Space would reopen the
    // picker instead of doing something useful (now Space toggles play).
    // .no-ring: the user didn't tab here, we put them here — don't draw a ring.
    playBtn.classList.add("no-ring");
    try { playBtn.focus({ preventScroll: true }); } catch {}
    resetTranscriptState();
    resetThread();
    setListen("loading");

    // Point the player at the local file — no proxy, no network, it's right here.
    if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl); } catch {} }
    currentObjectUrl = URL.createObjectURL(file);
    try { audioEl.preload = "metadata"; } catch {}
    audioEl.src = currentObjectUrl;
    try { audioEl.load(); } catch {}
    if (!autoplay) {
      // Repaint rather than trust the last state: replacing src doesn't reliably
      // fire 'pause', so the bar could otherwise be left showing ❚❚ over an audio
      // that never started. Focus is already on the play button (above), so Space
      // starts it immediately.
      paintPlay();
      return true;
    }
    // Opening a file is a user gesture, so autoplay is allowed.
    const p = audioEl.play();
    if (p && p.catch) p.catch((e) => {
      paintPlay();   // never leave the bar showing "playing" when it isn't
      if (e && e.name === "NotSupportedError") showWindowStatus("This audio can't be played in your browser.", "error");
    });
    return true;
  }

  // Open an uploaded audio file: reject it if it's a drift-prone VBR MP3/AAC,
  // otherwise play it locally and transcribe it through the Parakeet service.
  async function openFile(file) {
    if (!file) return;
    // Claim the shared "active load" generation so a YouTube import opened while
    // we sniff the header (audioDriftRisk is async) can supersede us, and so we
    // supersede any in-flight server prep. Whichever open the user triggered last
    // wins, deterministically.
    const token = ++srcToken;
    if (srcAbort) { try { srcAbort.abort(); } catch {} srcAbort = null; }
    setYouTubeSource(null);   // a local file has no picture — drop any video at once
    const risk = await audioDriftRisk(file);
    if (token !== srcToken) return;   // a newer open took over while sniffing
    if (risk) { showAudioRejected(file, risk); return; }
    if (loadAudio(file)) fetchTranscript(file);
  }

  /* ---------- drift-prone (VBR) audio guard ----------
     Reject files that play out of sync in the browser. Only TWO accepted formats
     can drift: MP3 and raw ADTS AAC — bare chains of frames with NO timing index,
     so the player estimates seek position as (time/duration)×bytes, which is wrong
     for variable bitrate (Mozilla bug 994561). Every container format (WAV, FLAC,
     M4A/MP4, Ogg/Opus, WebM) carries explicit per-sample/page timing and stays
     accurate even when VBR — those are always allowed. */

  function asciiEq(b, o, s) {
    for (let k = 0; k < s.length; k++) if (b[o + k] !== s.charCodeAt(k)) return false;
    return true;
  }

  function sniffAudioFormat(b, name) {
    if (b.length >= 12 && asciiEq(b, 0, "RIFF") && asciiEq(b, 8, "WAVE")) return "wav";
    if (asciiEq(b, 0, "fLaC")) return "flac";
    if (asciiEq(b, 0, "OggS")) return "ogg";
    if (b.length >= 8 && asciiEq(b, 4, "ftyp")) return "mp4";
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
    if (asciiEq(b, 0, "ID3")) return "mp3";
    // 0xFFE… frame sync: layer bits 00 ⇒ ADTS AAC, otherwise MP3.
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return ((b[1] >> 1) & 3) === 0 ? "aac" : "mp3";
    const ext = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return ext ? ext[1] : "unknown";
  }

  // Parse one MPEG-audio Layer III frame header at offset i (bitrate kbps, frame
  // length, side-info size), or null if it isn't a valid Layer III frame.
  function parseMp3Header(b, i) {
    if (!(b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0)) return null;
    const ver = (b[i + 1] >> 3) & 3;        // 0=2.5 1=reserved 2=2 3=1
    if (ver === 1) return null;
    if (((b[i + 1] >> 1) & 3) !== 1) return null;   // Layer III only
    const brI = (b[i + 2] >> 4) & 0x0f;
    if (brI === 0 || brI === 0x0f) return null;
    const srI = (b[i + 2] >> 2) & 3;
    if (srI === 3) return null;
    const pad = (b[i + 2] >> 1) & 1;
    const mono = ((b[i + 3] >> 6) & 3) === 3;
    const mpeg1 = ver === 3;
    const BR = mpeg1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const SR = ver === 3 ? [44100, 48000, 32000] : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    const bitrate = BR[brI], sampleRate = SR[srI];
    if (!bitrate || !sampleRate) return null;
    const frameLen = Math.floor((mpeg1 ? 144 : 72) * bitrate * 1000 / sampleRate) + pad;
    const sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    return { bitrate, frameLen, sideInfo };
  }

  function findMp3Sync(b, from) {
    for (let i = from; i + 4 < b.length; i++) {
      if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 && parseMp3Header(b, i)) return i;
    }
    return -1;
  }

  // "cbr" | "vbr" | "unknown". Trust the LAME VBR-method nibble first, then the
  // Xing/Info tag, then fall back to scanning frame bitrates for variation.
  function mp3Vbr(b) {
    const i = findMp3Sync(b, 0);
    if (i < 0) return "unknown";
    const h = parseMp3Header(b, i);
    if (!h) return "unknown";
    const to = i + 4 + h.sideInfo;
    const tag = String.fromCharCode(b[to] || 0, b[to + 1] || 0, b[to + 2] || 0, b[to + 3] || 0);
    // LAME tag VBR-method nibble (most reliable): 1/8 = CBR, 2/3/4/5/9 = VBR/ABR.
    for (let p = i; p < i + 200 && p + 9 < b.length; p++) {
      if (b[p] === 0x4c && b[p + 1] === 0x41 && b[p + 2] === 0x4d && b[p + 3] === 0x45) {  // "LAME"
        const nib = b[p + 9] & 0x0f;
        if (nib === 1 || nib === 8) return "cbr";
        if (nib === 2 || nib === 3 || nib === 4 || nib === 5 || nib === 9) return "vbr";
        break;
      }
    }
    if (tag === "Info") return "cbr";
    if (tag === "Xing") return "vbr";
    // No Xing/Info header: scan up to 40 frames; differing bitrates ⇒ VBR.
    const seen = new Set();
    let pos = i, n = 0;
    while (pos + 4 < b.length && n < 40) {
      const fh = parseMp3Header(b, pos);
      if (!fh || !fh.frameLen) { const ns = findMp3Sync(b, pos + 1); if (ns < 0) break; pos = ns; continue; }
      seen.add(fh.bitrate);
      pos += fh.frameLen; n++;
    }
    if (n < 4) return "unknown";
    return seen.size > 1 ? "vbr" : "cbr";
  }

  // Raw ADTS AAC has no VBR flag — infer it from frame-length variation.
  function adtsVbr(b) {
    let pos = -1;
    for (let i = 0; i + 7 < b.length; i++) {
      if (b[i] === 0xff && (b[i + 1] & 0xf6) === 0xf0) { pos = i; break; }
    }
    if (pos < 0) return "unknown";
    let min = Infinity, max = 0, n = 0;
    while (pos + 7 < b.length && n < 80) {
      if (!(b[pos] === 0xff && (b[pos + 1] & 0xf6) === 0xf0)) break;
      const len = ((b[pos + 3] & 3) << 11) | (b[pos + 4] << 3) | (b[pos + 5] >> 5);
      if (len < 7) break;
      if (len < min) min = len;
      if (len > max) max = len;
      pos += len; n++;
    }
    if (n < 6) return "unknown";
    return (max - min) > 4 ? "vbr" : "cbr";   // CBR ADTS frames are near-constant
  }

  // Read the file head and decide whether it will drift in the browser. Returns
  // a {label} object to reject, or null to allow (fail open on any uncertainty).
  async function audioDriftRisk(file) {
    let head;
    try { head = new Uint8Array(await file.slice(0, 12).arrayBuffer()); } catch { return null; }
    const fmt = sniffAudioFormat(head, file.name);
    if (fmt !== "mp3" && fmt !== "aac") return null;   // sample-accurate container ⇒ safe
    let start = 0;
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {   // skip an ID3v2 tag
      const sz = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      start = 10 + sz + ((head[5] & 0x10) ? 10 : 0);
    }
    let b;
    try { b = new Uint8Array(await file.slice(start, start + 96 * 1024).arrayBuffer()); } catch { return null; }
    const v = fmt === "mp3" ? mp3Vbr(b) : adtsVbr(b);
    if (v !== "vbr") return null;   // cbr / unknown ⇒ allow
    return { fmt, label: fmt === "mp3" ? "a variable-bitrate (VBR) MP3" : "a variable-bitrate (VBR) AAC" };
  }

  // Reject a drift-prone file in the caption, with a copy-ready convert command
  // that REPLACES the original VBR file with the new CBR one. ffmpeg can't read
  // and write the same file at once, so it always encodes to a temp file; the
  // && steps only run if that succeeds, leaving the original untouched on error.
  function showAudioRejected(file, info) {
    const name = file.name || "input";
    const base = name.replace(/\.[^.]+$/, "");
    const tmp = base + "-cbr.tmp.mp3";
    // MP3 stays .mp3 in place; raw-ADTS AAC must become .mp3 (the native AAC
    // encoder isn't reliably CBR, so an AAC re-encode could be rejected again).
    const dest = info.fmt === "mp3" ? name : base + ".mp3";
    let cmd = 'ffmpeg -i "' + name + '" -c:a libmp3lame -b:a 192k "' + tmp + '"';
    cmd += dest === name
      ? ' && mv -f "' + tmp + '" "' + name + '"'                            // overwrite in place
      : ' && rm -f "' + name + '" && mv -f "' + tmp + '" "' + dest + '"';   // drop the .aac, keep .mp3
    document.title = BASE_TITLE;
    nowWindow.innerHTML =
      '<div class="window-status error">' +
      '<p>This is ' + escapeHtml(info.label) + ", which plays out of sync in the browser.</p>" +
      "<p>Convert it to constant bitrate (this replaces the file), then load it:</p>" +
      '<pre style="white-space:pre-wrap;word-break:break-all;user-select:all;font-size:12px;' +
      'background:rgba(0,0,0,0.18);padding:8px 10px;border-radius:6px;margin:6px 0;text-align:left;">' +
      escapeHtml(cmd) + "</pre>" +
      '<p style="font-size:12px;opacity:0.7;">CBR MP3, WAV, FLAC, M4A, Ogg/Opus and WebM all work as-is.</p>' +
      "</div>";
  }

  // Release the object URL when the page goes away.
  window.addEventListener("pagehide", () => {
    if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl); } catch {} currentObjectUrl = null; }
  });

  /* ---------- source picker (local file + YouTube) ----------
     The open button raises a popover: a local file, or a YouTube link. A YouTube
     import is fetched + re-encoded to CBR by the server (so playback can't drift)
     and then run through the SAME play+transcribe path as a local file — no
     client-side VBR guard needed, the server guarantees it. */

  const srcMenu = document.getElementById("ln-src-menu");
  const srcSheet = document.getElementById("ln-src-sheet");
  const srcSheetBackdrop = document.getElementById("ln-src-backdrop");
  const srcCloseBtn = document.getElementById("ln-src-close");
  const srcList = document.getElementById("ln-src-list");
  const srcTitleEl = document.getElementById("ln-src-title");
  let srcAbort = null, srcToken = 0;
  let srcMenuLoaded = false;

  function pickFile() { fileInput.click(); }
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";   // reset so re-picking the SAME file still fires change
    if (file) openFile(file);
  });

  /* --- the source popover --- */
  function openSrcMenu() {
    ensureSrcMenu();   // lazily populate the injected items (idempotent)
    srcMenu.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
    // Capture-phase so a click anywhere else closes it before that click acts.
    document.addEventListener("pointerdown", onOutsidePointer, true);
  }
  function closeSrcMenu() {
    if (srcMenu.hidden) return;
    srcMenu.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutsidePointer, true);
  }
  function onOutsidePointer(e) {
    if (srcMenu.contains(e.target) || openBtn.contains(e.target)) return;
    closeSrcMenu();
  }
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    srcMenu.hidden ? openSrcMenu() : closeSrcMenu();
  });
  document.getElementById("ln-src-file").addEventListener("click", () => { closeSrcMenu(); pickFile(); });

  // Play-in-screen icon for the YouTube import item.
  const YT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.2l5 2.8-5 2.8z" fill="currentColor" stroke="none"/></svg>';

  // Ask the server whether it can import YouTube (yt-dlp present) and, if so,
  // append the YouTube item to the popover. Runs once; the menu still works
  // (local file only) if the call fails.
  async function ensureSrcMenu() {
    if (srcMenuLoaded) return;
    srcMenuLoaded = true;
    let data;
    try {
      const res = await fetch(comartAPI() + "/api/sources/feeds");
      data = await res.json();
    } catch { srcMenuLoaded = false; return; }   // allow a retry on next open
    // Desktop audio first — the server owns the microphone-free capture and
    // reports here whether it can do it at all (Linux + a PulseAudio socket).
    if (data && data.youtube) {
      const yt = document.createElement("button");
      yt.type = "button";
      yt.className = "src-menu-item";
      yt.setAttribute("role", "menuitem");
      yt.innerHTML = YT_ICON + "<span>YouTube…<small>Paste a video link</small></span>";
      yt.addEventListener("click", () => { closeSrcMenu(); openYouTubePrompt(); });
      srcMenu.appendChild(yt);
    }
  }

  // The YouTube "paste a link" prompt, rendered into the shared source sheet.
  // Submitting POSTs the link to the server, which resolves it to an opaque id;
  // we then open that id through openSource, the same fetch + CBR + transcribe
  // path a local file ends in.
  function openYouTubePrompt() {
    sheetOpener = openBtn;
    srcTitleEl.textContent = "YouTube";
    showSheet();
    srcList.innerHTML = "";

    const form = document.createElement("form");
    form.className = "yt-form";
    const input = document.createElement("input");
    input.type = "url";
    input.className = "yt-input";
    input.placeholder = "Paste a YouTube link…";
    input.autocomplete = "off";
    input.spellcheck = false;
    const load = document.createElement("button");
    load.type = "submit";
    load.className = "yt-load";
    load.textContent = "Load";
    const status = document.createElement("div");
    status.className = "yt-status";
    form.append(input, load, status);
    srcList.appendChild(form);
    try { input.focus(); } catch {}

    let busy = false;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const url = input.value.trim();
      if (!url) { try { input.focus(); } catch {} return; }
      busy = true;
      input.disabled = load.disabled = true;
      status.innerHTML = '<div class="window-status"><div class="spinner"></div><p>Checking the link…</p></div>';
      let data;
      try {
        const res = await fetch(comartAPI() + "/api/sources/youtube", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) || "Couldn't load that video.");
      } catch (err) {
        busy = false;
        input.disabled = load.disabled = false;
        status.innerHTML = '<div class="window-status error"><p>' +
          escapeHtml(err.message || "Couldn't load that video.") + "</p></div>";
        try { input.focus(); } catch {}
        return;
      }
      if (srcSheet.hidden) return;   // closed while loading
      closeSheet(false);
      // The same id resolves the picture (/api/sources/yt-video), so hand it to
      // openSource as the video source too — that's what offers the video toggle.
      openSource({ id: data.id, title: data.title || "YouTube video" },
        comartAPI() + "/api/sources/yt-audio?id=" + encodeURIComponent(data.id), data.id);
    });
  }

  /* --- the shared source sheet --- */
  function showSheet() {
    if (!srcSheet.hidden) return;
    srcSheet.hidden = false;
    try { srcCloseBtn.focus(); } catch {}   // move focus into the aria-modal dialog
  }
  // Which control raised the sheet — focus returns there on close (dialog a11y).
  // Today that is always the add-audio button (the YouTube prompt hangs off it),
  // but the sheet doesn't need to know that.
  let sheetOpener = null;
  function closeSheet(returnFocus = true) {
    if (srcSheet.hidden) return;
    srcSheet.hidden = true;
    // Return focus to the opener — EXCEPT when an item was picked (returnFocus=false),
    // where the load path moves focus itself (e.g. loadAudio → play button), so
    // Space won't reopen the picker.
    if (returnFocus && sheetOpener) { try { sheetOpener.focus(); } catch {} }
  }
  srcSheetBackdrop.addEventListener("click", closeSheet);
  srcCloseBtn.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!srcSheet.hidden) closeSheet();
    else closeSrcMenu();
  });

  /* --- open a server-prepared source --- */
  // Make a filesystem-safe display name for the fetched blob (drives the tab
  // title; the bytes themselves are the server's CBR MP3).
  function safeName(s) {
    s = String(s || "audio").replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    return (s.slice(0, 120) || "audio") + ".mp3";
  }

  // Open a server-prepared source (today only a YouTube import): fetch the CBR
  // MP3 the server produced, then run it through the same play + transcribe path
  // as a local file. audioURL is required — the caller names the endpoint.
  // ytId is the opaque id of a YouTube import — the one source kind that also has
  // a picture available (see the video-mode block). It's declared only once the
  // audio is actually in hand, and cleared up front, so the video toggle never
  // points at a source that failed to open.
  async function openSource(ep, audioURL, ytId) {
    if (!ep || !ep.id || !audioURL) return;
    const token = ++srcToken;
    if (srcAbort) { try { srcAbort.abort(); } catch {} }
    const ctl = (srcAbort = new AbortController());
    setYouTubeSource(null);
    // Abandon any transcript run for the previously loaded file.
    transcriptToken++;
    if (txAbort) { try { txAbort.abort(); } catch {} }

    currentName = ep.title || "audio";
    document.title = currentName + " · " + BASE_TITLE;
    resetTranscriptState();
    resetThread();
    playBtn.disabled = true;
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    try { audioEl.pause(); } catch {}
    showWindowStatus("Preparing audio on the server…", "loading");
    // A cold video (first open) waits on a server download + ffmpeg transcode;
    // reassure after a few seconds so a long tail doesn't read as a hang.
    const hintTimer = setTimeout(() => {
      if (token === srcToken) showWindowStatus("Still preparing… longer videos take a moment.", "loading");
    }, 8000);

    let file;
    try {
      const res = await fetch(audioURL, { signal: ctl.signal });
      if (token !== srcToken) return;
      if (!res.ok) {
        let msg = "Couldn't prepare this audio.";
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (token !== srcToken) return;
      if (!blob.size) throw new Error("The audio was empty.");
      file = new File([blob], safeName(ep.title), { type: "audio/mpeg" });
    } catch (e) {
      clearTimeout(hintTimer);
      if (e && e.name === "AbortError") return;
      if (token !== srcToken) return;
      document.title = BASE_TITLE;   // don't leave the tab stuck on a failed video
      currentName = "";
      showWindowStatus(e.message || "Couldn't prepare this audio.", "error");
      // No audio loaded, so loadAudio's focus-to-play never runs. We started the
      // import from the sheet (which deliberately didn't return focus), so put
      // focus back on the open button rather than stranding it on <body>. (Abort /
      // superseded returns above are owned by the newer action — left untouched.)
      try { openBtn.focus(); } catch {}
      return;
    }
    clearTimeout(hintTimer);
    if (token !== srcToken) return;
    // Server-guaranteed CBR — straight into the normal play + transcribe path.
    // A server-prepared source waits for you to press play; ytId is set for every
    // one of them today, so autoplay stays off.
    if (loadAudio(file, { autoplay: !ytId })) {
      setYouTubeSource(ytId);   // offer (or withdraw) the video toggle for this source
      fetchTranscript(file);
    }
  }

  // The whole page is a drop target. preventDefault on dragover is what allows a
  // drop at all; the band lights up (.drag-over) while a file hovers the window.
  let dragDepth = 0;
  const draggingFiles = (e) => !!e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types, "Files");
  window.addEventListener("dragenter", (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    bandEl.classList.add("drag-over");
  });
  window.addEventListener("dragover", (e) => { if (draggingFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) bandEl.classList.remove("drag-over");
  });
  window.addEventListener("drop", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragDepth = 0;
    bandEl.classList.remove("drag-over");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) openFile(file);
  });

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
  playBtn.addEventListener("click", (e) => {
    // A mouse click leaves focus on the button; the next keypress would then raise
    // the focus ring around it. e.detail is 0 for a keyboard-driven click — a
    // keyboard user tabbed here and has earned the ring, so leave theirs alone.
    if (e.detail > 0) playBtn.classList.add("no-ring");
    togglePlay();
  });
  // Focus left the button, so the suppression expires with it: whatever brings
  // focus back next (a Tab, say) gets judged on its own merits.
  playBtn.addEventListener("blur", () => playBtn.classList.remove("no-ring"));
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
    if (!srcSheet.hidden || !srcMenu.hidden) return;   // a picker is open — don't drive playback
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

  /* ---------- pasted-text reading mode ---------- */

  // A SECOND source for the SAME explanation panel: the user pastes a text
  // (⌘V / Ctrl+V) and reads it in the main space. Every word becomes a markable
  // .word span, so the click-a-word / drag-a-phrase flow is identical to the
  // caption's. The ONE difference is the CONTEXT WINDOW sent to /api/explain:
  // here it's SENT_WINDOW sentences before + the selection's own sentence(s) +
  // SENT_WINDOW after, drawn from the PASTED text (never the audio transcript).
  //
  // Context isolation is automatic: each panel snapshots its context into
  // panel.threadText at selection time (see startNewExplain / startNewExplainText)
  // and the backend is source-agnostic, so a text pick carries text context and
  // an audio pick carries audio context — they never mix. A fresh pick of either
  // kind resets the single shared panel (nextPanelForSelection), so switching
  // between the two clears the panel. Follow-ups stay inside one panel and keep
  // that pick's context.

  const textEl = document.getElementById("ln-text");

  const SENT_WINDOW = 5;        // sentences kept on EACH side of the selection
  const MAX_PASTE = 600000;     // ~600k-char guard so a giant paste can't hang
  const MAX_HTML = 3000000;     // rich-paste guard (HTML markup is far bulkier)

  let pastedText = "";          // raw pasted text (normalised newlines)
  let textSentences = [];       // [sentenceString] — the context-window units
  let textTokens = [];          // [{type:'word'|'sep'|'break', value?, marked?, sent?}]
  let textSpans = [];           // token index -> rendered .word element (sparse)
  let textActive = false;       // is a pasted text currently shown?
  let textDrag = null;          // in-progress drag selection over the text

  // Split a paragraph into sentences — the same lightweight rule the backend
  // uses for its plain-text fallback: break after . ! ? … + whitespace.
  function splitSentences(para) {
    const out = [];
    for (const s of para.split(/(?<=[.!?…])\s+/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
    return out.length ? out : (para.trim() ? [para.trim()] : []);
  }

  // Offset-preserving version of the same sentence rule, used by the HTML paste
  // path. Returns [start, end) ranges that TILE the whole string (every char is
  // in exactly one range), so a token's character offset maps cleanly to the
  // sentence it belongs to — which is what drives the context window. The split
  // is the same as splitSentences (break after . ! ? … + whitespace), but the
  // trailing whitespace stays attached to the preceding sentence's range.
  function sentenceRanges(text) {
    const ranges = [];
    const re = /[.!?…]+\s+/g;
    let start = 0, m;
    while ((m = re.exec(text)) !== null) {
      const end = m.index + m[0].length;
      ranges.push([start, end]);
      start = end;
    }
    if (start < text.length) ranges.push([start, text.length]);
    if (!ranges.length) ranges.push([0, text.length]);
    return ranges;
  }

  // Turn raw pasted text into the token stream + the sentence list. Paragraphs
  // (blank-line separated) become 'break' tokens; wrapped single newlines inside
  // a paragraph are joined into one flowing line. Each word token carries the
  // index of the sentence it belongs to, which drives the context window.
  function buildTextModel(text) {
    textTokens = [];
    textSentences = [];
    let firstPara = true;
    for (const rawPara of text.split(/\n{2,}/)) {
      const para = rawPara.replace(/\s*\n\s*/g, " ").trim();
      if (!para) continue;
      if (!firstPara) textTokens.push({ type: "break" });
      firstPara = false;
      const sents = splitSentences(para);
      for (let s = 0; s < sents.length; s++) {
        const sentIdx = textSentences.length;
        textSentences.push(sents[s]);
        for (const tok of tokenize(sents[s])) {
          textTokens.push(tok.type === "word"
            ? { type: "word", value: tok.value, marked: false, sent: sentIdx }
            : { type: "sep", value: tok.value });
        }
        if (s < sents.length - 1) textTokens.push({ type: "sep", value: " " });
      }
    }
  }

  // ---- rich (HTML) paste ----------------------------------------------------
  //
  // The clipboard usually carries a text/html flavour alongside the plain text.
  // We read ONLY its structure — block boundaries (p / h1–h6 / li / …) and the
  // inline bold/italic state — and re-emit our OWN controlled spans. The pasted
  // markup is never injected into the page, so there is no XSS surface: we touch
  // tag names and text node values only.

  // Walk the parsed HTML into an ordered list of blocks. Each block is
  //   { tag: "p" | "h1".."h6", text: <plain text>, runs: [{len, b, i}] }
  // where `runs` tile `text` and record the bold/italic state of each slice.
  function htmlToBlocks(html) {
    const BLOCK = { P:1, DIV:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, LI:1,
      BLOCKQUOTE:1, SECTION:1, ARTICLE:1, HEADER:1, FOOTER:1, MAIN:1, ASIDE:1,
      NAV:1, UL:1, OL:1, DL:1, DT:1, DD:1, TABLE:1, TR:1, FIGURE:1,
      FIGCAPTION:1, HR:1, PRE:1, ADDRESS:1, DETAILS:1, SUMMARY:1 };
    const HEADING = { H1:1, H2:1, H3:1, H4:1, H5:1, H6:1 };
    const SKIP = { SCRIPT:1, STYLE:1, HEAD:1, NOSCRIPT:1, TEMPLATE:1, TITLE:1 };

    let doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); }
    catch (_) { return []; }
    const root = doc && (doc.body || doc.documentElement);
    if (!root) return [];

    const blocks = [];
    let curTag = "p";
    let parts = [];                       // [{text, b, i}] for the open block

    function flush() {
      while (parts.length && !parts[0].text.trim()) parts.shift();
      while (parts.length && !parts[parts.length - 1].text.trim()) parts.pop();
      if (parts.length) {
        parts[0] = { text: parts[0].text.replace(/^\s+/, ""), b: parts[0].b, i: parts[0].i };
        const li = parts.length - 1;
        parts[li] = { text: parts[li].text.replace(/\s+$/, ""), b: parts[li].b, i: parts[li].i };
      }
      const text = parts.map((p) => p.text).join("");
      if (text.trim()) {
        blocks.push({ tag: curTag, text, runs: parts.map((p) => ({ len: p.text.length, b: p.b, i: p.i })) });
      }
      parts = [];
    }

    function visit(node, b, i) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {                       // text node
          const t = child.nodeValue.replace(/\s+/g, " "); // collapse like HTML does
          if (t) parts.push({ text: t, b, i });
        } else if (child.nodeType === 1) {                // element
          const tag = child.tagName;
          if (SKIP[tag]) continue;
          if (tag === "BR") { parts.push({ text: " ", b, i }); continue; }
          // An <img> is the one non-text block the reading view keeps. Emit it
          // only when it carries real alt text on an https src: that single test
          // drops tracking pixels, spacers and related-story promo thumbnails (all
          // alt="") while keeping the article's actual figure photos. The server
          // never touches it — the browser would load it straight from its origin,
          // which the page CSP's img-src currently allows for no remote host.
          if (tag === "IMG") {
            const alt = (child.getAttribute("alt") || "").trim();
            const src = (child.getAttribute("src") || "").trim();
            if (alt && /^https:\/\//i.test(src)) { flush(); blocks.push({ tag: "img", src, alt }); }
            continue;
          }
          // An <iframe> embed (YouTube video, data viz, …) can't render here — the
          // page CSP blocks third-party frames outright. Left alone it would vanish
          // and strand its section heading with nothing under it. So emit a labelled
          // placeholder (the embed's own title, when it has one) so the reader knows
          // a video/embed belongs there.
          if (tag === "IFRAME") {
            const label = (child.getAttribute("title") || "").trim();
            const isrc = child.getAttribute("src") || "";
            const fig = child.closest && child.closest("figure");
            const video = /youtube|youtu\.be|vimeo|\/embed\//i.test(isrc)
              || /is-type-video/.test((fig && fig.className) || "");
            flush();
            blocks.push({ tag: "embed", label, video });
            continue;
          }
          // Emphasis = inherited, then the tag's own contribution, then an
          // explicit inline style wins (browsers inline computed weight/style
          // when copying, so this is where the source's REAL look comes from).
          // Headings are bold by UA default — but the source often overrides a
          // title/byline back to normal via CSS, which copy turns into an inline
          // `font-weight: normal/400`; honouring that is what keeps a non-bold
          // title from rendering bold here.
          let nb = b || tag === "B" || tag === "STRONG" || !!HEADING[tag];
          let ni = i || tag === "I" || tag === "EM";
          const styleAttr = child.getAttribute("style");
          if (styleAttr) {
            const mw = /font-weight\s*:\s*([a-z0-9]+)/i.exec(styleAttr);
            if (mw) { const v = mw[1].toLowerCase(), n = parseInt(v, 10);
              if (v === "bold" || v === "bolder") nb = true;
              else if (v === "normal" || v === "lighter") nb = false;
              else if (!isNaN(n)) nb = n >= 600; }
            const ms = /font-style\s*:\s*([a-z]+)/i.exec(styleAttr);
            if (ms) { const v = ms[1].toLowerCase();
              if (v === "italic" || v === "oblique") ni = true;
              else if (v === "normal") ni = false; }
          }
          if (BLOCK[tag]) {
            flush();
            const saved = curTag;
            // figcaption → a styled image caption; address → the title's byline
            // (that is how sources mark a masthead credit); everything else is a paragraph.
            curTag = HEADING[tag] ? tag.toLowerCase()
              : tag === "FIGCAPTION" ? "figcaption"
              : tag === "ADDRESS" ? "byline"
              : "p";
            visit(child, nb, ni);
            flush();
            curTag = saved;
          } else {
            visit(child, nb, ni);                         // inline: keep accumulating
          }
        }
      }
    }

    visit(root, false, false);
    flush();
    return blocks;
  }

  // Build the SAME token stream buildTextModel produces — word / sep / break,
  // with word tokens carrying a `sent` index — but with two additions the plain
  // path lacks: a `tag` on each break (so render knows heading vs paragraph) and
  // `b` / `i` flags on word tokens. The word/sep tokenisation and sentence
  // indexing are unchanged, so click / drag / phrase-join / context all behave
  // exactly as before.
  function buildTextModelFromHtml(html) {
    textTokens = [];
    textSentences = [];
    const blocks = htmlToBlocks(html);
    for (const blk of blocks) {
      // An image block carries no words — emit a standalone img token (skipped by
      // the word/mark logic, which only ever touches type === "word").
      if (blk.tag === "img") { textTokens.push({ type: "img", src: blk.src, alt: blk.alt }); continue; }
      if (blk.tag === "embed") { textTokens.push({ type: "embed", label: blk.label, video: blk.video }); continue; }
      const text = blk.text;
      if (!text.trim()) continue;
      textTokens.push({ type: "break", tag: blk.tag });   // leading break carries this block's tag
      const ranges = sentenceRanges(text);
      const baseSent = textSentences.length;
      for (const r of ranges) textSentences.push(text.slice(r[0], r[1]).trim());
      const runs = blk.runs;
      let off = 0, si = 0, ri = 0, racc = 0;               // forward pointers (off is non-decreasing)
      for (const tok of tokenize(text)) {
        if (tok.type === "word") {
          while (si < ranges.length - 1 && off >= ranges[si][1]) si++;
          while (ri < runs.length - 1 && off >= racc + runs[ri].len) { racc += runs[ri].len; ri++; }
          const st = runs[ri] || { b: false, i: false };
          textTokens.push({ type: "word", value: tok.value, marked: false, sent: baseSent + si, b: !!st.b, i: !!st.i });
        } else {
          textTokens.push({ type: "sep", value: tok.value });
        }
        off += tok.value.length;
      }
    }
  }

  function renderTextView() {
    let html = "", para = "", curTag = "p";
    const flush = () => {
      if (!para) return;
      if (curTag === "p") html += `<p class="rt-p">${para}</p>`;
      else if (curTag === "figcaption") html += `<p class="rt-cap">${para}</p>`;
      else if (curTag === "byline") html += `<p class="rt-byline">${para}</p>`;
      else html += `<${curTag} class="rt-h">${para}</${curTag}>`;   // h1–h6 from the paste
      para = "";
    };
    for (let i = 0; i < textTokens.length; i++) {
      const t = textTokens[i];
      if (t.type === "img") {
        // src is validated to https in htmlToBlocks; both attrs are escaped so the
        // built string can't break out of the tag (matches the .word escaping).
        flush();
        html += `<figure class="rt-fig"><img class="rt-img" loading="lazy" decoding="async" src="${escapeHtml(t.src)}" alt="${escapeHtml(t.alt)}"></figure>`;
        continue;
      }
      if (t.type === "embed") {
        // A non-renderable embed (CSP blocks third-party frames) → a labelled note
        // in place of the missing video/widget, so its section isn't a bare heading.
        flush();
        const kind = t.video ? "▶ Video" : "Embedded media";
        const lbl = t.label ? ` — ${escapeHtml(t.label)}` : "";
        html += `<p class="rt-embed">${kind}${lbl}</p>`;
        continue;
      }
      if (t.type === "break") { flush(); curTag = t.tag || "p"; continue; }
      if (t.type === "word") {
        const emph = (t.b ? " b" : "") + (t.i ? " i" : "");
        para += `<span class="word${t.marked ? " marked" : ""}${emph}" data-i="${i}">${escapeHtml(t.value)}</span>`;
      } else {
        para += escapeHtml(t.value);
      }
    }
    flush();
    textEl.innerHTML = html;
    textSpans = [];
    for (const sp of textEl.querySelectorAll(".word")) textSpans[Number(sp.dataset.i)] = sp;
  }

  // The context window for a text selection: every sentence the marked words
  // touch, plus SENT_WINDOW sentences before the first and after the last.
  function textContextWindow() {
    let lo = Infinity, hi = -Infinity;
    for (const t of textTokens) {
      if (t.type === "word" && t.marked && t.sent != null) {
        if (t.sent < lo) lo = t.sent;
        if (t.sent > hi) hi = t.sent;
      }
    }
    if (!isFinite(lo)) return pastedText.slice(0, 4000);
    const from = Math.max(0, lo - SENT_WINDOW);
    const to = Math.min(textSentences.length - 1, hi + SENT_WINDOW);
    return textSentences.slice(from, to + 1).join(" ");
  }

  // Flip one word's mark, touching only its rendered span — cheap during a drag
  // over a long article (no full re-render).
  function setTextMarked(i, val) {
    const t = textTokens[i];
    if (!t || t.type !== "word" || t.marked === val) return;
    t.marked = val;
    const sp = textSpans[i];
    if (sp) sp.classList.toggle("marked", val);
  }

  // Repaint only the words whose mark changed since the last drag step (the
  // union of the old and new ranges), so dragging stays smooth on long texts.
  function applyTextDragRange(ds = textDrag) {
    if (!ds) return;
    const a = Math.min(ds.startIdx, ds.currentIdx), b = Math.max(ds.startIdx, ds.currentIdx);
    const pa = ds.prevA == null ? a : ds.prevA;
    const pb = ds.prevB == null ? b : ds.prevB;
    for (let i = Math.min(a, pa); i <= Math.max(b, pb); i++) {
      const t = textTokens[i];
      if (!t || t.type !== "word") continue;
      const inRange = i >= a && i <= b;
      setTextMarked(i, ds.snapshot[i] !== inRange);   // XOR: toggle within range
    }
    ds.prevA = a; ds.prevB = b;
  }

  function clearTextMarks() {
    for (let i = 0; i < textTokens.length; i++) {
      if (textTokens[i].marked) setTextMarked(i, false);
    }
  }

  // A fresh text selection → next (shared) panel slot, anchored to the text's
  // own context window, then explained. `ctx` is captured BEFORE marks clear.
  function startNewExplainText(items, ctx) {
    const panel = nextPanelForSelection();
    panel.threadText = ctx;
    triggerExplain(panel, items);
  }

  // ---- Lora warm-up + reveal gating (kills the paste font-swap flash) --------
  //
  // The pasted reading view (.text-window) is set in Lora — a self-hosted woff2
  // loaded with font-display:swap. Left alone, the first paste paints in the
  // fallback serif (Georgia) and then reflows the instant Lora finishes
  // downloading: the "small then bigger" blink. To make that swap NEVER show, we
  // warm every Lora face at boot and keep the text-window hidden until Lora is
  // actually ready, so the text paints once, already in Lora. document.fonts
  // caches, so every paste after the first reveals on the next microtask with no
  // wait. A safety timeout means a font-load failure reveals the text in the
  // fallback rather than trapping it hidden forever.
  const FONT_REVEAL_TIMEOUT = 1500;   // ms — only a failure fallback, not a latency knob
  let loraReady = null;               // memoised: resolves when Lora is usable (or we gave up)
  let textWindowRevealSeq = 0;        // ignore a stale reveal if a newer paste lands first

  function warmLoraFonts() {
    if (loraReady) return loraReady;
    // The four faces a paste can render: regular, bold (.word.b), italic
    // (.word.i) and bold-italic — same family string the CSS @font-face uses.
    const faces = ['400 1em "Lora"', '700 1em "Lora"',
                   'italic 400 1em "Lora"', 'italic 700 1em "Lora"'];
    let ready;
    try {
      ready = (document.fonts && document.fonts.load)
        ? Promise.all(faces.map((f) => document.fonts.load(f, "Mg")))
        : Promise.resolve();
    } catch (_) { ready = Promise.resolve(); }   // API quirk — don't block on it
    // Never reject (a 404 / server error must not block reveal) and cap the wait
    // so the first paste can't hang on a slow or failed font fetch.
    loraReady = Promise.race([
      ready.catch(() => {}),
      new Promise((res) => setTimeout(res, FONT_REVEAL_TIMEOUT)),
    ]);
    return loraReady;
  }

  // Reveal the text-window only once Lora is ready (or the timeout fires), so the
  // fallback→Lora swap is never on screen. After the first reveal the promise is
  // already settled, so later pastes unhide on the next microtask — no visible
  // wait, and no re-hide flicker (we only ever set hidden = false).
  function revealTextWindow() {
    const seq = ++textWindowRevealSeq;
    warmLoraFonts().then(() => {
      if (seq !== textWindowRevealSeq) return;   // a newer paste took over
      if (videoShown()) return;   // video mode owns the slot (loadPastedText leaves it first)
      textEl.hidden = false;
      textEl.scrollTop = 0;
    });
  }

  // Accepts either { html, plain } from the clipboard or a bare plain string.
  // The rich path is tried first and falls back to plain if the HTML carried no
  // usable text — so a paste from a plain source behaves exactly as before.
  function loadPastedText(raw) {
    let html = "", plain = "";
    if (raw && typeof raw === "object") { html = raw.html || ""; plain = raw.plain || ""; }
    else { plain = String(raw); }

    let built = false;
    if (html && html.trim()) {
      if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
      buildTextModelFromHtml(html);
      built = textTokens.length > 0;
    }
    if (built) {
      // Keep a plain copy for textContextWindow's no-selection fallback.
      const flat = (plain && plain.trim()) ? plain : textSentences.join(" ");
      pastedText = flat.length > MAX_PASTE ? flat.slice(0, MAX_PASTE) : flat;
    } else {
      const text = String(plain).replace(/\r\n?/g, "\n");
      pastedText = text.length > MAX_PASTE ? text.slice(0, MAX_PASTE) : text;
      buildTextModel(pastedText);
    }
    if (!textTokens.length) return;        // nothing usable in the paste
    // A text load means "show me this", so leave video mode first — before
    // textActive flips, so the reading view is revealed by revealTextWindow's
    // font-gated path below and not unhidden bare by applyVideoMode.
    exitVideoMode();
    renderTextView();
    textActive = true;
    revealTextWindow();   // unhide only once Lora is ready — no font-swap flash
  }

  function initTextMode() {
    // Paste anywhere on the page loads the text — unless an editable field is
    // focused (none today, but stay polite if one is ever added).
    document.addEventListener("paste", (e) => {
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      const html = cd.getData("text/html") || "";
      const plain = cd.getData("text/plain") || cd.getData("text") || "";
      if (!html.trim() && !plain.trim()) return;
      e.preventDefault();
      loadPastedText({ html, plain });
    });

    // Click-a-word / drag-a-phrase — the same gesture as the caption, on the
    // text's own token array. Plain click marks one word; a drag marks the range.
    // On release: collect items, capture the context window, clear marks, explain.
    // Begin a pick at `span`: clear prior highlight, snapshot, seed textDrag.
    // Shared by mousedown and the touch hold.
    const beginTextPick = (span) => {
      // Drop the previous lookup's highlight so this gesture starts from a clean
      // slate: the snapshot below must read all-false, and only the word(s) picked
      // in THIS gesture should stay lit — one active highlight at a time, matching
      // the single explanation panel (MAX_PANELS).
      clearTextMarks();
      const i = Number(span.dataset.i);
      textDrag = { startIdx: i, currentIdx: i, moved: false, snapshot: textTokens.map((t) => !!t.marked) };
    };
    const extendTextPick = (span) => {
      if (!textDrag) return;
      const i = Number(span.dataset.i);
      if (i === textDrag.currentIdx) return;
      textDrag.currentIdx = i;
      if (i !== textDrag.startIdx) textDrag.moved = true;
      applyTextDragRange();
    };
    function finishTextGesture() {
      if (!textDrag) return;
      const ds = textDrag; textDrag = null;
      if (ds.moved) applyTextDragRange(ds);
      else setTextMarked(ds.startIdx, true);   // a plain click selects the word
      const items = collectMarkedItems(textTokens);
      const ctx = textContextWindow();          // context window for the model
      // Leave the selection highlighted in the original text so the reader can see
      // which word the explanation is about — it clears on the next mousedown.
      if (items.length) startNewExplainText(items, ctx);
    }
    textEl.addEventListener("mousedown", (e) => {
      if (mouseSuppressed()) return;   // ignore the synthetic click trailing a touch gesture
      const span = e.target.closest && e.target.closest(".word");
      if (!span || e.button !== 0) return;
      e.preventDefault();
      beginTextPick(span);
    });
    textEl.addEventListener("mousemove", (e) => {
      if (!textDrag) return;
      if (e.buttons === 0) { textDrag = null; return; }
      const span = e.target.closest && e.target.closest(".word");
      if (!span) return;
      extendTextPick(span);
    });
    window.addEventListener("mouseup", finishTextGesture);
    // Touch: hold a word in the pasted text, then drag across it to select a phrase.
    enableTouchWordSelect(textEl, ".word", beginTextPick, extendTextPick, finishTextGesture);
  }

  /* ---------- video mode (YouTube sources · desktop only) ----------

     A YouTube link is imported as AUDIO — a server-made CBR MP3 that the
     transcript's word timings are aligned to. Video mode adds the PICTURE on top
     without touching any of that: the server prepares an audio-free MP4
     (/api/sources/yt-video) and a MUTED <video> plays it slaved to #ln-audio. The
     audio element stays the single clock, so no amount of picture buffering,
     stalling or keyframe-snapping can drag the caption out of sync — the worst a
     bad video stream can do is look choppy. The stage takes the reading view's
     slot in the band, so "on" shows the picture where the text was and "off"
     gives the text back.

     Nothing here is allowed to accumulate over a session — the whole point of
     keeping the video tab-local:
       · no blob, no object URL: the element streams a plain src URL, so the
         BROWSER owns the buffer and Range-fetches only what's actually watched.
         (The audio path deliberately does the opposite — it needs the bytes in
         hand to upload them for transcription. A video has no such second use.)
       · ONE <video> element, in the markup, reused forever, with its listeners
         attached exactly once here — so toggling a hundred times adds none.
       · turning video mode off (or loading any other source, or crossing to a
         phone-width viewport, or leaving the page) runs releaseVideo(): pause,
         drop the src ATTRIBUTE, load() — the spec's recipe for making the element
         let go of the decoder, the network stream and every buffered range.
       · drift correction rides the caption's existing 150 ms ticker, so the
         feature owns no timer of its own; the one-shot "still preparing" hints are
         cleared on every state change.
       · the server answers with Cache-Control: no-store, so once the element lets
         go, the browser is holding no copy of the file either.

     Desktop only: the band is a fixed-height flex column there, and a phone has no
     room for a picture above the panel and the player. The toggle is CSS-hidden
     below 761px and crossing that breakpoint releases the video. */

  const videoWrap = document.getElementById("ln-video");
  const videoEl = document.getElementById("ln-video-el");
  const videoStatusEl = document.getElementById("ln-video-status");
  const videoBtn = document.getElementById("ln-video-btn");

  // Drift bands against the audio clock, in seconds. Below RATE the picture is
  // left alone; between RATE and SEEK we trim playbackRate and let it coast back
  // into line; above SEEK — an arrow-key jump, a track click, an A-B loop
  // wrapping — only a seek can land it.
  const VIDEO_DRIFT_RATE = 0.12;
  const VIDEO_DRIFT_SEEK = 0.5;
  const VIDEO_RATE_TRIM = 0.06;   // ±6% on a MUTED picture is invisible; a seek stutters
  const VIDEO_SEEK_EPS = 0.08;    // even a forced resync skips a jump smaller than this

  let ytSourceId = null;    // opaque id of the loaded YouTube source (null = not YouTube)
  let videoMode = false;    // the toggle. In memory ONLY — never persisted, so every
                            // tab (and every reload) starts on audio, by design.
  let videoState = "idle";  // idle | loading | ready | error
  let videoToken = 0;       // bumped by every attach/release; a stale probe/hint bails
  let videoAbort = null;    // AbortController for the in-flight prepare probe
  let videoHints = [];      // reassurance timers during a long prepare

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

  function clearVideoHints() {
    for (const t of videoHints) clearTimeout(t);
    videoHints = [];
  }
  // A one-shot reassurance line, valid only while THIS attach is still current.
  function videoHint(ms, message) {
    const token = videoToken;
    videoHints.push(setTimeout(() => {
      if (token === videoToken && videoState === "loading") videoStatus(message, "loading");
    }, ms));
  }

  // Let go of everything the stage holds. Safe to call at any time, any number of
  // times — the reconcilers below lean on that.
  function releaseVideo() {
    clearVideoHints();
    if (videoAbort) { try { videoAbort.abort(); } catch {} videoAbort = null; }
    const hadSrc = videoEl.hasAttribute("src");
    videoState = "idle";
    videoToken++;             // any probe or hint still in flight is now stale
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

  // Reconcile stage + button with (mode, source, viewport). Idempotent, so it can
  // be called from a resize, a source change or the toggle without care.
  function applyVideoMode() {
    const offerable = !!ytSourceId && videoCapable();
    const on = offerable && videoMode;
    videoBtn.hidden = !offerable;
    videoBtn.setAttribute("aria-pressed", String(on));
    videoBtn.setAttribute("aria-label", on ? "Hide video" : "Show video");
    videoBtn.title = on ? "Hide video" : "Show video";
    // Video mode flag on <body> (see the body.video-on rules — the record button
    // gets a drop-shadow so its glyph stays legible over the picture).
    document.body.classList.toggle("video-on", on);
    if (!on) {
      releaseVideo();
      videoWrap.hidden = true;
      // Hand the slot back to the reading view — if there is any text in it. Set
      // directly rather than via revealTextWindow(), which resets the scroll
      // position (right for a fresh paste, wrong for coming back from the video).
      textEl.hidden = !textActive;
      return;
    }
    textEl.hidden = true;
    videoWrap.hidden = false;
    if (videoState === "idle") attachVideo();   // otherwise it's already loading/ready/failed
  }

  // A paste means "show me this" — so it leaves video mode and gives the reading
  // view its slot back.
  function exitVideoMode() {
    if (!videoMode) return;
    videoMode = false;
    applyVideoMode();
  }

  // Declare the loaded source's YouTube identity: the opaque id for a YouTube
  // import, null for a local file or a failed open. EVERY open path calls this,
  // so the stage and the toggle can never outlive the source they belong to. The
  // mode itself survives a switch between two YouTube videos (the reader is still
  // watching), and applyVideoMode then prepares the new one.
  function setYouTubeSource(id) {
    ytSourceId = id || null;
    releaseVideo();      // the previous picture's stream and decoder go now, not later
    applyVideoMode();
  }

  // Prepare the picture on the server, then attach it. The probe call is what
  // turns a server-side failure into a real sentence ("too large", "YouTube is
  // blocking…") — a <video> element could only ever report a generic decode
  // error. Only once it succeeds does the element get a src, so it streams a warm
  // cache file instead of holding a request open through the whole download.
  async function attachVideo() {
    if (!ytSourceId) return;
    const url = comartAPI() + "/api/sources/yt-video?id=" + encodeURIComponent(ytSourceId);
    const token = ++videoToken;
    if (videoAbort) { try { videoAbort.abort(); } catch {} }
    const ctl = (videoAbort = new AbortController());
    videoState = "loading";
    videoStatus("Preparing the video on the server…", "loading");
    // A cold video is a full yt-dlp download plus a remux, so say what's happening
    // rather than spinning silently. The audio keeps playing throughout — you can
    // listen and read while the picture is being fetched.
    videoHint(8000, "Downloading the video on the server…");
    videoHint(45000, "Still going — the first play of a long video takes a few minutes.");
    let data;
    try {
      const res = await fetch(url + "&probe=1", { signal: ctl.signal });
      if (token !== videoToken) return;
      data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || "Couldn't prepare the video.");
    } catch (e) {
      if (e && e.name === "AbortError") return;   // released or superseded — the newer action owns it
      if (token !== videoToken) return;
      clearVideoHints();
      videoState = "error";
      videoStatus(e.message || "Couldn't prepare the video.", "error");
      return;
    }
    if (token !== videoToken) return;
    clearVideoHints();
    videoAbort = null;
    videoEl.src = url;            // plain src: the browser Range-streams it and owns the buffer
    try { videoEl.load(); } catch {}
    videoStatus("", "loading");   // spinner only, until the first frame decodes
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
  videoBtn.addEventListener("click", () => { videoMode = !videoMode; applyVideoMode(); });
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
  setListen("idle");   // show the upload prompt; the caption stays empty
  startTicker();
  checkCredits();
  initTextMode();
  applyVideoMode();  // no source yet → stage down, toggle hidden (one source of truth)
  warmLoraFonts();   // start fetching Lora now so the first paste reveals flash-free
  ensureSrcMenu();   // pre-populate the source menu so it's ready on first open
})();
