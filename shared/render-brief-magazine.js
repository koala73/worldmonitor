// Deterministic renderer for the WorldMonitor Brief magazine.
//
// Pure function: (BriefEnvelope) -> HTML string. No I/O, no LLM calls,
// no network, no time-dependent output. The composer writes the
// envelope once; any consumer (edge route, dashboard panel preview,
// Tauri window) re-renders the same HTML at read time.
//
// The page sequence is derived from the data, not hardcoded:
//   1. Dark cover
//   2. Digest · 01 Greeting             (always)
//   3. Digest · 02 At A Glance          (always)
//   4. Digest · 03 On The Desk          (one page if threads.length <= 6;
//                                        else split into 03a + 03b)
//   5. Digest · 04 Signals              (omitted when signals.length === 0)
//   6. Stories                          (one page per story, alternating
//                                        light/dark by index parity)
//   7. Dark back cover
//
// Source references:
//   - Visual prototype: .claude/worktrees/zany-chasing-boole/digest-magazine.html
//   - Brainstorm: docs/brainstorms/2026-04-17-worldmonitor-brief-magazine-requirements.md
//   - Plan: docs/plans/2026-04-17-003-feat-worldmonitor-brief-magazine-plan.md

/**
 * @typedef {import('./brief-envelope.js').BriefEnvelope} BriefEnvelope
 * @typedef {import('./brief-envelope.js').BriefStory} BriefStory
 * @typedef {import('./brief-envelope.js').BriefThread} BriefThread
 */

// ── Chrome constants ─────────────────────────────────────────────────────────

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

const MAX_THREADS_PER_PAGE = 6;

// ── HTML escaping ────────────────────────────────────────────────────────────

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** @param {string} str */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

// ── Logo (inline SVG, coloured via currentColor) ─────────────────────────────

/**
 * @param {{ size: number; stroke: number; color?: string }} opts
 */
function logoSvg({ size, stroke, color }) {
  const ekgStroke = (stroke + 0.6).toFixed(2);
  const styleAttr = color ? ` style="color: ${color};"` : '';
  return (
    `<svg class="wm-logo" width="${size}" height="${size}" viewBox="0 0 64 64" ` +
    `fill="none" stroke="currentColor" stroke-width="${stroke}" ` +
    `stroke-linecap="round" aria-label="WorldMonitor"${styleAttr}>` +
    '<circle cx="32" cy="32" r="28"/>' +
    '<ellipse cx="32" cy="32" rx="5" ry="28"/>' +
    '<ellipse cx="32" cy="32" rx="14" ry="28"/>' +
    '<ellipse cx="32" cy="32" rx="22" ry="28"/>' +
    '<ellipse cx="32" cy="32" rx="28" ry="5"/>' +
    '<ellipse cx="32" cy="32" rx="28" ry="14"/>' +
    `<path d="M 6 32 L 20 32 L 24 24 L 30 40 L 36 22 L 42 38 L 46 32 L 56 32" stroke-width="${ekgStroke}"/>` +
    '<circle cx="57" cy="32" r="1.8" fill="currentColor" stroke="none"/>' +
    '</svg>'
  );
}

// ── Running head (shared across digest pages) ────────────────────────────────

/** @param {string} dateShort @param {string} label */
function digestRunningHead(dateShort, label) {
  return (
    '<div class="running-head">' +
    '<span class="mono left">' +
    logoSvg({ size: 22, stroke: 1.8 }) +
    ` · WorldMonitor Brief · ${escapeHtml(dateShort)} ·` +
    '</span>' +
    `<span class="mono">${escapeHtml(label)}</span>` +
    '</div>'
  );
}

// ── Page renderers ───────────────────────────────────────────────────────────

/**
 * @param {{ dateLong: string; dateShort: string; issue: string; storyCount: number; pageIndex: number; totalPages: number }} opts
 */
function renderCover({ dateLong, issue, storyCount, pageIndex, totalPages }) {
  const blurb =
    storyCount === 1
      ? 'One thread that shaped the world today.'
      : `${storyCount} threads that shaped the world today.`;
  return (
    '<section class="page cover">' +
    '<div class="meta-top">' +
    '<span class="brand">' +
    logoSvg({ size: 48, stroke: 2 }) +
    '<span class="mono">WorldMonitor</span>' +
    '</span>' +
    `<span class="mono">Issue № ${escapeHtml(issue)}</span>` +
    '</div>' +
    '<div class="hero">' +
    `<div class="kicker">${escapeHtml(dateLong)}</div>` +
    '<h1>WorldMonitor<br/>Brief.</h1>' +
    `<p class="blurb">${escapeHtml(blurb)}</p>` +
    '</div>' +
    '<div class="meta-bottom">' +
    '<span class="mono">Good evening</span>' +
    '<span class="mono">Swipe / ↔ to begin</span>' +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

/**
 * @param {{ greeting: string; lead: string; dateShort: string; pageIndex: number; totalPages: number }} opts
 */
function renderDigestGreeting({ greeting, lead, dateShort, pageIndex, totalPages }) {
  return (
    '<section class="page digest">' +
    digestRunningHead(dateShort, 'Digest / 01') +
    '<div class="body">' +
    '<div class="label mono">At The Top Of The Hour</div>' +
    `<h2>${escapeHtml(greeting)}</h2>` +
    `<blockquote>${escapeHtml(lead)}</blockquote>` +
    '<hr class="rule" />' +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

/**
 * @param {{ numbers: import('./brief-envelope.js').BriefNumbers; date: string; dateShort: string; pageIndex: number; totalPages: number }} opts
 */
function renderDigestNumbers({ numbers, date, dateShort, pageIndex, totalPages }) {
  const rows = [
    { n: numbers.clusters, label: 'story clusters ingested in the last 24 hours' },
    { n: numbers.multiSource, label: 'multi-source confirmed events' },
    { n: numbers.surfaced, label: 'threads surfaced in this brief' },
  ]
    .map(
      (row) =>
        '<div class="stat-row">' +
        `<div class="stat-num">${pad2(row.n)}</div>` +
        `<div class="stat-label">${escapeHtml(row.label)}</div>` +
        '</div>',
    )
    .join('');
  return (
    '<section class="page digest">' +
    digestRunningHead(dateShort, 'Digest / 02 — At A Glance') +
    '<div class="body">' +
    '<div class="label mono">The Numbers Today</div>' +
    `<div class="stats">${rows}</div>` +
    `<div class="footer-caption mono">Signal Window · ${escapeHtml(date)}</div>` +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

/**
 * @param {{ threads: BriefThread[]; dateShort: string; label: string; heading: string; includeEndMarker: boolean; pageIndex: number; totalPages: number }} opts
 */
function renderDigestThreadsPage({
  threads,
  dateShort,
  label,
  heading,
  includeEndMarker,
  pageIndex,
  totalPages,
}) {
  const rows = threads
    .map(
      (t) =>
        '<p class="thread">' +
        `<span class="tag">${escapeHtml(t.tag)} —</span>` +
        `${escapeHtml(t.teaser)}` +
        '</p>',
    )
    .join('');
  const endMarker = includeEndMarker
    ? '<div class="end-marker"><hr /><span class="mono">Stories follow →</span></div>'
    : '';
  return (
    '<section class="page digest">' +
    digestRunningHead(dateShort, label) +
    '<div class="body">' +
    '<div class="label mono">Today\u2019s Threads</div>' +
    `<h2>${escapeHtml(heading)}</h2>` +
    `<div class="threads">${rows}</div>` +
    endMarker +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

/**
 * @param {{ signals: string[]; dateShort: string; pageIndex: number; totalPages: number }} opts
 */
function renderDigestSignals({ signals, dateShort, pageIndex, totalPages }) {
  const paragraphs = signals
    .map((s) => `<p class="signal">${escapeHtml(s)}</p>`)
    .join('');
  return (
    '<section class="page digest">' +
    digestRunningHead(dateShort, 'Digest / 04 — Signals') +
    '<div class="body">' +
    '<div class="label mono">Signals To Watch</div>' +
    '<h2>What would change the story.</h2>' +
    `<div class="signals">${paragraphs}</div>` +
    '<div class="end-marker"><hr /><span class="mono">End of digest · Stories follow →</span></div>' +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

/**
 * @param {{ story: BriefStory; rank: number; palette: 'light' | 'dark'; pageIndex: number; totalPages: number }} opts
 */
function renderStoryPage({ story, rank, palette, pageIndex, totalPages }) {
  const threatClass = story.threatLevel === 'critical' || story.threatLevel === 'high' ? ' crit' : '';
  const threatLabel =
    story.threatLevel.charAt(0).toUpperCase() + story.threatLevel.slice(1);
  return (
    `<section class="page story ${palette}">` +
    '<div class="left">' +
    `<div class="rank-ghost">${pad2(rank)}</div>` +
    '<div class="left-content">' +
    '<div class="tag-row">' +
    `<span class="tag">${escapeHtml(story.category)}</span>` +
    `<span class="tag">${escapeHtml(story.country)}</span>` +
    `<span class="tag${threatClass}">${escapeHtml(threatLabel)}</span>` +
    '</div>' +
    `<h3>${escapeHtml(story.headline)}</h3>` +
    `<p class="desc">${escapeHtml(story.description)}</p>` +
    `<div class="source">Source · ${escapeHtml(story.source)}</div>` +
    '</div>' +
    '</div>' +
    '<div class="right">' +
    '<div class="callout">' +
    '<div class="label">Why this is important</div>' +
    `<p class="note">${escapeHtml(story.whyMatters)}</p>` +
    '</div>' +
    '</div>' +
    '<div class="logo-chrome">' +
    logoSvg({ size: 28, stroke: 1.8 }) +
    '<span class="mono">WorldMonitor Brief</span>' +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

/** @param {{ tz: string; pageIndex: number; totalPages: number }} opts */
function renderBackCover({ tz, pageIndex, totalPages }) {
  return (
    '<section class="page cover back">' +
    '<div class="hero">' +
    '<div class="centered-logo">' +
    logoSvg({ size: 80, stroke: 2.4, color: 'var(--bone)' }) +
    '</div>' +
    '<div class="kicker">Thank you for reading</div>' +
    '<h1>End of<br/>Transmission.</h1>' +
    '</div>' +
    '<div class="meta-bottom">' +
    '<span class="mono">worldmonitor.app</span>' +
    `<span class="mono">Next brief · 08:00 ${escapeHtml(tz)}</span>` +
    '</div>' +
    `<div class="page-number mono">${pad2(pageIndex)} / ${pad2(totalPages)}</div>` +
    '</section>'
  );
}

// ── Shell (document + CSS + JS) ──────────────────────────────────────────────

const STYLE_BLOCK = `<style>
  :root {
    --ink: #0a0a0a;
    --bone: #f2ede4;
    --cream: #f1e9d8;
    --cream-ink: #1a1612;
    --sienna: #8b3a1f;
    --paper: #fafafa;
    --paper-ink: #0a0a0a;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100vw; height: 100vh; overflow: hidden;
    background: #000;
    font-family: 'Source Serif 4', Georgia, serif;
    -webkit-font-smoothing: antialiased;
  }
  .deck {
    width: 100vw; height: 100vh; display: flex;
    transition: transform 620ms cubic-bezier(0.77, 0, 0.175, 1);
    will-change: transform;
  }
  .page {
    flex: 0 0 100vw; width: 100vw; height: 100vh;
    padding: 6vh 6vw 10vh;
    position: relative; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .mono {
    font-family: 'IBM Plex Mono', monospace;
    font-weight: 500; letter-spacing: 0.18em;
    text-transform: uppercase; font-size: max(11px, 0.85vw);
  }
  .wm-logo { display: block; }
  .logo-chrome {
    position: absolute; bottom: 5vh; left: 6vw;
    display: flex; align-items: center; gap: 0.8vw; opacity: 0.7;
  }
  .cover { background: var(--ink); color: var(--bone); }
  .cover .meta-top, .cover .meta-bottom {
    display: flex; justify-content: space-between; align-items: center; opacity: 0.75;
  }
  .cover .meta-top .brand { display: flex; align-items: center; gap: 1vw; }
  .cover .hero {
    flex: 1; display: flex; flex-direction: column; justify-content: center;
  }
  .cover .hero h1 {
    font-family: 'Playfair Display', serif; font-weight: 900;
    font-size: 10vw; line-height: 0.92; letter-spacing: -0.03em;
    margin-bottom: 6vh;
  }
  .cover .hero .kicker {
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(13px, 1.1vw); letter-spacing: 0.3em;
    text-transform: uppercase; opacity: 0.75; margin-bottom: 4vh;
  }
  .cover .hero .blurb {
    font-family: 'Source Serif 4', serif; font-style: italic;
    font-size: max(18px, 1.7vw); max-width: 48ch; opacity: 0.82; line-height: 1.4;
  }
  .cover.back { align-items: center; justify-content: center; text-align: center; }
  .cover.back .hero { align-items: center; flex: 0; }
  .cover.back .centered-logo { margin-bottom: 5vh; opacity: 0.9; }
  .cover.back .hero h1 { font-size: 8vw; }
  .cover.back .meta-bottom {
    width: 100%; position: absolute; bottom: 6vh; left: 0; padding: 0 6vw;
  }
  .digest { background: var(--cream); color: var(--cream-ink); }
  .digest .running-head {
    display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 2vh; border-bottom: 1px solid rgba(26, 22, 18, 0.18);
  }
  .digest .running-head .left {
    display: flex; align-items: center; gap: 0.8vw;
    color: var(--sienna); font-weight: 600;
  }
  .digest .body {
    flex: 1; display: flex; flex-direction: column;
    justify-content: center; padding-top: 4vh;
  }
  .digest .label { color: var(--sienna); margin-bottom: 5vh; }
  .digest h2 {
    font-family: 'Playfair Display', serif; font-weight: 900;
    font-size: 7vw; line-height: 0.98; letter-spacing: -0.02em;
    margin-bottom: 6vh; max-width: 18ch;
  }
  .digest blockquote {
    font-family: 'Source Serif 4', serif; font-style: italic;
    font-size: 2vw; line-height: 1.38; max-width: 32ch;
    margin-bottom: 5vh; padding-left: 2vw;
    border-left: 3px solid var(--sienna);
  }
  .digest .rule {
    border: none; height: 2px; background: var(--sienna);
    width: 8vw; margin-top: 5vh;
  }
  .digest .stats { display: flex; flex-direction: column; gap: 3vh; }
  .digest .stat-row {
    display: grid; grid-template-columns: 22vw 1fr;
    align-items: baseline; gap: 3vw;
    padding-bottom: 3vh; border-bottom: 1px solid rgba(26, 22, 18, 0.14);
  }
  .digest .stat-row:last-child { border-bottom: none; }
  .digest .stat-num {
    font-family: 'Playfair Display', serif; font-weight: 900;
    font-size: 11vw; line-height: 0.9; color: var(--cream-ink);
  }
  .digest .stat-label {
    font-family: 'Source Serif 4', serif; font-style: italic;
    font-size: max(18px, 1.7vw); line-height: 1.3;
    color: var(--cream-ink); opacity: 0.85;
  }
  .digest .footer-caption { margin-top: 4vh; color: var(--sienna); opacity: 0.85; }
  .digest .threads { display: flex; flex-direction: column; gap: 3.2vh; max-width: 62ch; }
  .digest .thread {
    font-family: 'Source Serif 4', serif;
    font-size: max(17px, 1.55vw); line-height: 1.45;
    color: var(--cream-ink);
  }
  .digest .thread .tag {
    font-family: 'IBM Plex Mono', monospace; font-weight: 600;
    letter-spacing: 0.2em; color: var(--sienna); margin-right: 0.6em;
  }
  .digest .signals { display: flex; flex-direction: column; gap: 3.5vh; max-width: 60ch; }
  .digest .signal {
    font-family: 'Source Serif 4', serif;
    font-size: max(18px, 1.65vw); line-height: 1.45;
    color: var(--cream-ink); padding-left: 2vw;
    border-left: 2px solid var(--sienna);
  }
  .digest .end-marker {
    margin-top: 5vh; display: flex; align-items: center; gap: 1.5vw;
  }
  .digest .end-marker hr {
    flex: 0 0 10vw; border: none; height: 2px; background: var(--sienna);
  }
  .digest .end-marker .mono { color: var(--sienna); }
  .story { display: grid; grid-template-columns: 55fr 45fr; gap: 4vw; }
  .story.light { background: var(--paper); color: var(--paper-ink); }
  .story.dark { background: var(--ink); color: var(--bone); }
  .story .left {
    display: flex; flex-direction: column; justify-content: center;
    position: relative; padding-right: 2vw;
  }
  .story .rank-ghost {
    font-family: 'Playfair Display', serif; font-weight: 900;
    font-size: 38vw; line-height: 0.8;
    position: absolute; top: 50%; left: -1vw;
    transform: translateY(-50%); opacity: 0.07;
    pointer-events: none; letter-spacing: -0.04em;
  }
  .story.dark .rank-ghost { opacity: 0.1; }
  .story .left-content { position: relative; z-index: 2; }
  .story .tag-row {
    display: flex; gap: 1.2vw; margin-bottom: 4vh; flex-wrap: wrap;
  }
  .story .tag {
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.85vw); font-weight: 600;
    letter-spacing: 0.22em; text-transform: uppercase;
    padding: 0.5em 1em; border: 1px solid currentColor; opacity: 0.82;
  }
  .story .tag.crit { background: currentColor; color: var(--paper); }
  .story.dark .tag.crit { background: var(--bone); color: var(--ink); border-color: var(--bone); }
  .story h3 {
    font-family: 'Playfair Display', serif; font-weight: 900;
    font-size: 5vw; line-height: 0.98; letter-spacing: -0.02em;
    margin-bottom: 5vh; max-width: 18ch;
  }
  .story .desc {
    font-family: 'Source Serif 4', serif;
    font-size: max(17px, 1.55vw); line-height: 1.45;
    max-width: 40ch; margin-bottom: 4vh; opacity: 0.88;
  }
  .story.dark .desc { opacity: 0.85; }
  .story .source {
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.9vw); letter-spacing: 0.2em;
    text-transform: uppercase; opacity: 0.6;
  }
  .story .right { display: flex; flex-direction: column; justify-content: center; }
  .story .callout {
    background: rgba(0, 0, 0, 0.05);
    border-left: 4px solid currentColor;
    padding: 5vh 3vw 5vh 3vw;
  }
  .story.dark .callout {
    background: rgba(242, 237, 228, 0.06);
    border-left-color: var(--bone);
  }
  .story .callout .label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.85vw); font-weight: 600;
    letter-spacing: 0.22em; text-transform: uppercase;
    margin-bottom: 3vh; opacity: 0.75;
  }
  .story .callout .note {
    font-family: 'Source Serif 4', serif;
    font-size: max(17px, 1.55vw); line-height: 1.5; opacity: 0.82;
  }
  .nav-dots {
    position: fixed; bottom: 3.5vh; left: 50%;
    transform: translateX(-50%);
    display: flex; gap: 0.9vw; z-index: 20;
    padding: 0.9vh 1.4vw;
    background: rgba(20, 20, 20, 0.55);
    backdrop-filter: blur(8px); border-radius: 999px;
  }
  .nav-dots button {
    width: 9px; height: 9px; border-radius: 50%; border: none;
    background: rgba(255, 255, 255, 0.3);
    cursor: pointer; padding: 0;
    transition: all 220ms ease;
  }
  .nav-dots button.digest-dot { background: rgba(139, 58, 31, 0.55); }
  .nav-dots button.active {
    background: rgba(255, 255, 255, 0.95);
    width: 26px; border-radius: 5px;
  }
  .nav-dots button.active.digest-dot { background: var(--sienna); }
  .hint {
    position: fixed; bottom: 3.5vh; right: 3vw;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.5);
    z-index: 20; mix-blend-mode: difference;
  }
  .page-number {
    position: absolute; top: 5vh; right: 4vw;
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.85vw);
    letter-spacing: 0.2em; opacity: 0.55;
  }
</style>`;

const NAV_SCRIPT = `<script>
(function() {
  var deck = document.getElementById('deck');
  if (!deck) return;
  var pages = deck.querySelectorAll('.page');
  var dotsContainer = document.getElementById('navDots');
  var total = pages.length;
  var current = 0;
  var wheelLock = false;
  var touchStartX = 0;
  var digestIndexes = new Set(JSON.parse(deck.dataset.digestIndexes || '[]'));
  for (var i = 0; i < total; i++) {
    var b = document.createElement('button');
    b.setAttribute('aria-label', 'Go to page ' + (i + 1));
    if (digestIndexes.has(i)) b.classList.add('digest-dot');
    (function(idx) { b.addEventListener('click', function() { go(idx); }); })(i);
    dotsContainer.appendChild(b);
  }
  var dots = dotsContainer.querySelectorAll('button');
  function render() {
    deck.style.transform = 'translateX(-' + (current * 100) + 'vw)';
    for (var i = 0; i < dots.length; i++) {
      if (i === current) dots[i].classList.add('active');
      else dots[i].classList.remove('active');
    }
  }
  function go(i) { current = Math.max(0, Math.min(total - 1, i)); render(); }
  function next() { go(current + 1); }
  function prev() { go(current - 1); }
  window.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(total - 1); }
  });
  window.addEventListener('wheel', function(e) {
    if (wheelLock) return;
    var delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 12) return;
    wheelLock = true;
    if (delta > 0) next(); else prev();
    setTimeout(function() { wheelLock = false; }, 620);
  }, { passive: true });
  window.addEventListener('touchstart', function(e) { touchStartX = e.touches[0].clientX; }, { passive: true });
  window.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < 50) return;
    if (dx < 0) next(); else prev();
  }, { passive: true });
  render();
})();
</script>`;

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * @param {BriefEnvelope} envelope
 * @returns {string}
 */
export function renderBriefMagazine(envelope) {
  if (!envelope?.data) {
    throw new Error('renderBriefMagazine: envelope.data is required');
  }
  const { user, issue, date, dateLong, digest, stories } = envelope.data;
  if (!Array.isArray(stories) || stories.length === 0) {
    throw new Error('renderBriefMagazine: envelope.data.stories must be a non-empty array');
  }
  const dateShort = date.split('-').reverse().slice(0, 2).join('.'); // "2026-04-17" -> "17.04"

  // Build page order first — we need totals up front for page-number chrome.
  const pageBuilders = [];
  const digestIndexes = [];

  pageBuilders.push(({ pageIndex, totalPages }) =>
    renderCover({
      dateLong,
      dateShort,
      issue,
      storyCount: stories.length,
      pageIndex,
      totalPages,
    }),
  );

  digestIndexes.push(pageBuilders.length);
  pageBuilders.push(({ pageIndex, totalPages }) =>
    renderDigestGreeting({
      greeting: digest.greeting,
      lead: digest.lead,
      dateShort,
      pageIndex,
      totalPages,
    }),
  );

  digestIndexes.push(pageBuilders.length);
  pageBuilders.push(({ pageIndex, totalPages }) =>
    renderDigestNumbers({
      numbers: digest.numbers,
      date,
      dateShort,
      pageIndex,
      totalPages,
    }),
  );

  const threads = digest.threads || [];
  if (threads.length <= MAX_THREADS_PER_PAGE) {
    digestIndexes.push(pageBuilders.length);
    pageBuilders.push(({ pageIndex, totalPages }) =>
      renderDigestThreadsPage({
        threads,
        dateShort,
        label: 'Digest / 03 — On The Desk',
        heading: 'What the desk is watching.',
        includeEndMarker: digest.signals.length === 0,
        pageIndex,
        totalPages,
      }),
    );
  } else {
    const mid = Math.ceil(threads.length / 2);
    digestIndexes.push(pageBuilders.length);
    pageBuilders.push(({ pageIndex, totalPages }) =>
      renderDigestThreadsPage({
        threads: threads.slice(0, mid),
        dateShort,
        label: 'Digest / 03a — On The Desk',
        heading: 'What the desk is watching.',
        includeEndMarker: false,
        pageIndex,
        totalPages,
      }),
    );
    digestIndexes.push(pageBuilders.length);
    pageBuilders.push(({ pageIndex, totalPages }) =>
      renderDigestThreadsPage({
        threads: threads.slice(mid),
        dateShort,
        label: 'Digest / 03b — On The Desk',
        heading: '\u2026 continued.',
        includeEndMarker: digest.signals.length === 0,
        pageIndex,
        totalPages,
      }),
    );
  }

  if (digest.signals.length > 0) {
    digestIndexes.push(pageBuilders.length);
    pageBuilders.push(({ pageIndex, totalPages }) =>
      renderDigestSignals({
        signals: digest.signals,
        dateShort,
        pageIndex,
        totalPages,
      }),
    );
  }

  stories.forEach((story, i) => {
    pageBuilders.push(({ pageIndex, totalPages }) =>
      renderStoryPage({
        story,
        rank: i + 1,
        palette: i % 2 === 0 ? 'light' : 'dark',
        pageIndex,
        totalPages,
      }),
    );
  });

  pageBuilders.push(({ pageIndex, totalPages }) =>
    renderBackCover({
      tz: user.tz,
      pageIndex,
      totalPages,
    }),
  );

  const totalPages = pageBuilders.length;
  const pagesHtml = pageBuilders
    .map((build, i) => build({ pageIndex: i + 1, totalPages }))
    .join('');

  const title = `WorldMonitor Brief · ${escapeHtml(dateLong)}`;

  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
    `<title>${title}</title>` +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    `<link href="${FONTS_HREF}" rel="stylesheet">` +
    STYLE_BLOCK +
    '</head>' +
    '<body>' +
    `<div class="deck" id="deck" data-digest-indexes='${JSON.stringify(digestIndexes)}'>` +
    pagesHtml +
    '</div>' +
    '<div class="nav-dots" id="navDots"></div>' +
    '<div class="hint">← → / swipe / scroll</div>' +
    NAV_SCRIPT +
    '</body>' +
    '</html>'
  );
}
