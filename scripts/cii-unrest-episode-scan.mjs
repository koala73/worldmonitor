#!/usr/bin/env node
// Applies the registered P15b sustained-unrest selection rule
// (docs/methodology/cii-v15-recalibration.md, "P15b historical unrest
// episode") to per-country GDELT day counts rebuilt by
// scripts/cii-gdelt-archive-rebuild.mjs. Inputs only: no score is read.
//
//   node scripts/cii-unrest-episode-scan.mjs gate --cache-dir DIR --out gate.json
//   node scripts/cii-unrest-episode-scan.mjs scan --cache-dir DIR --out candidates.json
//   node scripts/cii-unrest-episode-scan.mjs confirm --candidates candidates.json --cache-dir DIR --out selected.json
//
// Amendment 1: the daily file only screens (SCREEN_RULE, volume floors at 90%),
// `gate` decides whether it may, and `confirm` re-tests every screened episode
// on the 2.0 stream at the registered RULE before selecting.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  datesBetween,
  loadDailyMd5s,
  loadMasterDescriptors,
  rebuildDailyDay,
  rebuildV2Day,
} from './cii-gdelt-archive-rebuild.mjs';
import { summarizeCountryEvents } from './_gdelt-country-events.mjs';

// Registered constants. Changing any of them after the scan is a new study.
export const RULE = Object.freeze({
  countries: ['DE', 'FR', 'GB', 'JP', 'KR', 'PL', 'US'],
  windowFrom: '2015-04-01',
  windowTo: '2026-10-31',
  weekDays: 7, // T-7..T-1, the scorer's week at a clock at the end of day T
  normDays: 28, // T-35..T-8, the four weeks before the week
  minNormDays: 21,
  minNormProtest: 28,
  minWeekArticles: 200, // OQ11
  minWeekProtest: 35,
  ratio: 2,
  minElevatedDays: 5,
  maxTailProbability: 1e-6,
  clusterGapDays: 7,
});

// Amendment 1 screen: only the article-volume floors drop to 90%.
export const SCREEN_FLOOR_FRACTION = 0.9;
export const SCREEN_RULE = Object.freeze({
  ...RULE,
  minWeekArticles: RULE.minWeekArticles * SCREEN_FLOOR_FRACTION,
  minWeekProtest: RULE.minWeekProtest * SCREEN_FLOOR_FRACTION,
  minNormProtest: RULE.minNormProtest * SCREEN_FLOOR_FRACTION,
});

// Amendment 1 admission gate: daily-file ratio within 10% of the 2.0 ratio.
export const ADMISSION_GATE = Object.freeze({
  captureDays: ['2026-11-13', '2026-11-14'],
  ratioTolerance: 0.1,
});

const DAY_MS = 86_400_000;
const ARTICLES = 0;
const PROTEST = 2;

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function logChoose(n, k) {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const factorialCache = [0];
function logFactorial(n) {
  for (let i = factorialCache.length; i <= n; i += 1) factorialCache[i] = factorialCache[i - 1] + Math.log(i);
  return factorialCache[n];
}

/** P(X ≥ k) for X ~ Binomial(n, p), summed in log space from k upward. */
export function binomialUpperTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let maxLog = -Infinity;
  const terms = [];
  for (let i = k; i <= n; i += 1) {
    const term = logChoose(n, i) + i * logP + (n - i) * logQ;
    terms.push(term);
    if (term > maxLog) maxLog = term;
    if (i > n * p && term < maxLog - 50) break;
  }
  return Math.min(1, Math.exp(maxLog) * terms.reduce((sum, term) => sum + Math.exp(term - maxLog), 0));
}

/**
 * Statistics for one country at capture day T. `dayCounts(date)` returns
 * `[articles, conflict, protest, strikes]` for a complete day, or null when the
 * day is missing or incomplete.
 */
export function evaluateCaptureDay(T, dayCounts, rule = RULE) {
  const week = Array.from({ length: rule.weekDays }, (_, i) => shiftDate(T, -(i + 1)));
  const norm = Array.from({ length: rule.normDays }, (_, i) => shiftDate(T, -(rule.weekDays + 1 + i)));
  const normDays = norm.map(dayCounts).filter(Boolean);
  const weekDays = week.map(dayCounts);
  const current = dayCounts(T);
  const normArticles = normDays.reduce((sum, d) => sum + d[ARTICLES], 0);
  const normProtest = normDays.reduce((sum, d) => sum + d[PROTEST], 0);
  const out = {
    date: T,
    normDays: normDays.length,
    normArticles,
    normProtest,
    normShare: normArticles > 0 ? normProtest / normArticles : null,
    weekComplete: weekDays.every(Boolean),
    currentComplete: Boolean(current),
  };
  if (!out.weekComplete || !out.currentComplete) return { ...out, qualifies: false, failed: ['completeness'] };
  const weekArticles = weekDays.reduce((sum, d) => sum + d[ARTICLES], 0);
  const weekProtest = weekDays.reduce((sum, d) => sum + d[PROTEST], 0);
  const n = out.normShare;
  const share = (d) => (d[ARTICLES] > 0 ? d[PROTEST] / d[ARTICLES] : 0);
  const elevated = n === null ? 0 : weekDays.filter((d) => share(d) >= rule.ratio * n).length;
  const weekShare = weekArticles > 0 ? weekProtest / weekArticles : 0;
  const stats = {
    ...out,
    weekArticles,
    weekProtest,
    weekShare,
    ratio: n ? weekShare / n : null,
    elevatedDays: elevated,
    currentArticles: current[ARTICLES],
    currentProtest: current[PROTEST],
    currentShare: share(current),
    tailProbability: n ? binomialUpperTail(weekProtest, weekArticles, n) : null,
  };
  const failed = [];
  if (out.normDays < rule.minNormDays) failed.push('normDays');
  if (normProtest < rule.minNormProtest) failed.push('normProtest');
  if (weekArticles < rule.minWeekArticles) failed.push('weekArticles');
  if (weekProtest < rule.minWeekProtest) failed.push('weekProtest');
  if (!n || weekShare < rule.ratio * n) failed.push('ratio');
  if (elevated < rule.minElevatedDays) failed.push('elevatedDays');
  if (!n || stats.currentShare < rule.ratio * n) failed.push('currentDay');
  if (stats.tailProbability === null || stats.tailProbability > rule.maxTailProbability) failed.push('significance');
  return { ...stats, qualifies: failed.length === 0, failed };
}

/** Qualifying capture days of one country → episodes (runs with gaps ≤ clusterGapDays). */
export function clusterEpisodes(iso2, qualifying, rule = RULE) {
  const sorted = [...qualifying].sort((a, b) => a.date.localeCompare(b.date));
  const episodes = [];
  for (const day of sorted) {
    const last = episodes.at(-1);
    const gap = last ? (Date.parse(day.date) - Date.parse(last.days.at(-1).date)) / DAY_MS : Infinity;
    if (last && gap <= rule.clusterGapDays) last.days.push(day);
    else episodes.push({ iso2, days: [day] });
  }
  return episodes.map(({ iso2: code, days }) => {
    const peak = days.reduce((best, day) => (day.ratio > best.ratio ? day : best));
    return { iso2: code, first: days[0].date, last: days.at(-1).date, qualifyingDays: days.length, peak };
  });
}

/** Ascending peak ratio, then earliest peak date, then ISO2; lower median. */
export function orderEpisodes(episodes) {
  return [...episodes].sort((a, b) => a.peak.ratio - b.peak.ratio
    || a.peak.date.localeCompare(b.peak.date)
    || a.iso2.localeCompare(b.iso2));
}

export function lowerMedianIndex(n) {
  return n > 0 ? Math.floor((n - 1) / 2) : -1;
}

/** Scans every capture day of every rule country. `days` maps date → { available, countries }. */
export function scanDays(days, rule = RULE) {
  const counts = (iso2) => (date) => {
    const day = days[date];
    if (!day?.available) return null;
    return day.countries[iso2] ?? [0, 0, 0, 0];
  };
  const evaluations = {};
  const episodes = [];
  for (const iso2 of rule.countries) {
    const read = counts(iso2);
    const evaluated = datesBetween(rule.windowFrom, rule.windowTo).map((T) => evaluateCaptureDay(T, read, rule));
    evaluations[iso2] = evaluated;
    episodes.push(...clusterEpisodes(iso2, evaluated.filter((e) => e.qualifies), rule));
  }
  return { evaluations, episodes: orderEpisodes(episodes) };
}

/** Daily-vs-2.0 ratio comparison at the gate's capture days, per rule country. */
export function admissionGate(dailyRead, v2Read, gate = ADMISSION_GATE, rule = RULE) {
  const rows = [];
  for (const T of gate.captureDays) {
    for (const iso2 of rule.countries) {
      const v2 = evaluateCaptureDay(T, v2Read(iso2), rule);
      const daily = evaluateCaptureDay(T, dailyRead(iso2), rule);
      const tested = v2.ratio !== null && v2.ratio !== undefined;
      const relativeDifference = tested && daily.ratio != null ? daily.ratio / v2.ratio - 1 : null;
      const pass = !tested || (relativeDifference !== null && Math.abs(relativeDifference) <= gate.ratioTolerance);
      rows.push({
        T, iso2, tested, v2Ratio: v2.ratio ?? null, dailyRatio: daily.ratio ?? null, relativeDifference, pass,
        v2NormDays: v2.normDays, dailyNormDays: daily.normDays,
      });
    }
  }
  return { tolerance: gate.ratioTolerance, rows, pass: rows.every((row) => row.pass) };
}

/**
 * Amendment 1: confirmed episodes take their peak ratio from the 2.0 rebuild,
 * then the registered ordering and lower median apply to them only.
 */
export function selectConfirmed(results) {
  const confirmed = orderEpisodes(results.filter((r) => r.confirmed)
    .map((r) => ({ ...r.episode, screenPeak: r.episode.peak, peak: r.v2Evaluation })));
  const index = lowerMedianIndex(confirmed.length);
  return { confirmed, index, selected: index >= 0 ? confirmed[index] : null };
}

/** Every day the registered scan reads: the window plus each capture's 35-day lead-in. */
export function requiredScanDates(rule = RULE) {
  return datesBetween(shiftDate(rule.windowFrom, -(rule.weekDays + rule.normDays)), rule.windowTo);
}

/** The registered copied magnitudes only; GDELT strike days are never copied. */
export function copiedMagnitudes(scorer) {
  if (!scorer) return null;
  const { conflict, protest, week } = scorer;
  return { conflict, protest, week };
}

/** The scorer's view at the end of capture day T, from v2 days T-35..T. */
export function scorerViewAt(T, v2Days) {
  const cursor = `${T.replaceAll('-', '')}234500`;
  const nowMs = Date.parse(`${T}T23:59:59.999Z`);
  return { cursor, nowMs, summary: summarizeCountryEvents({ cursor, days: v2Days }, nowMs) };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      'cache-dir': { type: 'string' },
      out: { type: 'string' },
      candidates: { type: 'string' },
    },
  });
  const cacheDir = values['cache-dir'];
  if (!cacheDir) throw new Error('--cache-dir is required');
  mkdirSync(cacheDir, { recursive: true });
  const log = (message) => process.stderr.write(`${message}\n`);
  if (command === 'scan') {
    const md5s = await loadDailyMd5s({ cacheDir });
    const days = {};
    // The range is fixed by the registered rule, never by the caller.
    const dates = requiredScanDates();
    for (const date of dates) {
      days[date] = await rebuildDailyDay(date, { cacheDir, md5s });
      if (date.endsWith('-01')) log(`${date}: ${days[date].available ? 'ok' : 'missing'}`);
    }
    const missingDays = Object.entries(days).filter(([, day]) => !day.available).map(([date]) => date);
    const md5ListMismatches = Object.entries(days).filter(([, day]) => day.listMd5Mismatch)
      .map(([date, day]) => ({ date, ...day.listMd5Mismatch }));
    const { evaluations, episodes } = scanDays(days, SCREEN_RULE);
    const output = {
      rule: SCREEN_RULE,
      source: 'gdelt-daily-events (screen only, amendment 1)',
      scannedFrom: dates[0],
      scannedTo: dates.at(-1),
      missingDays,
      md5ListMismatches,
      episodeCount: episodes.length,
      episodes,
      qualifyingCaptureDays: Object.fromEntries(Object.entries(evaluations)
        .map(([iso2, list]) => [iso2, list.filter((e) => e.qualifies)])),
      nearMisses: Object.fromEntries(Object.entries(evaluations).map(([iso2, list]) => [iso2,
        list.filter((e) => !e.qualifies && e.failed.length === 1).length])),
    };
    writeFileSync(values.out, JSON.stringify(output, null, 1));
    log(`${episodes.length} screened episodes`);
  } else if (command === 'gate') {
    const md5s = await loadDailyMd5s({ cacheDir });
    const descriptors = await loadMasterDescriptors({ cacheDir });
    const span = datesBetween(shiftDate(ADMISSION_GATE.captureDays[0], -(RULE.weekDays + RULE.normDays)),
      ADMISSION_GATE.captureDays.at(-1));
    const dailyDays = {};
    const v2Days = {};
    for (const date of span) {
      // The gate dates lie outside the window; earlier days were never rebuilt and stay missing.
      if (date < '2026-10-15') continue;
      dailyDays[date] = await rebuildDailyDay(date, { cacheDir, md5s });
      v2Days[date] = await rebuildV2Day(date, { descriptors, cacheDir, log });
    }
    const dailyRead = (iso2) => (date) => (dailyDays[date]?.available ? (dailyDays[date].countries[iso2] ?? [0, 0, 0, 0]) : null);
    const v2Read = (iso2) => (date) => (v2Days[date]?.cohorts === 96 ? (v2Days[date].countries[iso2] ?? [0, 0, 0, 0]) : null);
    const result = admissionGate(dailyRead, v2Read);
    writeFileSync(values.out, JSON.stringify(result, null, 1));
    for (const row of result.rows) {
      log(`${row.T} ${row.iso2}: v2 ${row.v2Ratio?.toFixed(4)} daily ${row.dailyRatio?.toFixed(4)} diff ${row.relativeDifference === null ? 'n/a' : (row.relativeDifference * 100).toFixed(2)}% ${row.pass ? 'pass' : 'FAIL'}`);
    }
    log(`gate ${result.pass ? 'passes' : 'fails'}`);
  } else if (command === 'confirm') {
    const scan = JSON.parse(readFileSync(values.candidates, 'utf8'));
    const descriptors = await loadMasterDescriptors({ cacheDir });
    const results = [];
    for (const episode of scan.episodes) {
      const T = episode.peak.date;
      const v2Days = {};
      for (const date of datesBetween(shiftDate(T, -(RULE.weekDays + RULE.normDays)), T)) {
        v2Days[date] = await rebuildV2Day(date, { descriptors, cacheDir, log });
      }
      const read = (date) => (v2Days[date]?.cohorts === 96 ? (v2Days[date].countries[episode.iso2] ?? [0, 0, 0, 0]) : null);
      const v2Evaluation = evaluateCaptureDay(T, read);
      const view = scorerViewAt(T, v2Days);
      const scorer = view.summary.byCountry[episode.iso2] ?? null;
      const scorerChecks = {
        weekReady: Boolean(view.summary.weekReady),
        baselineReady: Boolean(view.summary.baselineReady),
        currentComplete: Boolean(view.summary.currentComplete),
        protestBaselinePositive: Boolean(scorer && scorer.protest.baselineMedian > 0),
        protestCurrentAboveBaseline: Boolean(scorer && scorer.protest.current > scorer.protest.baselineMedian),
      };
      const scorerEligible = Object.values(scorerChecks).every(Boolean);
      const confirmed = v2Evaluation.qualifies && scorerEligible;
      const { byCountry, ...meta } = view.summary;
      results.push({
        episode, v2Evaluation, scorerChecks, scorerEligible, confirmed,
        failed: [...v2Evaluation.failed, ...Object.entries(scorerChecks).filter(([, ok]) => !ok).map(([name]) => `scorer:${name}`)],
        cursor: view.cursor, nowMs: view.nowMs, scorerSummaryMeta: meta,
        copied: copiedMagnitudes(scorer), scorerCountrySummary: scorer,
        missingV2Days: Object.entries(v2Days).filter(([, day]) => day.cohorts !== 96).map(([date, day]) => [date, day.cohorts]),
      });
      log(`${episode.iso2} ${T}: v2 ${v2Evaluation.qualifies ? 'qualifies' : `fails ${v2Evaluation.failed}`}; scorer eligible ${scorerEligible}`);
      writeFileSync(`${values.out}.partial`, JSON.stringify(results, null, 1));
    }
    const { confirmed, index, selected } = selectConfirmed(results);
    const selectedResult = selected ? results.find((r) => r.episode.iso2 === selected.iso2 && r.episode.peak.date === selected.screenPeak.date) : null;
    writeFileSync(values.out, JSON.stringify({
      screenedCount: results.length,
      failedCount: results.filter((r) => !r.confirmed).length,
      confirmedCount: confirmed.length,
      selectedIndex: index,
      selected: selectedResult,
      confirmedOrder: confirmed.map((e) => ({ iso2: e.iso2, peak: e.peak.date, ratio: e.peak.ratio })),
      results,
    }, null, 1));
    log(selected ? `selected ${selected.iso2} ${selected.peak.date} (index ${index} of ${confirmed.length})` : 'no episode confirmed');
  } else {
    log('usage: cii-unrest-episode-scan.mjs scan|confirm [options]');
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
