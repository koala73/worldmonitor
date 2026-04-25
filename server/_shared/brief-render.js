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

import { BRIEF_ENVELOPE_VERSION, SUPPORTED_ENVELOPE_VERSIONS } from '../../shared/brief-envelope.js';

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
// publicLead / publicSignals / publicThreads: optional v3+ fields.
// Hold non-personalised content the public-share renderer uses in
// place of the personalised lead/signals/threads. v2 envelopes (no
// publicLead) still pass — the validator's optional-key pattern is
// "in the allow list, but isString/array check is skipped when
// undefined" (see validateBriefDigest below).
const ALLOWED_DIGEST_KEYS = new Set([
  'greeting', 'lead', 'numbers', 'threads', 'signals',
  'publicLead', 'publicSignals', 'publicThreads',
]);
const ALLOWED_NUMBERS_KEYS = new Set(['clusters', 'multiSource', 'surfaced']);
const ALLOWED_THREAD_KEYS = new Set(['tag', 'teaser']);
const ALLOWED_STORY_KEYS = new Set([
  'category',
  'country',
  'threatLevel',
  'headline',
  'description',
  'source',
  'sourceUrl',
  'whyMatters',
]);

// Closed list of URL schemes we will interpolate into `href=`. A source
// record with an unknown scheme is a composer bug, not something to
// render — the story is dropped at envelope-validation time rather than
// shipping with an unlinked / broken source.
const ALLOWED_SOURCE_URL_SCHEMES = new Set(['https:', 'http:']);

/**
 * Parses and validates a story source URL. Returns the normalised URL
 * string on success; throws a descriptive error otherwise. The renderer
 * validator wraps this in a per-story path-prefixed error so composer
 * bugs are easy to locate.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function validateSourceUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`must be a parseable absolute URL (got ${JSON.stringify(raw)})`);
  }
  if (!ALLOWED_SOURCE_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`scheme ${JSON.stringify(parsed.protocol)} is not allowed (http/https only)`);
  }
  // Bar `javascript:`-style smuggling via credentials or a Unicode host
  // that renders like a legitimate outlet. These aren't exploitable
  // through the renderer (we only emit the URL in an href with
  // rel=noopener and we escape it), but they're always a composer bug
  // so flag at write time.
  if (parsed.username || parsed.password) {
    throw new Error('must not include userinfo credentials');
  }
  return parsed.toString();
}

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

  // Accept any version in SUPPORTED_ENVELOPE_VERSIONS. The composer
  // only ever writes the current BRIEF_ENVELOPE_VERSION; older
  // versions are tolerated on READ so links issued in the 7-day TTL
  // window survive a renderer rollout. Unknown versions are still
  // rejected — an unexpected shape would lead the renderer to
  // interpolate garbage.
  if (typeof env.version !== 'number' || !SUPPORTED_ENVELOPE_VERSIONS.has(env.version)) {
    throw new Error(
      `renderBriefMagazine: envelope.version=${JSON.stringify(env.version)} is not in supported set [${[...SUPPORTED_ENVELOPE_VERSIONS].join(', ')}]. Deploy a matching renderer before producing envelopes at this version.`,
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
  // publicLead: optional v3+ field. When present, MUST be a non-empty
  // string (typed contract enforcement); when absent, the renderer's
  // public-mode lead block omits the pull-quote entirely (per the
  // "never fall back to personalised lead" rule).
  if (digest.publicLead !== undefined && !isNonEmptyString(digest.publicLead)) {
    throw new Error('envelope.data.digest.publicLead, when present, must be a non-empty string');
  }
  // publicSignals + publicThreads: optional v3+. When present, MUST
  // match the signals/threads contracts (array of non-empty strings,
  // array of {tag, teaser}). Absent siblings are OK — public render
  // path falls back to "omit signals page" / "category-derived
  // threads stub" rather than serving the personalised version.
  if (digest.publicSignals !== undefined) {
    if (!Array.isArray(digest.publicSignals)) {
      throw new Error('envelope.data.digest.publicSignals, when present, must be an array');
    }
    digest.publicSignals.forEach((s, i) => {
      if (!isNonEmptyString(s)) throw new Error(`envelope.data.digest.publicSignals[${i}] must be a non-empty string`);
    });
  }
  if (digest.publicThreads !== undefined) {
    if (!Array.isArray(digest.publicThreads)) {
      throw new Error('envelope.data.digest.publicThreads, when present, must be an array');
    }
    digest.publicThreads.forEach((t, i) => {
      if (!isObject(t)) throw new Error(`envelope.data.digest.publicThreads[${i}] must be an object`);
      const th = /** @type {Record<string, unknown>} */ (t);
      assertNoExtraKeys(th, ALLOWED_THREAD_KEYS, `envelope.data.digest.publicThreads[${i}]`);
      if (!isNonEmptyString(th.tag)) throw new Error(`envelope.data.digest.publicThreads[${i}].tag must be a non-empty string`);
      if (!isNonEmptyString(th.teaser)) throw new Error(`envelope.data.digest.publicThreads[${i}].teaser must be a non-empty string`);
    });
  }

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
    // sourceUrl is required on v2 and absent on v1. When present on
    // either version, it must parse cleanly — a malformed URL would
    // break the href. On v1 it's expected to be absent; a v1 envelope
    // that somehow carries a sourceUrl is still validated (cheap
    // defence against composer regressions).
    if (env.version === BRIEF_ENVELOPE_VERSION || st.sourceUrl !== undefined) {
      try {
        validateSourceUrl(st.sourceUrl);
      } catch (err) {
        throw new Error(
          `envelope.data.stories[${i}].sourceUrl ${/** @type {Error} */ (err).message}`,
        );
      }
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
 * Strip the trailing period from envelope.data.digest.greeting
 * ("Good afternoon." → "Good afternoon") so the cover's mono-cased
 * salutation stays consistent with the historical no-period style.
 * Defensive: if the envelope ever produces an unexpected value, fall
 * back to a generic "Hello" rather than hardcoding a wrong time-of-day.
 */
function coverGreeting(greeting) {
  if (typeof greeting !== 'string' || greeting.length === 0) return 'Hello';
  return greeting.replace(/\.+$/, '').trim() || 'Hello';
}

/**
 * @param {{ dateLong: string; issue: string; storyCount: number; pageIndex: number; totalPages: number; greeting: string }} opts
 */
function renderCover({ dateLong, issue, storyCount, pageIndex, totalPages, greeting }) {
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
    `<span class="mono">${escapeHtml(coverGreeting(greeting))}</span>` +
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
  // Public-share fail-safe: when `lead` is empty, omit the pull-quote
  // entirely. Reached via redactForPublic when the envelope lacks a
  // non-empty `publicLead` — NEVER serve the personalised lead on the
  // public surface. Page still reads as a complete editorial layout
  // (greeting + horizontal rule), just without the italic blockquote.
  // Codex Round-2 High (security on share-URL surface).
  const blockquote = typeof lead === 'string' && lead.length > 0
    ? `<blockquote>${escapeHtml(lead)}</blockquote>`
    : '';
  return (
    '<section class="page digest">' +
    digestRunningHead(dateShort, 'Digest / 01') +
    '<div class="body">' +
    '<div class="label mono">At The Top Of The Hour</div>' +
    `<h2>${escapeHtml(greeting)}</h2>` +
    blockquote +
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
 * Build a tracked outgoing URL for the source line. Adds utm_source /
 * utm_medium / utm_campaign / utm_content only when absent — if the
 * upstream feed already embeds UTM (many publisher RSS do), we keep
 * their attribution intact and just append ours after.
 *
 * Returns the original `raw` on URL parse failure. This path is
 * unreachable in practice because assertBriefEnvelope already proved
 * the URL parses, but fail-safe is cheap.
 *
 * @param {string} raw           validated absolute https URL
 * @param {string} issueDate     envelope.data.date (YYYY-MM-DD)
 * @param {number} rank          1-indexed story rank
 */
function buildTrackedSourceUrl(raw, issueDate, rank) {
  try {
    const u = new URL(raw);
    if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'worldmonitor');
    if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'brief');
    if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', issueDate);
    if (!u.searchParams.has('utm_content')) u.searchParams.set('utm_content', `story-${pad2(rank)}`);
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * @param {{ story: BriefStory; rank: number; palette: 'light' | 'dark'; pageIndex: number; totalPages: number; issueDate: string }} opts
 */
function renderStoryPage({ story, rank, palette, pageIndex, totalPages, issueDate }) {
  const threatClass = HIGHLIGHTED_LEVELS.has(story.threatLevel) ? ' crit' : '';
  const threatLabel = THREAT_LABELS[story.threatLevel];
  // v1 envelopes don't carry sourceUrl — render the source as plain
  // text (matching pre-v2 appearance). v2 envelopes always have a
  // validated URL, so we wrap in a UTM-tracked anchor.
  const sourceBlock = story.sourceUrl
    ? `<a class="source-link" href="${escapeHtml(buildTrackedSourceUrl(story.sourceUrl, issueDate, rank))}" target="_blank" rel="noopener noreferrer">${escapeHtml(story.source)}</a>`
    : escapeHtml(story.source);
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
    `<div class="source">Source · ${sourceBlock}</div>` +
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

/**
 * @param {{
 *   tz: string;
 *   pageIndex: number;
 *   totalPages: number;
 *   publicMode: boolean;
 *   refCode: string;
 * }} opts
 */
function renderBackCover({ tz, pageIndex, totalPages, publicMode, refCode }) {
  const ctaHref = publicMode
    ? `https://worldmonitor.app/pro${refCode ? `?ref=${encodeURIComponent(refCode)}` : ''}`
    : 'https://worldmonitor.app';
  const kicker = publicMode
    ? 'You\u2019re reading a shared brief'
    : 'Thank you for reading';
  const headline = publicMode
    ? 'Get your own<br/>daily brief.'
    : 'End of<br/>Transmission.';
  const metaLeft = publicMode
    ? `<a href="${escapeHtml(ctaHref)}" class="mono back-cta" target="_blank" rel="noopener">Subscribe \u2192</a>`
    : '<span class="mono">worldmonitor.app</span>';
  const metaRight = publicMode
    ? '<span class="mono">worldmonitor.app</span>'
    : `<span class="mono">Next brief \u00b7 08:00 ${escapeHtml(tz)}</span>`;
  return (
    '<section class="page cover back">' +
    '<div class="hero">' +
    '<div class="centered-logo">' +
    logoRef({ size: 80, color: 'var(--bone)' }) +
    '</div>' +
    `<div class="kicker">${kicker}</div>` +
    `<h1>${headline}</h1>` +
    '</div>' +
    '<div class="meta-bottom">' +
    metaLeft +
    metaRight +
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
  /* Outgoing source anchor — inherit the palette colour from .source,
     underline for affordance. rel=noopener noreferrer and target=_blank
     are set in HTML; this is purely visual. */
  .story .source-link {
    color: inherit;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.18em;
    transition: text-decoration-thickness 160ms ease;
  }
  .story .source-link:hover { text-decoration-thickness: 2px; }
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

  /* ── Share button (non-public views) ─────────────────────────────
     Floating action pill in the top-right chrome. Separate from the
     page-number so it doesn't disappear during mobile stacking
     overrides. Hidden entirely in public views because a public
     reader shouldn't see a "Share" UI (the button relies on the
     authenticated /api/brief/share-url endpoint). */
  .wm-share {
    position: fixed;
    top: 3vh; right: 3vw;
    z-index: 30;
    display: inline-flex; align-items: center; gap: 0.5em;
    padding: 0.55em 1em;
    background: rgba(20, 20, 20, 0.65);
    color: var(--bone);
    border: 1px solid rgba(242, 237, 228, 0.25);
    border-radius: 999px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.8vw);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    cursor: pointer;
    backdrop-filter: blur(8px);
    transition: transform 160ms ease, background 160ms ease;
    mix-blend-mode: normal;
  }
  .wm-share:hover { background: rgba(20, 20, 20, 0.85); transform: translateY(-1px); }
  .wm-share[data-state="sharing"] { opacity: 0.6; cursor: progress; }
  .wm-share[data-state="copied"]::after { content: ' \u00b7 copied'; opacity: 0.75; }
  .wm-share[data-state="error"]::after { content: ' \u00b7 error'; opacity: 0.75; color: #ff9b9b; }

  /* ── Public view: Subscribe banner ─────────────────────────────── */
  .wm-public-strip {
    position: fixed;
    top: 0; left: 0; right: 0;
    z-index: 30;
    display: flex; align-items: center; justify-content: center;
    gap: 1em;
    padding: 0.8em 1.2em;
    background: var(--ink);
    color: var(--bone);
    border-bottom: 1px solid rgba(242, 237, 228, 0.2);
    font-family: 'IBM Plex Mono', monospace;
    font-size: max(11px, 0.75vw);
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .wm-public-strip a {
    color: var(--mint, #4ade80);
    text-decoration: none;
    border-bottom: 1px solid currentColor;
  }
  @media (max-width: 640px) {
    .wm-public-strip { font-size: 11px; padding: 0.7em 1em; gap: 0.6em; flex-wrap: wrap; }
  }
</style>`;

/**
 * Inline share-button client. The hosted magazine route has already
 * derived the share URL server-side (it has the userId, issueDate,
 * and BRIEF_SHARE_SECRET — the same inputs the share-url endpoint
 * uses) and embedded it as `data-share-url` on the button. At click
 * time we just invoke navigator.share with a clipboard fallback.
 *
 * No network, no auth — the per-user magazine route's HMAC token
 * check already proved this reader is authorised to share the brief
 * they are viewing. Deriving the URL at render time instead of click
 * time also means the button works in a fresh tab with no Clerk
 * session context (common path: reader opened the magazine from an
 * email link in a browser they're not signed into).
 *
 * Emitted only for non-public views AND only when data-share-url is
 * present on the button (i.e. BRIEF_SHARE_SECRET was configured).
 */
const SHARE_SCRIPT = `<script>
(function() {
  var btn = document.querySelector('.wm-share');
  if (!btn) return;
  var shareUrl = btn.dataset.shareUrl;
  if (!shareUrl) return;
  btn.addEventListener('click', async function() {
    if (btn.dataset.state === 'sharing') return;
    btn.dataset.state = 'sharing';
    try {
      var shareTitle = 'WorldMonitor Brief';
      var shareText = 'My WorldMonitor Brief for today:';
      if (navigator.share) {
        try {
          await navigator.share({ title: shareTitle, text: shareText, url: shareUrl });
          btn.dataset.state = 'copied';
          return;
        } catch (err) {
          if (err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))) {
            btn.dataset.state = '';
            return;
          }
          // Fall through to clipboard on non-abort share errors.
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        btn.dataset.state = 'copied';
      } else {
        // Ancient browser. Show the URL so the user can copy manually.
        window.prompt('Copy the link below:', shareUrl);
        btn.dataset.state = 'copied';
      }
    } catch (err) {
      btn.dataset.state = 'error';
      try { console.warn('[brief] share failed:', err); } catch (_) {}
    } finally {
      setTimeout(function() { if (btn.dataset.state !== 'sharing') btn.dataset.state = ''; }, 2400);
    }
  });
})();
</script>`;

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
 * Replace per-user / personal fields with generic placeholders so a
 * brief can be rendered on the unauth'd public share mirror without
 * leaking the recipient's name or the LLM-generated whyMatters (which
 * is framed as direct advice to that specific reader).
 *
 * Runs AFTER assertBriefEnvelope so the full contract is still
 * enforced on the input — we never loosen validation for the public
 * path, only redact the output.
 *
 * Lead-field handling (v3, 2026-04-25): the personalised `digest.lead`
 * can carry profile context (watched assets, region preferences) and
 * MUST NEVER be served on the public surface. v3 envelopes carry
 * `digest.publicLead` — a non-personalised parallel synthesis from
 * generateDigestProsePublic — which we substitute into the `lead`
 * slot so all downstream renderers stay agnostic to the public/
 * personalised distinction. When `publicLead` is absent (v2
 * envelopes still in the 7-day TTL window, or v3 envelopes where
 * the publicLead generation failed), we substitute an EMPTY string
 * — the renderer's pull-quote block reads "no pull-quote" for empty
 * leads (per renderDigestGreeting), so the page renders without
 * leaking personalised content. NEVER fall through to the original
 * `lead`. Codex Round-2 High (security).
 *
 * @param {BriefData} data
 * @returns {BriefData}
 */
function redactForPublic(data) {
  const safeLead = typeof data.digest?.publicLead === 'string' && data.digest.publicLead.length > 0
    ? data.digest.publicLead
    : '';
  // Public signals: substitute the publicSignals array (also produced
  // by generateDigestProsePublic with profile=null) when present.
  // When absent, EMPTY the signals array — the renderer's hasSignals
  // gate then omits the entire "04 · Signals" page rather than
  // serving the personalised forward-looking phrases (which can echo
  // the user's watched assets / regions).
  const safeSignals = Array.isArray(data.digest?.publicSignals) && data.digest.publicSignals.length > 0
    ? data.digest.publicSignals
    : [];
  // Public threads: substitute publicThreads when present (preferred
  // — the public synthesis still produces topic clusters from story
  // content). When absent, fall back to category-derived stubs so
  // the threads page still renders without leaking any personalised
  // phrasing the original `threads` array might carry.
  const safeThreads = Array.isArray(data.digest?.publicThreads) && data.digest.publicThreads.length > 0
    ? data.digest.publicThreads
    : derivePublicThreadsStub(data.stories);
  return {
    ...data,
    user: { ...data.user, name: 'WorldMonitor' },
    digest: {
      ...data.digest,
      lead: safeLead,
      signals: safeSignals,
      threads: safeThreads,
    },
    stories: data.stories.map((s) => ({
      ...s,
      whyMatters: 'Subscribe to WorldMonitor Brief to see the full editorial on this story.',
    })),
  };
}

/**
 * Category-derived threads fallback for the public surface when the
 * envelope lacks `publicThreads`. Mirrors deriveThreadsFromStories
 * in shared/brief-filter.js (the composer's stub path) — keeps the
 * fallback shape identical to what v2 envelopes already render with.
 *
 * @param {Array<{ category?: unknown }>} stories
 * @returns {Array<{ tag: string; teaser: string }>}
 */
function derivePublicThreadsStub(stories) {
  if (!Array.isArray(stories) || stories.length === 0) {
    return [{ tag: 'World', teaser: 'One thread on the desk today.' }];
  }
  const byCategory = new Map();
  for (const s of stories) {
    const tag = typeof s?.category === 'string' && s.category.length > 0 ? s.category : 'World';
    byCategory.set(tag, (byCategory.get(tag) ?? 0) + 1);
  }
  const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 6).map(([tag, count]) => ({
    tag,
    teaser: count === 1 ? 'One thread on the desk today.' : `${count} threads on the desk today.`,
  }));
}

/**
 * @param {BriefEnvelope} envelope
 * @param {{ publicMode?: boolean; refCode?: string; shareUrl?: string }} [options]
 * @returns {string}
 */
export function renderBriefMagazine(envelope, options = {}) {
  assertBriefEnvelope(envelope);
  const publicMode = options.publicMode === true;
  // refCode shape is validated at the route boundary; the renderer
  // still HTML-escapes it before interpolation so this is belt-and-
  // suspenders against any accidental leak through that boundary.
  const refCode = typeof options.refCode === 'string' ? options.refCode : '';
  // shareUrl is expected to be an absolute https URL produced by
  // buildPublicBriefUrl at the route level. We accept anything
  // non-empty here and still escape it into the attribute; if the
  // string is malformed the button's click handler simply fails open
  // (prompt fallback). Suppressed entirely on publicMode.
  const shareUrl = !publicMode && typeof options.shareUrl === 'string' && options.shareUrl.length > 0
    ? options.shareUrl
    : '';
  const rawData = publicMode ? redactForPublic(envelope.data) : envelope.data;
  const { user, issue, date, dateLong, digest, stories } = rawData;
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
      greeting: digest.greeting,
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
        issueDate: date,
      }),
    );
  });

  pagesHtml.push(
    renderBackCover({
      tz: user.tz,
      pageIndex: ++p,
      totalPages,
      publicMode,
      refCode,
    }),
  );

  const title = `WorldMonitor Brief · ${escapeHtml(dateLong)}`;

  // In public view: the per-hash mirror is noindexed via the HTTP
  // header AND a meta tag, and we prepend a subscribe strip pointing
  // at /pro (with optional referral attribution).
  const publicStripHref = `https://worldmonitor.app/pro${refCode ? `?ref=${encodeURIComponent(refCode)}` : ''}`;
  const publicStripHtml = publicMode
    ? '<div class="wm-public-strip">'
      + '<span>WorldMonitor Brief \u00b7 shared issue</span>'
      // Match renderBackCover's pattern: escapeHtml on the full href
      // even though encodeURIComponent already handles HTML-special
      // chars inside refCode — consistency for anyone auditing XSS
      // hygiene, and a safety net if the route boundary loosens.
      + `<a href="${escapeHtml(publicStripHref)}" target="_blank" rel="noopener">`
      + 'Subscribe \u2192</a>'
      + '</div>'
    : '';

  // Only render the Share button on authenticated (non-public) views
  // AND only when the route was able to derive a share URL (i.e.
  // BRIEF_SHARE_SECRET is configured and the pointer write
  // succeeded). The URL is embedded as data-share-url and read at
  // click time by SHARE_SCRIPT — no fetch, no auth required
  // client-side.
  const shareButtonHtml = shareUrl
    ? `<button class="wm-share" type="button" data-share-url="${escapeHtml(shareUrl)}" data-issue-date="${escapeHtml(date)}" aria-label="Share this brief">Share</button>`
    : '';

  const headMeta = publicMode
    ? '<meta name="robots" content="noindex,nofollow">'
    : '';

  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
    headMeta +
    `<title>${title}</title>` +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    `<link href="${FONTS_HREF}" rel="stylesheet">` +
    STYLE_BLOCK +
    '</head>' +
    '<body>' +
    LOGO_SYMBOL +
    publicStripHtml +
    shareButtonHtml +
    `<div class="deck" id="deck" data-digest-indexes='${JSON.stringify(digestIndexes)}'>` +
    pagesHtml.join('') +
    '</div>' +
    '<div class="nav-dots" id="navDots"></div>' +
    '<div class="hint">← → / swipe / scroll</div>' +
    (shareUrl ? SHARE_SCRIPT : '') +
    NAV_SCRIPT +
    '</body>' +
    '</html>'
  );
}
