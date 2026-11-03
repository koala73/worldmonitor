// Shared pieces of the /tools/<slug>/ live data pages. A topic page is built
// once with the frozen weekly reading, and the routing middleware swaps in the
// current reading at request time (the pattern #9333 shipped for chokepoints).
//
// Pure module: no Node or DOM APIs, so middleware.ts can bundle it.

import { escapeHtml, formatStaticDateTime } from '../crawlable-chokepoint-live.mjs';

export { escapeHtml, formatStaticDateTime };

// The section's FAQ is rendered here and in middleware, never by the corpus
// attribution pass, so it names its author itself (#7980). Same typed stub as
// WORLD_MONITOR_ORG in build-crawlable-corpus.mjs.
const AUTHOR = Object.freeze({
  '@id': 'https://www.worldmonitor.app/#organization',
  '@type': 'Organization',
  name: 'World Monitor',
  url: 'https://www.worldmonitor.app/',
});

export function liveSectionMarkers(slug) {
  return { start: `<!--wm-live:${slug}-->`, end: `<!--/wm-live:${slug}-->` };
}

/** Thrown by a topic's record() when a payload cannot be published as current. */
export class UnpublishableReading extends Error {}

export function requireFreshTimestamp(value, { now, maxAgeMs, label }) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new UnpublishableReading(`${label}: no capture time`);
  }
  if (now - timestamp > maxAgeMs) {
    throw new UnpublishableReading(`${label}: captured ${new Date(timestamp).toISOString()}, older than ${Math.round(maxAgeMs / 3_600_000)} h`);
  }
  return new Date(timestamp).toISOString();
}

/** "Oct 16, 2026" for a value that names a day, not a moment (a market close, a report week). */
export function formatStaticDate(iso) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return String(iso || '');
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp));
}

// Number(null) and Number('') are 0, which would publish a missing value as a
// real zero; absent stays null.
export function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

const COMPACT_USD = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
];

export function formatUsdCompact(value, digits = 2) {
  for (const [scale, word] of COMPACT_USD) {
    if (Math.abs(value) >= scale) return `$${(value / scale).toFixed(digits)} ${word}`;
  }
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export function formatUsdWhole(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** JSON for an inline <script>: "<" is escaped so the text cannot close the tag. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The marked live section. `answer` is a plain-text sentence that states the
 * reading with its date, so a quoted excerpt carries its own time context. The
 * FAQ markup lives inside the section so the middleware's swap updates the
 * structured answer together with the visible one. A page that carries several
 * live sections declares one FAQPage of its own and passes `faq: false`.
 */
export function renderLiveSection({ slug, question, record, live, answer, bodyHtml, asOf, dateOnly = false, sourceHtml, faq = true }) {
  const { start, end } = liveSectionMarkers(slug);
  const status = record
    ? (live ? 'Live reading' : 'Published reading')
    : 'No current reading';
  const when = dateOnly ? `for ${formatStaticDate(asOf)}` : formatStaticDateTime(asOf);
  const time = record && asOf
    ? `<time data-live-updated datetime="${escapeHtml(dateOnly ? asOf.slice(0, 10) : asOf)}">${escapeHtml(live ? 'Live reading' : 'Published reading')} ${escapeHtml(when)}</time>`
    : '<span data-live-updated>No current reading is available</span>';
  return `${start}
      <section class="live-tool" data-live-topic="${escapeHtml(slug)}" data-state="${record ? 'ready' : 'loading'}"${live && record ? ' data-live-at-request' : ''}>
        <h2>${escapeHtml(question)}</h2>
        <p data-live-answer>${escapeHtml(answer)}</p>
        <div class="tool-head">
          <p class="eyebrow">Current reading</p>
          <span class="live-status" data-live-status>${escapeHtml(status)}</span>
        </div>
${bodyHtml}
        <div class="tool-meta">
          ${time}
          <span>${sourceHtml}</span>
        </div>
${faq ? `        <script type="application/ld+json">${scriptJson({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          author: AUTHOR,
          mainEntity: [{ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } }],
        })}</script>
` : ''}      </section>
${end}`;
}

/**
 * Replaces the marked live section of `slug` in a built page. Returns null when
 * the page carries no single well-formed section, so the caller serves the
 * built page unchanged instead of guessing.
 */
export function replaceLiveSection(html, slug, section) {
  const { start: open, end: close } = liveSectionMarkers(slug);
  const start = html.indexOf(open);
  if (start === -1 || html.indexOf(open, start + 1) !== -1) return null;
  const end = html.indexOf(close, start);
  if (end === -1) return null;
  return html.slice(0, start) + section + html.slice(end + close.length);
}

export function metric(label, value, note = '') {
  return `          <div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
}
