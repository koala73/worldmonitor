// The level section of /blog/glossary/pentagon-pizza-index/, rendered by ONE
// function for the blog build, the routing middleware and the weekly pulse
// freeze. The build renders the last reading the freeze published, dated, so
// the HTML a crawler fetches always carries a level; the middleware swaps in
// the current reading at request time.
//
// The markup keeps every hook live-tools.js hydrates, so an open page goes on
// refreshing the server-rendered reading in place.
//
// Pure module: no Node or DOM APIs, so middleware.ts can bundle it.

import { PIZZINT_LEVEL_LABELS, pizzIntAnswerText, pizzIntViewModel } from '../crawlable-live-tools.mjs';
import { escapeHtml, formatStaticDateTime, liveSectionMarkers } from './common.mjs';

export const PIZZA_INDEX_SLUG = 'pentagon-pizza-index';
export const PIZZA_INDEX_PAGE_PATH = '/blog/glossary/pentagon-pizza-index/';
// Bare `public=1`: include_gdelt stays false, so the handler reads only the
// pizza seed. src/shared/public-rpc-cache.ts admits exactly this shape.
export const PIZZA_INDEX_STATUS_PATH = '/api/intelligence/v1/get-pizzint-status?public=1';
// The relay publishes a level only while a venue reports live busyness, so the
// weekly freeze often finds none and carries the previous edition's reading.
// Past two weeks a dated level says more about the archive than the index.
export const MAX_PUBLISHED_PIZZA_INDEX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

const FALLBACK_TEXT = 'The current level loads in your browser from World Monitor’s live feed, refreshed every 15 minutes.'
  + ' It also appears next to the pizza icon in the <a href="/dashboard">dashboard header</a>.';

/**
 * The view to publish, or null when no current level exists (expired seed,
 * closed-only poll). A malformed payload throws; the middleware then serves
 * the built page.
 */
export function pizzaIndexReading(payload, now = Date.now()) {
  const view = pizzIntViewModel(payload, now);
  return view.available ? view : null;
}

/** The JSON the weekly freeze stores for a live view. */
export function pizzaIndexRecord(view) {
  return {
    updatedAt: new Date(view.updatedAt).toISOString(),
    level: view.level,
    label: view.label,
    venues: view.venues.map((venue) => ({ name: venue.name, status: venue.status })),
  };
}

/**
 * The frozen reading in a pulse snapshot, or null when the pulse carries none,
 * carries one that fails the shape check, or carries one older than
 * MAX_PUBLISHED_PIZZA_INDEX_AGE_MS.
 */
export function publishedPizzaIndex(livePulse, now = Date.now()) {
  const record = livePulse?.pizzaIndex;
  if (!record || typeof record !== 'object') return null;
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > MAX_PUBLISHED_PIZZA_INDEX_AGE_MS) return null;
  if (PIZZINT_LEVEL_LABELS[record.level] !== record.label) return null;
  if (!Array.isArray(record.venues) || !record.venues.every((venue) => (
    typeof venue?.name === 'string' && venue.name && typeof venue?.status === 'string' && venue.status
  ))) return null;
  return pizzaIndexRecord({ ...record, updatedAt });
}

// The weekly editions the corpus builds from; a stray file with the same prefix
// is not one.
const LIVE_PULSE_EDITION_RE = /(?:^|\/)crawlable-live-pulse-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * The glossary page's published reading and schema dateModified. `pulses` maps
 * snapshot path to parsed JSON (the blog's import.meta.glob); the newest weekly
 * edition supplies the reading, and the page is dated by the later of its
 * review date and that reading.
 */
export function glossaryPizzaIndex(pulses, modifiedDate, now = Date.now()) {
  const newest = Object.keys(pulses).filter((path) => LIVE_PULSE_EDITION_RE.test(path)).sort().at(-1);
  const reading = newest ? publishedPizzaIndex(pulses[newest], now) : null;
  const dateModified = [modifiedDate, reading?.updatedAt].filter((value) => value != null).sort().at(-1);
  return { reading, dateModified };
}

function publishedAnswerText(record) {
  return `As of ${formatStaticDateTime(record.updatedAt)}, the last published reading of the Pentagon Pizza Index was level ${record.level}, ${record.label}.`;
}

function venueItems(venues) {
  return venues.length > 0
    ? venues.map((venue) => `      <li>${escapeHtml(`${venue.name} · ${venue.status}`)}</li>`).join('\n')
    : '      <li>No venue is reporting live busyness right now. The level returns with the next live reading.</li>';
}

/**
 * The marked section. `reading` null renders the browser-loading state. With
 * `live` the reading is the current one (a view from pizzaIndexReading);
 * without it, the dated reading the freeze published (a pizzaIndexRecord),
 * which the browser keeps when no current level exists.
 */
export function renderPizzaIndexSection(reading, { live = true } = {}) {
  const { start, end } = liveSectionMarkers(PIZZA_INDEX_SLUG);
  if (!reading) {
    return `${start}
<section class="live-reading" data-live-pizzint data-state="loading" aria-labelledby="live-reading-heading">
  <div class="live-reading-head">
    <h2 id="live-reading-heading">Current level</h2>
    <span class="live-reading-status" data-live-status>Loading the live level…</span>
  </div>
  <p class="live-reading-answer" data-live-answer hidden></p>
  <p class="live-reading-fallback" data-live-fallback>${FALLBACK_TEXT}</p>
  <div class="live-reading-body" data-live-grid hidden aria-busy="true">
    <p class="live-reading-level">
      <strong data-pizzint-level>—</strong>
      <span data-pizzint-label></span>
    </p>
    <ul class="live-reading-venues" data-pizzint-venues></ul>
  </div>
  <div class="live-reading-foot">
    <time data-live-updated></time>
    <button type="button" data-live-refresh>Refresh</button>
  </div>
</section>
${end}`;
  }
  const updatedIso = new Date(reading.updatedAt).toISOString();
  const marker = live ? 'data-live-at-request' : 'data-published-reading';
  const status = live ? 'Live reading' : 'Last published reading';
  const answer = live ? pizzIntAnswerText(reading) : publishedAnswerText(reading);
  const stamp = live ? 'Updated' : 'Published reading';
  // A published reading can be days old; "Latest" stays true whether it or a
  // live reading the client swaps in ends up under the heading.
  const heading = live ? 'Current level' : 'Latest level';
  return `${start}
<section class="live-reading" data-live-pizzint data-state="ready" data-published-pulse ${marker} aria-labelledby="live-reading-heading">
  <div class="live-reading-head">
    <h2 id="live-reading-heading">${heading}</h2>
    <span class="live-reading-status" data-live-status>${status}</span>
  </div>
  <p class="live-reading-answer" data-live-answer>${escapeHtml(answer)}</p>
  <p class="live-reading-fallback" data-live-fallback hidden>${FALLBACK_TEXT}</p>
  <div class="live-reading-body" data-live-grid aria-busy="false">
    <p class="live-reading-level">
      <strong data-pizzint-level>${escapeHtml(reading.level)}</strong>
      <span data-pizzint-label>${escapeHtml(reading.label)}</span>
    </p>
    <ul class="live-reading-venues" data-pizzint-venues>
${venueItems(reading.venues)}
    </ul>
  </div>
  <div class="live-reading-foot">
    <time data-live-updated datetime="${escapeHtml(updatedIso)}">${stamp} ${escapeHtml(formatStaticDateTime(updatedIso))}</time>
    <button type="button" data-live-refresh>Refresh</button>
  </div>
</section>
${end}`;
}
