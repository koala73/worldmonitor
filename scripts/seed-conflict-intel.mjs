#!/usr/bin/env node

/**
 * Seed conflict + intelligence data to Redis.
 *
 * Seedable (fixed/predictable inputs):
 * - listAcledEvents (all countries, last 30 days)
 * - getHumanitarianSummary (top conflict countries)
 * - getPizzintStatus (base + gdelt variants)
 *
 * NOT seeded (inherently on-demand, user-specific):
 * - classifyEvent: per-headline LLM classification (sha256 cache key)
 * - deductSituation: per-query LLM deduction
 * - getCountryIntelBrief: per-country LLM brief with context hash
 * - getCountryFacts: per-country REST Countries + Wikidata + Wikipedia
 * - searchGdeltDocuments: per-query GDELT search
 */

import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  writeExtraKey,
  writeExtraKeyWithMeta,
  extendExistingTtl,
  sleep,
  loadSharedConfig,
  readSeedSnapshot,
} from './_seed-utils.mjs';
import { fetchGdeltJson } from './_gdelt-fetch.mjs';
import { buildGdeltConflictUrl, mapGdeltArticlesToEvents, GDELT_COUNTRY_NAMES } from './_conflict-gdelt.mjs';
import { fetchGdeltBulkConflictEvents, GDELT_BULK_WORST_NETWORK_MS, GDELT_ROLLING_WINDOW_MS, gdeltTimestampToMs, mergeGdeltBulkRollingWindow } from './_conflict-gdelt-bulk.mjs';
import { GDELT_BULK_CONFLICT_KEY } from './_gdelt-bulk-contract.mjs';
import {
  HAPI_HDX_MAX_RESPONSE_BYTES,
  HAPI_HDX_PACKAGE_URL,
  HAPI_MAX_PAGES,
  HAPI_PAGE_LIMIT,
  aggregateHapiConflictEvents,
  buildHapiConflictEventsUrl,
  fetchHapiHdxSnapshotRows,
  hapiCountryCodeForIso3,
  hapiHdxFailureReason,
  parseHapiHdxConflictCsv,
  selectHapiHdxCsvResources,
} from './_conflict-hapi.mjs';
import { makeSeedHistoryAfterPublish } from './_seed-history.mjs';
import { resolveIso2 } from './_country-resolver.mjs';

export {
  HAPI_HDX_MAX_RESPONSE_BYTES,
  HAPI_HDX_PACKAGE_URL,
  aggregateHapiConflictEvents,
  buildHapiConflictEventsUrl,
  fetchHapiHdxSnapshotRows,
  parseHapiHdxConflictCsv,
  selectHapiHdxCsvResources,
};

loadEnvFile(import.meta.url);

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_CACHE_KEY = 'conflict:acled:v1:all:0:0';
const ACLED_RESOLUTION_CACHE_KEY = 'conflict:acled-resolution:v1:all:0:0';
// Data TTL for the conflict-events key. MUST outlive health's staleness threshold
// for acledIntel (maxStaleMin 38 in api/health.js), or the key expires BEFORE
// STALE_SEED can fire and a merely-late seeder reports as an EMPTY crit — while
// consumers of the forecast EMA input get nothing at all.
//
// Was 900s (15 min) against a */15 cron: a TTL exactly equal to the refresh
// interval, i.e. ZERO headroom. Railway SKIPS a tick whenever the previous run is
// still in flight (11 skipped ticks in one 12h window), so one skip dropped the
// data. Observed live: last good run 23 min old, key already gone, health crit.
// 2700s = 45 min = 3x the interval, matching the convention in
// seed-defense-patents.mjs (21d TTL for a weekly seed). Pinned by
// tests/seed-ttl-outlives-health-staleness.
export const ACLED_TTL = 2700;
const ACLED_DISPLAY_LOOKBACK_DAYS = 30;
const ACLED_DISPLAY_LIMIT = 500;
const ACLED_RESOLUTION_LOOKBACK_DAYS = 60;
const ACLED_RESOLUTION_PAGE_LIMIT = 5000;
const ACLED_RESOLUTION_MAX_PAGES = 20;
const ACLED_PAGE_DELAY_MS = 250;
const HAPI_CACHE_KEY_PREFIX = 'conflict:humanitarian:v1';
const HAPI_TTL = 21600;
// api/health.js's SEED_META entry for this family reads ONE aggregate key
// (seed-meta:conflict:humanitarian), not the per-country seed-meta keys
// writeExtraKeyWithMeta derives per HAPI_CACHE_KEY_PREFIX write below — those
// don't share a common non-country-specific prefix writeSeedMeta could roll up
// automatically. maxStaleMin in health.js is 300 (5h) — bounded above by HAPI_TTL
// (360min/6h, the per-country data key's own Redis TTL) so the alarm fires BEFORE
// per-country data can expire, not just against this seeder's 15min cron cadence
// (30 days would NOT have caught #5554 promptly, and even 12h left a 6h blind
// spot where data was already empty but health still reported OK — #5554 review).
// The TTL here must clearly OUTLIVE that staleness threshold — matching the
// ACLED_TTL headroom lesson above (a TTL equal to the staleness window has zero
// headroom against a single missed/late tick, and reports EMPTY instead of STALE).
const HAPI_SEED_META_KEY = 'seed-meta:conflict:humanitarian';
const HAPI_SEED_META_TTL_SECONDS = 3 * 86400;
// HAPI publishes this ACLED-derived table weekly. The conflict seeder runs every
// 15 minutes for its other feeds, so a freshness gate prevents that unrelated
// cadence from repeatedly hitting HAPI. The 2h interval remains comfortably
// inside the 5h health threshold and 6h per-country data TTL.
export const HAPI_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const HAPI_FAILURE_BACKOFF_MS = 2 * 60 * 60 * 1000;
const HAPI_FAILURE_BACKOFF_KEY = 'conflict:humanitarian:hapi-backoff:v1';
const HAPI_REQUEST_TIMEOUT_MS = 15_000;
const HAPI_REQUEST_DELAY_MS = 1_100;
const PIZZINT_TTL = 600;

export const CONFLICT_COUNTRIES = [
  'AF', 'SY', 'UA', 'SD', 'SS', 'SO', 'CD', 'MM', 'YE', 'ET',
  'IQ', 'PS', 'LY', 'ML', 'BF', 'NE', 'NG', 'CM', 'MZ', 'HT',
];
export const GDELT_MIN_SUCCESSFUL_COUNTRIES = Math.ceil(CONFLICT_COUNTRIES.length * 0.8);
// Crisis-tracker registry (shared/crawlable-crises.json) countries HAPI must cover that
// CONFLICT_COUNTRIES doesn't already include. Kept as a SEPARATE list, not merged into
// CONFLICT_COUNTRIES — that array also sizes GDELT_MIN_SUCCESSFUL_COUNTRIES and the GDELT
// sweep threshold below; growing it here would silently shift GDELT's coverage floor and
// break its fixed-count tests (#5554 — a prior fix attempt did exactly this).
const HAPI_ONLY_COUNTRIES = ['IR', 'IL', 'RU', 'SA', 'DJ', 'ER'];
// The dashboard's country-tension widget (src/services/conflict/index.ts
// HAPI_COUNTRY_CODES) requests this 20-country watchlist. Before this fix, a cache
// miss fell back to a live HAPI fetch, so incomplete seed coverage was invisible;
// the RPC handlers are now cache-only (#5554 review), so every widget country is
// part of the guaranteed coverage contract. Keep the complete list in sync with
// that file rather than listing only the countries unique to the dashboard.
const HAPI_DASHBOARD_COUNTRIES = [
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
  'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
];
const HAPI_CRISIS_COUNTRIES = ['IR', 'IL', 'UA', 'RU', 'SD', 'YE', 'SA', 'DJ', 'ER'];
// Public crisis trackers and the dashboard batch are the guaranteed coverage
// contract. The broader conflict set is still collected when national rows are
// present, but it does not trigger a per-country fallback fan-out.
export const HAPI_REQUIRED_COUNTRIES = [
  ...new Set([...HAPI_CRISIS_COUNTRIES, ...HAPI_DASHBOARD_COUNTRIES]),
];
const HAPI_COUNTRIES = [...new Set([...HAPI_ONLY_COUNTRIES, ...HAPI_DASHBOARD_COUNTRIES, ...CONFLICT_COUNTRIES])];
// The bounded transport emits stable route-specific failure codes. Treat the
// failures known to implicate the selected route as a run-scoped circuit
// signal; repeating them for another country cannot improve source reachability.
const GDELT_ROUTE_FAILURE = /\bGDELT_(?:SOURCE_PROXY|SHARED_PROXY|PROXY|DIRECT)_(?:CONFIG|HTTP_(?:401|403|404|406|407|408|410|429|451|5\d\d)|INVALID_JSON|TLS|TIMEOUT|DNS|TRANSPORT)\b|\bHTTP 429\b|SSL_ERROR_SYSCALL|\b(?:timed?\s*out|timeout)\b/i;
// #5140: the GDELT fallback sweep may not LAUNCH a batch after this much of the
// fetch phase has elapsed (fetchAll anchors the clock at its own entry and passes
// an absolute deadline down, so slow aux feeds automatically shrink the sweep
// window instead of stacking on top of it). HAPI now uses one bounded API request
// plus, only on bot detection, an official snapshot instead of a 38-country
// sequential sweep. One
// in-flight batch may still drain past the cutoff: ≤~100s at the knobs below
// (either 15s concurrent direct legs when no proxy is configured, or 4 × 20s
// SERIALIZED sync proxy curls — curlFetch is execFileSync, so "concurrent"
// proxy attempts block the event loop one at a time). Worst single fetchAll attempt before the bulk
// fallback is now dominated by the GDELT path. Without this cap a
// GDELT brownout ran 5 batches ≈ 375s+ → deadline breach → exit 75 every tick.
// HAPI's 15s API plus 60s metadata and, only at the January boundary, at most
// two 120s annual snapshot downloads run inside the parallel auxiliary stage,
// not after the sweep. The resulting ≤315s HAPI bound remains comfortably under
// ACLED_INTEL_LOCK_TTL_MS's 540s fetch deadline (lockTtlMs+120s)
// below (re-verified #5554 review after growing HAPI_COUNTRIES to 38).
export const GDELT_SWEEP_BUDGET_MS = 120_000;
// Cold-start floor for the bulk-primary path (#5849 review): only consulted
// on a TRUE cold start (no previous snapshot of any kind — #5855 review). Kept
// deliberately low — a quiet-but-healthy 2h export window still clears it,
// while a partially-degraded mirror serving a single-country handful does not.
const GDELT_BULK_COLD_START_MIN_COUNTRIES = 3;
// Freshness gate for the bulk-primary path (#5855 review): a mirror that stops
// updating keeps serving the same aging exports, and without an age check every
// tick publishes a "fresh" seed-meta write while a possibly-healthy DOC route
// is never consulted. 3h = 12 export cycles of lag — beyond any routine GDELT
// publication gap, far under the 24h rolling window. An unparseable newest
// export timestamp fails closed (treated as stale).
export const GDELT_BULK_MAX_EXPORT_AGE_MS = 3 * 60 * 60 * 1000;
// Materialized exports come from the same 15-minute Railway cadence, so they
// should never lead this consumer's clock materially. Allow a small deployment
// clock skew, then fail closed instead of pinning a future export as fresh.
export const GDELT_BULK_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
// The shared GDELT transport enforces one selected-route attempt. These explicit
// values pin that contract at this high-fanout caller. timeoutMs is pinned too:
// _gdelt-fetch.mjs's default rose from 15s to 30s for seed-gdelt-intel's slow
// residential-proxy route (issue #5830), but this sweep's own budget was never
// re-tuned for that — GDELT_SWEEP_BUDGET_MS (120s) launches batches of 4 and
// needs 16/20 countries to clear GDELT_MIN_SUCCESSFUL_COUNTRIES. Inheriting the
// 30s default would let a single degraded batch eat a quarter of the whole
// sweep budget, so this call site keeps the prior 15s ceiling explicitly.
export const GDELT_COUNTRY_FETCH_OPTS = Object.freeze({ maxRetries: 0, proxyMaxAttempts: 1, timeoutMs: 15_000 });
// Lock must outlive the worst legitimate run (runSeed's documented invariant —
// _seed-utils.mjs: "a healthy seeder is designed never to outlive its own lock");
// it also sets the fetch deadline (lockTtlMs + 120s margin = 540s). The default
// 120s lock was ALREADY shorter than this seeder's worst case. Cron cadence is
// 15min, so a hard-crashed run's dangling lock costs at most 7 of those minutes.
export const ACLED_INTEL_LOCK_TTL_MS = 420_000;

// HDX HAPI's `app_identifier` is used for per-client tracking/rate-limiting, not
// just auth. The API remains the preferred route, but HAPI now bot-blocks both
// Railway's direct egress and the configured residential proxy. A bot block
// therefore falls back to HAPI's official annual CSV snapshot on HDX instead of
// retrying the identical API endpoint through another egress. This seeder is
// the only source of HAPI traffic; the RPC handlers only read the Redis keys it
// writes, and the freshness gate permits one attempt at most every two hours.
const HAPI_APP_IDENTIFIER_CONFIG = loadSharedConfig('hapi-app-identifier.json');
const HAPI_APP_IDENTIFIER = Buffer.from(
  `${HAPI_APP_IDENTIFIER_CONFIG.application}:${HAPI_APP_IDENTIFIER_CONFIG.email}`,
).toString('base64');

// ─── ACLED Events ───

async function fetchAcledToken() {
  // Priority 1: ACLED_EMAIL + ACLED_PASSWORD -> OAuth flow (matches server/acled-auth.ts)
  const email = process.env.ACLED_EMAIL?.trim();
  const password = process.env.ACLED_PASSWORD?.trim();
  if (email && password) {
    const body = new URLSearchParams({
      username: email, password, grant_type: 'password', client_id: 'acled',
    });
    const resp = await fetch('https://acleddata.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CHROME_UA },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`ACLED OAuth failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.access_token) return data.access_token;
    throw new Error('ACLED OAuth response missing access_token');
  }

  // Priority 2: Static token fallback (legacy)
  const staticToken = process.env.ACLED_ACCESS_TOKEN?.trim();
  if (staticToken) return staticToken;

  return null;
}

let acledTokenPromise;
function getAcledTokenOnce() {
  if (!acledTokenPromise) acledTokenPromise = fetchAcledToken();
  return acledTokenPromise;
}

function acledDateRange(now, lookbackDays) {
  return {
    startDate: new Date(now - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date(now).toISOString().split('T')[0],
  };
}

function buildAcledParams({ startDate, endDate, limit, page }) {
  const params = new URLSearchParams({
    event_type: 'Battles|Explosions/Remote violence|Violence against civilians',
    event_date: `${startDate}|${endDate}`,
    event_date_where: 'BETWEEN',
    limit: String(limit),
    _format: 'json',
  });
  if (page) params.set('page', String(page));
  return params;
}

function stableAcledEventId(event) {
  if (typeof event?.event_id_cnty !== 'string') return null;
  const id = event.event_id_cnty.trim();
  return id || null;
}

async function fetchAcledPage(token, params) {
  const resp = await fetch(`${ACLED_API_URL}?${params}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`ACLED HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error || data.message) throw new Error(data.error || data.message);
  return Array.isArray(data.data) ? data.data : [];
}

export function normalizeAcledConflictEvents(rawEvents) {
  return rawEvents.flatMap((e) => {
    const eventId = stableAcledEventId(e);
    const lat = parseFloat(e?.latitude || '');
    const lon = parseFloat(e?.longitude || '');
    if (
      !eventId
      || !Number.isFinite(lat)
      || !Number.isFinite(lon)
      || lat < -90
      || lat > 90
      || lon < -180
      || lon > 180
    ) {
      return [];
    }
    return [{
      id: `acled-${eventId}`,
      eventType: e.event_type || '',
      country: e.country || '',
      // event_date ('YYYY-MM-DD') is the field the EMA engine reads
      // (_ema-threat-engine.mjs `Date.parse(ev.event_date)`); without it ACLED
      // events parsed as NaN and were never counted by the escalation EMA.
      event_date: e.event_date || '',
      location: { latitude: parseFloat(e.latitude || '0'), longitude: parseFloat(e.longitude || '0') },
      occurredAt: new Date(e.event_date || '').getTime(),
      fatalities: parseInt(e.fatalities || '', 10) || 0,
      actors: [e.actor1, e.actor2].filter(Boolean),
      source: e.source || '',
      admin1: e.admin1 || '',
    }];
  });
}

export function shouldStopAcledPagination({
  pageSize,
  limit,
  stableEventIdCount,
  addedEventCount,
}) {
  return pageSize < limit || (stableEventIdCount === pageSize && addedEventCount === 0);
}

async function fetchAcledEvents({
  lookbackDays = ACLED_DISPLAY_LOOKBACK_DAYS,
  limit = ACLED_DISPLAY_LIMIT,
  paginated = false,
  maxPages = 1,
  label = 'ACLED',
} = {}) {
  const token = await getAcledTokenOnce();
  if (!token) {
    console.log(`  ${label}: no credentials configured, skipping`);
    return null;
  }

  const now = Date.now();
  const { startDate, endDate } = acledDateRange(now, lookbackDays);
  const rawEvents = [];
  const seen = new Set();
  let pagesFetched = 0;
  let lastPageCount = 0;
  let missingEventIdCount = 0;
  const pageLimit = paginated ? Math.max(1, maxPages) : 1;

  for (let page = 1; page <= pageLimit; page += 1) {
    const params = buildAcledParams({
      startDate,
      endDate,
      limit,
      page: paginated ? page : undefined,
    });
    const pageEvents = await fetchAcledPage(token, params);
    pagesFetched = page;
    lastPageCount = pageEvents.length;
    const before = rawEvents.length;
    let stableEventIdCount = 0;
    for (const event of pageEvents) {
      // ACLED documents event_id_cnty as the stable identifier that survives
      // detail updates. A composite fallback changes when notes/source details
      // are revised and therefore cannot safely key history or retractions.
      const id = stableAcledEventId(event);
      if (!id) {
        missingEventIdCount += 1;
        continue;
      }
      stableEventIdCount += 1;
      if (seen.has(id)) continue;
      seen.add(id);
      rawEvents.push(event);
    }
    if (
      !paginated
      || shouldStopAcledPagination({
        pageSize: pageEvents.length,
        limit,
        stableEventIdCount,
        addedEventCount: rawEvents.length - before,
      })
    ) {
      break;
    }
    await sleep(ACLED_PAGE_DELAY_MS);
  }

  const events = normalizeAcledConflictEvents(rawEvents);
  if (missingEventIdCount > 0) {
    console.warn(`  ${label}: dropped ${missingEventIdCount} event(s) missing stable event_id_cnty`);
  }
  const pagination = paginated
    ? { lookbackDays, limit, pagesFetched, maxPages, truncated: pagesFetched >= maxPages && lastPageCount >= limit }
    : undefined;
  console.log(`  ${label}: ${events.length} events (${startDate} to ${endDate}${paginated ? `, ${pagesFetched} page(s)` : ''})`);
  return { events, pagination };
}

// ─── GDELT conflict-events fallback (used when ACLED has no credentials) ───
// ACLED requires a registered account. When its credentials are absent, keep a
// near-real-time conflict signal from GDELT. The official 15-minute bulk event
// export is PRIMARY (#5849): it serves real material-conflict records from the
// unthrottled GCS mirror with no proxy involvement. The DOC 2.0 per-country
// sweep — which counts recent conflict-tagged articles and emits synthetic
// events in the SAME {country, event_date} shape the EMA engine reads
// (_ema-threat-engine.mjs) — is supply-side load-shed (#5843: 0/20 countries
// for weeks) and runs only when the bulk path itself fails.
export async function fetchGdeltCountryEvents(cc) {
  if (!GDELT_COUNTRY_NAMES[cc]) {
    return { country: cc, ok: false, events: [], error: 'unknown country code' };
  }
  let data;
  try {
    // Runs 20× per cycle — keep each call cheap so the whole sweep fits the run window.
    data = await fetchGdeltJson(buildGdeltConflictUrl(cc), { label: `conflict:${cc}`, ...GDELT_COUNTRY_FETCH_OPTS });
  } catch (e) {
    console.warn(`  GDELT ${cc}: ${e.message}`);
    return { country: cc, ok: false, events: [], error: e.message || String(e) };
  }
  return { country: cc, ok: true, events: mapGdeltArticlesToEvents(data?.articles, cc) };
}

// #5855 review: a programming defect in our own code must crash loud and
// attributable to the deploy — never be reclassified as an upstream outage and
// quietly degraded to sourceUnavailable/exit 0 under the mirror-outage runbook.
function isProgrammingDefect(error) {
  return error instanceof TypeError
    || error instanceof ReferenceError
    || error instanceof RangeError
    || error instanceof SyntaxError;
}

export async function fetchGdeltConflictEvents({
  fetchCountryEvents = fetchGdeltCountryEvents,
  fetchBulkEvents = fetchGdeltBulkConflictEvents,
  pace = sleep,
  now = Date.now,
  deadlineAt,
  loadPreviousSnapshot = () => readSeedSnapshot(ACLED_CACHE_KEY, { strict: true }),
} = {}) {
  // Bulk export first (#5849). On any bulk failure — mirror outage, stale
  // mirror, empty rolling window — fall through to the DOC sweep below. An
  // empty CURRENT tick is not by itself a failure: the retained rolling window
  // still publishes, and only empty-current + nothing-retained falls through
  // (#5855 review).
  const bulkStartedAt = now();
  let bulkFailure;
  try {
    const bulk = await fetchBulkEvents();
    const newestExportAgeMs = now() - gdeltTimestampToMs(bulk?.exportTimestamp);
    if (!Number.isFinite(newestExportAgeMs) || newestExportAgeMs > GDELT_BULK_MAX_EXPORT_AGE_MS) {
      throw new Error(
        `bulk export stale or unparseable: newest export ${bulk?.exportTimestamp}`
        + ` is ${Number.isFinite(newestExportAgeMs) ? Math.round(newestExportAgeMs / 60000) : '?'}min old`
        + ` (max ${GDELT_BULK_MAX_EXPORT_AGE_MS / 60000}min)`,
      );
    }
    let previousSnapshot = null;
    let previousSnapshotReadFailed = false;
    try {
      previousSnapshot = await loadPreviousSnapshot();
    } catch (snapshotError) {
      previousSnapshotReadFailed = true;
      console.warn(
        '  GDELT bulk previous snapshot unavailable; publishing current exports only:'
        + ` ${snapshotError?.message || snapshotError}`,
      );
    }
    const rolling = mergeGdeltBulkRollingWindow(bulk, previousSnapshot, now());
    if (!rolling.events.length) throw new Error('rolling bulk window contained no priority-country material-conflict events');
    const countriesWithEvents = new Set(rolling.events.map(event => event.country)).size;
    if (bulk.exportsSucceeded < bulk.exportsRequested) {
      // Partial mirror degradation normally still publishes (each 15-min slice
      // gets ~RECENT_EXPORT_COUNT retries before aging out of the manifest
      // tail, and the rolling merge retains prior events), but say so — a
      // silent thin tick is how a persistent asymmetric outage hides (#5849
      // review). Logged ahead of the cold-start floor so a thin cold-start
      // tick — exactly the degraded-mirror shape — still reports the ratio
      // (#5855 review).
      console.warn(`  GDELT bulk exports partially degraded: ${bulk.exportsSucceeded}/${bulk.exportsRequested} export files fetched`);
    }
    // Cold-start coverage floor (#5849 review, flagged independently by two
    // reviewers): on a true first-ever run, an implausibly thin bulk result —
    // a partially-degraded mirror serving one usable export — must not become
    // the primary feed. Fall through to the sweep (and, both-fail, to
    // runSeed's sourceUnavailable last-good preservation) instead.
    // The floor arms ONLY on a true cold start (#5855 review):
    // - a transient snapshot-read failure means "could not read", not
    //   "first-ever run" (previousSnapshotReadFailed guard), and
    // - a previous snapshot that exists but is DOC-sourced also zeroes
    //   retainedPreviousEvents; flooring that state ping-pongs recovery back
    //   onto the load-shed DOC route every time DOC briefly succeeds (#5852's
    //   floor half). Publishing thin-but-real bulk re-primes the window.
    if (
      !previousSnapshotReadFailed
      && previousSnapshot == null
      && rolling.retainedPreviousEvents === 0
      && countriesWithEvents < GDELT_BULK_COLD_START_MIN_COUNTRIES
    ) {
      throw new Error(
        `cold-start bulk window too thin: ${countriesWithEvents} countries with events`
        + ` (min ${GDELT_BULK_COLD_START_MIN_COUNTRIES})`,
      );
    }
    console.log(
      `  GDELT bulk conflict-events: ${rolling.events.length} events through export ${bulk.exportTimestamp}`
      + ` (${rolling.retainedPreviousEvents} retained from prior runs)`,
    );
    return {
      events: rolling.events,
      pagination: {
        exportTimestamp: bulk.exportTimestamp,
        exportsRequested: bulk.exportsRequested,
        exportsSucceeded: bulk.exportsSucceeded,
        countriesWithEvents,
        rollingWindowHours: GDELT_ROLLING_WINDOW_MS / (60 * 60 * 1000),
        rollingWindowStartedAt: rolling.rollingWindowStartedAt,
        rollingWindowComplete: rolling.rollingWindowComplete,
        retainedPreviousEvents: rolling.retainedPreviousEvents,
      },
      source: 'gdelt-bulk',
    };
  } catch (bulkError) {
    // Reclassified as a "bulk failure", a code defect would route to the
    // load-shed DOC sweep and end in a quiet sourceUnavailable exit 0,
    // sending operators down the mirror-outage runbook (#5855 review).
    if (isProgrammingDefect(bulkError)) throw bulkError;
    bulkFailure = `GDELT bulk event export failed: ${bulkError?.message || bulkError}`;
    console.warn(`  ${bulkFailure}; falling back to the DOC country sweep`);
  }

  // DOC sweep fallback — canary, batch, budget, floor, and circuit semantics
  // unchanged from when it was primary (#5140). The bulk attempt's elapsed time
  // is credited back to the cutoff: the deadline invariant already budgets
  // GDELT_BULK_WORST_NETWORK_MS ON TOP of the sweep window (seed-fetch-deadline-
  // budget-invariants.test.mjs), and without the credit a slow-failing mirror
  // (up to ~60s of timeouts) would hand the healthy DOC fallback an already-
  // expired budget every tick. Aux-stage time still comes out of the window,
  // and the credit is clamped to the same GDELT_BULK_WORST_NETWORK_MS constant
  // the invariant test models, so the modelled and actual worst-case envelopes
  // stay the same number (#5140 arithmetic unchanged).
  const events = [];
  const failedCountries = [];
  let successfulCountries = 0;
  const CONCURRENCY = 4;
  const launchCutoffAt = deadlineAt != null
    ? deadlineAt + Math.min(now() - bulkStartedAt, GDELT_BULK_WORST_NETWORK_MS)
    : now() + GDELT_SWEEP_BUDGET_MS;
  for (let i = 0; i < CONFLICT_COUNTRIES.length;) {
    // #5140: stop LAUNCHING batches once the phase cutoff passes or the floor can
    // no longer be reached — either way the caller degrades to aux-only and exits 0,
    // instead of grinding retries into the fetch-phase deadline (exit 75).
    const remaining = CONFLICT_COUNTRIES.slice(i);
    const overBudget = now() >= launchCutoffAt;
    const floorUnreachable = successfulCountries + remaining.length < GDELT_MIN_SUCCESSFUL_COUNTRIES;
    if (overBudget || floorUnreachable) {
      const why = [overBudget && 'sweep budget exhausted', floorUnreachable && 'coverage floor unreachable']
        .filter(Boolean).join(' + ');
      for (const cc of remaining) failedCountries.push({ country: cc, error: why });
      console.warn(`  [GDELT] conflict sweep stopped early (${why}) with ${i}/${CONFLICT_COUNTRIES.length} countries attempted`);
      break;
    }
    // Probe one country before widening. A selected-route failure on the canary
    // aborts the sweep after a single request (bulk has already failed by this
    // point — see top of function) instead of repeating the same blocked path
    // across a four-country batch.
    const batchSize = successfulCountries === 0 ? 1 : CONCURRENCY;
    const batch = remaining.slice(0, batchSize);
    const results = await Promise.all(batch.map(cc => fetchCountryEvents(cc)));
    for (const result of results) {
      if (result?.ok) {
        successfulCountries += 1;
        events.push(...(Array.isArray(result.events) ? result.events : []));
      } else {
        failedCountries.push({ country: result?.country || 'unknown', error: result?.error || 'unknown failure' });
      }
    }
    i += batch.length;

    // A whole batch of selected-route failures means the route, not a country
    // query, is unavailable. Open the circuit for 429, TLS, timeout, DNS,
    // malformed upstream JSON, and route-wide HTTP statuses alike.
    const batchAllFailed = results.every(r => !r?.ok);
    const routeFailed = results.some(r => GDELT_ROUTE_FAILURE.test(String(r?.error ?? '')));
    if (batchAllFailed && routeFailed) {
      const why = 'GDELT selected-route circuit open (batch fully failed)';
      for (const cc of CONFLICT_COUNTRIES.slice(i)) failedCountries.push({ country: cc, error: why });
      console.warn(`  [GDELT] conflict sweep backed off (${why}) after ${i}/${CONFLICT_COUNTRIES.length} countries`);
      break;
    }
    if (i < CONFLICT_COUNTRIES.length) await pace(500); // inter-batch only; no trailing wait
  }
  if (successfulCountries < GDELT_MIN_SUCCESSFUL_COUNTRIES || events.length === 0) {
    const sample = failedCountries.slice(0, 6).map(({ country, error }) => `${country}:${error}`).join(', ');
    const docFailure = successfulCountries < GDELT_MIN_SUCCESSFUL_COUNTRIES
      ? `GDELT conflict-events coverage below floor: ${successfulCountries}/${CONFLICT_COUNTRIES.length} countries succeeded ` +
        `(min ${GDELT_MIN_SUCCESSFUL_COUNTRIES})${sample ? `; failures: ${sample}` : ''}`
      : `GDELT conflict-events returned zero events across ${successfulCountries}/${CONFLICT_COUNTRIES.length} successful countries`;
    throw new Error(`${bulkFailure}; DOC sweep fallback failed: ${docFailure}`);
  }
  console.log(`  GDELT conflict-events DOC sweep fallback: ${events.length} events across ${successfulCountries}/${CONFLICT_COUNTRIES.length} successful country fetches`);
  return {
    events,
    pagination: {
      countriesTotal: CONFLICT_COUNTRIES.length,
      countriesSucceeded: successfulCountries,
      countriesFailed: failedCountries.length,
      minSuccessfulCountries: GDELT_MIN_SUCCESSFUL_COUNTRIES,
    },
    source: 'gdelt',
  };
}

// The bulk materializer owns GDELT downloads and the 24h rolling window.
// Conflict remains the publisher of the established ACLED-compatible key, but
// its no-credentials fallback is now a single Redis read instead of a second
// bulk download followed by a 20-country DOC sweep.
export async function readMaterializedGdeltConflictEvents({
  readSnapshot = () => readSeedSnapshot(GDELT_BULK_CONFLICT_KEY, { strict: true }),
  now = Date.now,
} = {}) {
  const snapshot = await readSnapshot();
  if (
    snapshot?.source !== 'gdelt-bulk'
    || !Array.isArray(snapshot?.events)
    || snapshot.events.length === 0
  ) {
    throw new Error(`${GDELT_BULK_CONFLICT_KEY} missing or empty`);
  }
  const exportTimestamp = snapshot?.pagination?.exportTimestamp;
  const exportMs = gdeltTimestampToMs(exportTimestamp);
  const nowMs = now();
  if (!Number.isFinite(exportMs)) {
    throw new Error(`${GDELT_BULK_CONFLICT_KEY} export timestamp is unparseable: ${exportTimestamp}`);
  }
  const ageMs = nowMs - exportMs;
  if (ageMs > GDELT_BULK_MAX_EXPORT_AGE_MS) {
    throw new Error(
      `${GDELT_BULK_CONFLICT_KEY} stale export ${exportTimestamp}`
      + ` (${Math.round(ageMs / 60000)}min old; max ${GDELT_BULK_MAX_EXPORT_AGE_MS / 60000}min)`,
    );
  }
  if (ageMs < -GDELT_BULK_MAX_FUTURE_SKEW_MS) {
    throw new Error(
      `${GDELT_BULK_CONFLICT_KEY} future export ${exportTimestamp}`
      + ` (${Math.round(-ageMs / 60000)}min ahead; max ${GDELT_BULK_MAX_FUTURE_SKEW_MS / 60000}min)`,
    );
  }
  // Cold-start coverage floor, carried onto the materialized path (#5864).
  // #5855 added this so an implausibly thin window could not become the whole
  // conflict feed; after the #5863 cutover it survived only in the unwired DOC
  // seam. It arms ONLY before the rolling window is complete — steady-state
  // ticks always carry a full 24h window and are never floored. Throwing here
  // routes to fetchAll's sourceUnavailable path, which preserves last-good.
  if (snapshot?.pagination?.rollingWindowComplete === false) {
    const countriesWithEvents = new Set(
      snapshot.events.map((event) => event?.country).filter(Boolean),
    ).size;
    if (countriesWithEvents < GDELT_BULK_COLD_START_MIN_COUNTRIES) {
      throw new Error(
        `${GDELT_BULK_CONFLICT_KEY} cold-start window too thin:`
        + ` ${countriesWithEvents} countries with events`
        + ` (min ${GDELT_BULK_COLD_START_MIN_COUNTRIES})`,
      );
    }
  }
  return snapshot;
}

// ─── Humanitarian Summary (HAPI) ───

async function defaultPreserveHapiLastGood() {
  await extendExistingTtl(
    HAPI_COUNTRIES.map((countryCode) => `${HAPI_CACHE_KEY_PREFIX}:${countryCode}`),
    HAPI_TTL,
  );
  await extendExistingTtl(
    [HAPI_CACHE_KEY_PREFIX, HAPI_SEED_META_KEY],
    HAPI_SEED_META_TTL_SECONDS,
  );
}

function hapiFailureReason(status, providerMessage = '') {
  if (/blocked due to bot activity/i.test(providerMessage)) {
    return 'HAPI_BOT_BLOCK';
  }
  if (Number(status) === 429) return 'HAPI_RATE_LIMIT';
  return Number.isInteger(Number(status)) ? `HTTP_${Number(status)}` : 'HAPI_FETCH_FAILED';
}

async function hapiResponseError(resp) {
  let providerMessage = '';
  try {
    const rawBody = await resp.text();
    try {
      const body = JSON.parse(rawBody);
      providerMessage = String(body?.error || body?.detail || rawBody);
    } catch {
      providerMessage = rawBody;
    }
  } catch {
    // Status and status text remain sufficient when the provider sends no body.
  }
  return Object.assign(
    new Error(`HTTP ${resp.status} ${resp.statusText}${providerMessage ? `: ${providerMessage}` : ''}`),
    {
      status: resp.status,
      reasonCode: hapiFailureReason(resp.status, providerMessage),
    },
  );
}

async function fetchHapiRows({
  fetchFn,
  nowMs,
  countryCode,
  adminLevel,
}) {
  const records = [];
  let fullyRead = false;
  for (let page = 0; page < HAPI_MAX_PAGES; page += 1) {
    const offset = page * HAPI_PAGE_LIMIT;
    const resp = await fetchFn(
      buildHapiConflictEventsUrl({ nowMs, offset, countryCode, adminLevel }),
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': CHROME_UA,
          'X-HDX-HAPI-APP-IDENTIFIER': HAPI_APP_IDENTIFIER,
        },
        signal: AbortSignal.timeout(HAPI_REQUEST_TIMEOUT_MS),
      },
    );
    if (!resp.ok) {
      throw await hapiResponseError(resp);
    }

    const rawData = await resp.json();
    const pageRows = Array.isArray(rawData?.data) ? rawData.data : [];
    records.push(...pageRows);
    if (pageRows.length < HAPI_PAGE_LIMIT) {
      fullyRead = true;
      break;
    }
  }

  if (!fullyRead) {
    throw new Error(
      `${countryCode || 'global'} bulk response exceeded ${HAPI_MAX_PAGES * HAPI_PAGE_LIMIT} rows`,
    );
  }
  return records;
}

export async function fetchAllHumanitarianSummaries({
  fetchFn = (...args) => globalThis.fetch(...args),
  now = Date.now,
  pace = sleep,
  countryCodes = HAPI_COUNTRIES,
  requiredCountryCodes = countryCodes === HAPI_COUNTRIES ? HAPI_REQUIRED_COUNTRIES : countryCodes,
  loadPreviousMarker = () => readSeedSnapshot(HAPI_CACHE_KEY_PREFIX),
  loadFailureBackoff = () => readSeedSnapshot(HAPI_FAILURE_BACKOFF_KEY),
  snapshotFetchFn = (...args) => globalThis.fetch(...args),
  writeFailureBackoff = (value) => writeExtraKey(
    HAPI_FAILURE_BACKOFF_KEY,
    value,
    Math.ceil(HAPI_FAILURE_BACKOFF_MS / 1000),
  ),
  writeFailureMeta = (value) => writeExtraKey(
    HAPI_SEED_META_KEY,
    value,
    HAPI_SEED_META_TTL_SECONDS,
  ),
  preserveLastGood = defaultPreserveHapiLastGood,
} = {}) {
  const nowMs = now();
  const failureBackoff = await loadFailureBackoff().catch((error) => {
    console.warn(`  HAPI backoff read failed: ${error.message}`);
    return null;
  });
  if (Number(failureBackoff?.retryAt) > nowMs) {
    console.log(`  Humanitarian: provider backoff active until ${new Date(failureBackoff.retryAt).toISOString()}`);
    return null;
  }

  const previousMarker = await loadPreviousMarker().catch((error) => {
    console.warn(`  HAPI freshness marker read failed: ${error.message}`);
    return null;
  });
  if (
    Number.isFinite(Number(previousMarker?.updatedAt))
    && nowMs - Number(previousMarker.updatedAt) < HAPI_REFRESH_INTERVAL_MS
  ) {
    console.log(`  Humanitarian: recent bulk snapshot still fresh (${Object.keys(previousMarker).length > 0 ? previousMarker.countriesCovered ?? 'unknown' : 'unknown'} countries)`);
    return null;
  }

  let useSnapshot = false;
  let snapshotTriggerFailure = null;
  let snapshotRowsPromise;
  const loadSnapshotRows = () => {
    if (!snapshotRowsPromise) {
      snapshotRowsPromise = fetchHapiHdxSnapshotRows({
        fetchFn: snapshotFetchFn,
        nowMs,
        countryCodes,
      });
    }
    return snapshotRowsPromise;
  };
  const fetchRowsFromSnapshot = async ({ countryCode, adminLevel }) => {
    try {
      const snapshotRows = await loadSnapshotRows();
      return snapshotRows.filter((row) => {
        const rowCountryCode = hapiCountryCodeForIso3(row?.location_code);
        if (countryCode && rowCountryCode !== countryCode) return false;
        if (adminLevel != null && String(row?.admin_level ?? '0') !== String(adminLevel)) {
          return false;
        }
        return true;
      });
    } catch (snapshotFailure) {
      const snapshotFailureReason = hapiHdxFailureReason(snapshotFailure);
      throw Object.assign(
        new Error(
          `HAPI HDX snapshot fallback failed after direct bot detection: ${snapshotFailureReason}`,
        ),
        {
          status: Number.isFinite(Number(snapshotFailure?.status))
            ? Number(snapshotFailure.status)
            : Number(snapshotTriggerFailure?.status),
          reasonCode: 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED',
          directFailureReason: snapshotTriggerFailure?.reasonCode ?? 'HAPI_BOT_BLOCK',
          snapshotFailureReason,
        },
      );
    }
  };
  const fetchRows = async (options) => {
    if (useSnapshot) {
      return fetchRowsFromSnapshot(options);
    }
    try {
      return await fetchHapiRows({ ...options, fetchFn });
    } catch (directFailure) {
      if (directFailure?.reasonCode !== 'HAPI_BOT_BLOCK') throw directFailure;

      useSnapshot = true;
      snapshotTriggerFailure = directFailure;
      console.warn('  HAPI direct request hit provider bot detection — loading official HDX snapshot');
      return fetchRowsFromSnapshot(options);
    }
  };

  let failure;
  try {
    // Most countries have national rows, so one global admin-0 request covers
    // them without the old per-country fan-out.
    const nationalRows = await fetchRows({
      nowMs,
      adminLevel: '0',
    });
    const results = aggregateHapiConflictEvents(nationalRows, { nowMs, countryCodes });

    // HRP/GHO countries may only publish subnational rows. Fetch only the
    // national-missing target countries and aggregate their deepest available
    // administrative level, pacing the bounded fallback sequentially.
    const missingCountries = requiredCountryCodes.filter((countryCode) => !results[countryCode]);
    let fallbackFailure = null;
    let fallbackRows = 0;
    for (let i = 0; i < missingCountries.length; i += 1) {
      const countryCode = missingCountries[i];
      try {
        const rows = await fetchRows({
          nowMs,
          countryCode,
          adminLevel: null,
        });
        fallbackRows += rows.length;
        Object.assign(
          results,
          aggregateHapiConflictEvents(rows, { nowMs, countryCodes: [countryCode] }),
        );
      } catch (error) {
        fallbackFailure = error;
        console.warn(`  HAPI ${countryCode} fallback failed: ${error.message}`);
        if (error.reasonCode === 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED') throw error;
        if (error.status === 429 || error.status === 403) break;
      }
      if (i < missingCountries.length - 1 && !useSnapshot) {
        await pace(HAPI_REQUEST_DELAY_MS);
      }
    }

    if (Object.keys(results).length === 0) {
      // Carry the fallback's status (e.g. 429/403) onto the thrown error so the
      // outer catch's backoff write below records the real provider status
      // instead of falling back to 0 when a fallback rejection is what left
      // results empty.
      throw Object.assign(
        new Error('bulk response contained no target-country national summaries'),
        fallbackFailure
          ? {
              ...(fallbackFailure.status != null ? { status: fallbackFailure.status } : {}),
              ...(fallbackFailure.reasonCode ? { reasonCode: fallbackFailure.reasonCode } : {}),
              ...(fallbackFailure.directFailureReason
                ? { directFailureReason: fallbackFailure.directFailureReason }
                : {}),
              ...(fallbackFailure.snapshotFailureReason
                ? { snapshotFailureReason: fallbackFailure.snapshotFailureReason }
                : {}),
            }
          : {},
      );
    }

    if (fallbackFailure) {
      const retryAt = nowMs + HAPI_FAILURE_BACKOFF_MS;
      await writeFailureBackoff({
        status: Number.isFinite(Number(fallbackFailure.status)) ? Number(fallbackFailure.status) : 0,
        reasonCode: fallbackFailure.reasonCode ?? 'HAPI_FETCH_FAILED',
        failedAt: nowMs,
        retryAt,
      }).catch((error) => console.warn(`  HAPI backoff write failed: ${error.message}`));
      await preserveLastGood().catch((error) => console.warn(`  HAPI last-good preservation failed: ${error.message}`));
    }

    const requiredCovered = requiredCountryCodes.filter((countryCode) => results[countryCode]).length;
    console.log(`  Humanitarian: ${Object.keys(results).length}/${countryCodes.length} countries (${requiredCovered}/${requiredCountryCodes.length} required) from ${nationalRows.length + fallbackRows} bulk rows`);
    return results;
  } catch (error) {
    failure = error;
  }

  const retryAt = nowMs + HAPI_FAILURE_BACKOFF_MS;
  const reasonCode = failure?.reasonCode ?? 'HAPI_FETCH_FAILED';
  console.warn(`  HAPI bulk failed: ${failure.message} — preserving last-good data and backing off until ${new Date(retryAt).toISOString()}`);
  await writeFailureMeta({
    fetchedAt: nowMs,
    recordCount: Number(previousMarker?.requiredCountriesCovered) || 0,
    status: 'error',
    errorReason: reasonCode,
    failedAt: nowMs,
    ...(Number.isFinite(Number(previousMarker?.updatedAt))
      ? { lastSuccessAt: Number(previousMarker.updatedAt) }
      : {}),
    ...(failure?.directFailureReason
      ? { directFailureReason: failure.directFailureReason }
      : {}),
    ...(failure?.snapshotFailureReason
      ? { snapshotFailureReason: failure.snapshotFailureReason }
      : {}),
  }).catch((error) => console.warn(`  HAPI failure health write failed: ${error.message}`));
  await writeFailureBackoff({
    status: Number.isFinite(Number(failure.status)) ? Number(failure.status) : 0,
    reasonCode,
    failedAt: nowMs,
    retryAt,
  }).catch((error) => console.warn(`  HAPI backoff write failed: ${error.message}`));
  await preserveLastGood().catch((error) => console.warn(`  HAPI last-good preservation failed: ${error.message}`));
  return null;
}

// ─── PizzINT Status ───

async function fetchPizzintStatus() {
  const resp = await fetch('https://www.pizzint.watch/api/dashboard-data', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const raw = await resp.json();
  if (!raw.success || !raw.data) return null;

  const locations = raw.data.map(d => ({
    placeId: d.place_id, name: d.name, address: d.address,
    currentPopularity: d.current_popularity,
    percentageOfUsual: d.percentage_of_usual ?? 0,
    isSpike: d.is_spike, spikeMagnitude: d.spike_magnitude ?? 0,
    dataSource: d.data_source, recordedAt: d.recorded_at,
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: d.is_closed_now ?? false, lat: d.lat ?? 0, lng: d.lng ?? 0,
  }));

  const open = locations.filter(l => !l.isClosedNow);
  const spikes = locations.filter(l => l.isSpike).length;
  const avgPop = open.length > 0 ? open.reduce((s, l) => s + l.currentPopularity, 0) / open.length : 0;
  const adjusted = Math.min(100, avgPop + spikes * 10);
  let defconLevel = 5, defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  const hasFresh = locations.some(l => l.dataFreshness === 'DATA_FRESHNESS_FRESH');
  const pizzint = {
    defconLevel, defconLabel, aggregateActivity: Math.round(avgPop),
    activeSpikes: spikes, locationsMonitored: locations.length, locationsOpen: open.length,
    updatedAt: Date.now(),
    dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    locations,
  };

  console.log(`  PizzINT: DEFCON ${defconLevel}, ${locations.length} locations, ${spikes} spikes`);
  return pizzint;
}

async function fetchGdeltTensions() {
  const pairs = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';
  const resp = await fetch(`https://www.pizzint.watch/api/gdelt/batch?pairs=${encodeURIComponent(pairs)}&method=gpr`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const raw = await resp.json();
  return Object.entries(raw).map(([pairKey, dataPoints]) => {
    const countries = pairKey.split('_');
    const latest = dataPoints[dataPoints.length - 1];
    const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
    const change = prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
    return {
      id: pairKey, countries, label: countries.map(c => c.toUpperCase()).join(' - '),
      score: latest?.v ?? 0,
      trend: change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE',
      changePercent: Math.round(change * 10) / 10, region: 'global',
    };
  });
}

// ─── Main ───

// runSeed invokes this as `fetchFn()` with no arguments, so the injected dep is for tests
// only — the GDELT fallback reaches its proxy through a `curl` child process, which no
// global-fetch stub can intercept, so it must be injectable to keep tests hermetic.
export async function fetchAll({
  fetchGdeltFallback = readMaterializedGdeltConflictEvents,
} = {}) {
  // #5140: anchor the GDELT-fallback sweep cutoff at the START of the fetch phase,
  // not at sweep entry — the aux feeds below and the sweep share runSeed's
  // single fetch deadline, so time the aux stage burns must come out of the
  // sweep's window, not be added to it. HAPI is now one bulk request plus only
  // bounded missing-country fallbacks rather than a 38-country sweep.
  const sweepDeadlineAt = Date.now() + GDELT_SWEEP_BUDGET_MS;
  const [acled, acledResolution, hapi, pizzint, gdelt] = await Promise.allSettled([
    fetchAcledEvents({ label: 'ACLED display' }),
    fetchAcledEvents({
      lookbackDays: ACLED_RESOLUTION_LOOKBACK_DAYS,
      limit: ACLED_RESOLUTION_PAGE_LIMIT,
      paginated: true,
      maxPages: ACLED_RESOLUTION_MAX_PAGES,
      label: 'ACLED resolution',
    }),
    fetchAllHumanitarianSummaries(),
    fetchPizzintStatus(),
    fetchGdeltTensions(),
  ]);

  const ac = acled.status === 'fulfilled' ? acled.value : null;
  const acResolution = acledResolution.status === 'fulfilled' ? acledResolution.value : null;
  const ha = hapi.status === 'fulfilled' ? hapi.value : null;
  const pi = pizzint.status === 'fulfilled' ? pizzint.value : null;
  const gd = gdelt.status === 'fulfilled' ? gdelt.value : null;

  if (acled.status === 'rejected') console.warn(`  ACLED failed: ${acled.reason?.message || acled.reason}`);
  if (acledResolution.status === 'rejected') console.warn(`  ACLED resolution failed: ${acledResolution.reason?.message || acledResolution.reason}`);
  if (hapi.status === 'rejected') console.warn(`  HAPI failed: ${hapi.reason?.message || hapi.reason}`);
  if (pizzint.status === 'rejected') console.warn(`  PizzINT failed: ${pizzint.reason?.message || pizzint.reason}`);
  if (gdelt.status === 'rejected') console.warn(`  GDELT failed: ${gdelt.reason?.message || gdelt.reason}`);

  // Write secondary keys BEFORE returning or failing the primary feed
  // (runSeed calls process.exit after primary write).
  if (ha && Object.keys(ha).length > 0) {
    for (const [cc, data] of Object.entries(ha)) await writeExtraKeyWithMeta(`${HAPI_CACHE_KEY_PREFIX}:${cc}`, data, HAPI_TTL, 1);
    // Aggregate marker for api/health.js — STANDALONE_KEYS.humanitarianSummary STRLENs
    // this exact bare key (no country suffix) and SEED_META.humanitarianSummary reads
    // its seed-meta; the per-country writes above don't give either check anything to
    // read (they're all suffixed :<CC>, and writeExtraKeyWithMeta's auto-derived
    // seed-meta keys for them are per-country too, not one family-wide pointer).
    // Guarded on ha having entries, same as the per-country loop above: a run where
    // EVERY HAPI call failed has nothing new to report, and attempting this write
    // anyway would add a fresh network call (and crash risk if Redis is ALSO
    // degraded) to a path that previously did nothing at all in that scenario —
    // staleness still surfaces naturally once the last real marker's TTL/maxStaleMin
    // window elapses, no need to force a write here.
    const requiredCountriesCovered = HAPI_REQUIRED_COUNTRIES.filter((countryCode) => ha[countryCode]).length;
    await writeExtraKeyWithMeta(
      HAPI_CACHE_KEY_PREFIX,
      {
        countriesCovered: Object.keys(ha).length,
        requiredCountriesCovered,
        requiredCountriesTotal: HAPI_REQUIRED_COUNTRIES.length,
        updatedAt: Date.now(),
      },
      HAPI_SEED_META_TTL_SECONDS,
      requiredCountriesCovered,
      HAPI_SEED_META_KEY,
      HAPI_SEED_META_TTL_SECONDS,
    );
  }
  if (acResolution?.events?.length) {
    await writeExtraKeyWithMeta(
      ACLED_RESOLUTION_CACHE_KEY,
      { events: acResolution.events, clusters: [], pagination: acResolution.pagination },
      ACLED_TTL,
      acResolution.events.length,
    );
  }
  if (pi) await writeExtraKeyWithMeta('intel:pizzint:v1:base', { pizzint: pi, tensionPairs: [] }, PIZZINT_TTL, pi.locationsMonitored ?? 0);
  if (pi && gd) await writeExtraKeyWithMeta('intel:pizzint:v1:gdelt', { pizzint: pi, tensionPairs: gd }, PIZZINT_TTL, gd.length ?? 0);

  if (!ac) {
    // ACLED credentials are optional. When NONE are configured (fetchAcledEvents
    // returned null → fulfilled), the seed runs in its long-standing auxiliary-only
    // mode (#1651/#2288): the auxiliary conflict/intel feeds above are already
    // published, so return an empty ACLED payload and exit 0 rather than crashing
    // every cron tick. We only refuse to let auxiliary feeds mask the PRIMARY feed
    // when ACLED credentials ARE present but the display fetch failed (#5106).
    const missingCredentials = acled.status === 'fulfilled';
    if (missingCredentials) {
      // No ACLED credentials → fall back to GDELT (bulk event export primary, DOC
      // article-volume sweep as emergency fallback — #5849) so the conflict
      // escalation EMA keeps a near-real-time signal (#5099). This runs only
      // on the no-creds path: a credentialed-but-failed fetch still throws below, and a
      // credentialed-but-empty ACLED result is trusted (returns `ac`) rather than
      // overwritten by GDELT volume.
      const gdeltEvents = await fetchGdeltFallback({ deadlineAt: sweepDeadlineAt }).catch((e) => {
        // Outages degrade to sourceUnavailable below; our own defects must
        // escape to runSeed and fail attributably (#5855 review).
        if (isProgrammingDefect(e)) throw e;
        console.warn(`  GDELT conflict-events fallback failed: ${e.message}`);
        return null;
      });
      if (gdeltEvents?.events?.length) return gdeltEvents;
      // #5256: we have NO usable primary source this tick — ACLED is unconfigured and the
      // only fallback errored (fetchGdeltConflictEvents throws on floor-miss/zero/bulk
      // failure; it never resolves to a legitimate empty). Say so explicitly.
      //
      // Returning a bare `{ events: [] }` here laundered an upstream OUTAGE into a
      // "0 records" result, which runSeed reads as contract RETRY -> and once the
      // last-good keys had expired, #5258's guard exited 1. With no source configured no
      // retry can ever fix that, so it crash-looped every tick forever while /api/health
      // already reported acledIntel EMPTY. sourceUnavailable tells runSeed to publish
      // nothing (an empty envelope would wipe last-good the moment GDELT merely blips)
      // and exit 0, leaving the data alarm to health where it belongs.
      console.warn('  ACLED: no credentials + GDELT fallback unavailable — no usable conflict source; publishing auxiliary feeds only, primary feed left untouched (health reports acledIntel EMPTY)');
      return { events: [], pagination: undefined, sourceUnavailable: true };
    }
    const reason = acled.reason?.message || acled.reason;
    const err = new Error(
      `ACLED display fetch failed for ${ACLED_CACHE_KEY}; refusing to let auxiliary conflict/intel feeds mask the primary feed (${reason})`,
    );
    if (acled.reason?.nonRetryable) err.nonRetryable = true;
    throw err;
  }

  return ac;
}

function validate(data) {
  return data != null && Array.isArray(data.events);
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

/**
 * Project published ACLED events into intel-history records (#5694). ACLED
 * carries no prose headline, so the title is composed from the structured
 * fields the payload retains; `country` arrives as a display name and is
 * mapped to ISO2 for the history store's filterable country field.
 */
export function buildConflictHistoryRecords(data) {
  return (data?.events ?? []).map((event) => {
    if (!event?.id || !Number.isFinite(event?.occurredAt)) return null;
    const place = [event.admin1, event.country].filter(Boolean).join(', ');
    const actors = Array.isArray(event.actors) ? event.actors.filter(Boolean).slice(0, 2) : [];
    const structuredTitle = [
      event.eventType || 'Conflict event',
      actors.length > 0 ? actors.join(' vs ') : null,
      place ? `in ${place}` : null,
    ].filter(Boolean).join(' — ');
    // GDELT article events carry an upstream headline; retain it for a useful,
    // searchable history record while ACLED keeps its structured fallback.
    const title = typeof event.title === 'string' && event.title.trim()
      ? event.title.trim()
      : structuredTitle;
    const summaryBits = [];
    if (Number.isFinite(event.fatalities)) summaryBits.push(`fatalities: ${event.fatalities}`);
    if (event.source) summaryBits.push(`source: ${event.source}`);
    return {
      dedupeKey: `conflict:acled-intel:${event.id}`,
      country: resolveIso2({ name: event.country }) ?? undefined,
      category: event.eventType || undefined,
      title,
      summary: summaryBits.length > 0 ? summaryBits.join('; ') : undefined,
      sourceUrl: event.url || undefined,
      occurredAt: event.occurredAt,
    };
  }).filter(Boolean);
}

export const conflictIntelAfterPublish = makeSeedHistoryAfterPublish({
  domain: 'conflict',
  resource: 'acled-intel',
  buildRecords: buildConflictHistoryRecords,
});

if (process.argv[1]?.endsWith('seed-conflict-intel.mjs')) {
  runSeed('conflict', 'acled-intel', ACLED_CACHE_KEY, fetchAll, {
    validateFn: validate,
    lockTtlMs: ACLED_INTEL_LOCK_TTL_MS,
    ttlSeconds: ACLED_TTL,
    sourceVersion: 'acled-hapi-pizzint',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 38,
    afterPublish: conflictIntelAfterPublish,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
