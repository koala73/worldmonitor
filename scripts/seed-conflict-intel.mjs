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

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep, loadSharedConfig } from './_seed-utils.mjs';
import { fetchGdeltJson } from './_gdelt-fetch.mjs';
import { buildGdeltConflictUrl, mapGdeltArticlesToEvents, GDELT_COUNTRY_NAMES } from './_conflict-gdelt.mjs';

loadEnvFile(import.meta.url);

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_CACHE_KEY = 'conflict:acled:v1:all:0:0';
const ACLED_RESOLUTION_CACHE_KEY = 'conflict:acled-resolution:v1:all:0:0';
const ACLED_TTL = 900;
const ACLED_DISPLAY_LOOKBACK_DAYS = 30;
const ACLED_DISPLAY_LIMIT = 500;
const ACLED_RESOLUTION_LOOKBACK_DAYS = 60;
const ACLED_RESOLUTION_PAGE_LIMIT = 5000;
const ACLED_RESOLUTION_MAX_PAGES = 20;
const ACLED_PAGE_DELAY_MS = 250;
const HAPI_CACHE_KEY_PREFIX = 'conflict:humanitarian:v1';
const HAPI_TTL = 21600;
const PIZZINT_TTL = 600;

const CONFLICT_COUNTRIES = [
  'AF', 'SY', 'UA', 'SD', 'SS', 'SO', 'CD', 'MM', 'YE', 'ET',
  'IQ', 'PS', 'LY', 'ML', 'BF', 'NE', 'NG', 'CM', 'MZ', 'HT',
];
export const GDELT_MIN_SUCCESSFUL_COUNTRIES = Math.ceil(CONFLICT_COUNTRIES.length * 0.8);
// #5140: the GDELT fallback sweep may not LAUNCH a batch after this much of the
// fetch phase has elapsed (fetchAll anchors the clock at its own entry and passes
// an absolute deadline down, so slow aux feeds — HAPI is sequential, ~306s worst —
// automatically shrink the sweep window instead of stacking on top of it). One
// in-flight batch may still drain past the cutoff: ≤~100s at the knobs below
// (15s concurrent direct legs + 4 × 20s SERIALIZED sync proxy curls — curlFetch is
// execFileSync, so "concurrent" proxy attempts block the event loop one at a time;
// 92s observed live 2026-07-10). Worst single fetchAll attempt ≈
// max(HAPI 306s, 120s + 100s) + extra-key writes ≈ ~350s, inside both the 360s
// lock below and the 480s fetch deadline (lockTtl + margin). Without this cap a
// GDELT brownout ran 5 batches ≈ 375s+ → deadline breach → exit 75 every tick.
export const GDELT_SWEEP_BUDGET_MS = 120_000;
// maxRetries: 0 — a second direct attempt would honor GDELT's Retry-After header
// (≤60s sleep, _gdelt-fetch.mjs MAX_RETRY_AFTER_MS), blowing any per-batch bound;
// the proxy leg (IP-rotating) is the designed 429 answer, not a same-IP retry.
// proxyMaxAttempts: 1 — proxy curls are synchronous (execFileSync, ≤20s each) and
// serialize across the whole batch: each extra attempt adds 4 × 20s of worst case.
export const GDELT_COUNTRY_FETCH_OPTS = Object.freeze({ maxRetries: 0, proxyMaxAttempts: 1 });
// Lock must outlive the worst legitimate run (runSeed's documented invariant —
// _seed-utils.mjs: "a healthy seeder is designed never to outlive its own lock");
// it also sets the fetch deadline (lockTtlMs + 120s margin = 480s). The default
// 120s lock was ALREADY shorter than this seeder's worst case. Cron cadence is
// 30min, so a hard-crashed run's dangling lock costs at most 6 of those minutes.
export const ACLED_INTEL_LOCK_TTL_MS = 360_000;

const ISO2_TO_ISO3 = loadSharedConfig('iso2-to-iso3.json');

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

function normalizeAcledConflictEvents(rawEvents) {
  return rawEvents
    .filter(e => {
      const lat = parseFloat(e.latitude || '');
      const lon = parseFloat(e.longitude || '');
      return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    })
    .map(e => ({
      id: `acled-${e.event_id_cnty}`,
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
    }));
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
    for (const event of pageEvents) {
      const id = event.event_id_cnty || `${event.event_date}:${event.country}:${event.latitude}:${event.longitude}:${event.notes || event.source || ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rawEvents.push(event);
    }
    if (!paginated || pageEvents.length < limit || rawEvents.length === before) break;
    await sleep(ACLED_PAGE_DELAY_MS);
  }

  const events = normalizeAcledConflictEvents(rawEvents);
  const pagination = paginated
    ? { lookbackDays, limit, pagesFetched, maxPages, truncated: pagesFetched >= maxPages && lastPageCount >= limit }
    : undefined;
  console.log(`  ${label}: ${events.length} events (${startDate} to ${endDate}${paginated ? `, ${pagesFetched} page(s)` : ''})`);
  return { events, pagination };
}

// ─── GDELT conflict-events fallback (used when ACLED has no credentials) ───
// ACLED requires a registered account. When its credentials are absent, keep a
// near-real-time conflict signal by proxying GDELT DOC 2.0 coverage volume: per
// priority country, count recent conflict-tagged articles and emit them as synthetic
// events in the SAME {country, event_date} shape the EMA engine reads
// (_ema-threat-engine.mjs). Article volume is a coarser proxy than ACLED event counts,
// but it is keyless, near-real-time, and directionally valid for the per-country
// escalation EMA. URL/query + article→event mapping live in the import-safe,
// unit-tested _conflict-gdelt.mjs; this fn owns the throttle-aware fetch via
// fetchGdeltJson's proxy path (GDELT is per-IP 429-throttled).
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

export async function fetchGdeltConflictEvents({
  fetchCountryEvents = fetchGdeltCountryEvents,
  pace = sleep,
  now = Date.now,
  deadlineAt,
} = {}) {
  const events = [];
  const failedCountries = [];
  let successfulCountries = 0;
  const CONCURRENCY = 4; // bound the run window (20 countries × proxy retries)
  const launchCutoffAt = deadlineAt ?? now() + GDELT_SWEEP_BUDGET_MS;
  for (let i = 0; i < CONFLICT_COUNTRIES.length; i += CONCURRENCY) {
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
    const batch = remaining.slice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(cc => fetchCountryEvents(cc)));
    for (const result of results) {
      if (result?.ok) {
        successfulCountries += 1;
        events.push(...(Array.isArray(result.events) ? result.events : []));
      } else {
        failedCountries.push({ country: result?.country || 'unknown', error: result?.error || 'unknown failure' });
      }
    }
    if (i + CONCURRENCY < CONFLICT_COUNTRIES.length) await pace(500); // inter-batch only; no trailing wait
  }
  if (successfulCountries < GDELT_MIN_SUCCESSFUL_COUNTRIES) {
    const sample = failedCountries.slice(0, 6).map(({ country, error }) => `${country}:${error}`).join(', ');
    throw new Error(
      `GDELT conflict-events coverage below floor: ${successfulCountries}/${CONFLICT_COUNTRIES.length} countries succeeded ` +
      `(min ${GDELT_MIN_SUCCESSFUL_COUNTRIES})${sample ? `; failures: ${sample}` : ''}`,
    );
  }
  console.log(`  GDELT conflict-events (ACLED fallback): ${events.length} events across ${successfulCountries}/${CONFLICT_COUNTRIES.length} successful country fetches`);
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

// ─── Humanitarian Summary (HAPI) ───

async function fetchHapiSummary(countryCode) {
  const iso3 = ISO2_TO_ISO3[countryCode];
  if (!iso3) return null;

  const appId = Buffer.from('worldmonitor:monitor@worldmonitor.app').toString('base64');
  const url = `https://hapi.humdata.org/api/v2/coordination-context/conflict-events?output_format=json&limit=1000&offset=0&app_identifier=${appId}&location_code=${iso3}`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const rawData = await resp.json();
  const records = rawData.data || [];

  const agg = { eventsTotal: 0, eventsPV: 0, eventsCT: 0, eventsDem: 0, fatPV: 0, fatCT: 0, month: '', locationName: '' };
  for (const r of records) {
    if ((r.location_code || '') !== iso3) continue;
    const month = r.reference_period_start || '';
    const eventType = (r.event_type || '').toLowerCase();
    const events = r.events || 0;
    const fatalities = r.fatalities || 0;
    if (!agg.locationName) agg.locationName = r.location_name || '';
    if (month > agg.month) { agg.month = month; agg.eventsTotal = 0; agg.eventsPV = 0; agg.eventsCT = 0; agg.eventsDem = 0; agg.fatPV = 0; agg.fatCT = 0; }
    if (month === agg.month) {
      agg.eventsTotal += events;
      if (eventType.includes('political_violence')) { agg.eventsPV += events; agg.fatPV += fatalities; }
      if (eventType.includes('civilian_targeting')) { agg.eventsCT += events; agg.fatCT += fatalities; }
      if (eventType.includes('demonstration')) agg.eventsDem += events;
    }
  }
  if (!agg.month) return null;

  return {
    summary: {
      countryCode: countryCode.toUpperCase(),
      countryName: agg.locationName,
      conflictEventsTotal: agg.eventsTotal,
      conflictPoliticalViolenceEvents: agg.eventsPV + agg.eventsCT,
      conflictFatalities: agg.fatPV + agg.fatCT,
      referencePeriod: agg.month,
      conflictDemonstrations: agg.eventsDem,
      updatedAt: Date.now(),
    },
  };
}

async function fetchAllHumanitarianSummaries() {
  const results = {};
  for (const cc of CONFLICT_COUNTRIES) {
    try {
      const data = await fetchHapiSummary(cc);
      if (data?.summary) results[cc] = data;
      await sleep(300);
    } catch (e) {
      console.warn(`  HAPI ${cc}: ${e.message}`);
    }
  }
  console.log(`  Humanitarian: ${Object.keys(results).length}/${CONFLICT_COUNTRIES.length} countries`);
  return results;
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

async function fetchAll() {
  // #5140: anchor the GDELT-fallback sweep cutoff at the START of the fetch phase,
  // not at sweep entry — the aux feeds below (HAPI is sequential, ~306s worst) and
  // the sweep share runSeed's single fetch deadline, so time the aux stage burns
  // must come out of the sweep's window, not be added to it.
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
  if (ha) { for (const [cc, data] of Object.entries(ha)) await writeExtraKeyWithMeta(`${HAPI_CACHE_KEY_PREFIX}:${cc}`, data, HAPI_TTL, 1); }
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
      // No ACLED credentials → fall back to the GDELT article-volume proxy so the
      // conflict escalation EMA keeps a near-real-time signal (#5099). This runs only
      // on the no-creds path: a credentialed-but-failed fetch still throws below, and a
      // credentialed-but-empty ACLED result is trusted (returns `ac`) rather than
      // overwritten by GDELT volume.
      const gdeltEvents = await fetchGdeltConflictEvents({ deadlineAt: sweepDeadlineAt }).catch((e) => {
        console.warn(`  GDELT conflict-events fallback failed: ${e.message}`);
        return null;
      });
      if (gdeltEvents?.events?.length) return gdeltEvents;
      console.log('  ACLED: no credentials + GDELT fallback empty — publishing auxiliary feeds only, primary feed left empty');
      return { events: [], pagination: undefined };
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

if (process.argv[1]?.endsWith('seed-conflict-intel.mjs')) {
  runSeed('conflict', 'acled-intel', ACLED_CACHE_KEY, fetchAll, {
    validateFn: validate,
    lockTtlMs: ACLED_INTEL_LOCK_TTL_MS,
    ttlSeconds: ACLED_TTL,
    sourceVersion: 'acled-hapi-pizzint',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 38,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
