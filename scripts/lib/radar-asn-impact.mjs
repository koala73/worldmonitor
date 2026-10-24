// National impact of an ASN-attributed Cloudflare Radar outage.
//
// Radar files some outage annotations against networks (ASNs) and no country.
// The CII counts such an outage for the country Radar places the ASN in only
// when it disrupted more than CII_OUTAGE_ASN_NATIONAL_SHARE of that country's
// Internet (server/worldmonitor/intelligence/v1/_risk-config.ts). This module
// measures that fraction from Radar's own traffic data, never from text:
//
//   impact = sum over the annotation's ASNs in the country of
//            share(ASN of the country's traffic, the 7 days before the outage)
//          x drop(ASN's own traffic during the outage vs the same hours a week earlier)
//
// Limits, kept visible on each record:
//  - The share is NetFlows bytes seen by Cloudflare, not users; Radar lists
//    the top 100 ASes per country, so an ASN outside that list is bounded by
//    the smallest listed share and the impact is an upper bound.
//  - The drop compares with the same hours one week earlier, so a holiday or
//    a recurring outage a week before distorts it.
//  - Hourly buckets dilute an outage much shorter than an hour; outages under
//    six hours are read in 15-minute buckets.
// The country's own traffic drop was rejected as the measure: on the year to
// 2026-10-23 it moved by -30% to +32% around ASN outages that carried 1-3% of
// the country's traffic, so it attributes unrelated swings to the outage.

export const ASN_IMPACT_MEASURE = 'asn-traffic-share-x-drop';

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const TOP_ASES_LIMIT = 100;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The annotation's ASNs grouped by the country Radar places each ASN in; ASNs with no country are left out. */
export function asnCountryGroups(annotation) {
  const groups = new Map();
  for (const detail of annotation?.asnsDetails ?? []) {
    const code = String(detail?.location?.code ?? '').toUpperCase();
    const asn = Number(detail?.asn);
    if (!/^[A-Z]{2}$/.test(code) || !Number.isInteger(asn) || asn <= 0) continue;
    if (!groups.has(code)) groups.set(code, { countryCode: code, countryName: detail.location.name || code, asns: [], asnNames: [] });
    const group = groups.get(code);
    group.asns.push(asn);
    group.asnNames.push(String(detail.name ?? ''));
  }
  return [...groups.values()];
}

/** A Radar number: a finite number or numeric string. null, '', undefined and text are missing, never 0. */
export function radarNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 1 - traffic during [startMs, endMs) / traffic in the same buckets of the
 * week before the outage began, from one Radar timeseries spanning both.
 * Clamped to [0, 1]: traffic above the baseline is no disruption.
 *
 * Returns `{ drop }`, or `{ drop: null, reason }` when the measure cannot be
 * taken: every bucket of the window, and its baseline a week earlier, must
 * hold a number. The window stops at the series' last published bucket, so an
 * ongoing outage is read up to the data Radar has; a gap before that is
 * missing data, not a drop.
 */
export function trafficDrop(result, startMs, endMs, stepMs) {
  const timestamps = result?.serie_0?.timestamps;
  const values = result?.serie_0?.values;
  if (!Array.isArray(timestamps) || !Array.isArray(values) || timestamps.length !== values.length) {
    return { drop: null, reason: 'timeseries missing or malformed' };
  }
  const at = new Map();
  for (let i = 0; i < timestamps.length; i++) at.set(Date.parse(timestamps[i]), radarNumber(values[i]));
  const published = Math.max(-Infinity, ...at.keys()) + stepMs;
  const windowEnd = Math.min(endMs, published);
  let during = 0;
  let before = 0;
  let buckets = 0;
  const first = Math.floor(startMs / stepMs) * stepMs;
  for (let t = first; t < windowEnd; t += stepMs) {
    // The same bucket of the week before the outage began, however long the
    // outage has lasted: a week-earlier bucket inside the outage is no baseline.
    const base = t - WEEK_MS * (Math.floor((t - first) / WEEK_MS) + 1);
    const now = at.has(t) ? at.get(t) : null;
    const then = at.has(base) ? at.get(base) : null;
    if (now == null) return { drop: null, reason: `missing outage sample at ${new Date(t).toISOString()}` };
    if (then == null) return { drop: null, reason: `missing baseline sample at ${new Date(base).toISOString()}` };
    during += now;
    before += then;
    buckets++;
  }
  if (buckets === 0) return { drop: null, reason: 'no samples in the outage window' };
  if (before <= 0) return { drop: null, reason: 'zero baseline traffic' };
  return { drop: Math.min(1, Math.max(0, 1 - during / before)) };
}

/**
 * Measures one country group of an ASN outage. `get(path)` returns a Radar
 * `result` object or throws. Never throws: a failure is an unknown impact.
 */
export async function measureAsnNationalImpact({ get, countryCode, asns, startMs, endMs, nowMs }) {
  const unknown = (reason) => ({ measure: ASN_IMPACT_MEASURE, nationalImpact: null, impactIsUpperBound: false, unknownReason: reason });
  if (!Number.isFinite(startMs) || startMs <= 0) return unknown('no start time');
  const end = Math.min(Number.isFinite(endMs) && endMs > startMs ? endMs : nowMs, nowMs);
  if (!(end > startMs)) return unknown('outage has not started');
  const step = end - startMs < 6 * HOUR_MS ? QUARTER_MS : HOUR_MS;
  const from = Math.floor(startMs / step) * step;
  // Radar refuses a dateEnd at or after now (HTTP 400 "Must be before now").
  const latest = Math.floor((nowMs - 60_000) / 60_000) * 60_000;
  const to = Math.min(Math.ceil(end / step) * step, latest);
  if (!(to > from)) return unknown('no published data for the outage yet');
  try {
    const top = await get(`/radar/netflows/top/ases?location=${countryCode}&dateStart=${iso(from - WEEK_MS)}&dateEnd=${iso(from)}&limit=${TOP_ASES_LIMIT}&format=json`);
    if (!Array.isArray(top?.top_0)) return unknown('top ASes missing');
    const shareOf = new Map();
    let smallest = Infinity;
    for (const row of top.top_0) {
      const asn = Number(row?.clientASN);
      const value = radarNumber(row?.value);
      if (!Number.isInteger(asn)) continue;
      shareOf.set(asn, value == null ? null : value / 100);
      if (value != null) smallest = Math.min(smallest, value / 100);
    }
    let impact = 0;
    let upperBound = false;
    const parts = [];
    for (const asn of asns) {
      let share;
      if (shareOf.has(asn)) {
        share = shareOf.get(asn);
        if (share == null) return unknown(`share missing for AS${asn}`);
      } else {
        // Not among the listed ASes: its share is at most the smallest listed one.
        if (!Number.isFinite(smallest)) return unknown(`AS${asn} not listed and no listed share to bound it`);
        share = smallest;
        upperBound = true;
      }
      const agg = step === QUARTER_MS ? '15m' : '1h';
      const series = await get(`/radar/netflows/timeseries?asn=${asn}&dateStart=${iso(from - WEEK_MS)}&dateEnd=${iso(to)}&aggInterval=${agg}&format=json`);
      const { drop, reason } = trafficDrop(series, startMs, end, step);
      if (drop == null) return unknown(`AS${asn}: ${reason}`);
      impact += share * drop;
      parts.push({ asn, share, drop });
    }
    return { measure: ASN_IMPACT_MEASURE, nationalImpact: Math.min(1, impact), impactIsUpperBound: upperBound, parts };
  } catch (err) {
    return unknown(String(err?.message || err).slice(0, 120));
  }
}

// ------------------------------------------------------------------------
// The impact measure is optional work inside the seeder's fetch phase: it
// must never cost the outage publish. All of it shares one wall-clock budget,
// cut to what runSeed's fetch deadline leaves minus a margin; an ASN still
// unmeasured when the budget runs out is published with impact unknown
// (`impactUnknownReason: 'budget'`).
// ------------------------------------------------------------------------

export const ASN_IMPACT_BUDGET_MS = 60_000;
/**
 * Only ASN outages that can score are measured: the CII's scored causes and
 * scoring window (CII_OUTAGE_SCORED_CAUSES, CII_OUTAGE_WINDOW_MS in
 * server/worldmonitor/intelligence/v1/_risk-config.ts; the seeder cannot
 * import TypeScript, so tests/cii-outages-asn.test.mts pins these copies).
 */
export const ASN_IMPACT_CAUSES = Object.freeze(['GOVERNMENT_DIRECTED', 'MILITARY_ACTION']);
export const ASN_IMPACT_WINDOW_MS = 7 * 24 * HOUR_MS;
const ASN_IMPACT_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Left between the end of the impact pass and runSeed's fetch deadline. */
export const ASN_IMPACT_DEADLINE_MARGIN_MS = 5_000;
export const ASN_IMPACT_REQUEST_TIMEOUT_MS = 15_000;
export const ASN_IMPACT_CONCURRENCY = 4;

/** The impact budget: ASN_IMPACT_BUDGET_MS, cut to what the fetch deadline leaves minus the margin. 0 skips the pass. */
export function asnImpactBudgetMs(fetchDeadlineAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(fetchDeadlineAtMs)) return ASN_IMPACT_BUDGET_MS;
  return Math.max(0, Math.min(ASN_IMPACT_BUDGET_MS, fetchDeadlineAtMs - nowMs - ASN_IMPACT_DEADLINE_MARGIN_MS));
}

/** Why a job is not worth measuring now, or null when it can score. */
function notMeasuredReason(job, nowMs) {
  if (!ASN_IMPACT_CAUSES.includes(String(job.cause || '').toUpperCase())) return 'not measured: cause out of construct';
  const start = Number(job.startMs);
  if (!Number.isFinite(start) || start <= 0 || start > nowMs + ASN_IMPACT_FUTURE_SKEW_MS) return 'not measured: outside the window';
  const end = Number(job.endMs);
  const lastActive = Number.isFinite(end) && end > 0 ? Math.min(end, nowMs) : nowMs;
  return lastActive < nowMs - ASN_IMPACT_WINDOW_MS ? 'not measured: outside the window' : null;
}

/**
 * Measures each job ({ countryCode, asns, cause, startMs, endMs }) with at
 * most `concurrency` in flight, inside one `budgetMs` wall clock.
 * `getWithTimeout(path, ms)` performs one Radar GET bounded by `ms`.
 *  - Only jobs that can score are measured (ASN_IMPACT_CAUSES, inside
 *    ASN_IMPACT_WINDOW_MS), newest start first; the rest resolve as unknown
 *    with a 'not measured: ...' reason and cost no request.
 *  - Settles within the budget even when a request ignores its timeout; every
 *    job still running then, or never started, resolves as unknown 'budget'.
 * Results keep job order.
 */
export async function measureAsnImpactsWithinBudget(jobs, { getWithTimeout, budgetMs, nowMs, concurrency = ASN_IMPACT_CONCURRENCY }) {
  const budgetUnknown = { measure: ASN_IMPACT_MEASURE, nationalImpact: null, impactIsUpperBound: false, unknownReason: 'budget' };
  const results = jobs.map((job) => {
    const reason = notMeasuredReason(job, nowMs);
    return reason ? { ...budgetUnknown, unknownReason: reason } : budgetUnknown;
  });
  const queue = jobs.map((_job, i) => i)
    .filter((i) => results[i] === budgetUnknown)
    .sort((a, b) => Number(jobs[b].startMs) - Number(jobs[a].startMs));
  if (queue.length === 0 || !(budgetMs > 0)) return results;
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  let next = 0;
  const worker = async () => {
    while (next < queue.length && remaining() > 0) {
      const i = queue[next++];
      const get = (path) => {
        const ms = Math.min(ASN_IMPACT_REQUEST_TIMEOUT_MS, remaining());
        if (ms <= 0) return Promise.reject(new Error('budget'));
        return getWithTimeout(path, ms);
      };
      results[i] = await measureAsnNationalImpact({ get, ...jobs[i], nowMs });
      if (results[i].unknownReason && remaining() <= 0) results[i] = budgetUnknown;
    }
  };
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
  const pool = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  await Promise.race([pool, expiry]).finally(() => clearTimeout(timer));
  // Snapshot: a job that finishes after the budget is not published.
  return results.slice();
}
