// Per-country index top-up for the crawlable freeze (#7748).
//
// Even pooled, the news digest names roughly a third of indexed countries in
// a week; the rest were the enrichment tail. Every country the pool leaves
// under the headline limit asks the search route's `country:<ISO2>` form for
// the bulk materializer's rolling GKG index (scripts/_gdelt-bulk-
// materializer.mjs, served by server/worldmonitor/intelligence/v1/search-
// gdelt-documents.ts). Digest rows keep precedence; index rows fill the
// remaining slots. The route is anonymous, so a keyless freeze still tops
// up its headlines.
//
// Plain .mjs importing only plain-JS modules: the freeze runs under bare
// `node`. Split from scripts/freeze-crawlable-live-pulse.mjs so the freeze
// keeps one concern per module, like crawlable-developments.mjs.

import { countryMentionTerms, mentionsCountry } from '../shared/country-mention.js';
import { gdeltSeenDateToMs } from './_conflict-gdelt.mjs';
import { COUNTRY_INDEX_ORIGIN, isVerifiableArticleUrl } from './crawlable-developments.mjs';

// Twelve candidates leave the title gate room to drop location-only mentions
// (the route caps at twenty). A row older than the timeline window is not
// "recent" on a page headed that way: keep this in lockstep with
// COUNTRY_TIMELINE_WINDOW_DAYS in the freeze, and at least as long as the
// materializer's GDELT_COUNTRY_INDEX_WINDOW_MS or rows the index holds would
// be refused here.
export const COUNTRY_INDEX_FETCH_LIMIT = 12;
export const COUNTRY_INDEX_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
// GDELT seendates are quarter-hour capture times; allow a little skew past
// the freeze instant rather than dropping this quarter-hour's rows.
export const COUNTRY_INDEX_FUTURE_SKEW_MS = 60 * 60 * 1000;

/** Route path for one country's index rows. */
export function countryIndexPath(code) {
  return `/api/intelligence/v1/search-gdelt-documents?query=${encodeURIComponent(`country:${code}`)}`
    + `&max_records=${COUNTRY_INDEX_FETCH_LIMIT}`;
}

function canonicalHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// Index rows in publishable headline form. The route already serves index
// order (title mentions first, then primary mentions, newest first) and has
// applied the title gate; both are re-applied here because these rows reach
// a prerendered page and the corpus re-applies its publish rules the same
// way. Stricter than the digest slice on one point: an aggregator redirect
// (news.google.com) is refused, as on the homepage strip. Every accepted row
// is stamped with its origin so the corpus can render it nofollow and the
// brief floor can tell curated grounding from open-web corroboration.
export function selectCountryIndexHeadlines(articles, code, nowMs = Date.now()) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || !Array.isArray(articles)) return [];
  const terms = countryMentionTerms(normalized);
  const cutoff = nowMs - COUNTRY_INDEX_MAX_AGE_MS;
  const rows = [];
  const seen = new Set();
  for (const article of articles) {
    const title = String(article?.title || '').replace(/\s+/g, ' ').trim();
    const source = String(article?.source || '').trim();
    const url = canonicalHttpsUrl(article?.url);
    const publishedAtMs = gdeltSeenDateToMs(article?.date);
    if (!title || !source || !url || title.includes('**') || seen.has(url)) continue;
    if (!isVerifiableArticleUrl(url)) continue;
    if (!Number.isFinite(publishedAtMs) || publishedAtMs < cutoff || publishedAtMs > nowMs + COUNTRY_INDEX_FUTURE_SKEW_MS) continue;
    if (!mentionsCountry(title, terms)) continue;
    seen.add(url);
    rows.push({ title, source, url, publishedAt: new Date(publishedAtMs).toISOString(), origin: COUNTRY_INDEX_ORIGIN });
  }
  return rows;
}

// The route's country form answers every whole-index condition as a string in
// `error`. Only a genuine miss settles the run: the index is one key, so
// asking ~190 more times would repeat the answer. A transient read failure
// ('index-read-failed', 'revocations-unavailable') is that country's error
// and the loop continues, like an HTTP failure — one Redis blip must not
// revert a week's tail to digest-only (review of #7748).
const RUN_SETTLING_ROUTE_ERRORS = new Set(['seed-unavailable']);

function countryIndexState({ servedCount, unavailableCount, errorCount }) {
  if (servedCount > 0 && unavailableCount > 0) return 'partial';
  if (servedCount > 0) return 'available';
  if (unavailableCount > 0) return 'unavailable';
  if (errorCount > 0) return 'error';
  return 'not-requested';
}

/**
 * Top every under-filled country up from the index. Mutates `headlinesByCode`
 * in place (digest rows first, then accepted index rows, capped at
 * `headlineLimit`). Returns the coverage record, the capture errors (for the
 * snapshot's errors.developments — append them AFTER brief errors so the
 * brief gate's thrown cause is never a top-up hiccup) and the accepted URLs
 * (for the brief provenance pool).
 *
 * `fetchIndex(code)` resolves to the route payload or rejects; `sleep` paces
 * the requests like every other capture loop.
 */
export async function topUpCountryIndex({
  codes,
  headlinesByCode,
  headlineLimit,
  fetchIndex,
  nowMs = Date.now(),
  requestGapMs = 0,
  sleep = async () => {},
}) {
  const countryIndex = {
    state: 'not-requested',
    requestCount: 0,
    servedCount: 0,
    unavailableCount: 0,
    errorCount: 0,
    countryCount: 0,
  };
  const errors = [];
  const urls = new Set();
  let settled = false;
  for (const code of codes) {
    const digestRows = headlinesByCode.get(code) || [];
    if (digestRows.length >= headlineLimit || settled) continue;
    countryIndex.requestCount += 1;
    try {
      const payload = await fetchIndex(code);
      const routeError = typeof payload?.error === 'string' ? payload.error : '';
      if (RUN_SETTLING_ROUTE_ERRORS.has(routeError)) {
        countryIndex.unavailableCount += 1;
        settled = true;
        errors.push({
          code: '*',
          stage: 'country-index',
          message: `per-country article index answered ${routeError}; the remaining countries keep digest rows only`,
        });
      } else if (routeError) {
        countryIndex.errorCount += 1;
        errors.push({ code, stage: 'country-index', message: `per-country article index answered ${routeError}` });
      } else {
        countryIndex.servedCount += 1;
        const rows = selectCountryIndexHeadlines(payload?.articles, code, nowMs)
          .filter((row) => !digestRows.some((existing) => existing.url === row.url))
          .slice(0, headlineLimit - digestRows.length);
        if (rows.length > 0) {
          countryIndex.countryCount += 1;
          for (const row of rows) urls.add(row.url);
          headlinesByCode.set(code, [...digestRows, ...rows]);
        }
      }
    } catch (error) {
      countryIndex.errorCount += 1;
      errors.push({ code, stage: 'country-index', message: error instanceof Error ? error.message : String(error) });
    }
    await sleep(requestGapMs);
  }
  countryIndex.state = countryIndexState(countryIndex);
  return { countryIndex, errors, urls };
}
