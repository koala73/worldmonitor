import pairs from './shared/gdelt-tension-pairs.json' with { type: 'json' };
import { GDELT_PUBLICATION_LEAD_MS, gdeltTimestampToMs } from './_conflict-gdelt-bulk.mjs';

const DAY_MS = 86_400_000;
// A side is one CAMEO country code or a group of them (Iran–GCC sums Iran
// against each member). Every country pair maps to at most one configured pair.
const pairByActors = new Map(pairs.flatMap(pair => {
  const [left, right] = pair.actors.map(side => [side].flat());
  return left.flatMap(a => right.map(b => [[a, b].sort().join(':'), pair.id]));
}));
const emptyPair = () => ({ total: 0, conflict: 0, intensity: 0, toneSum: 0, toneCount: 0 });
const HOUR_MS = 3_600_000;
// Hourly buckets are kept for the dates the rolling window can reach: the
// 192 hours (8 days) before the last complete hour, so up to 9 calendar days.
const HOURLY_DAYS = 8;
const hourlyCutoff = (nowMs) => new Date(nowMs - HOURLY_DAYS * DAY_MS).toISOString().slice(0, 10);

// Add one cohort to its hour. An hour is complete with its 4 quarter-hour
// cohorts; each pair keeps [conflict, intensity], and only when non-zero.
function addHourCohort(day, timestamp, dyads) {
  const hour = (day.hours ??= {})[timestamp.slice(8, 10)] ??= { cohorts: 0, pairs: {} };
  hour.cohorts++;
  for (const pair of pairs) {
    const counts = dyads[pair.id];
    if (!counts || (!counts.conflict && !counts.intensity)) continue;
    const [conflict, intensity] = hour.pairs[pair.id] ?? [0, 0];
    hour.pairs[pair.id] = [conflict + counts.conflict, intensity + counts.intensity];
  }
}

// Actor country codes are CAMEO, not the FIPS location codes used by the
// conflict map. Count every event, including non-root events, exactly once.
export function parseDyadExport(csv) {
  const counts = Object.fromEntries(pairs.map(pair => [pair.id, emptyPair()]));
  for (const line of String(csv).split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 35) continue;
    const id = pairByActors.get([fields[7], fields[17]].sort().join(':'));
    if (!id) continue;
    const bucket = counts[id];
    bucket.total++;
    const tone = fields[34].trim() === '' ? NaN : Number(fields[34]);
    if (Number.isFinite(tone)) { bucket.toneSum += tone; bucket.toneCount++; }
    if (fields[29] !== '3' && fields[29] !== '4') continue;
    bucket.conflict++;
    const mentions = Number(fields[31]);
    const goldstein = Number(fields[30]);
    if (Number.isFinite(mentions) && mentions >= 0 && Number.isFinite(goldstein)) {
      bucket.intensity += mentions * Math.max(0, -goldstein);
    }
  }
  return counts;
}

// Publish the cursor in the SAME snapshot as the buckets. If the separate
// materializer cursor write fails, a replay cannot add the same cohort twice.
export function mergeDyadBuckets(previous, batches, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - 90 * DAY_MS).toISOString().slice(0, 10);
  const days = structuredClone(previous?.days ?? {});
  for (const date of Object.keys(days)) if (date < cutoff) delete days[date];
  const hoursFrom = hourlyCutoff(nowMs);
  for (const [date, day] of Object.entries(days)) if (date < hoursFrom) delete day.hours;
  let cursor = previous?.cursor ?? '';
  for (const batch of [...batches].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (batch.timestamp <= cursor) continue;
    const timestampMs = gdeltTimestampToMs(batch.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > nowMs + GDELT_PUBLICATION_LEAD_MS) throw new Error('Invalid dyad cohort timestamp');
    const date = new Date(timestampMs).toISOString().slice(0, 10);
    if (date >= cutoff) {
      const day = days[date] ??= { cohorts: 0, pairs: Object.fromEntries(pairs.map(pair => [pair.id, emptyPair()])) };
      day.cohorts++;
      for (const pair of pairs) {
        const counts = batch.dyads[pair.id];
        // A pair added to the config after the day began has no bucket: it
        // would miss the earlier cohorts. The day is rebuilt once it is past.
        if (!counts || !day.pairs[pair.id]) continue;
        for (const field of Object.keys(emptyPair())) day.pairs[pair.id][field] += counts[field];
      }
      // Hours are independent units: one that began before this worker saw
      // it has fewer than 4 cohorts and is never treated as complete.
      if (date >= hoursFrom) addHourCohort(day, batch.timestamp, batch.dyads);
    }
    cursor = batch.timestamp;
  }
  return { cursor, days };
}

// The scoring window: the 90 completed UTC days before today, newest first.
function scoringWindow(nowMs) {
  return Array.from({ length: 90 }, (_, i) => new Date(nowMs - (i + 1) * DAY_MS).toISOString().slice(0, 10));
}

// The 96 quarter-hour export timestamps of one UTC day.
export function dyadDayExportTimestamps(date) {
  const compact = date.replaceAll('-', '');
  return Array.from({ length: 96 }, (_, i) =>
    `${compact}${String(Math.floor(i / 4)).padStart(2, '0')}${String((i % 4) * 15).padStart(2, '0')}00`);
}

// A day whose repair failed (verification or download) waits this long before
// it is retried, so it cannot hold the per-run download budget and starve
// older days. Six hours is 24 runs: a transient storage or network fault has
// cleared by then, and a persistently bad day costs at most four downloads a day.
export const DYAD_REPAIR_BACKOFF_MS = 6 * 60 * 60 * 1000;

// Days that stop scoreDyads (missing, not exactly 96 cohorts, without a
// bucket for a pair added to the config after the day began, or, within the
// hourly window, without complete hours) and that the live merge can no
// longer touch: a day strictly before the cursor's day.
// Without this, a partial first day or one missed cohort would block every
// pair for 90 days.
function repairableDates(snapshot, nowMs) {
  const cursorDate = /^\d{14}$/.test(snapshot?.cursor ?? '')
    ? `${snapshot.cursor.slice(0, 4)}-${snapshot.cursor.slice(4, 6)}-${snapshot.cursor.slice(6, 8)}` : '';
  if (!cursorDate) return [];
  const hoursFrom = hourlyCutoff(nowMs);
  return scoringWindow(nowMs).filter((date) => {
    const day = snapshot.days?.[date];
    return date < cursorDate && (day?.cohorts !== 96 || pairs.some(pair => !day.pairs?.[pair.id])
      || (date >= hoursFrom && Object.values(day.hours ?? {}).filter(hour => hour.cohorts === 4).length !== 24));
  });
}

// Repair candidates, newest first, skipping days still inside their backoff.
export function planDyadRepair(snapshot, nowMs, maxDays) {
  const failures = snapshot?.repairFailures ?? {};
  return repairableDates(snapshot, nowMs)
    .filter((date) => {
      const failedAt = Number(failures[date]);
      return !Number.isFinite(failedAt) || nowMs - failedAt >= DYAD_REPAIR_BACKOFF_MS;
    })
    .slice(0, Math.max(0, maxDays));
}

// Sum one day from its 96 source cohorts. The result replaces the stored day
// wholesale, so it must cover the whole day exactly once.
export function rebuildDyadDay(date, batches) {
  const expected = new Set(dyadDayExportTimestamps(date));
  const seen = new Set(batches.map(batch => batch.timestamp));
  if (batches.length !== 96 || seen.size !== 96 || [...seen].some(timestamp => !expected.has(timestamp))) {
    throw new Error(`Dyad rebuild for ${date} needs its 96 distinct cohorts`);
  }
  const day = { cohorts: 96, pairs: Object.fromEntries(pairs.map(pair => [pair.id, emptyPair()])), hours: {} };
  for (const batch of batches) {
    for (const pair of pairs) {
      const counts = batch.dyads[pair.id];
      if (!counts) continue;
      for (const field of Object.keys(emptyPair())) day.pairs[pair.id][field] += counts[field];
    }
    addHourCohort(day, batch.timestamp, batch.dyads);
  }
  return day;
}

// Replace, never add: a partial day already holds some of these cohorts.
// Days the live merge still owns, or that left the window, are ignored.
// Failure records follow the same rule: a rebuilt day clears its record, new
// failures are added, and records for days no longer repairable are dropped.
export function replaceDyadDays(snapshot, rebuilt, nowMs, failures = {}) {
  const eligible = new Set(repairableDates(snapshot, nowMs));
  const hoursFrom = hourlyCutoff(nowMs);
  const days = structuredClone(snapshot.days ?? {});
  for (const [date, day] of Object.entries(rebuilt ?? {})) {
    if (!eligible.has(date) || day?.cohorts !== 96) continue;
    const { hours, ...daily } = day;
    days[date] = date >= hoursFrom ? day : daily;
  }
  const { repairFailures: previousFailures, ...rest } = snapshot;
  const stillRepairable = new Set(repairableDates({ ...snapshot, days }, nowMs));
  const repairFailures = Object.fromEntries(Object.entries({ ...previousFailures, ...failures })
    .filter(([date, failedAt]) => stillRepairable.has(date) && Number.isFinite(failedAt)));
  return Object.keys(repairFailures).length ? { ...rest, days, repairFailures } : { ...rest, days };
}

// The 192 hourly [conflict, intensity] values for one pair, newest first,
// ending at the last complete hour of the cursor's data, or null when any of
// them is unusable: the hour lacks one of its 4 cohorts, or its day has no
// bucket for the pair (the pair was added after that day began).
function hourlySeries(snapshot, pairId) {
  if (!/^\d{14}$/.test(snapshot?.cursor ?? '')) return null;
  const cursorMs = gdeltTimestampToMs(snapshot.cursor);
  // The cursor's hour is complete once its :45 cohort is in.
  const endMs = Math.floor(cursorMs / HOUR_MS) * HOUR_MS - (snapshot.cursor.slice(10, 12) === '45' ? 0 : HOUR_MS);
  const series = [];
  for (let i = 0; i < 192; i++) {
    const iso = new Date(endMs - i * HOUR_MS).toISOString();
    const day = snapshot.days?.[iso.slice(0, 10)];
    const hour = day?.hours?.[iso.slice(11, 13)];
    if (!day?.pairs?.[pairId] || hour?.cohorts !== 4) return null;
    series.push(hour.pairs[pairId] ?? [0, 0]);
  }
  return series;
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

// N = 20 measured conflict events/day × 7 days. Require 90 complete UTC
// days (96 cohorts/day); partial/missing days are not evidence of calm.
// Intensity is the daily sum of mentions × max(0, -Goldstein) for Quad 3/4.
// Score: midrank percentile of the recent 7-day daily mean in the 90-day
// daily distribution, with a non-flat maximum clamped to 100. A flat
// distribution ranks at 50.
// Live: the recent 7 days are the last 168 complete hours, so the score
// moves within the hour, and the change is the last 24 hours against the
// daily mean of the 7 days before them. When any of those 192 hours is
// unusable (after a deploy, or an upstream gap) the pair falls back to the
// completed UTC days: the last 7 against the 7 before them.
export function scoreDyads(snapshot, nowMs = Date.now()) {
  const history = scoringWindow(nowMs).map(date => snapshot.days[date]);
  const tensionPairs = [];
  const insufficientPairs = [];
  for (const { actors: _actors, ...pair } of pairs) {
    const days = history.map(day => day?.pairs?.[pair.id]);
    if (history.some(day => day?.cohorts !== 96) || days.some(day => !day)) {
      insufficientPairs.push(pair.id);
      continue;
    }
    const values = days.map(day => day.intensity);
    const hours = hourlySeries(snapshot, pair.id);
    const weekConflict = hours ? sum(hours.slice(0, 168).map(([conflict]) => conflict))
      : sum(days.slice(0, 7).map(day => day.conflict));
    const mean = hours ? sum(hours.slice(0, 168).map(([, intensity]) => intensity)) / 7 : sum(values.slice(0, 7)) / 7;
    const recent = hours ? sum(hours.slice(0, 24).map(([, intensity]) => intensity)) : mean;
    const previousMean = hours ? sum(hours.slice(24).map(([, intensity]) => intensity)) / 7 : sum(values.slice(7, 14)) / 7;
    if (weekConflict < 140) { insufficientPairs.push(pair.id); continue; }
    // A zero baseline has no finite percentage change. Do not invent 100%.
    if (previousMean === 0 && recent > 0) { insufficientPairs.push(pair.id); continue; }
    const change = previousMean === 0 ? 0 : (recent - previousMean) / previousMean * 100;
    const below = values.filter(value => value < mean).length;
    const equal = values.filter(value => value === mean).length;
    const maximum = Math.max(...values);
    const score = mean >= maximum && maximum > Math.min(...values)
      ? 100 : (below + equal / 2) / values.length * 100;
    tensionPairs.push({ ...pair, score: Math.round(score * 10) / 10,
      trend: change > 10 ? 'TREND_DIRECTION_RISING' : change < -10 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE',
      changePercent: Math.round(change * 10) / 10 });
  }
  return { tensionPairs, insufficientPairs };
}
