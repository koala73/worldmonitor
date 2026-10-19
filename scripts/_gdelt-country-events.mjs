// Per-country GDELT conflict and protest volume for every country, as daily
// buckets plus each country's own trailing baseline. The CII scores the excess
// over that baseline for its Conflict and Unrest components while ACLED is
// unavailable (WorldMonitor has no ACLED access).
//
// The row-level conflict feed (gdelt:bulk:conflict-events:v1) keeps only the
// crisis-registry countries: replaying October 2026 exports showed a worldwide
// row feed is ~3,700 rows a day, and GDELT codes so much US crime and policing
// as material conflict that the US out-reports Ukraine's war several times over
// on every static measure tried (raw outlets, conflict share, war-only CAMEO
// codes). Protest coverage has the same skew. Comparing each country with its
// own recent norm removes that media-volume bias, so this module keeps counts
// for all countries and lets the CII score the excess.
//
// Same day-bucket and repair design as _gdelt-dyad-tension.mjs: the live tick
// adds new 15-minute cohorts behind a cursor; past days that are missing or
// incomplete are rebuilt from the public export archive, a bounded number per
// tick, so a fresh deploy reaches a full baseline in hours rather than weeks.

import { GDELT_PUBLICATION_LEAD_MS, gdeltTimestampToMs } from './_conflict-gdelt-bulk.mjs';
import { GDELT_FIPS_TO_ISO2 } from './_gdelt-country-codes.mjs';
import { dyadDayExportTimestamps } from './_gdelt-dyad-tension.mjs';

const DAY_MS = 86_400_000;
const COHORTS_PER_DAY = 96;
const MATERIAL_VIOLENCE_ROOT_CODES = new Set(['18', '19', '20']);
// CAMEO 14: demonstrate, hunger strike, strike/boycott, obstruct, violent protest.
const PROTEST_ROOT_CODE = '14';
// Per-country counter layout: [articles, conflictArticles, protestArticles].
const COUNTER_FIELDS = 3;
const CONFLICT = 1;
const PROTEST = 2;

// Days kept: today, yesterday, and the 28-day baseline before yesterday.
export const COUNTRY_EVENTS_BASELINE_DAYS = 28;
export const COUNTRY_EVENTS_HISTORY_DAYS = COUNTRY_EVENTS_BASELINE_DAYS + 2;
// A baseline needs three weeks of complete days; fewer is not a norm.
export const COUNTRY_EVENTS_MIN_BASELINE_DAYS = 21;
// Same backoff as dyad repair: a failed day waits 24 runs before a retry.
export const COUNTRY_EVENTS_REPAIR_BACKOFF_MS = 6 * 60 * 60 * 1000;

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One export cohort → { ISO2: [articles, conflictArticles, protestArticles] },
 * counting distinct source articles (GDELT codes several root events per
 * article) located in each country. Conflict is QuadClass 4 with CAMEO root
 * 18/19/20, the same filter as the row-level conflict feed; protest is CAMEO
 * root 14.
 */
export function parseCountryEventsExport(csv) {
  const sets = new Map();
  for (const line of String(csv || '').split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 61 || fields[25] !== '1') continue;
    const iso2 = GDELT_FIPS_TO_ISO2[fields[53]];
    if (!iso2) continue;
    const article = fields[60].trim() || fields[0];
    if (!article) continue;
    if (!sets.has(iso2)) sets.set(iso2, [new Set(), new Set(), new Set()]);
    const counters = sets.get(iso2);
    counters[0].add(article);
    if (fields[29] === '4' && MATERIAL_VIOLENCE_ROOT_CODES.has(fields[28])) counters[CONFLICT].add(article);
    if (fields[28] === PROTEST_ROOT_CODE) counters[PROTEST].add(article);
  }
  return Object.fromEntries([...sets].map(([iso2, counters]) => [iso2, counters.map((set) => set.size)]));
}

function addCounts(target, counts) {
  for (const [iso2, values] of Object.entries(counts ?? {})) {
    if (!Array.isArray(values)) continue;
    const current = target[iso2] ?? Array(COUNTER_FIELDS).fill(0);
    target[iso2] = current.map((total, i) => total + (Number(values[i]) || 0));
  }
}

function historyWindow(nowMs) {
  return Array.from({ length: COUNTRY_EVENTS_HISTORY_DAYS }, (_, i) => utcDate(nowMs - i * DAY_MS));
}

/**
 * Add new live cohorts to their UTC day. The cursor travels in the same
 * snapshot as the buckets, so replaying a cohort after a failed cursor write
 * cannot count it twice.
 */
export function mergeCountryEventsBuckets(previous, batches, nowMs = Date.now()) {
  const keep = new Set(historyWindow(nowMs));
  const days = {};
  for (const [date, day] of Object.entries(previous?.days ?? {})) {
    if (keep.has(date)) days[date] = structuredClone(day);
  }
  let cursor = typeof previous?.cursor === 'string' ? previous.cursor : '';
  for (const batch of [...batches].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (batch.timestamp <= cursor) continue;
    const timestampMs = gdeltTimestampToMs(batch.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > nowMs + GDELT_PUBLICATION_LEAD_MS) {
      throw new Error('Invalid country-events cohort timestamp');
    }
    const date = utcDate(timestampMs);
    if (keep.has(date)) {
      const day = days[date] ??= { cohorts: 0, countries: {} };
      day.cohorts += 1;
      addCounts(day.countries, batch.countries);
    }
    cursor = batch.timestamp;
  }
  return { cursor, days };
}

// Past days that are missing or incomplete and that the live merge can no
// longer touch (strictly before the cursor's day), newest first.
function repairableDates(snapshot, nowMs) {
  const cursor = snapshot?.cursor ?? '';
  if (!/^\d{14}$/.test(cursor)) return [];
  const cursorDate = `${cursor.slice(0, 4)}-${cursor.slice(4, 6)}-${cursor.slice(6, 8)}`;
  return historyWindow(nowMs)
    .slice(1)
    .filter((date) => date < cursorDate && snapshot.days?.[date]?.cohorts !== COHORTS_PER_DAY);
}

export function planCountryEventsRepair(snapshot, nowMs, maxDays) {
  const failures = snapshot?.repairFailures ?? {};
  return repairableDates(snapshot, nowMs)
    .filter((date) => {
      const failedAt = Number(failures[date]);
      return !Number.isFinite(failedAt) || nowMs - failedAt >= COUNTRY_EVENTS_REPAIR_BACKOFF_MS;
    })
    .slice(0, Math.max(0, maxDays));
}

/** Sum one UTC day from exactly its 96 source cohorts; replaces the stored day. */
export function rebuildCountryEventsDay(date, batches) {
  const expected = new Set(dyadDayExportTimestamps(date));
  const seen = new Set(batches.map((batch) => batch.timestamp));
  if (batches.length !== COHORTS_PER_DAY || seen.size !== COHORTS_PER_DAY
    || [...seen].some((timestamp) => !expected.has(timestamp))) {
    throw new Error(`Country-conflict rebuild for ${date} needs its 96 distinct cohorts`);
  }
  const day = { cohorts: COHORTS_PER_DAY, countries: {} };
  for (const batch of batches) addCounts(day.countries, batch.countries);
  return day;
}

export function replaceCountryEventsDays(snapshot, rebuilt, nowMs, failures = {}) {
  const eligible = new Set(repairableDates(snapshot, nowMs));
  const days = structuredClone(snapshot.days ?? {});
  for (const [date, day] of Object.entries(rebuilt ?? {})) {
    if (eligible.has(date) && day?.cohorts === COHORTS_PER_DAY) days[date] = day;
  }
  const { repairFailures: previousFailures, ...rest } = snapshot;
  const stillRepairable = new Set(repairableDates({ ...snapshot, days }, nowMs));
  const repairFailures = Object.fromEntries(Object.entries({ ...previousFailures, ...failures })
    .filter(([date, failedAt]) => stillRepairable.has(date) && Number.isFinite(failedAt)));
  return Object.keys(repairFailures).length ? { ...rest, days, repairFailures } : { ...rest, days };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-country summary the CII reads, for conflict and protest alike.
 *
 * `current` is the last 24 hours of articles: today's partial day plus the
 * matching share of yesterday (yesterday's count scaled to the cohorts today
 * has not covered yet). `baselineMedian` is the median daily count over the 28
 * complete days before yesterday, so the current spike never sits in its own
 * norm. A day with fewer than 96 cohorts is excluded rather than read as calm;
 * under 21 complete days there is no baseline at all.
 */
export function summarizeCountryEvents(snapshot, nowMs = Date.now()) {
  const days = snapshot?.days ?? {};
  const today = days[utcDate(nowMs)];
  const yesterday = days[utcDate(nowMs - DAY_MS)];
  const todayCohorts = Math.min(COHORTS_PER_DAY, today?.cohorts ?? 0);
  const yesterdayShare = yesterday?.cohorts > 0
    ? Math.min(1, (COHORTS_PER_DAY - todayCohorts) / yesterday.cohorts)
    : 0;
  const currentCohorts = todayCohorts + Math.round(yesterdayShare * (yesterday?.cohorts ?? 0));
  const baselineDates = Array.from(
    { length: COUNTRY_EVENTS_BASELINE_DAYS },
    (_, i) => utcDate(nowMs - (i + 2) * DAY_MS),
  ).filter((date) => days[date]?.cohorts === COHORTS_PER_DAY);
  const baselineReady = baselineDates.length >= COUNTRY_EVENTS_MIN_BASELINE_DAYS;

  const codes = new Set([
    ...Object.keys(today?.countries ?? {}),
    ...Object.keys(yesterday?.countries ?? {}),
    ...baselineDates.flatMap((date) => Object.keys(days[date].countries ?? {})),
  ]);
  const signal = (iso2, field) => {
    const current = (today?.countries?.[iso2]?.[field] ?? 0)
      + yesterdayShare * (yesterday?.countries?.[iso2]?.[field] ?? 0);
    const baselineMedian = baselineReady
      ? median(baselineDates.map((date) => days[date].countries?.[iso2]?.[field] ?? 0))
      : null;
    return { current: Math.round(current * 10) / 10, baselineMedian };
  };
  const byCountry = {};
  for (const iso2 of [...codes].sort()) {
    const conflict = signal(iso2, CONFLICT);
    const protest = signal(iso2, PROTEST);
    if (!conflict.current && !conflict.baselineMedian && !protest.current && !protest.baselineMedian) continue;
    byCountry[iso2] = { conflict, protest };
  }
  return {
    byCountry,
    currentCohorts,
    baselineDays: baselineDates.length,
    baselineReady,
    minBaselineDays: COUNTRY_EVENTS_MIN_BASELINE_DAYS,
  };
}
