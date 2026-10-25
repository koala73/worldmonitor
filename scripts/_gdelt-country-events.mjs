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
// for all countries and lets the CII score the excess. A crisis that lasts
// weeks raises that norm, so each country also carries its raw counts for the
// seven complete days through yesterday (`week`); the CII scores the share of
// them that is conflict- or protest-coded, where media volume cancels out.
//
// Same day-bucket and repair design as _gdelt-dyad-tension.mjs: the live tick
// adds new 15-minute cohorts behind a cursor; past days that are missing or
// incomplete are rebuilt from the public export archive, a bounded number per
// tick, so a fresh deploy reaches a full baseline in hours rather than weeks.
//
// The fourth counter (since CII v12) is kinetic strikes that hit the country: CAMEO
// 194 (artillery, tanks) and 195 (aerial weapons: air, drone and missile
// strikes) where the target (Actor2) is the country the event is located in.
// GDELT geocodes many war stories to their dateline, so without the target
// test the US files more "strikes" a day than Ukraine (Oct 5-18 2026: 12.9 vs
// 11.1 articles) and Moscow collects Russia's strikes on Ukraine. With it, the
// US drops to 1.5 a day (0.03% of its coverage) and Ukraine keeps 4.2 (1.2%).
// 190 (conventional force) and 193 (small arms) stay out: they are the US
// crime and policing noise. Days stored before this counter carry three
// fields; they are rebuilt from the archive like any incomplete day, and until
// then they are unknown for strikes, never zero.

import { GDELT_PUBLICATION_LEAD_MS, gdeltTimestampToMs } from './_conflict-gdelt-bulk.mjs';
import { GDELT_FIPS_TO_ISO2 } from './_gdelt-country-codes.mjs';
import { dyadDayExportTimestamps } from './_gdelt-dyad-tension.mjs';
import ISO3_TO_ISO2 from './shared/iso3-to-iso2.json' with { type: 'json' };

const DAY_MS = 86_400_000;
const COHORTS_PER_DAY = 96;
const MATERIAL_VIOLENCE_ROOT_CODES = new Set(['18', '19', '20']);
// CAMEO 14: demonstrate, hunger strike, strike/boycott, obstruct, violent protest.
const PROTEST_ROOT_CODE = '14';
// CAMEO EventBaseCode 194 (artillery and tanks) and 195 (aerial weapons).
const STRIKE_BASE_CODES = new Set(['194', '195']);
// Per-country counter layout: [articles, conflictArticles, protestArticles, strikeArticles].
const COUNTER_FIELDS = 4;
const CONFLICT = 1;
const PROTEST = 2;
const STRIKE = 3;

// Days kept: today, yesterday, and the 28-day baseline before yesterday.
export const COUNTRY_EVENTS_BASELINE_DAYS = 28;
export const COUNTRY_EVENTS_HISTORY_DAYS = COUNTRY_EVENTS_BASELINE_DAYS + 2;
// A baseline needs three weeks of complete days; fewer is not a norm.
export const COUNTRY_EVENTS_MIN_BASELINE_DAYS = 21;
// The sustained level reads the seven days through yesterday; it needs five
// of them complete.
export const COUNTRY_EVENTS_WEEK_DAYS = 7;
export const COUNTRY_EVENTS_MIN_WEEK_DAYS = 5;
// Strike days: the 21 the CII decays (half-life 3 days, so day 21 weighs under
// 1%) and the six before them, which the CII's campaign rule reads to judge the
// oldest decayed days.
export const COUNTRY_EVENTS_STRIKE_DAYS = 27;
// A day is read for strikes once 4 hours of it are in: strikes are scored as a
// share of the day's coverage, which a partial day still estimates.
export const COUNTRY_EVENTS_STRIKE_MIN_COHORTS = 16;
// Same backoff as dyad repair: a failed day waits 24 runs before a retry.
export const COUNTRY_EVENTS_REPAIR_BACKOFF_MS = 6 * 60 * 60 * 1000;

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One export cohort → { ISO2: [articles, conflictArticles, protestArticles, strikeArticles] },
 * counting distinct source articles (GDELT codes several root events per
 * article) located in each country. Conflict is QuadClass 4 with CAMEO root
 * 18/19/20, the same filter as the row-level conflict feed; protest is CAMEO
 * root 14; a strike is CAMEO 194/195 whose target (Actor2) is that country.
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
    if (!sets.has(iso2)) sets.set(iso2, Array.from({ length: COUNTER_FIELDS }, () => new Set()));
    const counters = sets.get(iso2);
    counters[0].add(article);
    if (fields[29] === '4' && MATERIAL_VIOLENCE_ROOT_CODES.has(fields[28])) counters[CONFLICT].add(article);
    if (fields[28] === PROTEST_ROOT_CODE) counters[PROTEST].add(article);
    if (STRIKE_BASE_CODES.has(fields[27]) && ISO3_TO_ISO2[fields[17]] === iso2) counters[STRIKE].add(article);
  }
  return Object.fromEntries([...sets].map(([iso2, counters]) => [iso2, counters.map((set) => set.size)]));
}

// Stored rows may have three counters (written before the strike counter).
function addCounts(target, counts) {
  for (const [iso2, values] of Object.entries(counts ?? {})) {
    if (!Array.isArray(values)) continue;
    const current = target[iso2] ?? [];
    target[iso2] = Array.from({ length: COUNTER_FIELDS }, (_, i) => (Number(current[i]) || 0) + (Number(values[i]) || 0));
  }
}

/** Every cohort of the day carries the strike counter (it may be partial). */
function strikeMeasured(day) {
  return day?.cohorts > 0 && day.strikeCohorts === day.cohorts;
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
      const day = days[date] ??= { cohorts: 0, strikeCohorts: 0, countries: {} };
      day.cohorts += 1;
      // Every cohort this module parses carries the strike counter; a day
      // begun before it existed stays short until the repair rebuilds it.
      day.strikeCohorts = (day.strikeCohorts ?? 0) + 1;
      addCounts(day.countries, batch.countries);
    }
    cursor = batch.timestamp;
  }
  return { cursor, days };
}

// Past days that are missing or incomplete and that the live merge can no
// longer touch (strictly before the cursor's day), newest first.
/** The day's 15-minute export stamps, through `cursor` when the cursor falls on that day. */
export function countryEventsDayStamps(date, cursor = '') {
  const stamps = dyadDayExportTimestamps(date);
  return typeof cursor === 'string' && cursor.startsWith(date.replaceAll('-', ''))
    ? stamps.filter((stamp) => stamp <= cursor)
    : stamps;
}

function expectedCohorts(date, cursor) {
  return countryEventsDayStamps(date, cursor).length;
}

// Days missing cohorts that the live merge can no longer add, newest first:
// any past day short of 96, and the cursor's own day when it holds fewer
// cohorts than were published through the cursor. The live downloader keeps
// only the newest 8 cohorts per tick, so an outage longer than 2h leaves a
// hole in today that only a rebuild from the archive can fill. A day stored
// before the strike counter (some cohorts without it) is rebuilt too.
function repairableDates(snapshot, nowMs) {
  const cursor = snapshot?.cursor ?? '';
  if (!/^\d{14}$/.test(cursor)) return [];
  const cursorDate = `${cursor.slice(0, 4)}-${cursor.slice(4, 6)}-${cursor.slice(6, 8)}`;
  return historyWindow(nowMs).filter((date) => {
    const day = snapshot.days?.[date];
    const cohorts = day?.cohorts ?? 0;
    const legacy = cohorts > 0 && !strikeMeasured(day);
    if (date < cursorDate) return cohorts !== COHORTS_PER_DAY || legacy;
    return date === cursorDate && (cohorts < expectedCohorts(date, cursor) || legacy);
  });
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

/**
 * Sum one UTC day from exactly its source cohorts (all 96, or those through
 * `cursor` for the cursor's own day); the result replaces the stored day.
 */
export function rebuildCountryEventsDay(date, batches, cursor = '') {
  const expected = new Set(countryEventsDayStamps(date, cursor));
  const seen = new Set(batches.map((batch) => batch.timestamp));
  if (batches.length !== expected.size || seen.size !== expected.size
    || [...seen].some((timestamp) => !expected.has(timestamp))) {
    throw new Error(`Country-events rebuild for ${date} needs its ${expected.size} distinct cohorts`);
  }
  const day = { cohorts: expected.size, strikeCohorts: expected.size, countries: {} };
  for (const batch of batches) addCounts(day.countries, batch.countries);
  return day;
}

export function replaceCountryEventsDays(snapshot, rebuilt, nowMs, failures = {}) {
  const eligible = new Set(repairableDates(snapshot, nowMs));
  const days = structuredClone(snapshot.days ?? {});
  for (const [date, day] of Object.entries(rebuilt ?? {})) {
    if (eligible.has(date) && day?.cohorts === expectedCohorts(date, snapshot.cursor) && strikeMeasured(day)) days[date] = day;
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
  const todayDate = utcDate(nowMs);
  const today = days[todayDate];
  const yesterday = days[utcDate(nowMs - DAY_MS)];
  const cursor = typeof snapshot?.cursor === 'string' ? snapshot.cursor : '';
  // The window is today's cohorts published through the cursor plus the
  // matching tail of yesterday. The split comes from the clock (the cursor),
  // never from how many cohorts today happens to hold: after an outage that
  // would fill today's hole with yesterday's articles.
  const todayExpected = cursor.startsWith(todayDate.replaceAll('-', ''))
    ? expectedCohorts(todayDate, cursor)
    : 0;
  const todayCohorts = Math.min(COHORTS_PER_DAY, today?.cohorts ?? 0);
  const yesterdayNeeded = COHORTS_PER_DAY - Math.max(todayExpected, todayCohorts);
  const yesterdayShare = yesterday?.cohorts > 0 && yesterdayNeeded > 0
    ? Math.min(1, yesterdayNeeded / yesterday.cohorts)
    : 0;
  const currentCohorts = todayCohorts + Math.round(yesterdayShare * (yesterday?.cohorts ?? 0));
  // Complete only when every cohort of the window was observed. Anything less
  // is unknown, and the CII scores it as nothing rather than as calm.
  const currentComplete = todayCohorts >= todayExpected
    && (yesterdayNeeded <= 0 || yesterday?.cohorts === COHORTS_PER_DAY);
  const baselineDates = Array.from(
    { length: COUNTRY_EVENTS_BASELINE_DAYS },
    (_, i) => utcDate(nowMs - (i + 2) * DAY_MS),
  ).filter((date) => days[date]?.cohorts === COHORTS_PER_DAY);
  const baselineReady = baselineDates.length >= COUNTRY_EVENTS_MIN_BASELINE_DAYS;
  // Sustained level: raw counts over the complete days among the seven through
  // yesterday. The CII scores the conflict and protest share of them, so a
  // long campaign that has raised its own median still reads as one.
  const weekDates = Array.from(
    { length: COUNTRY_EVENTS_WEEK_DAYS },
    (_, i) => utcDate(nowMs - (i + 1) * DAY_MS),
  ).filter((date) => days[date]?.cohorts === COHORTS_PER_DAY);
  const weekReady = weekDates.length >= COUNTRY_EVENTS_MIN_WEEK_DAYS;
  // Strike days: today and the 26 days before it, each read once every cohort
  // it holds carries the strike counter and it holds at least 4 hours. The
  // CII scores a day's strikes as a share of its articles and decays them by
  // age; a day missing here is unknown, not quiet.
  const strikeDates = Array.from(
    { length: COUNTRY_EVENTS_STRIKE_DAYS },
    (_, i) => utcDate(nowMs - i * DAY_MS),
  ).filter((date) => strikeMeasured(days[date]) && days[date].cohorts >= COUNTRY_EVENTS_STRIKE_MIN_COHORTS);

  const codes = new Set([
    ...Object.keys(today?.countries ?? {}),
    ...Object.keys(yesterday?.countries ?? {}),
    ...baselineDates.flatMap((date) => Object.keys(days[date].countries ?? {})),
    ...weekDates.flatMap((date) => Object.keys(days[date].countries ?? {})),
    ...strikeDates.flatMap((date) => Object.keys(days[date].countries ?? {})),
  ]);
  const signal = (iso2, field) => {
    const current = (today?.countries?.[iso2]?.[field] ?? 0)
      + yesterdayShare * (yesterday?.countries?.[iso2]?.[field] ?? 0);
    const baselineMedian = baselineReady
      ? median(baselineDates.map((date) => days[date].countries?.[iso2]?.[field] ?? 0))
      : null;
    return { current: Math.round(current * 10) / 10, baselineMedian };
  };
  const weekTotals = (iso2) => {
    if (!weekReady) return null;
    const total = Array(COUNTER_FIELDS).fill(0);
    for (const date of weekDates) {
      const values = days[date].countries?.[iso2];
      if (Array.isArray(values)) values.forEach((value, i) => { total[i] += Number(value) || 0; });
    }
    return { articles: total[0], conflict: total[CONFLICT], protest: total[PROTEST] };
  };
  // { date: [strikeArticles, articles] } for the measured days with a strike.
  const strikeCounts = (iso2) => {
    const out = {};
    for (const date of strikeDates) {
      const values = days[date].countries?.[iso2];
      const strikes = Array.isArray(values) ? Number(values[STRIKE]) || 0 : 0;
      if (strikes > 0) out[date] = [strikes, Number(values[0]) || 0];
    }
    return Object.keys(out).length ? out : null;
  };
  const byCountry = {};
  for (const iso2 of [...codes].sort()) {
    const conflict = signal(iso2, CONFLICT);
    const protest = signal(iso2, PROTEST);
    const week = weekTotals(iso2);
    const strikes = strikeCounts(iso2);
    if (!conflict.current && !conflict.baselineMedian && !protest.current && !protest.baselineMedian
      && !week?.conflict && !week?.protest && !strikes) continue;
    byCountry[iso2] = strikes ? { conflict, protest, week, strikes } : { conflict, protest, week };
  }
  return {
    byCountry,
    currentCohorts,
    currentComplete,
    baselineDays: baselineDates.length,
    baselineReady,
    minBaselineDays: COUNTRY_EVENTS_MIN_BASELINE_DAYS,
    weekDays: weekDates.length,
    weekReady,
    minWeekDays: COUNTRY_EVENTS_MIN_WEEK_DAYS,
    // Measured strike days and their cohorts (a day absent here is unknown).
    strikeDays: Object.fromEntries(strikeDates.map((date) => [date, days[date].cohorts])),
  };
}
