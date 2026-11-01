#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA, readSeedSnapshot } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:portwatch:v1';
const TTL = 43_200; // 12h — 2× the 6h cron interval

const ARCGIS_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
// The Hub's CSV export of the same layer. It is served from cache, so one
// request returns every chokepoint while the query service above times out
// (since 2026-10-27, queries past ~10 s return 200 "Invalid query parameters").
const CSV_EXPORT_URL =
  'https://hub.arcgis.com/api/download/v1/items/3da2b9ca97684916b75c4013f95d18ab/csv?redirect=true&layers=0';
const CSV_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 2000;
const FETCH_TIMEOUT = 30_000;
export const HISTORY_DAYS = 180;
const CONCURRENCY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
// Year-earlier baseline: the 12 months ending one year before the seed, so a
// disruption that has run for months does not drag the "normal" it is measured
// against. Computed server-side by ArcGIS outStatistics (one row per
// chokepoint), not by paging 365 more days of features.
export const BASELINE_WINDOW_DAYS = 365;
export const BASELINE_LAG_DAYS = 365;
// Below this many published days the mean is not a year's normal.
export const BASELINE_MIN_DAYS = 300;
// Wall-clock budget for the whole baseline pass. The baseline only qualifies
// the daily history, so it must never push the fetch phase past its deadline
// (300s bundle section, ~260s fetch) and cost the fresh counts. Chokepoints
// still waiting when the budget runs out keep baseline: null.
export const BASELINE_BUDGET_MS = 45_000;
const BASELINE_REQUEST_TIMEOUT_MS = 15_000;
// Left between the end of the baseline pass and runSeed's fetch deadline.
const BASELINE_DEADLINE_MARGIN_MS = 10_000;

/**
 * The baseline budget: BASELINE_BUDGET_MS, cut to what runSeed's fetch
 * deadline leaves after the history fetch, minus a margin. 0 skips the pass.
 */
export function baselineBudgetMs(fetchDeadlineAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(fetchDeadlineAtMs)) return BASELINE_BUDGET_MS;
  return Math.max(0, Math.min(BASELINE_BUDGET_MS, fetchDeadlineAtMs - nowMs - BASELINE_DEADLINE_MARGIN_MS));
}

export const CHOKEPOINTS = [
  { name: 'Suez Canal',          id: 'suez' },
  { name: 'Malacca Strait',      id: 'malacca_strait' },
  { name: 'Strait of Hormuz',    id: 'hormuz_strait' },
  { name: 'Bab el-Mandeb Strait', id: 'bab_el_mandeb' },
  { name: 'Panama Canal',        id: 'panama' },
  { name: 'Taiwan Strait',       id: 'taiwan_strait' },
  { name: 'Cape of Good Hope',   id: 'cape_of_good_hope' },
  { name: 'Gibraltar Strait',    id: 'gibraltar' },
  { name: 'Bosporus Strait',     id: 'bosphorus' },
  { name: 'Korea Strait',        id: 'korea_strait' },
  { name: 'Dover Strait',        id: 'dover_strait' },
  { name: 'Kerch Strait',        id: 'kerch_strait' },
  { name: 'Lombok Strait',       id: 'lombok_strait' },
];

function formatDate(epochMs) {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

/**
 * Week-over-week change in total transits, as a percentage to one decimal.
 *
 * Needs 14 days: the trailing 7 compared against the 7 before them. A zero
 * prior week reports 0 rather than dividing by it — an infinite spike on a
 * chokepoint that simply had no traffic last week is noise, not signal.
 *
 * Exported so the arithmetic is tested against this function rather than a
 * copy of it.
 */
export function computeWow(history) {
  if (history.length < 14) return 0;
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let thisWeek = 0;
  let lastWeek = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) thisWeek += sorted[i].total;
  for (let i = 7; i < 14 && i < sorted.length; i++) lastWeek += sorted[i].total;
  if (lastWeek === 0) return 0;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10;
}

export async function fetchAllPages(portname, sinceEpoch) {
  const all = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      where: `portname='${portname.replace(/'/g, "''")}' AND date >= ${epochToTimestamp(sinceEpoch)}`,
      outFields: [
        'date',
        'n_container', 'n_dry_bulk', 'n_general_cargo', 'n_roro', 'n_tanker', 'n_total',
        'capacity_container', 'capacity_dry_bulk', 'capacity_general_cargo', 'capacity_roro', 'capacity_tanker',
      ].join(','),
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });
    const resp = await fetch(`${ARCGIS_BASE}?${params}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${portname}`);
    const body = await resp.json();
    if (body.error) throw new Error(`ArcGIS error for ${portname}: ${body.error.message}`);
    if (body.features?.length) all.push(...body.features);
    if (!body.exceededTransferLimit || !body.features?.length) break;
    // Advance by rows actually returned, not PAGE_SIZE: the layer's server-side
    // maxRecordCount (1000) is below PAGE_SIZE, so += PAGE_SIZE skips rows once
    // a query spans more than one server page (latent at 180 days, real beyond).
    offset += body.features.length;
  }
  return all;
}

/**
 * The baseline window, day-aligned in UTC: [now - 730d, now - 365d).
 * `from` and `to` are the first and last calendar days inside it, so the
 * stored record reads as an inclusive range.
 */
export function baselineWindow(nowMs = Date.now()) {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const toEpoch = dayStart - BASELINE_LAG_DAYS * DAY_MS;
  const fromEpoch = toEpoch - BASELINE_WINDOW_DAYS * DAY_MS;
  return { fromEpoch, toEpoch, from: formatDate(fromEpoch), to: formatDate(toEpoch - DAY_MS) };
}

export async function fetchBaselineStats(portname, { fromEpoch, toEpoch }, timeoutMs = BASELINE_REQUEST_TIMEOUT_MS) {
  const params = new URLSearchParams({
    where: `portname='${portname.replace(/'/g, "''")}' AND date >= ${epochToTimestamp(fromEpoch)} AND date < ${epochToTimestamp(toEpoch)}`,
    outStatistics: JSON.stringify([
      { statisticType: 'avg', onStatisticField: 'n_total', outStatisticFieldName: 'avg_total' },
      { statisticType: 'count', onStatisticField: 'n_total', outStatisticFieldName: 'day_count' },
    ]),
    f: 'json',
  });
  const resp = await fetch(`${ARCGIS_BASE}?${params}`, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${portname} baseline`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS baseline error for ${portname}: ${body.error.message}`);
  return body.features?.[0]?.attributes ?? null;
}

/**
 * `{ avgDaily, days, from, to }` from an outStatistics row, or null when the
 * window holds fewer than BASELINE_MIN_DAYS published days or the row is
 * malformed. Null is stored as-is: consumers withhold the comparison rather
 * than compare against a partial year.
 */
export function buildBaseline(stats, window) {
  const avg = Number(stats?.avg_total);
  const days = Number(stats?.day_count);
  if (!Number.isFinite(avg) || avg < 0 || !Number.isInteger(days) || days < BASELINE_MIN_DAYS) return null;
  return { avgDaily: Math.round(avg * 10) / 10, days, from: window.from, to: window.to };
}

export function buildHistory(features) {
  return features
    .filter(f => f.attributes?.date)
    .map(f => {
      const a = f.attributes;
      const container = Number(a.n_container ?? 0);
      const dryBulk = Number(a.n_dry_bulk ?? 0);
      const generalCargo = Number(a.n_general_cargo ?? 0);
      const roro = Number(a.n_roro ?? 0);
      const tanker = Number(a.n_tanker ?? 0);
      const total = Number(a.n_total ?? container + dryBulk + generalCargo + roro + tanker);
      return {
        date: formatDate(a.date),
        container, dryBulk, generalCargo, roro, tanker,
        cargo: container + dryBulk + generalCargo + roro,
        other: 0,
        total,
        capContainer: Number(a.capacity_container ?? 0),
        capDryBulk: Number(a.capacity_dry_bulk ?? 0),
        capGeneralCargo: Number(a.capacity_general_cargo ?? 0),
        capRoro: Number(a.capacity_roro ?? 0),
        capTanker: Number(a.capacity_tanker ?? 0),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const CSV_NUMERIC_FIELDS = [
  'n_container', 'n_dry_bulk', 'n_general_cargo', 'n_roro', 'n_tanker', 'n_total',
  'capacity_container', 'capacity_dry_bulk', 'capacity_general_cargo', 'capacity_roro', 'capacity_tanker',
];

/**
 * The chokepoint records from the Hub CSV export, in the shape
 * runFetchPipeline returns. Rows become the query service's features (its
 * DateOnly `date` comes back as YYYY-MM-DD), so history and WoW go through
 * buildHistory and computeWow unchanged, and the baseline is the outStatistics
 * avg/count of n_total over the same window. The export has no quoted fields,
 * and a quoted comma could only shift columns in an untracked port's row.
 * Throws when the header or every chokepoint's history is missing, so the
 * caller can fall back to the query service.
 */
export function chokepointsFromCsv(text, sinceEpoch, window) {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const columns = lines[0].trim().split(',');
  const col = Object.fromEntries(columns.map((name, i) => [name, i]));
  for (const name of ['date', 'portname', ...CSV_NUMERIC_FIELDS]) {
    if (!(name in col)) throw new Error(`CSV export missing column ${name}`);
  }
  const idByName = new Map(CHOKEPOINTS.map(cp => [cp.name, cp.id]));
  const sinceDay = formatDate(sinceEpoch);
  const baselineEndDay = formatDate(window.toEpoch);
  const features = {};
  const baselineTotals = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const id = idByName.get(cells[col.portname]);
    if (!id) continue;
    // A cut-off or non-numeric row would publish NaN counts; reject the
    // export so the caller falls back to the query service.
    if (cells.length < columns.length || CSV_NUMERIC_FIELDS.some(name => cells[col[name]] !== '' && !Number.isFinite(Number(cells[col[name]])))) {
      throw new Error(`CSV export has a malformed row for ${cells[col.portname]}`);
    }
    const date = cells[col.date].replaceAll('/', '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || formatDate(Date.parse(`${date}T00:00:00Z`)) !== date) {
      throw new Error(`CSV export has an invalid date for ${cells[col.portname]}`);
    }
    if (date >= window.from && date < baselineEndDay && cells[col.n_total] !== '') {
      (baselineTotals[id] ??= []).push(Number(cells[col.n_total]));
    }
    if (date < sinceDay) continue;
    const attributes = { date };
    for (const name of CSV_NUMERIC_FIELDS) attributes[name] = cells[col[name]] === '' ? null : Number(cells[col[name]]);
    (features[id] ??= []).push({ attributes });
  }
  const result = {};
  for (const [id, rows] of Object.entries(features)) {
    const history = buildHistory(rows);
    const totals = baselineTotals[id] ?? [];
    const stats = { avg_total: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null, day_count: totals.length };
    result[id] = { history, wowChangePct: computeWow(history), baseline: buildBaseline(stats, window) };
  }
  if (Object.keys(result).length === 0) throw new Error('CSV export has no chokepoint rows in the history window');
  return result;
}

async function fetchCsvExport(fetchDeadlineAtMs) {
  const timeoutMs = Number.isFinite(fetchDeadlineAtMs)
    ? Math.max(0, Math.min(CSV_TIMEOUT_MS, fetchDeadlineAtMs - Date.now()))
    : CSV_TIMEOUT_MS;
  const resp = await fetch(CSV_EXPORT_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Run the chokepoint fetch pipeline with batched concurrency + sequential
 * retry-on-empty. Extracted so tests can inject a mock `fetchPagesFn`
 * without hitting the real ArcGIS API.
 *
 * Retry rationale (PR #3611, 2026-05-06):
 *
 * The previous implementation silently dropped any chokepoint whose
 * upstream fetch returned `{features: []}` (empty 200) — a class of
 * transient failure that ArcGIS produces under per-egress-IP rate limits.
 * The pattern was bursty: 2 of 3 chokepoints in the same Promise.allSettled
 * batch came back empty, with no log line and no retry, while a manual
 * fetch from any other IP returned 179 features for the same query. The
 * 0-record outcome propagated through `seedTransitSummaries` (ais-relay.cjs)
 * → `dataAvailable: Boolean(cpData)` flipped false → /api/health flagged
 * `chokepoints: COVERAGE_PARTIAL`.
 *
 * Two changes here:
 *   1. **Log on empty**: surface the silent-drop path so Railway logs
 *      tell us which chokepoint(s) returned 0 features, and how often.
 *   2. **Sequential retry pass**: any chokepoint that came back empty
 *      OR rejected on the concurrent first pass gets retried alone with
 *      a small delay — stepping out of any rate-limit window the
 *      concurrent batch may have hit. Recovers transients without
 *      changing the steady-state code path.
 *
 * The retry is intentionally "1 attempt" — a permanent ArcGIS issue
 * for a given chokepoint should still surface as missing in seed-meta
 * recordCount so /api/health can flag it.
 *
 * Baselines run as a third pass over the chokepoints that have history, with
 * the same batch concurrency and one sequential retry. A baseline failure
 * stores `baseline: null` and never drops the chokepoint: the daily history
 * is the primary record and the baseline only qualifies it.
 */
export async function runFetchPipeline(
  chokepoints,
  sinceEpoch,
  fetchPagesFn,
  retryDelayMs = 500,
  { fetchBaselineFn = null, baselineWindow: window = null, baselineBudgetMs: budgetOverride = null, fetchDeadlineAtMs = null } = {},
) {
  const result = {};
  const missing = [];

  // First pass: concurrent batches.
  for (let i = 0; i < chokepoints.length; i += CONCURRENCY) {
    const batch = chokepoints.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(cp => fetchPagesFn(cp.name, sinceEpoch)));
    for (let j = 0; j < batch.length; j++) {
      const outcome = settled[j];
      const cp = batch[j];
      if (outcome.status === 'rejected') {
        console.warn(`  [PortWatch] ${cp.name}: rejected — ${outcome.reason?.message || outcome.reason}`);
        missing.push(cp);
        continue;
      }
      if (!outcome.value.length) {
        // Empty 200 — most often ArcGIS rate limit or transient. Queue for retry.
        console.warn(`  [PortWatch] ${cp.name}: 0 features (empty 200) — queued for retry`);
        missing.push(cp);
        continue;
      }
      const history = buildHistory(outcome.value);
      result[cp.id] = { history, wowChangePct: computeWow(history), baseline: null };
    }
  }

  // Second pass: sequential retry of any chokepoint that came back empty or rejected.
  // Sequential (not concurrent) to step out of any rate-limit burst from the first pass.
  if (missing.length > 0) {
    console.warn(`[PortWatch] Retrying ${missing.length} chokepoint(s) sequentially: ${missing.map(c => c.id).join(', ')}`);
    for (const cp of missing) {
      if (retryDelayMs > 0) await new Promise(r => setTimeout(r, retryDelayMs));
      try {
        const features = await fetchPagesFn(cp.name, sinceEpoch);
        if (features.length === 0) {
          console.warn(`  [PortWatch] ${cp.name}: still 0 features after retry — dropping`);
          continue;
        }
        const history = buildHistory(features);
        result[cp.id] = { history, wowChangePct: computeWow(history), baseline: null };
        console.log(`  [PortWatch] ${cp.name}: recovered ${features.length} features on retry`);
      } catch (e) {
        console.warn(`  [PortWatch] ${cp.name}: retry rejected — ${e?.message || e}`);
      }
    }
  }

  if (fetchBaselineFn && window) {
    // Measured after the history passes, so slow history shrinks the budget.
    const budget = Number.isFinite(budgetOverride) ? budgetOverride : baselineBudgetMs(fetchDeadlineAtMs);
    await attachBaselines(result, chokepoints, fetchBaselineFn, window, retryDelayMs, budget);
  }

  return result;
}

// Settles within `ms` even if the request ignores its own timeout, so the
// baseline budget is a wall-clock bound.
function withinMs(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`baseline budget exhausted after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function attachBaselines(result, chokepoints, fetchBaselineFn, window, retryDelayMs, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  const request = (cp) => {
    const ms = Math.min(BASELINE_REQUEST_TIMEOUT_MS, remaining());
    return withinMs(fetchBaselineFn(cp.name, window, ms), ms);
  };
  const covered = chokepoints.filter(cp => result[cp.id]);
  const failed = [];
  const store = (cp, stats) => {
    const baseline = buildBaseline(stats, window);
    result[cp.id].baseline = baseline;
    if (!baseline) {
      console.warn(`  [PortWatch] ${cp.name}: baseline withheld — ${Number(stats?.day_count) || 0} published days in ${window.from}..${window.to} (need ${BASELINE_MIN_DAYS})`);
    }
  };
  const skip = (cps) => {
    if (cps.length) console.warn(`[PortWatch] Baseline budget (${budgetMs}ms) spent; history kept, baseline null for: ${cps.map(cp => cp.id).join(', ')}`);
  };

  for (let i = 0; i < covered.length; i += CONCURRENCY) {
    if (remaining() <= 0) { skip(covered.slice(i)); return; }
    const batch = covered.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(request));
    for (let j = 0; j < batch.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'rejected') {
        console.warn(`  [PortWatch] ${batch[j].name}: baseline rejected — ${outcome.reason?.message || outcome.reason}`);
        failed.push(batch[j]);
        continue;
      }
      store(batch[j], outcome.value);
    }
  }

  for (const [k, cp] of failed.entries()) {
    if (retryDelayMs > 0) await new Promise(r => setTimeout(r, Math.min(retryDelayMs, Math.max(0, remaining()))));
    if (remaining() <= 0) { skip(failed.slice(k)); return; }
    try {
      store(cp, await request(cp));
    } catch (e) {
      console.warn(`  [PortWatch] ${cp.name}: baseline retry rejected — ${e?.message || e}; history kept, baseline null`);
    }
  }
}

// How long a chokepoint's last successful fetch may stand in for a failed one.
// Matches the energy:chokepoint-flows:v1 TTL, the longest window a consumer
// already accepts for this data. Each entry keeps its own fetchedAt, so an
// entry carried run after run still expires on schedule.
export const CARRY_FORWARD_MAX_AGE_MS = 3 * DAY_MS;

/**
 * Fill chokepoints this run failed to fetch from the previous snapshot.
 *
 * ArcGIS rejects a different subset of chokepoints on most runs. Publishing
 * only the survivors replaced the complete set, so a chokepoint that failed
 * once vanished downstream: chokepoint-flows lost its status, the relay wrote
 * zero-state rows, and seed-supply-vulnerability refused to publish (WM
 * 2026-10-31). A fresh entry always wins. A carried entry is marked
 * `carriedForward: true` and keeps its original fetchedAt. Legacy entries
 * without one are aged by the snapshot envelope; an entry with no provable
 * age is not carried.
 */
export function mergeWithPrevious(fresh, previous, chokepointIds, nowMs = Date.now()) {
  const result = { ...fresh };
  const carried = [];
  const expired = [];
  const absent = [];
  const keptNewer = [];
  const prior = previous?.data && typeof previous.data === 'object' ? previous.data : {};
  const snapshotFetchedAt = Number(previous?.meta?.fetchedAt);
  for (const id of chokepointIds) {
    const entry = prior[id];
    const fetchedAt = Number.isFinite(entry?.fetchedAt) ? entry.fetchedAt : snapshotFetchedAt;
    const carryable = entry?.history?.length > 0
      && Number.isFinite(fetchedAt) && nowMs - fetchedAt <= CARRY_FORWARD_MAX_AGE_MS;
    if (result[id]) {
      // The cached CSV export can trail a query-fallback run; never let it
      // move a chokepoint's history backward.
      const freshLast = result[id].history?.at(-1)?.date ?? '';
      if (carryable && entry.history.at(-1).date > freshLast) {
        result[id] = { ...entry, fetchedAt, carriedForward: true };
        keptNewer.push(id);
      }
      continue;
    }
    if (!entry?.history?.length) {
      absent.push(id);
      continue;
    }
    if (!carryable) {
      expired.push(id);
      continue;
    }
    result[id] = { ...entry, fetchedAt, carriedForward: true };
    carried.push(id);
  }
  return { result, carried, expired, absent, keptNewer };
}

const lastHistoryDate = entry => entry?.history?.at(-1)?.date ?? '';

async function fetchFresh(sinceEpoch, window, fetchDeadlineAtMs, prior) {
  try {
    const fresh = chokepointsFromCsv(await fetchCsvExport(fetchDeadlineAtMs), sinceEpoch, window);
    const noBaseline = Object.keys(fresh).filter(id => !fresh[id].baseline);
    console.log(`[PortWatch] source=hub-csv: ${Object.keys(fresh).length} chokepoints${noBaseline.length ? `, baseline withheld for ${noBaseline.join(', ')}` : ''}`);
    // Query what the export lacks, and what it trails: the cached export can
    // end before history an earlier query-fallback run already published.
    const candidates = CHOKEPOINTS.filter(cp => !fresh[cp.id] || lastHistoryDate(prior[cp.id]) > lastHistoryDate(fresh[cp.id]));
    if (candidates.length === 0) return fresh;
    console.warn(`[PortWatch] CSV export lacks or trails ${candidates.map(cp => cp.id).join(', ')}; querying ArcGIS for them`);
    const queried = await runFetchPipeline(candidates, sinceEpoch, fetchAllPages, 500, {
      fetchBaselineFn: fetchBaselineStats,
      baselineWindow: window,
      fetchDeadlineAtMs,
    });
    for (const [id, entry] of Object.entries(queried)) {
      if (lastHistoryDate(entry) > lastHistoryDate(fresh[id])) fresh[id] = entry;
    }
    return fresh;
  } catch (e) {
    console.warn(`[PortWatch] source=arcgis-query (csv failed: ${e?.message || e})`);
    return runFetchPipeline(CHOKEPOINTS, sinceEpoch, fetchAllPages, 500, {
      fetchBaselineFn: fetchBaselineStats,
      baselineWindow: window,
      fetchDeadlineAtMs,
    });
  }
}

export async function fetchAll({ fetchDeadlineAtMs = null } = {}) {
  const nowMs = Date.now();
  const sinceEpoch = nowMs - HISTORY_DAYS * DAY_MS;
  const previous = await readSeedSnapshot(CANONICAL_KEY, { strict: true, includeEnvelopeMeta: true });
  const prior = previous?.data && typeof previous.data === 'object' ? previous.data : {};
  const fresh = await fetchFresh(sinceEpoch, baselineWindow(nowMs), fetchDeadlineAtMs, prior);
  if (Object.keys(fresh).length === 0) throw new Error('No chokepoints returned data');
  for (const entry of Object.values(fresh)) entry.fetchedAt = nowMs;
  const { result, carried, expired, absent, keptNewer } = mergeWithPrevious(
    fresh,
    previous,
    CHOKEPOINTS.map(cp => cp.id),
    nowMs,
  );
  if (carried.length > 0) {
    console.warn(`[PortWatch] Carried ${carried.length} chokepoint(s) from the previous snapshot: ${carried.join(', ')}`);
  }
  if (expired.length > 0) {
    console.warn(`[PortWatch] Previous entry too old to carry (>${CARRY_FORWARD_MAX_AGE_MS / DAY_MS}d), dropping: ${expired.join(', ')}`);
  }
  if (keptNewer.length > 0) {
    console.warn(`[PortWatch] Previous history is newer than this run, keeping it: ${keptNewer.join(', ')}`);
  }
  if (absent.length > 0) {
    console.warn(`[PortWatch] No previous entry to carry, missing from this publish: ${absent.join(', ')}`);
  }
  console.log(`[PortWatch] ${Object.keys(fresh).length} fresh + ${carried.length} carried of ${CHOKEPOINTS.length} chokepoints`);
  return result;
}

export function validateFn(data) {
  return data && typeof data === 'object' && Object.keys(data).length >= 5;
}

const isMain = process.argv[1]?.endsWith('seed-portwatch.mjs');
export function declareRecords(data) {
  return data && typeof data === "object" ? Object.keys(data).length : 0;
}

if (isMain) {
  runSeed('supply_chain', 'portwatch', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'imf-portwatch-arcgis-v1',
    recordCount: (data) => Object.keys(data).length,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 720,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
