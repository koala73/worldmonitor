import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';
import {
  ECB_IRS_MARKETS,
  OECD_LT_MARKETS,
  OECD_LT_MAX_CONTENT_AGE_MIN,
  OECD_LT_SOURCE_BUDGET_MIN,
  OECD_LT_SOURCE_ECB,
  OECD_LT_SOURCE_FRED,
  buildOecdLtPayload,
  oecdContentFreshness,
  oecdLatestContentMeta,
  oecdSourceBudgetMinutes,
  parseEcbIrsCsv,
} from '../scripts/lib/yield-curves/oecd-lt.mjs';
import { latestTransform } from '../scripts/seed-oecd-lt-rates.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T00:00:30Z');
const AUG = Date.parse('2026-08-01T00:00:00Z');
const SEP = Date.parse('2026-09-01T00:00:00Z');
const countries = Object.keys(OECD_LT_MARKETS);
const stale = ['IT', 'NL', 'BE', 'AT', 'IE', 'DK', 'CZ', 'HU'];
const ECB_BUDGET_MS = OECD_LT_SOURCE_BUDGET_MIN[OECD_LT_SOURCE_ECB] * 60_000;
const FRED_BUDGET_MS = OECD_LT_SOURCE_BUDGET_MIN[OECD_LT_SOURCE_FRED] * 60_000;

function classify(contentFreshness, now = NOW) {
  const key = 'seed-meta:economic:oecd-lt-rates';
  const meta = { fetchedAt: now, recordCount: 15238, newestItemAt: SEP, oldestItemAt: AUG, maxContentAgeMin: OECD_LT_MAX_CONTENT_AGE_MIN, ...(contentFreshness ? { contentFreshness } : {}) };
  return __testing__.classifyKey('oecdLtRates', key, {}, {
    now, keyStrens: new Map([[key, 1000]]), keyErrors: new Map(),
    keyMetaValues: new Map([[key, JSON.stringify(meta)]]), keyMetaErrors: new Map(),
    activationStates: new Map([['oecdLtRates', true]]),
  });
}

function payload(staleMarkets = stale, { source = OECD_LT_SOURCE_FRED, sourceFor = () => source } = {}) {
  return { countries: Object.fromEntries(countries.map((country) => [country, {
    source: sourceFor(country),
    sources: [sourceFor(country)],
    curves: [
      { date: '1980-01-01', tenors: { '10y': 8 } },
      { date: staleMarkets.includes(country) ? '2026-08-01' : '2026-09-01', tenors: { '10y': 3 } },
    ],
  }])) };
}

test('budgets derive from the measured release lag of each source', () => {
  const budget = (lagDays) => (lagDays + 2 * 31 + 1 + 10) * 24 * 60;
  assert.equal(oecdSourceBudgetMinutes(41), budget(41));
  assert.deepEqual(OECD_LT_SOURCE_BUDGET_MIN, {
    [OECD_LT_SOURCE_ECB]: budget(41),
    [OECD_LT_SOURCE_FRED]: budget(47),
  });
  assert.equal(OECD_LT_SOURCE_BUDGET_MIN[OECD_LT_SOURCE_ECB], 114 * 24 * 60);
  assert.equal(OECD_LT_SOURCE_BUDGET_MIN[OECD_LT_SOURCE_FRED], 120 * 24 * 60);
  assert.equal(OECD_LT_MAX_CONTENT_AGE_MIN, Math.max(...Object.values(OECD_LT_SOURCE_BUDGET_MIN)));
});

test('OECD worker and health freshness budgets agree', () => {
  assert.equal(__testing__.SEED_META.oecdLtRates.requireContentFreshness.budgetMinutes, OECD_LT_MAX_CONTENT_AGE_MIN);
  assert.deepEqual(new Set(__testing__.SEED_META.oecdLtRates.requireContentFreshness.countries), new Set(countries));
});

test('every ECB market is also a FRED market, so FRED history backfills it', () => {
  for (const market of ECB_IRS_MARKETS) assert.ok(OECD_LT_MARKETS[market], market);
});

test('parses the ECB IRS CSV into month-start points per market, skipping blank prints', () => {
  const csv = readFileSync(new URL('./fixtures/yield-curves/ecb-irs-it-dk.csv', import.meta.url), 'utf8');
  assert.deepEqual(parseEcbIrsCsv(csv), {
    DK: [{ date: '2026-08-01', value: 3.011 }, { date: '2026-09-01', value: 3.287 }],
    IT: [{ date: '2026-07-01', value: 3.881 }, { date: '2026-09-01', value: 4.362 }],
  });
  assert.deepEqual(parseEcbIrsCsv(''), {});
});

test('an EU market with a fresher ECB print is served from ECB on top of FRED history', () => {
  const data = buildOecdLtPayload({
    fred: {
      IT: [{ date: '1991-03-01', value: 13.1 }, { date: '2026-07-01', value: 3.88 }, { date: '2026-08-01', value: 3.986 }],
      US: [{ date: '2026-08-01', value: 4.2 }, { date: '2026-09-01', value: 4.99 }],
    },
    ecb: {
      IT: [{ date: '2026-07-01', value: 3.881 }, { date: '2026-08-01', value: 3.986 }, { date: '2026-09-01', value: 4.362 }],
    },
  });
  assert.deepEqual(data.countries.IT, {
    source: OECD_LT_SOURCE_ECB,
    sources: [OECD_LT_SOURCE_ECB, OECD_LT_SOURCE_FRED],
    curves: [
      { date: '1991-03-01', tenors: { '10y': 13.1 } },
      { date: '2026-07-01', tenors: { '10y': 3.881 } },
      { date: '2026-08-01', tenors: { '10y': 3.986 } },
      { date: '2026-09-01', tenors: { '10y': 4.362 } },
    ],
  });
  assert.deepEqual(data.countries.US, {
    source: OECD_LT_SOURCE_FRED,
    sources: [OECD_LT_SOURCE_FRED],
    curves: [{ date: '2026-08-01', tenors: { '10y': 4.2 } }, { date: '2026-09-01', tenors: { '10y': 4.99 } }],
  });
});

test('a FRED print newer than every ECB print keeps FRED as the current source', () => {
  const data = buildOecdLtPayload({
    fred: { IT: [{ date: '2026-08-01', value: 3.986 }, { date: '2026-09-01', value: 4.36 }] },
    ecb: { IT: [{ date: '2026-08-01', value: 3.986 }] },
  });
  assert.equal(data.countries.IT.source, OECD_LT_SOURCE_FRED);
  assert.deepEqual(data.countries.IT.sources, [OECD_LT_SOURCE_ECB, OECD_LT_SOURCE_FRED]);
  assert.equal(data.countries.IT.curves.at(-1).tenors['10y'], 4.36);
});

test('an unavailable ECB feed degrades to FRED-only provenance', () => {
  const data = buildOecdLtPayload({ fred: { IT: [{ date: '2026-08-01', value: 3.986 }] }, ecb: null });
  assert.deepEqual(data.countries.IT, {
    source: OECD_LT_SOURCE_FRED,
    sources: [OECD_LT_SOURCE_FRED],
    curves: [{ date: '2026-08-01', tenors: { '10y': 3.986 } }],
  });
});

test('the :latest projection keeps provenance', () => {
  const data = buildOecdLtPayload({
    fred: { IT: [{ date: '2026-07-01', value: 3.88 }, { date: '2026-08-01', value: 3.986 }] },
    ecb: { IT: [{ date: '2026-09-01', value: 4.362 }] },
  });
  assert.deepEqual(latestTransform(data), { countries: { IT: {
    source: OECD_LT_SOURCE_ECB,
    sources: [OECD_LT_SOURCE_ECB, OECD_LT_SOURCE_FRED],
    curves: [{ date: '2026-09-01', tenors: { '10y': 4.362 } }],
  } } });
});

test('legacy metadata cannot prove all-market freshness', () => {
  assert.equal(classify().status, 'COVERAGE_DEGRADED');
});

test('captured 19 September / 8 August pattern is one skipped release, which is normal', () => {
  const data = payload();
  const before = JSON.stringify(data);
  const report = oecdContentFreshness(data, NOW);
  assert.deepEqual(new Set(report.criticalCountries), new Set(countries));
  assert.equal(report.freshCount, 27);
  assert.equal(report.staleCount, 0);
  assert.equal(report.criticalOldestObservedAt, AUG);
  assert.equal(report.criticalOldestObservedCountry, 'IT');
  assert.deepEqual(oecdLatestContentMeta(data), { newestItemAt: SEP, oldestItemAt: AUG });
  assert.equal(classify(report).status, 'OK');
  assert.equal(JSON.stringify(data), before);
});

test('September markets cannot hide August markets once a second release is missed', () => {
  const now = AUG + FRED_BUDGET_MS;
  const report = oecdContentFreshness(payload(), now);
  assert.equal(report.freshCount, 19);
  assert.equal(report.staleCount, 8);
  assert.deepEqual(new Set(report.criticalStaleCountries), new Set(stale));
  assert.deepEqual(new Set(report.staleCountries), new Set(stale));
  assert.equal(classify(report, now).status, 'STALE_CONTENT');
  assert.equal(classify(oecdContentFreshness(payload(), now - 1), now - 1).status, 'OK');
});

test('each market is judged at the budget of the source that supplied its latest print', () => {
  const now = AUG + ECB_BUDGET_MS;
  assert.ok(now < AUG + FRED_BUDGET_MS);
  const data = payload(['IT', 'NL'], { sourceFor: (country) => (country === 'IT' ? OECD_LT_SOURCE_ECB : OECD_LT_SOURCE_FRED) });
  const report = oecdContentFreshness(data, now);
  assert.deepEqual(report.staleCountries, ['IT']);
  assert.equal(report.freshCount, 26);
  assert.equal(classify(report, now).status, 'STALE_CONTENT');
});

test('a payload without provenance is judged at the FRED budget', () => {
  const data = payload(['IT']);
  delete data.countries.IT.source;
  delete data.countries.IT.sources;
  assert.equal(oecdContentFreshness(data, AUG + FRED_BUDGET_MS - DAY_MS).staleCount, 0);
  assert.equal(oecdContentFreshness(data, AUG + FRED_BUDGET_MS).staleCount, 1);
});

test('an unknown source id fails closed', () => {
  const data = payload([], { sourceFor: (country) => (country === 'IT' ? 'bogus' : OECD_LT_SOURCE_FRED) });
  const report = oecdContentFreshness(data, NOW);
  assert.equal(report.unknownCount, 1);
  assert.equal(report.criticalFreshCount, 26);
  assert.ok(report.criticalStaleCountries.includes('IT'));
  assert.equal(classify(report).status, 'STALE_CONTENT');
});

test('a later health read re-ages an originally fresh mixed-vintage publication', () => {
  const report = oecdContentFreshness(payload(), Date.parse('2026-10-18T10:10:03Z'));
  assert.equal(report.freshCount, 27);
  assert.equal(classify(report, AUG + FRED_BUDGET_MS).status, 'STALE_CONTENT');
});

test('all current latest observations clear even with decades of historical data', () => {
  assert.equal(classify(oecdContentFreshness(payload([]), NOW)).status, 'OK');
});

test('stale markets outrank the newest observation prewarning', () => {
  const now = Date.parse('2026-12-10T00:00:00Z');
  assert.ok(now - SEP >= 0.8 * FRED_BUDGET_MS && now - SEP < FRED_BUDGET_MS);
  for (const publishedAt of [Date.parse('2026-10-18T10:10:03Z'), now]) {
    const result = classify(oecdContentFreshness(payload(), publishedAt), now);
    assert.equal(result.status, 'STALE_CONTENT');
    assert.notEqual(__testing__.healthStatusBucket(result, now), 'ok');
  }
});

test('fresh markets retain the advisory prewarning', () => {
  const now = Date.parse('2026-12-10T00:00:00Z');
  const result = classify(oecdContentFreshness(payload([]), now), now);
  assert.equal(result.status, 'CONTENT_AGE_PREWARNING');
  assert.equal(__testing__.healthStatusBucket(result, now), 'ok');
});

test('missing, invalid and future latest observations cannot disappear from scope', () => {
  for (const date of [null, 'invalid', '2027-01-01']) {
    const data = payload([]);
    if (date === null) delete data.countries.IT;
    else data.countries.IT.curves.at(-1).date = date;
    const report = oecdContentFreshness(data, NOW);
    assert.equal(report.coveredCount, 27);
    assert.equal(report.criticalFreshCount, 26);
    assert.equal(classify(report).status, 'STALE_CONTENT');
  }
});
