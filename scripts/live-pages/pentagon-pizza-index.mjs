// The "Current level" section of /blog/glossary/pentagon-pizza-index/,
// rendered by ONE function for both the blog build (no reading: the browser
// loads it) and the routing middleware (the current reading at request time).
// Before this, the HTML a crawler fetched said "Loading the live level…", so
// the search snippet carried the definition while rival pages showed a level.
//
// The markup keeps every hook live-tools.js hydrates, so an open page goes on
// refreshing the server-rendered reading in place.
//
// Pure module: no Node or DOM APIs, so middleware.ts can bundle it.

import { pizzIntAnswerText, pizzIntViewModel } from '../crawlable-live-tools.mjs';
import { escapeHtml, formatStaticDateTime, liveSectionMarkers } from './common.mjs';

export const PIZZA_INDEX_SLUG = 'pentagon-pizza-index';
export const PIZZA_INDEX_PAGE_PATH = '/blog/glossary/pentagon-pizza-index/';
// Bare `public=1`: include_gdelt stays false, so the handler reads only the
// pizza seed. src/shared/public-rpc-cache.ts admits exactly this shape.
export const PIZZA_INDEX_STATUS_PATH = '/api/intelligence/v1/get-pizzint-status?public=1';

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

/** The marked section. `view` null renders the browser-loading state. */
export function renderPizzaIndexSection(view) {
  const { start, end } = liveSectionMarkers(PIZZA_INDEX_SLUG);
  if (!view) {
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
  const updatedIso = new Date(view.updatedAt).toISOString();
  const venues = view.venues.length > 0
    ? view.venues.map((venue) => `      <li>${escapeHtml(`${venue.name} · ${venue.status}`)}</li>`).join('\n')
    : '      <li>No venue is reporting live busyness right now. The level returns with the next live reading.</li>';
  return `${start}
<section class="live-reading" data-live-pizzint data-state="ready" data-published-pulse data-live-at-request aria-labelledby="live-reading-heading">
  <div class="live-reading-head">
    <h2 id="live-reading-heading">Current level</h2>
    <span class="live-reading-status" data-live-status>Live reading</span>
  </div>
  <p class="live-reading-answer" data-live-answer>${escapeHtml(pizzIntAnswerText(view))}</p>
  <p class="live-reading-fallback" data-live-fallback hidden>${FALLBACK_TEXT}</p>
  <div class="live-reading-body" data-live-grid aria-busy="false">
    <p class="live-reading-level">
      <strong data-pizzint-level>${escapeHtml(view.level)}</strong>
      <span data-pizzint-label>${escapeHtml(view.label)}</span>
    </p>
    <ul class="live-reading-venues" data-pizzint-venues>
${venues}
    </ul>
  </div>
  <div class="live-reading-foot">
    <time data-live-updated datetime="${escapeHtml(updatedIso)}">Updated ${escapeHtml(formatStaticDateTime(updatedIso))}</time>
    <button type="button" data-live-refresh>Refresh</button>
  </div>
</section>
${end}`;
}
