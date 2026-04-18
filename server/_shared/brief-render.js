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

import { BRIEF_ENVELOPE_VERSION } from '../../shared/brief-envelope.js';

/**
 * @typedef {import('../../shared/brief-envelope.js').BriefEnvelope} BriefEnvelope
 * @typedef {import('../../shared/brief-envelope.js').BriefData} BriefData
 * @typedef {import('../../shared/brief-envelope.js').BriefStory} BriefStory
 * @typedef {import('../../shared/brief-envelope.js').BriefThread} BriefThread
 * @typedef {import('../../shared/brief-envelope.js').BriefThreatLevel} BriefThreatLevel
 */

// ── Constants ────────────────────────────────────────────────────────────────

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

const MAX_THREADS_PER_PAGE = 6;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** @type {Record<BriefThreatLevel, string>} */
const THREAT_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** @type {Set<BriefThreatLevel>} */
const HIGHLIGHTED_LEVELS = new Set(['critical', 'high']);

const VALID_THREAT_LEVELS = new Set(
  /** @type {BriefThreatLevel[]} */ (['critical', 'high', 'medium', 'low']),
);

// ── HTML escaping ────────────────────────────────────────────────────────────

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/;
const HTML_ESCAPE_RE_G = /[&<>"']/g;

/**
 * Text-context HTML escape. Do not use for raw attribute-value
 * interpolation without extending the map.
 * @param {string} str
 */
function escapeHtml(str) {
  const s = String(str);
  if (!HTML_ESCAPE_RE.test(s)) return s;
  return s.replace(HTML_ESCAPE_RE_G, (ch) => HTML_ESCAPE_MAP[ch]);
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

// ── Envelope validation ──────────────────────────────────────────────────────

/** @param {unknown} v */
function isObject(v) {
  return typeof v === 'object' && v !== null;
}

/** @param {unknown} v */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** @param {unknown} v */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Closed key sets for each object in the contract. The validator
// rejects extra keys at every level — a producer cannot smuggle
// importanceScore, primaryLink, pubDate, briefModel, fetchedAt or any
// other forbidden upstream field into a persisted envelope. The
// renderer already refuses to interpolate unknown fields (and that is
// covered by the sentinel-poisoning test), but unknown fields resident
// in Redis still pollute every future consumer (edge route, dashboard
// panel preview, carousel, email teaser). Locking the contract at
// write time is the only place this invariant can live.
const ALLOWED_ENVELOPE_KEYS = new Set(['version', 'issuedAt', 'data']);
const ALLOWED_DATA_KEYS = new Set(['user', 'issue', 'date', 'dateLong', 'digest', 'stories']);
const ALLOWED_USER_KEYS = new Set(['name', 'tz']);
const ALLOWED_DIGEST_KEYS = new Set(['greeting', 'lead', 'numbers', 'threads', 'signals']);
const ALLOWED_NUMBERS_KEYS = new Set(['clusters', 'multiSource', 'surfaced']);
const ALLOWED_THREAD_KEYS = new Set(['tag', 'teaser']);
const ALLOWED_STORY_KEYS = new Set([
  'category',
  'country',
  'threatLevel',
  'headline',
  'description',
  'source',
  'whyMatters',
]);

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} path
 */
function assertNoExtraKeys(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${path} has unexpected key ${JSON.stringify(key)}; allowed keys: ${[...allowed].join(', ')}`,
      );
    }
  }
}

/**
 * Throws a descriptive error on the first missing, mis-typed, or
 * unexpected field. Runs before any HTML interpolation so the renderer
 * can assume the typed shape after this returns. The renderer is a
 * shared module with multiple independent producers (Railway composer,
 * tests, future dev-only fixtures) — a strict runtime contract matters
 * more than the declaration-file types alone.
 *
 * Also enforces the cross-field invariant that
 * `digest.numbers.surfaced === stories.length`. The renderer uses both
 * values (surfaced prints on the "at a glance" page; stories.length
 * drives cover blurb and page count) — allowing them to disagree would
 * produce a self-contradictory brief.
 *
 * @param {unknown} envelope
 * @returns {asserts envelope is BriefEnvelope}
 */
export function assertBriefEnvelope(envelope) {
  if (!isObject(envelope)) {
    throw new Error('renderBriefMagazine: envelope must be an object');
  }
  const env = /** @type {Record<string, unknown>} */ (envelope);
  assertNoExtraKeys(env, ALLOWED_ENVELOPE_KEYS, 'envelope');

  if (env.version !== BRIEF_ENVELOPE_VERSION) {
    throw new Error(
      `renderBriefMagazine: envelope.version=${JSON.stringify(env.version)} does not match renderer version=${BRIEF_ENVELOPE_VERSION}. Deploy a matching renderer before producing envelopes at this version.`,
    );
  }
  if (!isFiniteNumber(env.issuedAt)) {
    throw new Error('renderBriefMagazine: envelope.issuedAt must be a finite number');
  }
  if (!isObject(env.data)) {
    throw new Error('renderBriefMagazine: envelope.data is required');
  }
  const data = /** @type {Record<string, unknown>} */ (env.data);
  assertNoExtraKeys(data, ALLOWED_DATA_KEYS, 'envelope.data');

  if (!isObject(data.user)) throw new Error('envelope.data.user is required');
  const user = /** @type {Record<string, unknown>} */ (data.user);
  assertNoExtraKeys(user, ALLOWED_USER_KEYS, 'envelope.data.user');
  if (!isNonEmptyString(user.name)) throw new Error('envelope.data.user.name must be a non-empty string');
  if (!isNonEmptyString(user.tz)) throw new Error('envelope.data.user.tz must be a non-empty string');

  if (!isNonEmptyString(data.issue)) throw new Error('envelope.data.issue must be a non-empty string');
  if (!isNonEmptyString(data.date)) throw new Error('envelope.data.date must be a non-empty string');
  if (!DATE_REGEX.test(/** @type {string} */ (data.date))) {
    throw new Error('envelope.data.date must match YYYY-MM-DD');
  }
  if (!isNonEmptyString(data.dateLong)) throw new Error('envelope.data.dateLong must be a non-empty string');

  if (!isObject(data.digest)) throw new Error('envelope.data.digest is required');
  const digest = /** @type {Record<string, unknown>} */ (data.digest);
  assertNoExtraKeys(digest, ALLOWED_DIGEST_KEYS, 'envelope.data.digest');
  if (!isNonEmptyString(digest.greeting)) throw new Error('envelope.data.digest.greeting must be a non-empty string');
  if (!isNonEmptyString(digest.lead)) throw new Error('envelope.data.digest.lead must be a non-empty string');

  if (!isObject(digest.numbers)) throw new Error('envelope.data.digest.numbers is required');
  const numbers = /** @type {Record<string, unknown>} */ (digest.numbers);
  assertNoExtraKeys(numbers, ALLOWED_NUMBERS_KEYS, 'envelope.data.digest.numbers');
  for (const key of /** @type {const} */ (['clusters', 'multiSource', 'surfaced'])) {
    if (!isFiniteNumber(numbers[key])) {
      throw new Error(`envelope.data.digest.numbers.${key} must be a finite number`);
    }
  }

  if (!Array.isArray(digest.threads)) {
    throw new Error('envelope.data.digest.threads must be an array');
  }
  digest.threads.forEach((t, i) => {
    if (!isObject(t)) throw new Error(`envelope.data.digest.threads[${i}] must be an object`);
    const th = /** @type {Record<string, unknown>} */ (t);
    assertNoExtraKeys(th, ALLOWED_THREAD_KEYS, `envelope.data.digest.threads[${i}]`);
    if (!isNonEmptyString(th.tag)) throw new Error(`envelope.data.digest.threads[${i}].tag must be a non-empty string`);
    if (!isNonEmptyString(th.teaser)) throw new Error(`envelope.data.digest.threads[${i}].teaser must be a non-empty string`);
  });

  if (!Array.isArray(digest.signals)) {
    throw new Error('envelope.data.digest.signals must be an array');
  }
  digest.signals.forEach((s, i) => {
    if (!isNonEmptyString(s)) throw new Error(`envelope.data.digest.signals[${i}] must be a non-empty string`);
  });

  if (!Array.isArray(data.stories) || data.stories.length === 0) {
    throw new Error('envelope.data.stories must be a non-empty array');
  }
  data.stories.forEach((s, i) => {
    if (!isObject(s)) throw new Error(`envelope.data.stories[${i}] must be an object`);
    const st = /** @type {Record<string, unknown>} */ (s);
    assertNoExtraKeys(st, ALLOWED_STORY_KEYS, `envelope.data.stories[${i}]`);
    for (const field of /** @type {const} */ (['category', 'country', 'headline', 'description', 'source', 'whyMatters'])) {
      if (!isNonEmptyString(st[field])) {
        throw new Error(`envelope.data.stories[${i}].${field} must be a non-empty string`);
      }
    }
    if (typeof st.threatLevel !== 'string' || !VALID_THREAT_LEVELS.has(/** @type {BriefThreatLevel} */ (st.threatLevel))) {
      throw new Error(
        `envelope.data.stories[${i}].threatLevel must be one of critical|high|medium|low (got ${JSON.stringify(st.threatLevel)})`,
      );
    }
  });

  // Cross-field invariant: surfaced count must match the actual number
  // of stories surfaced to this reader. Enforced here so cover copy
  // ("N threads") and the at-a-glance stat can never disagree.
  if (numbers.surfaced !== data.stories.length) {
    throw new Error(
      `envelope.data.digest.numbers.surfaced=${numbers.surfaced} must equal envelope.data.stories.length=${data.stories.length}`,
    );
  }
}

// ── Logo symbol + references ─────────────────────────────────────────────────

/**
 * The full logo SVG is emitted ONCE per document inside an invisible
 * <svg><defs><symbol id="wm-logo-core"> block. Every placement then
 * references the symbol via `<use>` at the desired size. Saves ~7 KB on
 * a 12-story brief vs. repeating the full SVG per placement.
 *
 * Stroke width is baked into the symbol (medium weight). Visual variance
 * across placements (cover 48px vs story 28px) reads identically at
 * display size; sub-pixel stroke differences are not perceptible.
 */
const LOGO_SYMBOL = (
  '<svg aria-hidden="true" style="display:none;position:absolute;width:0;height:0" focusable="false">' +
  '<defs>' +
  '<symbol id="wm-logo-core" viewBox="0 0 64 64">' +
  '<circle cx="32" cy="32" r="28"/>' +
  '<ellipse cx="32" cy="32" rx="5" ry="28"/>' +
  '<ellipse cx="32" cy="32" rx="14" ry="28"/>' +
  '<ellipse cx="32" cy="32" rx="22" ry="28"/>' +
  '<ellipse cx="32" cy="32" rx="28" ry="5"/>' +
  '<ellipse cx="32" cy="32" rx="28" ry="14"/>' +
  '<path class="wm-ekg" d="M 6 32 L 20 32 L 24 24 L 30 40 L 36 22 L 42 38 L 46 32 L 56 32"/>' +
  '<circle class="wm-ekg-dot" cx="57" cy="32" r="1.8"/>' +
  '</symbol>' +
  '</defs>' +
  '</svg>'
);

/**
 * @param {{ size: number; color?: string }} opts
 */
function logoRef({ size, color }) {
  // color is sourced ONLY from a closed enum of theme strings at the
  // call sites in this file. Never interpolate envelope-derived content
  // into a style= attribute via this helper.
  const styleAttr = color ? ` style="color: ${color};"` : '';
  return (
    `<svg class="wm-logo" width="${size}" height="${size}" viewBox="0 0 64 64" ` +
    `aria-label="WorldMonitor"${styleAttr}>` +
    '<use href="#wm-logo-core"/>' +
    '</svg>'
  );
}

// ── Running head (shared across digest pages) ────────────────────────────────

/** @param {string} dateShort @param {string} label */
function digestRunningHead(dateShort, label) {
  return (
    '<div class="running-head">' +
    '<span class="mono left">' +
    logoRef({ size: 22 }) +
    ` · WorldMonitor Brief · ${escapeHtml(dateShort)} ·` +
    '</span>' +
    `<span class="mono">${escapeHtml(label)}</span>` +
    '</div>'
  );
}

// ── Page renderers ───────────────────────────────────────────────────────────

/**
 * @param {{ dateLong: string; issue: string; storyCount: number; pageIndex: number; totalPages: number }} opts
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
    logoRef({ size: 48 }) +
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
 * @param {{ numbers: import('../../shared/brief-envelope.js').BriefNumbers; date: string; dateShort: string; pageIndex: number; totalPages: number }} opts
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
  const threatClass = HIGHLIGHTED_LEVELS.has(story.threatLevel) ? ' crit' : '';
  const threatLabel = THREAT_LABELS[story.threatLevel];
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
    logoRef({ size: 28 }) +
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
    logoRef({ size: 80, color: 'var(--bone)' }) +
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
    /* WorldMonitor brand palette — aligned with /pro landing + dashboard.
       Previous sienna rust (#8b3a1f) was the only off-brand color in the
       product; swapped to WM mint at two strengths so the accent harmonises
       on both light and dark pages. Paper unified to a single crisp white
       (#fafafa) rather than warm cream so the brief reads as a sibling of
       /pro rather than a separate editorial product. */
    --ink: #0a0a0a;
    --bone: #f2ede4;
    --cream: #fafafa;           /* was #f1e9d8 — unified with --paper */
    --cream-ink: #0a0a0a;       /* was #1a1612 — crisper contrast on white */
    /* --sienna is kept as the variable name for backwards compat (every
       .digest rule below references it) but the VALUE is now a dark
       mint sized for WCAG AA 4.5:1 on #fafafa. The earlier #3ab567 hit
       only ~2.3:1, which failed accessibility for the mono running
       heads + source lines even at their 13-18 px sizes. #1f7a3f lands
       at ~4.90:1 — passes AA for normal text, still reads as mint-
       family (green hue dominant), and sits close enough to the brand
       #4ade80 that a reader recognises the relationship. */
    --sienna: #1f7a3f;          /* dark mint for light-page accents — WCAG AA on #fafafa */
    --mint: #4ade80;            /* bright WM brand mint for dark-page accents (AAA on #0a0a0a) */
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
  .wm-logo { display: block; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .wm-logo .wm-ekg { stroke-width: 2.4; }
  .wm-logo .wm-ekg-dot { fill: currentColor; stroke: none; }
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
  /* Source line — the one editorial accent on story pages. Sits at
     two-strength mint to match the brand (Option B): muted on light,
     bright on dark. Opacity removed so mint reads as a deliberate
     accent, not a muted bone/ink. */
  .story .source {
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.9vw); letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  .story.light .source { color: var(--sienna); }
  .story.dark  .source { color: var(--mint); }
  /* Logo ekg dot: mint on every page so the brand "signal" pulse
     shows across the whole magazine. Light pages use the muted mint
     so it doesn't glare against #fafafa. */
  /* Bright mint on DARK backgrounds only (ink cover + dark stories).
     Digest pages are light (#fafafa) so they need the dark-mint
     variant — bright mint would read as a neon dot on white. */
  .cover .wm-logo .wm-ekg-dot,
  .story.dark .wm-logo .wm-ekg-dot { fill: var(--mint); }
  .digest .wm-logo .wm-ekg-dot,
  .story.light .wm-logo .wm-ekg-dot { fill: var(--sienna); }
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
  @media (max-width: 640px) {
    .page { padding: 5vh 6vw 8vh; }
    /* padding-right must clear the absolute .page-number block on the
       right. "09 / 12" in IBM Plex Mono at 11px is ~65-70px wide and
       .page-number sits at right:5vw; on a 360px Android ~19px + 70px
       = ~89px of occupied space. 22vw ≈ 79px at 360px AND ≈ 86px at
       393px — enough headroom with a one-vw safety margin. 18vw left
       ~0 clearance on iPhone SE (Greptile P2). */
    .digest .running-head {
      flex-direction: column; align-items: flex-start;
      gap: 1vh; padding-right: 22vw;
    }
    .page-number { top: 4vh; right: 5vw; opacity: 0.6; }
    .digest h2 { font-size: 10vw; max-width: 22ch; margin-bottom: 4vh; }
    .digest blockquote {
      font-size: max(17px, 4.6vw); line-height: 1.35;
      max-width: 40ch; padding-left: 4vw;
    }
    .digest .rule { width: 14vw; margin-top: 4vh; }
    .digest .stat-row { grid-template-columns: 1fr; gap: 1.5vh; }
    .digest .stat-num { font-size: 18vw; }
    /* Keep px floors at or above the base-rule floors (17px / 18px)
       so very narrow viewports (<375px) never render smaller than
       desktop. vw term still scales up on typical phones (4vw ≈ 15.7px
       at 393px so the max() picks the px floor). Greptile P2. */
    .digest .stat-label { font-size: max(17px, 4vw); }
    .digest .thread { font-size: max(17px, 4vw); line-height: 1.5; }
    .digest .signal { font-size: max(18px, 4vw); padding-left: 4vw; }
    .story { display: flex; flex-direction: column; gap: 4vh; }
    .story .left { padding-right: 0; }
    .story .rank-ghost { font-size: 62vw; left: -4vw; top: 30%; }
    .story h3 { font-size: 9.5vw; max-width: none; margin-bottom: 3vh; }
    .story .desc {
      font-size: max(16px, 4.4vw); max-width: none;
      margin-bottom: 3vh; line-height: 1.5;
    }
    .story .tag-row { gap: 2vw; margin-bottom: 3vh; }
    .story .tag { font-size: 11px; padding: 0.4em 0.8em; }
    .story .source { font-size: 11px; }
    .story .right { justify-content: flex-start; }
    .story .callout { padding: 3vh 4vw; border-left-width: 3px; }
    .story .callout .label { font-size: 11px; margin-bottom: 1.5vh; opacity: 0.7; }
    .story .callout .note { font-size: max(16px, 4.2vw); line-height: 1.5; }
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
  // digest-indexes attribute is a server-built JSON number array.
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
  assertBriefEnvelope(envelope);
  const { user, issue, date, dateLong, digest, stories } = envelope.data;
  const [, month, day] = date.split('-');
  const dateShort = `${day}.${month}`;

  const threads = digest.threads;
  const hasSignals = digest.signals.length > 0;
  const splitThreads = threads.length > MAX_THREADS_PER_PAGE;

  // Total page count is fully data-derived, computed up front, so every
  // page renderer knows its position without a two-pass build.
  const totalPages =
    1 // cover
    + 1 // digest 01 greeting
    + 1 // digest 02 numbers
    + (splitThreads ? 2 : 1) // digest 03 on the desk (split if needed)
    + (hasSignals ? 1 : 0) // digest 04 signals (conditional)
    + stories.length
    + 1; // back cover

  /** @type {string[]} */
  const pagesHtml = [];
  /** @type {number[]} */
  const digestIndexes = [];
  let p = 0;

  pagesHtml.push(
    renderCover({
      dateLong,
      issue,
      storyCount: stories.length,
      pageIndex: ++p,
      totalPages,
    }),
  );

  digestIndexes.push(p);
  pagesHtml.push(
    renderDigestGreeting({
      greeting: digest.greeting,
      lead: digest.lead,
      dateShort,
      pageIndex: ++p,
      totalPages,
    }),
  );

  digestIndexes.push(p);
  pagesHtml.push(
    renderDigestNumbers({
      numbers: digest.numbers,
      date,
      dateShort,
      pageIndex: ++p,
      totalPages,
    }),
  );

  const threadsPages = splitThreads
    ? [threads.slice(0, Math.ceil(threads.length / 2)), threads.slice(Math.ceil(threads.length / 2))]
    : [threads];
  threadsPages.forEach((slice, i) => {
    const label = threadsPages.length === 1
      ? 'Digest / 03 — On The Desk'
      : `Digest / 03${i === 0 ? 'a' : 'b'} — On The Desk`;
    const heading = i === 0 ? 'What the desk is watching.' : '\u2026 continued.';
    digestIndexes.push(p);
    pagesHtml.push(
      renderDigestThreadsPage({
        threads: slice,
        dateShort,
        label,
        heading,
        includeEndMarker: i === threadsPages.length - 1 && !hasSignals,
        pageIndex: ++p,
        totalPages,
      }),
    );
  });

  if (hasSignals) {
    digestIndexes.push(p);
    pagesHtml.push(
      renderDigestSignals({
        signals: digest.signals,
        dateShort,
        pageIndex: ++p,
        totalPages,
      }),
    );
  }

  stories.forEach((story, i) => {
    pagesHtml.push(
      renderStoryPage({
        story,
        rank: i + 1,
        palette: i % 2 === 0 ? 'light' : 'dark',
        pageIndex: ++p,
        totalPages,
      }),
    );
  });

  pagesHtml.push(
    renderBackCover({
      tz: user.tz,
      pageIndex: ++p,
      totalPages,
    }),
  );

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
    LOGO_SYMBOL +
    `<div class="deck" id="deck" data-digest-indexes='${JSON.stringify(digestIndexes)}'>` +
    pagesHtml.join('') +
    '</div>' +
    '<div class="nav-dots" id="navDots"></div>' +
    '<div class="hint">← → / swipe / scroll</div>' +
    NAV_SCRIPT +
    '</body>' +
    '</html>'
  );
}
