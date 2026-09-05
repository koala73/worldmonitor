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
  writeExtraKeyWithMetaAtomically,
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
// The two channels HAPI publishes this table through, recorded on every seed so
// a number is always attributable to the route that produced it (#7658). They
// are NOT interchangeable: see the divergence note at the channel latch in
// fetchAllHumanitarianSummaries.
export const HAPI_SNAPSHOT_CHANNEL = 'hdx-snapshot';
export const HAPI_API_CHANNEL = 'hapi-api';
// HAPI publishes this ACLED-derived table weekly. The conflict seeder runs every
// 15 minutes for its other feeds, so a freshness gate prevents that unrelated
// cadence from repeatedly hitting HAPI. The 2h interval remains comfortably
// inside the 5h health threshold and 6h per-country data TTL.
export const HAPI_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
// #7658: a run that had to DEMOTE off the authoritative snapshot is not worth
// pinning for two hours. It publishes the JSON API's trailing month, which runs
// ~23% below the snapshot's, so holding it that long turns one transient HDX
// blip into 8 cron ticks of the lagging vintage and a ~30% discontinuity when
// the snapshot returns. Retry the authoritative channel on the next tick
// instead. This cannot become a retry storm: the expensive failure mode (a
// snapshot that fails SLOWLY) never demotes at all — it fails closed and writes
// the 2h HAPI_FAILURE_BACKOFF_MS — so everything reaching this interval failed
// fast and costs one cheap rejected request per tick.
export const HAPI_DEMOTED_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const HAPI_FAILURE_BACKOFF_MS = 2 * 60 * 60 * 1000;
const HAPI_FAILURE_BACKOFF_KEY = 'conflict:humanitarian:hapi-backoff:v1';
const HAPI_REQUEST_TIMEOUT_MS = 15_000;
const HAPI_REQUEST_DELAY_MS = 1_100;
// #7656: wall-clock budget for HAPI's discretionary network work, in the same
// "a request may not LAUNCH after the cutoff" shape as GDELT_SWEEP_BUDGET_MS.
// It gates demotion after a slow snapshot failure and every JSON API page launch.
// The API deadline is re-anchored at demotion, so a slow-failing snapshot cannot
// spend the fallback's whole window before it starts.
// Without a budget at all the two global sweeps (each ≤ HAPI_MAX_PAGES ×
// HAPI_REQUEST_TIMEOUT_MS = 75s) could be followed by 23 sequential per-country
// requests — 23 × 15s plus 22 × 1.1s pacing ≈ 369s — for a 519s route, well past
// the 315s envelope the whole fetch-deadline model is anchored on.
// Re-derived worst cases: the snapshot route pays 60s metadata + up to two 120s
// annual downloads = 300s and issues no HAPI request at all; the demoted route
// pays at most 140s before the demotion may launch, then every API page shares
// the re-anchored 140s window. One in-flight page may drain after the cutoff:
// 140s + 140s + 15s = 295s.
// seed-fetch-deadline-budget-invariants asserts both against the 315s envelope
// directly, so raising this constant past 150s still fails there.
export const HAPI_FALLBACK_BUDGET_MS = 140_000;
const PIZZINT_TTL = 600;

export const CONFLICT_COUNTRIES = [
  'AF', 'SY', 'UA', 'SD', 'SS', 'SO', 'CD', 'MM', 'YE', 'ET',
  'IQ', 'PS', 'LY', 'ML', 'BF', 'NE', 'NG', 'CM', 'MZ', 'HT',
];
export const GDELT_MIN_SUCCESSFUL_COUNTRIES = Math.ceil(CONFLICT_COUNTRIES.length * 0.8);
// DERIVED from the crisis-tracker registry, never hand-listed. This used to be a
// hardcoded duplicate of shared/crawlable-crises.json's coverage codes with nothing
// pinning the two together, so adding a tracker shipped a public /crises/<slug> page
// whose country the seeder never requested — a page that fails closed forever with no
// test, no alarm and no drift signal. Reading the registry makes it the single source.
export const HAPI_CRISIS_COUNTRIES = [
  ...new Set(
    (loadSharedConfig('crawlable-crises.json') || [])
      .flatMap((crisis) => (Array.isArray(crisis?.coverage) ? crisis.coverage : []))
      .map((entry) => String(entry?.code || '').toUpperCase())
      .filter(Boolean),
  ),
].sort();
// Registry countries HAPI must cover that CONFLICT_COUNTRIES doesn't already include.
// Kept as a SEPARATE list, not merged into CONFLICT_COUNTRIES — that array also sizes
// GDELT_MIN_SUCCESSFUL_COUNTRIES and the GDELT sweep threshold below; growing it here
// would silently shift GDELT's coverage floor and break its fixed-count tests
// (#5554 — a prior fix attempt did exactly this).
const HAPI_ONLY_COUNTRIES = HAPI_CRISIS_COUNTRIES.filter(
  (countryCode) => !CONFLICT_COUNTRIES.includes(countryCode),
);
// The dashboard's country-tension widget (src/services/conflict/index.ts
// HAPI_COUNTRY_CODES) requests this 20-country watchlist. Before this fix, a cache
// miss fell back to a live HAPI fetch, so incomplete seed coverage was invisible;
// the RPC handlers are now cache-only (#5554 review), so every widget country is
// part of the guaranteed coverage contract. Keep the complete list in sync with
// that file rather than listing only the countries unique to the dashboard.
export const HAPI_DASHBOARD_COUNTRIES = [
  'US', 'RU', 'CN', 'UA', 'IR', 'IL', 'TW', 'KP', 'SA', 'TR',
  'PL', 'DE', 'FR', 'GB', 'IN', 'PK', 'SY', 'YE', 'MM', 'VE',
];
// Public crisis trackers and the dashboard batch are the guaranteed coverage
// contract. The broader conflict set is still collected opportunistically from the
// same two bulk sweeps. api/health.js's humanitarianSummary minRecordCount tracks
// this length — tests/seed-conflict-intel-hapi-circuit-breaker pins the pair.
export const HAPI_REQUIRED_COUNTRIES = [
  ...new Set([...HAPI_CRISIS_COUNTRIES, ...HAPI_DASHBOARD_COUNTRIES]),
];
// countryCodes filters the aggregation, so a registry code absent here would be
// fetched by the sweeps below and then silently discarded. HAPI_ONLY_COUNTRIES is what
// carries every crisis-registry code into this list; that link is asserted by test.
export const HAPI_COUNTRIES = [...new Set([...HAPI_ONLY_COUNTRIES, ...HAPI_DASHBOARD_COUNTRIES, ...CONFLICT_COUNTRIES])];
// The bounded transport emits stable route-specific failure codes. Treat the
// failures known to implicate the selected route as a run-scoped circuit
// signal; repeating them for another country cannot improve source reachability.
const GDELT_ROUTE_FAILURE = /\bGDELT_(?:SOURCE_PROXY|SHARED_PROXY|PROXY|DIRECT)_(?:CONFIG|HTTP_(?:401|403|404|406|407|408|410|429|451|5\d\d)|INVALID_JSON|TLS|TIMEOUT|DNS|TRANSPORT)\b|\bHTTP 429\b|SSL_ERROR_SYSCALL|\b(?:timed?\s*out|timeout)\b/i;
// #5140: the GDELT fallback sweep may not LAUNCH a batch after this much of the
// fetch phase has elapsed (fetchAll anchors the clock at its own entry and passes
// an absolute deadline down, so slow aux feeds automatically shrink the sweep
// window instead of stacking on top of it). HAPI now serves both global sweeps
// from the authoritative HDX snapshot and demotes to two bounded global API
// sweeps only when that snapshot fails inside HAPI_FALLBACK_BUDGET_MS (#7658),
// instead of the old 38-country sequential sweep. One
// in-flight batch may still drain past the cutoff: ≤~100s at the knobs below
// (either 15s concurrent direct legs when no proxy is configured, or 4 × 20s
// SERIALIZED sync proxy curls — curlFetch is execFileSync, so "concurrent"
// proxy attempts block the event loop one at a time). Worst single fetchAll attempt before the bulk
// fallback is now dominated by the GDELT path. Without this cap a
// GDELT brownout ran 5 batches ≈ 375s+ → deadline breach → exit 75 every tick.
// HAPI's two global sweeps (admin-0 then admin-2) run inside the parallel
// auxiliary stage, not after the sweep, and re-derive as follows. Primary route
// (#7658 — the authoritative HDX snapshot): 60s metadata plus, only at the
// January boundary, at most two 120s annual downloads = 300s, and the sweeps
// then cost NOTHING because that ONE memoized snapshot serves both of them and
// the fallback by filtering rows already in memory. Demoted route (snapshot
// failed and HAPI_FALLBACK_BUDGET_MS still had room, so the JSON API takes
// over): the demotion may not start later than 140s, each sweep costs at most
// HAPI_MAX_PAGES(5) × HAPI_REQUEST_TIMEOUT_MS(15s) = 75s, and the per-country
// fan-out re-anchors its launch window at the demotion, so post-demotion the
// sweeps and the fan-out SHARE that window rather than stacking on it — 140s +
// max(150s sweeps, 140s budget + one 15s in-flight request) = 295s. Both stay
// inside the ≤315s envelope this model is anchored on; without the demotion gate
// a slow snapshot failure would have stacked 300s + 150s + 15s = 465s (#7656 is
// the same lesson for the fan-out: unbounded it was 150s + 369s = 519s).
// Both remain under ACLED_INTEL_LOCK_TTL_MS's 540s fetch deadline
// (lockTtlMs+120s) below. What this replaced was a fan-out paid on EVERY run —
// 6 missing countries ≈ 97s, and ≈290s once the 13 HRP countries that publish
// only admin-2 rows were added to the required set (re-verified #5554 review;
// HAPI_COUNTRIES is 38).
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
// just auth. It is still sent on every JSON API request, but that API is now the
// FALLBACK route, not the preferred one (#7658): HAPI bot-blocks both Railway's
// direct egress and the configured residential proxy, and its trailing-month
// numbers lag the official annual CSV snapshot on HDX that the block used to
// divert us to. The snapshot is therefore the primary channel and the API is
// what a snapshot outage falls back to. This seeder is the only source of HAPI
// traffic; the RPC handlers only read the Redis keys it writes, and the
// freshness gate permits one JSON API attempt at most every two hours. A seed
// that had to demote retries the SNAPSHOT every 15 minutes to reclaim the
// authoritative channel sooner, but that shortened pin deliberately does not
// speed up the API: while HDX stays down the demoted rows are preserved rather
// than re-swept (see demotedVintageStillFresh).
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
  readElapsedMs,
  deadlineAtMs,
}) {
  const records = [];
  let fullyRead = false;
  for (let page = 0; page < HAPI_MAX_PAGES; page += 1) {
    if (readElapsedMs() >= deadlineAtMs) {
      throw Object.assign(
        new Error(`${countryCode || 'global'} bulk response reached the HAPI fallback deadline`),
        { reasonCode: 'HAPI_FALLBACK_BUDGET_EXHAUSTED' },
      );
    }
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
  // `now` is the DATA clock — tests pin it to a fixed date so request URLs and
  // reference periods stay stable — so elapsed time needs its own reader. It
  // defaults to the MONOTONIC clock rather than Date.now: a mid-run NTP step
  // must not hand the fan-out below a budget it has not actually spent.
  readElapsedMs = () => performance.now(),
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
  const startedAtMs = readElapsedMs();
  const previousMarker = await loadPreviousMarker().catch((error) => {
    console.warn(`  HAPI freshness marker read failed: ${error.message}`);
    return null;
  });
  const failureBackoff = await loadFailureBackoff().catch((error) => {
    console.warn(`  HAPI backoff read failed: ${error.message}`);
    return null;
  });
  const apiBackoffActive = Number(failureBackoff?.retryAt) > nowMs;
  // A seed that came from the demoted channel earns a much shorter pin — see
  // HAPI_DEMOTED_REFRESH_INTERVAL_MS. Recording the channel and then not acting
  // on it would leave this fix's whole invariant (consecutive ticks are
  // comparable) unenforced.
  const previousMarkerAgeMs = nowMs - Number(previousMarker?.updatedAt);
  const previousWasDemoted = previousMarker?.sourceChannel === HAPI_API_CHANNEL;
  const nextSnapshotRetryAt = Number(previousMarker?.nextSnapshotRetryAt);
  const demotedSnapshotRetryDue = previousWasDemoted && (
    Number.isFinite(nextSnapshotRetryAt)
      ? nowMs >= nextSnapshotRetryAt
      : previousMarkerAgeMs >= HAPI_DEMOTED_REFRESH_INTERVAL_MS
  );
  // The shortened pin buys a cheap SNAPSHOT retry, not a cheap API refresh. If
  // the snapshot is still down below, the JSON API rows this tick would fetch
  // are the ones already published less than HAPI_REFRESH_INTERVAL_MS ago, so
  // re-sweeping for them costs two global requests per tick — 8x the designed
  // cadence — on the shared app_identifier that #5554 got throttled for exactly
  // that kind of burst, and a resulting 429 takes BOTH channels dark.
  const demotedVintageStillFresh = previousWasDemoted
    && Number.isFinite(previousMarkerAgeMs)
    && previousMarkerAgeMs < HAPI_REFRESH_INTERVAL_MS;
  const requiredCountryContract = [...requiredCountryCodes].sort();
  if (
    Number.isFinite(Number(previousMarker?.updatedAt))
    && (previousWasDemoted
      ? !demotedSnapshotRetryDue
      : previousMarkerAgeMs < HAPI_REFRESH_INTERVAL_MS)
    && Number(previousMarker?.requiredCountriesTotal) === requiredCountryCodes.length
    && Number(previousMarker?.requiredCountriesCovered) >= requiredCountryCodes.length
    && Array.isArray(previousMarker?.requiredCountryCodes)
    && previousMarker.requiredCountryCodes.length === requiredCountryContract.length
    && [...previousMarker.requiredCountryCodes]
      .sort()
      .every((countryCode, index) => countryCode === requiredCountryContract[index])
  ) {
    console.log(`  Humanitarian: recent bulk snapshot still fresh (${Object.keys(previousMarker).length > 0 ? previousMarker.countriesCovered ?? 'unknown' : 'unknown'} countries)`);
    return null;
  }
  if (apiBackoffActive && !demotedSnapshotRetryDue) {
    console.log(`  Humanitarian: provider backoff active until ${new Date(failureBackoff.retryAt).toISOString()}`);
    return null;
  }

  // #7658: the channel is chosen HERE, once, before any row is aggregated —
  // never by whether the provider happened to bot-block this tick. Measured
  // 2026-09-04 across every 2026 reference period at admin-0: the two channels
  // agree to within 0.1% for closed months, but for the TRAILING month (the one
  // this seeder publishes) the JSON API was 13,815 events against the snapshot's
  // 17,874 — 103 countries lower, ZERO higher. Same resource_hdx_ids, same row
  // counts, so it is one dataset at two vintages and the API is the one that
  // lags. Latching the snapshot as primary makes consecutive ticks comparable
  // and keeps the route that Railway can actually reach (HAPI bot-blocks its
  // egress, #5713/#5769/#5772) on the happy path instead of the rescue path.
  let sourceChannel = HAPI_SNAPSHOT_CHANNEL;
  let snapshotFailureReason = null;
  // docs/solutions/design-patterns/primary-fallback-inversion-budget-transfer.md,
  // filed against THIS module: inverting a primary/fallback order silently hands
  // the demoted path's shared time budget to the new primary, so a SLOW (not
  // down) primary permanently disables the emergency fallback — the exact
  // insurance it exists to provide. Anchored at entry while the snapshot is
  // serving, where it bounds nothing (those iterations filter rows already in
  // memory and issue no request), and re-anchored at the MOMENT OF DEMOTION so
  // the JSON API route gets the same window it had back when it was primary.
  // Demotion may not happen after HAPI_FALLBACK_BUDGET_MS. After it happens,
  // every JSON API page shares one re-anchored deadline. One in-flight 15s page
  // can drain after the cutoff, so the demoted worst case is 140s + 140s + 15s
  // = 295s, inside the 315s envelope.
  let fallbackDeadlineAtMs = startedAtMs + HAPI_FALLBACK_BUDGET_MS;
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
    const snapshotRows = await loadSnapshotRows();
    return snapshotRows.filter((row) => {
      const rowCountryCode = hapiCountryCodeForIso3(row?.location_code);
      if (countryCode && rowCountryCode !== countryCode) return false;
      if (adminLevel != null && String(row?.admin_level ?? '0') !== String(adminLevel)) {
        return false;
      }
      return true;
    });
  };

  const fetchRows = async (options) => (
    sourceChannel === HAPI_SNAPSHOT_CHANNEL
      ? fetchRowsFromSnapshot(options)
      : fetchHapiRows({
          ...options,
          fetchFn,
          readElapsedMs,
          deadlineAtMs: fallbackDeadlineAtMs,
        })
  );
  // Every thrown failure carries the channel that produced it, plus the reason
  // the primary channel was abandoned when it was, so seed-meta can say WHY a
  // tick published from the lagging route.
  const withChannelProvenance = (error) => Object.assign(error, {
    sourceChannel,
    ...(snapshotFailureReason ? { snapshotFailureReason } : {}),
  });

  let failure;
  try {
    // Resolving the snapshot up front is what keeps a run SINGLE-channel: the
    // download is memoized either way, so paying for it here costs nothing extra
    // and means no sweep can ever be served by a different vintage than the one
    // before it. A snapshot outage demotes the whole run to the JSON API, whose
    // failures then flow through the existing per-sweep degradation below rather
    // than through a second, differently-shaped abort path.
    try {
      const snapshotRows = await loadSnapshotRows();
      // A snapshot that parses but carries NOTHING for any of the 40-odd target
      // countries in the window is an upstream publication problem, not a quiet
      // month. Promoting the snapshot to primary would otherwise take HAPI dark
      // on that failure mode with a working fallback sitting unused — the JSON
      // API was the primary before #7658 and still covers it.
      if (snapshotRows.length === 0) {
        throw Object.assign(
          new Error('HAPI HDX snapshot carried no rows for any target country'),
          { reasonCode: 'HDX_SNAPSHOT_EMPTY' },
        );
      }
    } catch (snapshotFailure) {
      snapshotFailureReason = hapiHdxFailureReason(snapshotFailure);
      // Same "may not LAUNCH after the cutoff" gate the fan-out below uses, for
      // the same reason: the snapshot's own timeouts allow it to burn 60s of
      // metadata plus two 120s annual downloads before failing, and stacking two
      // 75s API sweeps behind that would push the worst case past the ≤315s
      // envelope the whole fetch-deadline model is anchored on. A snapshot that
      // fails FAST (DNS, 4xx/5xx, schema drift) still leaves ample budget to
      // demote; one that fails SLOWLY has already spent the tick, so fail closed
      // and let last-good ride to the next cron.
      if (readElapsedMs() - startedAtMs >= HAPI_FALLBACK_BUDGET_MS) {
        throw Object.assign(
          new Error(
            `HAPI HDX snapshot failed (${snapshotFailureReason}) with no budget left to demote to the JSON API`,
          ),
          {
            status: Number.isFinite(Number(snapshotFailure?.status))
              ? Number(snapshotFailure.status)
              : 0,
            reasonCode: snapshotFailureReason,
          },
        );
      }
      // Still down, and the demoted rows this tick would re-fetch are younger
      // than the normal refresh interval. Retry the snapshot again next tick
      // rather than re-sweeping the lagging channel for rows we already have —
      // see demotedVintageStillFresh. Last-good keeps serving (TTL extended,
      // fetchedAt untouched, so staleness still advances honestly) and the
      // previous seed-meta's sourceState 'degraded' keeps the health warning up.
      if (demotedVintageStillFresh) {
        console.log(
          `  Humanitarian: HDX still down (${snapshotFailureReason}); demoted rows are`
          + ` ${Math.round(previousMarkerAgeMs / 60_000)}min old — preserving them instead of re-sweeping the JSON API`,
        );
        await preserveLastGood().catch((error) => console.warn(`  HAPI last-good preservation failed: ${error.message}`));
        return null;
      }
      if (apiBackoffActive) {
        console.log(
          `  Humanitarian: HDX still down (${snapshotFailureReason}); API backoff remains active until`
          + ` ${new Date(failureBackoff.retryAt).toISOString()} — preserving last-good data`,
        );
        await preserveLastGood().catch((error) => console.warn(`  HAPI last-good preservation failed: ${error.message}`));
        return null;
      }

      sourceChannel = HAPI_API_CHANNEL;
      fallbackDeadlineAtMs = readElapsedMs() + HAPI_FALLBACK_BUDGET_MS;
      console.warn(
        `  HAPI HDX snapshot unavailable (${snapshotFailureReason}) — demoting to the JSON API,`
        + ' whose trailing reference period runs materially lower (#7658)',
      );
    }

    // Most countries have national rows, so one global admin-0 request covers
    // them without the old per-country fan-out.
    const nationalRows = await fetchRows({
      nowMs,
      adminLevel: '0',
    });

    // HRP/GHO countries publish ONLY admin-2 rows and never a national row, so
    // admin-0 alone left every one of them (AFG, SOM, COD, SSD, ETH, MLI, BFA,
    // NER, NGA, CMR, MOZ, HTI, PSE …) reachable only through the per-country
    // fan-out below — i.e. invisible unless someone remembered to hand-add the
    // code to a required list. One more global request at the deepest published
    // level covers all of them in ~2 pages. Upstream publishes each country at
    // exactly ONE admin level, so the two sweeps are disjoint today; aggregating
    // the concatenation in a SINGLE pass (rather than merging two aggregates)
    // still routes any future overlap through aggregateHapiConflictEvents'
    // "latest reference period, then deepest admin level" tiebreak, with the
    // national rows placed first so the deeper level wins the reset.
    // A failure here is deliberately NOT fatal — the admin-0 countries are
    // already in hand and the bounded fallback below can still cover the rest —
    // but it is recorded as a fallback failure so the run still backs off.
    let subnationalRows = [];
    let sweepFailure = null;
    try {
      subnationalRows = await fetchRows({
        nowMs,
        adminLevel: '2',
      });
    } catch (error) {
      sweepFailure = error;
      console.warn(`  HAPI subnational sweep failed: ${error.message}`);
    }

    const results = aggregateHapiConflictEvents(
      [...nationalRows, ...subnationalRows],
      { nowMs, countryCodes },
    );

    // Last-resort guard, not the normal path: with both global sweeps in hand
    // this iterates ZERO countries. It stays as the fail-closed net for a
    // required country upstream moves to an admin level neither sweep requests,
    // pacing the bounded per-country requests sequentially.
    const missingCountries = requiredCountryCodes.filter((countryCode) => !results[countryCode]);
    let fallbackFailure = sweepFailure;
    let fallbackRows = 0;
    for (let i = 0; i < missingCountries.length; i += 1) {
      const countryCode = missingCountries[i];
      // Snapshot-backed iterations issue no network request — they filter rows
      // already in memory — so they are not what this budget bounds, and gating
      // them would disable the net exactly on the run's primary route. On the
      // demoted route the deadline runs from the demotion, not from entry.
      if (
        sourceChannel !== HAPI_SNAPSHOT_CHANNEL
        && readElapsedMs() >= fallbackDeadlineAtMs
      ) {
        const skipped = missingCountries.slice(i);
        fallbackFailure = Object.assign(
          new Error(`fallback budget exhausted with ${skipped.length} required countries unattempted`),
          { reasonCode: 'HAPI_FALLBACK_BUDGET_EXHAUSTED' },
        );
        console.warn(`  HAPI fallback budget exhausted after ${i}/${missingCountries.length} countries — skipped ${skipped.join(', ')}`);
        break;
      }
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
        if (error.status === 429 || error.status === 403) break;
      }
      if (i < missingCountries.length - 1 && sourceChannel !== HAPI_SNAPSHOT_CHANNEL) {
        await pace(HAPI_REQUEST_DELAY_MS);
      }
    }

    if (Object.keys(results).length === 0) {
      // Carry the fallback's status (e.g. 429/403) onto the thrown error so the
      // outer catch's backoff write below records the real provider status
      // instead of falling back to 0 when a fallback rejection is what left
      // results empty.
      throw withChannelProvenance(Object.assign(
        new Error('bulk response contained no target-country national summaries'),
        fallbackFailure
          ? {
              ...(fallbackFailure.status != null ? { status: fallbackFailure.status } : {}),
              ...(fallbackFailure.reasonCode ? { reasonCode: fallbackFailure.reasonCode } : {}),
            }
          : {},
      ));
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
    console.log(`  Humanitarian: ${Object.keys(results).length}/${countryCodes.length} countries (${requiredCovered}/${requiredCountryCodes.length} required) from ${nationalRows.length + subnationalRows.length + fallbackRows} bulk rows via ${sourceChannel}`);
    return { summaries: results, sourceChannel, snapshotFailureReason };
  } catch (error) {
    failure = withChannelProvenance(error);
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
    // `attemptedChannel`, NOT `sourceChannel`: this run published nothing, so
    // the pages are still serving last-good from whichever channel last
    // succeeded — naming this one `sourceChannel` would claim the failed
    // attempt's channel over rows it never wrote. `servingChannel` carries the
    // previous marker's answer alongside it. Plus what pushed the run off the
    // authoritative snapshot, and the code health relays onto the entry, so a
    // dark HAPI can be attributed without re-running the seeder (#7658).
    ...(failure?.sourceChannel ? { attemptedChannel: failure.sourceChannel } : {}),
    ...(previousMarker?.sourceChannel
      ? { servingChannel: previousMarker.sourceChannel }
      : {}),
    ...(failure?.snapshotFailureReason
      ? { snapshotFailureReason: failure.snapshotFailureReason }
      : {}),
    ...(/^[A-Z0-9_]{1,64}$/.test(reasonCode) ? { errorCode: reasonCode } : {}),
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

/**
 * Build the HAPI coverage marker and the seed-meta diagnostics for one run.
 *
 * Extracted from fetchAll ONLY so it is reachable by a test that can actually
 * fail: the write itself lives behind Redis and a 5-way Promise.allSettled, so
 * asserting on a hand-built argument object proved nothing about what the
 * seeder constructs. Dropping the channel from the marker used to keep the
 * whole suite green.
 *
 * #7658: `sourceChannel` names which of HAPI's two channels served this tick,
 * recorded on BOTH the marker and the seed-meta record. The channels disagree
 * by ~23% on the trailing reference period, so a published number that cannot
 * name its channel cannot be compared with the tick before it. A RUN is
 * single-channel by construction — the channel latches once, before the first
 * sweep — so this names the channel behind every country the caller writes.
 *
 * Scope caveat, because the distinction is load-bearing: the per-country keys
 * outlive a run (HAPI_TTL is 6h, ~3 refresh cycles), and the caller's loop
 * overwrites only the countries THIS run covered. So after a partial run that
 * changed channel, the FAMILY can hold both vintages — the countries this run
 * wrote, plus older ones the previous channel wrote. The marker says which is
 * which: `sourceChannel` describes the whole family exactly when
 * countriesCovered === countriesTotal. Note that is the FULL HAPI_COUNTRIES set
 * (44), not the required set (41) — the 3 opportunistic countries are reachable
 * through getHumanitarianSummary like any other, so a run covering every
 * REQUIRED country can still leave them on the other channel. Making the family
 * atomically single-vintage would mean publishing all 44 as one generation
 * behind a pointer swap — a bigger change to the write path than this fix; the
 * coverage fields make the current state readable, not silent.
 *
 * `sourceState: 'degraded'` is the hook api/health.js already has for "degraded
 * BUT SERVING" (readSeedMeta -> sourceDegraded -> SEED_ERROR at warn, record
 * count preserved). Without it this change would REDUCE observability: a
 * snapshot failure used to be terminal and surfaced as SEED_ERROR, whereas a
 * demotion succeeds, so a permanent HDX-side break (resource rename, 403) would
 * otherwise publish the lagging channel indefinitely with health fully green.
 * Set only when demoted — omitting the field is the no-degradation-claim
 * default, and 'blocked' is deliberately NOT used: api/health.js escalates it
 * to a hard SEED_ERROR for every key but one allowlisted adapter.
 */
function nextFixedIntervalBoundary(nowMs, intervalMs) {
  return (Math.floor(nowMs / intervalMs) + 1) * intervalMs;
}

export function buildHapiSeedProvenance(humanitarian, { nowMs = Date.now() } = {}) {
  const summaries = humanitarian?.summaries ?? {};
  const requiredCountriesCovered = HAPI_REQUIRED_COUNTRIES.filter(
    (countryCode) => summaries[countryCode],
  ).length;
  const channelProvenance = {
    sourceChannel: humanitarian?.sourceChannel,
    ...(humanitarian?.snapshotFailureReason
      ? {
          snapshotFailureReason: humanitarian.snapshotFailureReason,
          sourceState: 'degraded',
          // api/health.js relays `errorCode` (regex-gated) onto the health entry
          // when the fault is SEED_ERROR, and relays `errorReason` nowhere — so
          // without this a demotion and a bot-block look identical on the public
          // endpoint. The HDX_*/HAPI_* codes all satisfy /^[A-Z0-9_]{1,64}$/.
          errorCode: humanitarian.snapshotFailureReason,
        }
      : {}),
  };
  return {
    requiredCountriesCovered,
    channelProvenance,
    marker: {
      countriesCovered: Object.keys(summaries).length,
      countriesTotal: HAPI_COUNTRIES.length,
      requiredCountriesCovered,
      requiredCountryCodes: [...HAPI_REQUIRED_COUNTRIES].sort(),
      requiredCountriesTotal: HAPI_REQUIRED_COUNTRIES.length,
      ...channelProvenance,
      ...(humanitarian?.sourceChannel === HAPI_API_CHANNEL
        ? { nextSnapshotRetryAt: nextFixedIntervalBoundary(nowMs, HAPI_DEMOTED_REFRESH_INTERVAL_MS) }
        : {}),
      updatedAt: nowMs,
    },
  };
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
  if (ha?.summaries && Object.keys(ha.summaries).length > 0) {
    for (const [cc, data] of Object.entries(ha.summaries)) await writeExtraKeyWithMeta(`${HAPI_CACHE_KEY_PREFIX}:${cc}`, data, HAPI_TTL, 1);
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
    // Marker fields and channel provenance are built by buildHapiSeedProvenance
    // above, where a test can reach them — see its contract note for what
    // sourceChannel does and does not claim about the family.
    const publishedAt = Date.now();
    const { requiredCountriesCovered, channelProvenance, marker } = buildHapiSeedProvenance(
      ha,
      { nowMs: publishedAt },
    );
    await writeExtraKeyWithMetaAtomically({
      key: HAPI_CACHE_KEY_PREFIX,
      data: marker,
      ttlSeconds: HAPI_SEED_META_TTL_SECONDS,
      recordCount: requiredCountriesCovered,
      metaKey: HAPI_SEED_META_KEY,
      metaTtlSeconds: HAPI_SEED_META_TTL_SECONDS,
      extra: channelProvenance,
      fetchedAt: publishedAt,
    });
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
