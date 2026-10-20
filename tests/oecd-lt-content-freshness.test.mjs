import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';
const NOW = Date.parse('2026-10-20T00:00:30Z');
const AUG = Date.parse('2026-08-01T00:00:00Z');
const SEP = Date.parse('2026-09-01T00:00:00Z');
const countries = ['DE','JP','GB','CA','AU','CH','NO','SE','IT','ES','KR','MX','ZA','PL','NL','BE','AT','PT','IE','FI','DK','GR','CZ','HU','CL','FR','US'];
const stale = ['IT','NL','BE','AT','IE','DK','CZ','HU'];
function classify(contentFreshness, now = NOW) {
  const key = 'seed-meta:economic:oecd-lt-rates';
  const meta = { fetchedAt: now, recordCount: 15238, newestItemAt: SEP, oldestItemAt: AUG, maxContentAgeMin: 115200, ...(contentFreshness ? { contentFreshness } : {}) };
  return __testing__.classifyKey('oecdLtRates', key, {}, {
    now, keyStrens: new Map([[key, 1000]]), keyErrors: new Map(),
    keyMetaValues: new Map([[key, JSON.stringify(meta)]]), keyMetaErrors: new Map(),
    activationStates: new Map([['oecdLtRates', true]]),
  });
}
test('September markets cannot hide August markets past the original deadline', () => {
  const result = classify({ coveredCount: 27, freshCount: 19, staleCount: 8, unknownCount: 0,
    criticalCountries: countries, criticalFreshCount: 19, criticalMissingCountries: 0,
    criticalOldestObservedAt: AUG, criticalStaleCountries: stale, staleCountries: stale });
  assert.equal(result.status, 'STALE_CONTENT');
});
test('legacy metadata cannot prove all-market freshness', () => {
  assert.equal(classify().status, 'COVERAGE_DEGRADED');
});

const { OECD_LT_MARKETS, OECD_LT_MAX_CONTENT_AGE_MIN, oecdContentFreshness, oecdLatestContentMeta } = await import('../scripts/lib/yield-curves/oecd-lt.mjs');
test('OECD worker and health freshness budgets agree', () => {
  assert.equal(__testing__.SEED_META.oecdLtRates.requireContentFreshness.budgetMinutes, OECD_LT_MAX_CONTENT_AGE_MIN);
});
function payload(staleMarkets = stale) {
  return { countries: Object.fromEntries(countries.map(country => [country, { curves: [
    { date: '1980-01-01', tenors: { '10y': 8 } },
    { date: staleMarkets.includes(country) ? '2026-08-01' : '2026-09-01', tenors: { '10y': 3 } },
  ] }])) };
}
test('captured 19 September / 8 August pattern reports every latest market, ignoring history', () => {
  const data = payload();
  const before = JSON.stringify(data);
  const report = oecdContentFreshness(data, NOW);
  assert.deepEqual(new Set(report.criticalCountries), new Set(Object.keys(OECD_LT_MARKETS)));
  assert.deepEqual(new Set(__testing__.SEED_META.oecdLtRates.requireContentFreshness.countries), new Set(Object.keys(OECD_LT_MARKETS)));
  assert.equal(report.freshCount, 19);
  assert.equal(report.staleCount, 8);
  assert.deepEqual(new Set(report.criticalStaleCountries), new Set(stale));
  assert.equal(report.criticalOldestObservedAt, AUG);
  assert.deepEqual(oecdLatestContentMeta(data), { newestItemAt: SEP, oldestItemAt: AUG });
  assert.equal(classify(report).status, 'STALE_CONTENT');
  assert.equal(JSON.stringify(data), before);
});
test('a later health read re-ages an originally fresh mixed-vintage publication', () => {
  const report = oecdContentFreshness(payload(), Date.parse('2026-10-18T10:10:03Z'));
  assert.equal(report.freshCount, 27);
  assert.equal(classify(report).status, 'STALE_CONTENT');
});
test('all current latest observations clear even with decades of historical data', () => {
  assert.equal(classify(oecdContentFreshness(payload([]), NOW)).status, 'OK');
});
test('stale markets outrank the newest observation prewarning', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  for (const publishedAt of [Date.parse('2026-10-18T10:10:03Z'), now]) {
    const result = classify(oecdContentFreshness(payload(), publishedAt), now);
    assert.equal(result.status, 'STALE_CONTENT');
    assert.notEqual(__testing__.healthStatusBucket(result, now), 'ok');
  }
});
test('fresh markets retain the advisory prewarning', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
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
