#!/usr/bin/env node
// People crossing borders in active crises, from the UNHCR Operational Data
// Portal (data.unhcr.org, CC BY 4.0). Each situation lists the population
// groups UNHCR publishes per receiving country. Two kinds of group behave
// differently and are queried differently:
//   - stock groups (refugees hosted, cumulative returns) report a running
//     total per country. Only the latest report is meaningful: asking for
//     reports since a date SUMS successive reports. Change per country comes
//     from the report history this seeder keeps between runs.
//   - flow groups (Mediterranean sea and land arrivals, deaths) report counts
//     in calendar-month buckets. Asking for reports since the first day of a
//     month returns arrivals from that month on; a mid-month date skips the
//     whole month. Monthly counts are differences of those sums.
// Situations overlap (Sudanese refugees in Chad appear in the Sudan and Sahel
// situations), so figures are never summed across situations.

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, withRetry } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import countryCentroids from './data/country-centroids.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('./shared/country-name-to-iso2.cjs');

export const ARRIVALS_CANONICAL_KEY = 'displacement:cross-border:v1';
export const ARRIVALS_ACTIVATION_KEY = 'seed-activated:displacement:cross-border';
// Per-country report history, kept out of the public payload.
export const ARRIVALS_HISTORY_KEY = 'displacement:cross-border:history:v1';
const ODP = 'https://data.unhcr.org/population/get';
const CACHE_TTL_SECONDS = 3 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const FETCH_CONCURRENCY = 3;
const HISTORY_POINTS = 8;
const TREND_POINTS = 13;
const FLOW_MONTHS = 5; // current partial month plus four complete months
export const MIN_SITUATIONS = 12;

// "Accelerating": the latest period grew at least ACCELERATION_RATIO times as
// fast as the median of the earlier periods AND by more than an absolute
// floor, so a quiet situation going from 10 to 30 people is not flagged. At
// least MIN_BASELINE_PERIODS earlier periods are required to judge.
export const ACCELERATION_RATIO = 2;
export const ARRIVALS_FLOOR = 1_000;
export const STOCK_FLOOR = 10_000;
const MIN_BASELINE_PERIODS = 3;

/**
 * kind: outflow = people who fled the crisis and are hosted abroad (stock)
 *       return  = people who crossed back into the crisis country (stock)
 *       arrival = people arriving in a receiving country (flow, windowed)
 *       death   = dead and missing on the route (flow, windowed)
 * origin: ISO2 of the crisis country, when the flow has a single origin.
 */
export const SITUATIONS = [
  { id: 'sudan', name: 'Sudan crisis', slug: 'sudansituation', svId: 63, origin: 'SD',
    flows: [
      { kind: 'outflow', label: 'Refugees from Sudan', query: { population_group: '5550' } },
      { kind: 'return', label: 'South Sudanese and others returning', query: { population_group: '5551' } },
    ],
    trend: { population_group: '5550', frequency: 'day' } },
  { id: 'south-sudan', name: 'South Sudan', slug: 'southsudan', svId: 5, origin: 'SS',
    flows: [{ kind: 'outflow', label: 'Refugees from South Sudan', query: { population_collection: '5' } }],
    trend: { population_collection: '5', frequency: 'day' } },
  { id: 'drc', name: 'Democratic Republic of the Congo', slug: 'drc', svId: 14, origin: 'CD',
    flows: [{ kind: 'outflow', label: 'Refugees and asylum seekers from the DRC', query: { population_group: '5114,5136' } }],
    trend: { population_group: '4689,5114,5136', frequency: 'day' } },
  { id: 'somalia', name: 'Horn of Africa (Somalia)', slug: 'horn', svId: 1, origin: 'SO',
    flows: [{ kind: 'outflow', label: 'Refugees from Somalia', query: { population_collection: '1' } }],
    trend: { population_collection: '1', frequency: 'day' } },
  { id: 'nigeria', name: 'Nigeria situation', slug: 'nigeriasituation', svId: 3, origin: 'NG',
    flows: [{ kind: 'outflow', label: 'Refugees from Nigeria', query: { population_group: '4950,5269,5277' } }],
    trend: { population_group: '4950,5269,5277', frequency: 'day' } },
  { id: 'sahel', name: 'Sahel crisis', slug: 'sahelcrisis', svId: 46, origin: null,
    flows: [{ kind: 'outflow', label: 'Refugees and asylum seekers hosted in the Sahel', query: { population_collection: '4,29' } }],
    trend: { population_group: '4599,4600,4722,5157,5185,5268,5299,5377', frequency: 'day' } },
  { id: 'burundi', name: 'Burundi situation', slug: 'burundi', svId: 13, origin: 'BI',
    flows: [{ kind: 'outflow', label: 'Refugees from Burundi', query: { population_collection: '12' } }] },
  { id: 'central-africa', name: 'Central Africa (Cameroon office)', slug: 'mco_cameroon', svId: 70, origin: null,
    flows: [{ kind: 'outflow', label: 'Refugees and asylum seekers hosted', query: { population_collection: '4,29' } }] },
  { id: 'southern-africa', name: 'Southern Africa', slug: 'samco', svId: 68, origin: null,
    flows: [{ kind: 'outflow', label: 'Refugees and asylum seekers hosted', query: { population_collection: '4,29,81' } }] },
  { id: 'myanmar', name: 'Myanmar situation', slug: 'myanmar', svId: 59, origin: 'MM',
    flows: [{ kind: 'outflow', label: 'Refugees and asylum seekers from Myanmar', query: { population_group: '5512' } }] },
  { id: 'syria', name: 'Syria regional response', slug: 'syria', svId: 4, origin: 'SY',
    flows: [{ kind: 'outflow', label: 'Syrian refugees in the region', query: { population_collection: '24' } }] },
  { id: 'middle-east', name: 'Middle East situation', slug: 'middle_eastern', svId: 123, origin: null,
    flows: [
      { kind: 'outflow', label: 'Lebanese crossing into neighbouring countries', origin: 'LB', query: { population_group: '5756' } },
      { kind: 'outflow', label: 'Iranians crossing into neighbouring countries', origin: 'IR', query: { population_group: '5759' } },
      { kind: 'return', label: 'Iranians crossing back', origin: 'IR', query: { population_group: '5771' } },
      { kind: 'return', label: 'Syrian and Afghan returnees', query: { population_group: '5762,5764' } },
    ] },
  { id: 'afghanistan', name: 'Afghanistan situation', slug: 'afghanistan', svId: 32, origin: 'AF',
    flows: [
      { kind: 'outflow', label: 'Afghan refugees in neighbouring countries', query: { population_group: '5604' } },
      { kind: 'return', label: 'Returns and deportations to Afghanistan', query: { population_group: '5715,5716,5717,5718,5720,5721,5722' } },
    ] },
  { id: 'central-asia', name: 'Central Asia', slug: 'central_asia', svId: 87, origin: null,
    flows: [{ kind: 'outflow', label: 'Refugees and asylum seekers hosted', query: { population_group: '5106,5290,5558,5616,5618,5620' } }] },
  { id: 'mediterranean', name: 'Mediterranean and Atlantic routes to Europe', slug: 'europe-sea-arrivals', svId: 100, origin: null,
    flows: [
      { kind: 'arrival', label: 'Sea and land arrivals', query: { population_group: '4797,4798,5634' } },
      { kind: 'death', label: 'Dead and missing (Northwest Africa route)', query: { population_group: '5644' } },
    ],
    trend: { population_group: '4797,4798,5634', frequency: 'month', flow: true } },
  { id: 'americas', name: 'Central America and Caribbean (Panama office)', slug: 'mcopanama', svId: 60, origin: null,
    flows: [{ kind: 'outflow', label: 'People in need of international protection', query: { population_group: '5741,5742' } }] },
];

const FLOW_KINDS = new Set(['arrival', 'death']);

function nonRetryable(message) {
  const err = new Error(message);
  err.nonRetryable = true;
  return err;
}

async function odpGet(endpoint, params) {
  const url = `${ODP}/${endpoint}?${new URLSearchParams(params)}`;
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 404) throw nonRetryable(`ODP ${endpoint} sv_id=${params.sv_id}: HTTP 404`);
    if (!resp.ok) throw new Error(`ODP ${endpoint} sv_id=${params.sv_id}: HTTP ${resp.status}`);
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`ODP ${endpoint} sv_id=${params.sv_id}: response is not JSON`);
    }
  }, 2, 2000);
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (nowMs, days) => isoDate(nowMs - days * 86_400_000);

/** First days of the current month and the months before it, newest first: ['2026-10-01', '2026-09-01', ...]. */
export function monthStarts(nowMs, count) {
  const now = new Date(nowMs);
  return Array.from({ length: count }, (_, i) => isoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
}

function sublocationQuery(situation, flow, fromDate) {
  return { geo_id: '0', forcesublocation: '0', fromDate, sv_id: String(situation.svId), ...flow.query };
}

/** One entry per receiving country: the latest report wins, a larger figure breaks a same-day tie. */
export function latestByCountry(rows) {
  const byCountry = new Map();
  for (const row of rows ?? []) {
    const name = String(row?.geomaster_name ?? '').trim();
    const individuals = Number(row?.individuals);
    const date = String(row?.date ?? '').slice(0, 10);
    if (!name || !Number.isFinite(individuals) || individuals < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const prev = byCountry.get(name);
    if (prev && (prev.date > date || (prev.date === date && prev.individuals >= individuals))) continue;
    const lat = Number(row.centroid_lat);
    const lon = Number(row.centroid_lon);
    byCountry.set(name, {
      country: name,
      iso2: countryNameToIso2(name) ?? '',
      individuals,
      date,
      location: Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) ? { latitude: lat, longitude: lon } : undefined,
    });
  }
  return [...byCountry.values()].sort((a, b) => b.individuals - a.individuals);
}

/**
 * Flow groups: the portal already sums reports since the query date, one row
 * per receiving country and group combination. Rows for the same country
 * (separate sea and land groups) are added; the newest report date is kept.
 */
export function sumByCountry(rows) {
  const byCountry = new Map();
  for (const row of rows ?? []) {
    const [entry] = latestByCountry([row]);
    if (!entry) continue;
    const prev = byCountry.get(entry.country);
    byCountry.set(entry.country, prev
      ? { ...prev, individuals: prev.individuals + entry.individuals, date: prev.date > entry.date ? prev.date : entry.date }
      : entry);
  }
  return byCountry;
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Flow groups: monthly counts from cumulative "since" sums, newest first.
 * since[i] = arrivals since the first day of month i; month i = since[i] - since[i-1].
 */
export function windowsFromSince(sinceTotals) {
  const windows = [];
  for (let i = 0; i < sinceTotals.length; i++) {
    const prev = i === 0 ? 0 : sinceTotals[i - 1];
    windows.push(Math.max(0, sinceTotals[i] - prev));
  }
  return windows;
}

/** counts: newest complete period first. */
export function arrivalsAcceleration(counts) {
  const [latest, ...earlier] = counts;
  const baseline = earlier.length >= MIN_BASELINE_PERIODS ? median(earlier) : null;
  const accelerating = Number.isFinite(latest) && latest >= ARRIVALS_FLOOR
    && baseline !== null && latest >= ACCELERATION_RATIO * Math.max(baseline, 1);
  return { latest: latest ?? 0, baseline, accelerating };
}

/**
 * Stock trend: the per-day growth of the latest step against the median
 * per-day growth of earlier steps. Points are [YYYY-MM-DD, total].
 */
export function stockTrendAcceleration(points) {
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const days = (Date.parse(points[i][0]) - Date.parse(points[i - 1][0])) / 86_400_000;
    if (!(days > 0)) continue;
    steps.push({ delta: points[i][1] - points[i - 1][1], perDay: (points[i][1] - points[i - 1][1]) / days, days });
  }
  const latest = steps.at(-1);
  if (!latest) return { latestDelta: null, latestDays: null, baselinePerDay: null, accelerating: false };
  const earlier = steps.slice(0, -1);
  const baselinePerDay = earlier.length >= MIN_BASELINE_PERIODS ? median(earlier.map((s) => s.perDay)) : null;
  const accelerating = latest.delta >= STOCK_FLOOR
    && baselinePerDay !== null && latest.perDay >= ACCELERATION_RATIO * Math.max(baselinePerDay, 1);
  return { latestDelta: latest.delta, latestDays: Math.round(latest.days), baselinePerDay, accelerating };
}

/** Portal series can repeat a date with a corrected figure; the last one wins. Sorted by date. */
export function dedupeSeries(points) {
  const byDate = new Map();
  for (const [date, n] of points) byDate.set(date, n);
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Appends a new report to a country's history when its date advanced; returns the change since the previous report. */
export function advanceHistory(previousPoints, date, individuals) {
  const points = Array.isArray(previousPoints) ? previousPoints.filter((p) => Array.isArray(p) && p.length === 2) : [];
  const last = points.at(-1);
  if (!last || date > last[0]) points.push([date, individuals]);
  else if (date === last[0]) points[points.length - 1] = [date, individuals];
  const trimmed = points.slice(-HISTORY_POINTS);
  const prior = trimmed.length >= 2 ? trimmed.at(-2) : null;
  return {
    history: trimmed,
    change: prior ? { since: prior[0], delta: individuals - prior[1] } : undefined,
  };
}

async function readPreviousHistory() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return {};
    const raw = await upstashCommand(creds, ['GET', ARRIVALS_HISTORY_KEY]);
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = value?.data ?? value;
    return data?.history && typeof data.history === 'object' ? data.history : {};
  } catch (err) {
    console.warn(`  WARN: previous cross-border history unreadable, starting fresh: ${err?.message || err}`);
    return {};
  }
}

async function buildFlow(situation, flow, nowMs, history, nextHistory) {
  const origin = flow.origin ?? situation.origin ?? null;
  const centroid = origin ? countryCentroids[origin] : null;
  const base = {
    kind: flow.kind,
    label: flow.label,
    origin: origin ?? '',
    originLocation: centroid ? { latitude: centroid[0], longitude: centroid[1] } : undefined,
  };
  if (FLOW_KINDS.has(flow.kind)) {
    // months[0] is the current, partial month; acceleration is judged on complete months.
    const months = monthStarts(nowMs, FLOW_MONTHS);
    const [ytdJson, ...sinceJson] = await Promise.all(
      [`${new Date(nowMs).getUTCFullYear()}-01-01`, ...months].map((start) => odpGet('sublocation', sublocationQuery(situation, flow, start))),
    );
    const sinceByCountry = sinceJson.map((json) => sumByCountry(json?.data));
    const ytd = sumByCountry(ytdJson?.data);
    const names = new Set([...ytd.keys(), ...sinceByCountry.flatMap((m) => [...m.keys()])]);
    const toMonths = (counts) => counts.map((n, i) => ({ month: months[i].slice(0, 7), individuals: n }));
    const countries = [...names].map((name) => {
      const counts = windowsFromSince(sinceByCountry.map((m) => m.get(name)?.individuals ?? 0));
      const sample = ytd.get(name) ?? sinceByCountry.find((m) => m.has(name))?.get(name);
      return {
        country: name,
        iso2: sample?.iso2 ?? '',
        location: sample?.location,
        date: sample?.date ?? '',
        individuals: ytd.get(name)?.individuals ?? 0,
        months: toMonths(counts),
        accelerating: arrivalsAcceleration(counts.slice(1)).accelerating,
      };
    }).sort((a, b) => b.months[1].individuals - a.months[1].individuals || b.individuals - a.individuals);
    const totals = windowsFromSince(sinceByCountry.map((m) => [...m.values()].reduce((sum, c) => sum + c.individuals, 0)));
    return {
      ...base,
      measure: 'monthly',
      total: countries.reduce((sum, c) => sum + c.individuals, 0),
      months: toMonths(totals),
      accelerating: arrivalsAcceleration(totals.slice(1)).accelerating,
      asOf: countries.map((c) => c.date).filter(Boolean).sort().at(-1) ?? '',
      countries,
    };
  }

  const json = await odpGet('sublocation', sublocationQuery(situation, flow, '1900-01-01'));
  const countries = latestByCountry(json?.data).map((c) => {
    const key = `${situation.id}|${flow.kind}|${flow.label}|${c.country}`;
    const { history: points, change } = advanceHistory(history[key], c.date, c.individuals);
    nextHistory[key] = points;
    return { ...c, change };
  });
  return {
    ...base,
    measure: 'stock',
    total: countries.reduce((sum, c) => sum + c.individuals, 0),
    asOf: countries.map((c) => c.date).sort().at(-1) ?? '',
    countries,
  };
}

async function buildTrend(situation, nowMs) {
  if (!situation.trend) return undefined;
  const { frequency, flow: isFlow, ...groups } = situation.trend;
  const fromDate = daysAgo(nowMs, isFlow ? 400 : 200);
  const json = await odpGet('timeseries', { sv_id: String(situation.svId), frequency, fromDate, ...groups });
  const points = dedupeSeries((json?.data?.timeseries ?? [])
    .map((p) => {
      const date = p.data_date ?? (p.year && p.month ? `${p.year}-${String(p.month).padStart(2, '0')}-01` : null);
      return [date, Number(p.individuals)];
    })
    .filter(([date, n]) => /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && Number.isFinite(n)))
    .slice(-TREND_POINTS);
  if (points.length === 0) return undefined;
  if (isFlow) {
    // Monthly arrivals; the current month is partial, so it is not judged. Early in a
    // month the portal may not list it yet, and then the newest point is complete.
    const currentMonth = new Date(nowMs).toISOString().slice(0, 7);
    const judged = points.at(-1)[0].startsWith(currentMonth) ? points.slice(0, -1) : points;
    const complete = judged.map((p) => p[1]).reverse();
    const { accelerating } = arrivalsAcceleration(complete);
    return { frequency, measure: 'monthly', points, latestDelta: complete[0] ?? null, accelerating };
  }
  const result = stockTrendAcceleration(points);
  return { frequency, measure: 'stock', points, latestDelta: result.latestDelta, latestDays: result.latestDays, accelerating: result.accelerating };
}

export async function fetchCrossBorderArrivals({ nowMs = Date.now(), previousHistory } = {}) {
  const history = previousHistory ?? await readPreviousHistory();
  const nextHistory = {};
  const results = [];
  const failures = [];
  const queue = [...SITUATIONS];
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const situation = queue.shift();
      try {
        const flows = [];
        for (const flow of situation.flows) flows.push(await buildFlow(situation, flow, nowMs, history, nextHistory));
        const trend = await buildTrend(situation, nowMs);
        const nonEmpty = flows.filter((f) => f.countries.length > 0);
        if (nonEmpty.length === 0) throw new Error('no country rows');
        results.push({
          id: situation.id,
          name: situation.name,
          origin: situation.origin ?? '',
          sourceUrl: `https://data.unhcr.org/en/situations/${situation.slug}`,
          asOf: nonEmpty.map((f) => f.asOf).filter(Boolean).sort().at(-1) ?? '',
          accelerating: Boolean(trend?.accelerating) || nonEmpty.some((f) => f.accelerating),
          flows: nonEmpty,
          trend,
        });
      } catch (err) {
        failures.push(`${situation.id}: ${err?.message || err}`);
      }
    }
  }));
  // A situation that failed today keeps its history, so one bad day does not reset its change figures.
  const failedIds = new Set(SITUATIONS.filter((s) => !results.some((r) => r.id === s.id)).map((s) => s.id));
  for (const [key, points] of Object.entries(history ?? {})) {
    if (failedIds.has(key.split('|')[0]) && !(key in nextHistory)) nextHistory[key] = points;
  }
  if (failures.length) console.warn(`  ODP: ${failures.length} situation(s) unavailable: ${failures.join('; ')}`);
  results.sort((a, b) => SITUATIONS.findIndex((s) => s.id === a.id) - SITUATIONS.findIndex((s) => s.id === b.id));
  console.log(`  ODP: ${results.length}/${SITUATIONS.length} situations, ${results.filter((s) => s.accelerating).length} accelerating`);
  return { source: 'UNHCR Operational Data Portal', situations: results, unavailable: failures.map((f) => f.split(':')[0]), history: nextHistory };
}

export function validate(data) {
  return Array.isArray(data?.situations) && data.situations.length >= MIN_SITUATIONS;
}

export function declareRecords(data) {
  return data?.situations?.length ?? 0;
}

/** The public payload: everything except the report history. */
export function publishTransform(data) {
  const { history: _history, ...published } = data ?? {};
  return published;
}

export function contentMeta(data, nowMs = Date.now()) {
  return tokensToContentMeta((data?.situations ?? []).map((s) => s.asOf).filter(Boolean), nowMs);
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', ARRIVALS_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: cross-border activation marker write failed: ${err?.message || err}`);
  }
}

export const seedOptions = {
  validateFn: validate,
  ttlSeconds: CACHE_TTL_SECONDS,
  sourceVersion: 'unhcr-odp-v1',
  declareRecords,
  contentMeta,
  schemaVersion: 1,
  maxStaleMin: 2880, // daily health-bundle tick; 48h = two missed ticks
  // The freshest situation normally reports within days; a month of silence
  // across every situation means the portal stopped publishing.
  maxContentAgeMin: 45 * DAY_MIN,
  emptyDataIsFailure: true,
  publishTransform,
  extraKeys: [{
    key: ARRIVALS_HISTORY_KEY,
    // Outlives the canonical key so a few failed days do not reset the change figures.
    ttl: 30 * 24 * 60 * 60,
    transform: (data) => ({ history: data?.history ?? {} }),
    allowPrePublishFields: ['history'],
    declareRecords: (data) => Object.keys(data?.history ?? {}).length,
  }],
  afterPublish: markActivated,
};

if (process.argv[1]?.endsWith('seed-cross-border-arrivals.mjs')) {
  runSeed('displacement', 'cross-border', ARRIVALS_CANONICAL_KEY, () => fetchCrossBorderArrivals(), seedOptions).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
