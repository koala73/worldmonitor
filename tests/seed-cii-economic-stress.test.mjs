import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CII_COUNTRY_CODES } from '../shared/cii-weights.ts';
import { __testing__ as health } from '../api/health.js';
import { buildEconomicStress, economicCountry, seedEconomicStress, ECONOMIC_COUNTRIES, ECONOMIC_KEY, ECONOMIC_META_KEY, ECONOMIC_ACTIVATION_KEY, INPUT_KEYS } from '../scripts/seed-cii-economic-stress.mjs';
import { readFileSync } from 'node:fs';
import { computeYoy, cleanDailyQuotes, hasTimeForOptionalFetch, withTimeCap, needsFallback, FX_MAX_NOISE_SHARE, FX_OPTIONAL_CAP_MS } from '../scripts/seed-fx-yoy.mjs';
import { fallbackDailyQuotes, fetchFallbackWindows } from '../scripts/_currency-api.mjs';
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/fx-daily-quotes-2026-11-13.json', import.meta.url), 'utf8')).series;
const recorded = (ccy) => cleanDailyQuotes(RECORDED[ccy].timestamps.map((ts, i) => ({ t: ts * 1000, close: RECORDED[ccy].closes[i] })), RECORDED[ccy].timeZone);
const NOW = Date.UTC(2026, 10, 13);
test('public health scrubs country diagnostics from fresh and cached compact responses', () => {
  const entry = { status: 'COVERAGE_PARTIAL', measuredCount: 22, unmeasuredCountries: ['TW', 'AE', 'QA'] };
  const snapshot = { status: 'WARNING', checks: { ciiEconomicStress: entry } };
  assert.equal(health.healthResponseBody(snapshot, true).problems.ciiEconomicStress.unmeasuredCountries, undefined);
  assert.equal(health.healthResponseBody({ status: 'WARNING', problems: { ciiEconomicStress: entry } }, true).problems.ciiEconomicStress.unmeasuredCountries, undefined);
  assert.deepEqual(health.healthResponseBody(snapshot, false).checks.ciiEconomicStress.unmeasuredCountries, entry.unmeasuredCountries);
});
const cpi = Array.from({ length: 37 }, (_, i) => ({ date: new Date(Date.UTC(2023, 9 + i, 1)).toISOString().slice(0, 7), value: 100 * 1.01 ** i }));
const bars = Array.from({ length: 25 }, (_, i) => ({ t: Date.UTC(2024, 10 + i, i === 24 ? 12 : 1), close: 1 }));
const DAY = 86400000;
// 133 flat sessions ending 2026-11-12, one per day.
const flatDaily = (close = 1) => Array.from({ length: 133 }, (_, i) => ({ t: Date.UTC(2026, 10, 12) - (132 - i) * DAY, close }));
function inputs() {
  const countries = Object.fromEntries(ECONOMIC_COUNTRIES.map(c => [c, { frequency: 'M', points: cpi }]));
  return { currency: { rates: ECONOMIC_COUNTRIES.map(countryCode => ({ countryCode, ...computeYoy(bars), daily90: cleanDailyQuotes(flatDaily()) })) },
    inflation: { countries }, eurostat: { countries: {} }, japan: { countries: {} }, usCpi: { components: { headline: cpi.map(p => ({ ...p, date: `${p.date}-01` })) } }, yield: { countries: {} } };
}
test('recorded Yahoo quote noise is cleaned or flagged upstream, and a real move survives', () => {
  // QAR is pegged at 3.64 and flips to a level 3.6% away on four sessions in ten: not comparable.
  const qar = recorded('QAR');
  assert.ok(qar.noiseShare > 0.3, `QAR noise ${qar.noiseShare}`);
  assert.equal(qar.reliable, false);
  // SAR is pegged; its raw last close is a 3% bad print that the median removes.
  const sar = recorded('SAR');
  const sarRaw = RECORDED.SAR.closes.filter(Boolean);
  assert.ok(100 * (1 - sarRaw.at(-1) / sarRaw.at(-64)) > 3, 'the raw SAR series shows a false 3% depreciation');
  assert.equal(sar.reliable, true);
  assert.ok(Math.abs(100 * (1 - sar.latest / sar.anchor.value)) < 0.5);
  // AED is a clean peg, EGP a real 6% depreciation with sixteen moves above 1% and none reverted.
  const aed = recorded('AED'), egp = recorded('EGP');
  assert.equal(aed.noiseShare, 0);
  assert.ok(Math.abs(100 * (1 - aed.latest / aed.anchor.value)) < 0.05);
  assert.equal(egp.reliable, true);
  assert.equal(egp.noiseShare, 0);
  assert.ok(100 * (1 - egp.latest / egp.anchor.value) > 5);
  for (const row of [sar, aed, egp]) {
    assert.equal(row.asOf, '2026-11-13');
    const gap = (Date.parse(row.asOf) - Date.parse(row.anchor.date)) / DAY;
    assert.ok(gap >= 90 && gap <= 97, `anchor gap ${gap}`);
  }
  assert.ok(FX_MAX_NOISE_SHARE > sar.noiseShare && FX_MAX_NOISE_SHARE < qar.noiseShare);
});
test('unreliable quotes leave the currency unmeasured, never zero, and thin series are refused', () => {
  const raw = inputs();
  raw.currency.rates = [{ countryCode: 'QA', daily90: recorded('QAR') }, { countryCode: 'SA', daily90: recorded('SAR') }, { countryCode: 'EG', daily90: recorded('EGP') }];
  const qa = economicCountry(raw, 'QA', NOW);
  assert.equal(qa.members.currency, undefined);
  assert.equal(qa.absent.currency.reason, 'unreliable-quotes');
  assert.equal(qa.absent.currency.value, undefined);
  assert.ok(Math.abs(economicCountry(raw, 'SA', NOW).members.currency.value) < 0.5);
  const eg = economicCountry(raw, 'EG', NOW).members.currency;
  assert.ok(eg.value > 5);
  assert.equal(eg.reference.method, 'median-of-5-sessions-depreciation-vs-90-day-anchor');
  assert.equal(cleanDailyQuotes(flatDaily().slice(-60)), null);
  const holed = flatDaily().filter(p => p.t > Date.UTC(2026, 7, 20) || p.t < Date.UTC(2026, 6, 20));
  assert.equal(cleanDailyQuotes(holed), null, 'a month-long hole at the anchor is not bridged');
  assert.equal(cleanDailyQuotes([...flatDaily(), { t: NaN, close: 1 }, { t: Date.UTC(2026, 10, 12), close: null }]).sessions, 133);
});
test('a reverted run at the end of the window cannot set the latest value', () => {
  // Three bad prints at 0.97, then back to 1: the quotes returned, so nothing depreciated.
  const pts = flatDaily().map((p, i) => ({ ...p, close: i >= 129 && i <= 131 ? 0.97 : 1 }));
  const row = cleanDailyQuotes(pts);
  assert.equal(row.reliable, true);
  assert.equal(row.latest, 1);
  assert.equal(row.anchor.value, 1);
  // The same run at the anchor end is dropped too.
  const anchored = cleanDailyQuotes(flatDaily().map((p, i) => ({ ...p, close: i >= 40 && i <= 42 ? 1.03 : 1 })));
  assert.equal(anchored.anchor.value, 1);
  // A move that does not come back is a price, and is kept.
  assert.ok(Math.abs(cleanDailyQuotes(flatDaily().map((p, i) => ({ ...p, close: i >= 129 ? 0.97 : 1 }))).latest - 0.97) < 1e-12);
});
test('a feed that resumes after a hole is not published as a fresh median', () => {
  // Three weeks of missing closes, then one new quote at a new level.
  const pts = flatDaily().filter((p, i) => i < 111 || i === 132).map((p, i, all) => (i === all.length - 1 ? { ...p, close: 0.9 } : p));
  assert.equal(cleanDailyQuotes(pts), null);
  const raw = inputs();
  raw.currency.rates = [{ countryCode: 'AE', asOf: '2026-11-12' }];
  assert.equal(economicCountry(raw, 'AE', NOW).absent.currency.reason, 'insufficient-history');
  // A hole at the anchor end is refused the same way.
  assert.equal(cleanDailyQuotes(flatDaily().filter((p, i) => i < 25 || i > 41 || i === 33)), null);
});
test('the optional daily request yields to the required rows when time is short', async () => {
  const base = { nowMs: 0, slowestRequestMs: 3000 };
  assert.equal(hasTimeForOptionalFetch({ ...base, deadlineAtMs: Infinity, remainingRequired: 44 }), true);
  // Its 20 s worst case, 44 required requests at 3.15 s each and the 15 s reserve need about 174 s.
  assert.equal(hasTimeForOptionalFetch({ ...base, deadlineAtMs: 240_000, remainingRequired: 44 }), true);
  assert.equal(hasTimeForOptionalFetch({ ...base, nowMs: 90_000, deadlineAtMs: 240_000, remainingRequired: 44 }), false);
  // At 150 s with 20 required requests left, admitting a request that can run its full cap would miss the deadline.
  assert.equal(hasTimeForOptionalFetch({ ...base, nowMs: 150_000, deadlineAtMs: 240_000, remainingRequired: 20 }), false);
  assert.equal(hasTimeForOptionalFetch({ ...base, nowMs: 205_000, deadlineAtMs: 240_000, remainingRequired: 0 }), true);
  assert.equal(hasTimeForOptionalFetch({ ...base, nowMs: 205_001, deadlineAtMs: 240_000, remainingRequired: 0 }), false);
  assert.equal(FX_OPTIONAL_CAP_MS, 20_000);
  // The cap is enforced, not assumed: a request that never settles is cut off.
  await assert.rejects(withTimeCap(new Promise(() => {}), 20, 'XXX fx-daily'), /exceeded 20 ms/);
  assert.equal(await withTimeCap(Promise.resolve('ok'), 20, 'XXX'), 'ok');
});
test('a frozen, noisy or missing Yahoo series is sent to the second source', () => {
  const fresh = cleanDailyQuotes(flatDaily());
  assert.equal(needsFallback(fresh, NOW), false);
  // A frozen feed has constant closes, so its noise share is 0 and it reads reliable.
  const frozen = cleanDailyQuotes(flatDaily().map(p => ({ ...p, t: p.t - 10 * DAY })));
  assert.equal(frozen.reliable, true);
  assert.equal(needsFallback(frozen, NOW), true);
  assert.equal(needsFallback(recorded('QAR'), NOW), true);
  assert.equal(needsFallback(null, NOW), true);
  assert.equal(needsFallback({ ...fresh, asOf: 'not a date' }, NOW), true);
});
test('a second source keeps a country measured when Yahoo quotes are unreliable', async () => {
  const asked = [];
  // 3.64 riyals per dollar on every day; today's snapshot is not published yet.
  const fetchSnapshot = async (date) => {
    asked.push(date);
    if (date === '2026-11-13') throw new Error('not published');
    return { date, usd: { qar: 3.64, egp: date < '2026-09-01' ? 50 : 53.5 } };
  };
  const windows = await fetchFallbackWindows(NOW, { fetchSnapshot });
  assert.deepEqual(windows.late.map(s => s.date), ['2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09', '2026-11-08']);
  assert.equal(windows.anchorDate, '2026-08-14');
  assert.equal(asked.length, 11);
  const qar = fallbackDailyQuotes('QAR', windows);
  assert.equal(qar.source, 'currency-api');
  assert.equal(qar.asOf, '2026-11-12');
  assert.ok(Math.abs(qar.latest - 1 / 3.64) < 1e-12);
  // The producer reads the fallback like any other block: a held peg is a measured zero.
  const raw = inputs();
  raw.currency.rates = [{ countryCode: 'QA', daily90: { ...qar, yahooNoiseShare: recorded('QAR').noiseShare } }, { countryCode: 'EG', daily90: fallbackDailyQuotes('EGP', windows) }];
  const member = economicCountry(raw, 'QA', NOW).members.currency;
  assert.equal(member.value, 0);
  assert.equal(member.reference.quoteSource, 'currency-api');
  assert.ok(member.reference.noiseShare > 0.3);
  assert.ok(Math.abs(economicCountry(raw, 'EG', NOW).members.currency.value - 100 * (1 - 50 / 53.5)) < 1e-9);
  // No table, a currency the table lacks, or too few days: no block, so the member stays absent.
  assert.equal(fallbackDailyQuotes('QAR', null), null);
  assert.equal(fallbackDailyQuotes('XXX', windows), null);
  assert.equal(await fetchFallbackWindows(NOW, { fetchSnapshot: async (date) => { if (date > '2026-11-09') throw new Error('down'); return { date, usd: { qar: 3.64 } }; } }), null);
});
test('country, canonical key, metadata and activation contracts agree', () => {
  assert.deepEqual([...ECONOMIC_COUNTRIES].sort(), [...CII_COUNTRY_CODES].sort());
  assert.equal(health.STANDALONE_KEYS.ciiEconomicStress, ECONOMIC_KEY);
  assert.equal(health.SEED_META.ciiEconomicStress.key, ECONOMIC_META_KEY);
  assert.notEqual(ECONOMIC_KEY, ECONOMIC_META_KEY);
  assert.equal(health.ACTIVATION_MARKERS.ciiEconomicStress, ECONOMIC_ACTIVATION_KEY);
});
test('publishes the union of input countries, including unmeasured rows, with the actual record count', async () => {
  const raw = inputs();
  raw.inflation.countries.NO = { frequency: 'M', points: cpi };
  raw.eurostat.countries.ES = { frequency: 'M', points: cpi };
  raw.japan.countries.AU = { frequency: 'Q', points: [] };
  raw.yield.countries.CA = { curves: [] };
  raw.currency.rates.push({ countryCode: 'PH', daily90: cleanDailyQuotes(flatDaily()) });
  // Aggregates and malformed identifiers are not countries.
  raw.inflation.countries.WLD = { frequency: 'M', points: cpi };
  raw.currency.rates.push({ countryCode: null }, { countryCode: 'ZZ' });
  let published;
  const { payload } = await seedEconomicStress({
    read: async key => raw[Object.keys(INPUT_KEYS).find(id => INPUT_KEYS[id] === key)],
    publish: async options => { published = options; return true; },
    activateKey: async () => {}, nowMs: NOW,
  });
  assert.deepEqual(Object.keys(payload.countries).sort(), [...ECONOMIC_COUNTRIES, 'NO', 'ES', 'AU', 'CA', 'PH'].sort());
  assert.equal(payload.countries.NO.measured, true);
  assert.equal(payload.countries.PH.measured, true);
  assert.equal(payload.countries.CA.measured, false);
  assert.equal(payload.countries.AU.measured, false);
  assert.equal(payload.measuredCount, 34);
  assert.equal(published.recordCount, 36);
  assert.equal(published.data, payload);
  const scoredOnly = buildEconomicStress(inputs(), NOW);
  for (const code of ECONOMIC_COUNTRIES) assert.deepEqual(payload.countries[code], scoredOnly.countries[code]);
});
test('health accepts global economic rows but still requires every scored country', () => {
  const payload = buildEconomicStress(inputs(), NOW);
  payload.countries.PH = economicCountry(inputs(), 'PH', NOW);
  const check = () => health.composeCiiEconomicStressHealth({ status: 'OK' }, JSON.stringify(payload), false, NOW);
  assert.equal(check().status, 'OK');
  assert.equal(check().validCoverage, true);
  delete payload.countries.KP; // Even a country with no expected economic member must exist.
  assert.equal(check().status, 'COVERAGE_PARTIAL');
  assert.equal(check().validCoverage, false);
  assert.ok(check().unmeasuredCountries.includes('KP'));
});
test('peg zero is observed and GDP does not affect the member', () => {
  const raw = inputs();
  assert.equal(raw.currency.rates[0].monthlyBars, undefined);
  const a = economicCountry(raw, 'AE', NOW), b = economicCountry(raw, 'QA', NOW);
  assert.equal(a.members.currency.value, 0);
  assert.deepEqual(a.members.currency, b.members.currency);
  raw.inflation.countries.AE.gdp = 1e15;
  assert.deepEqual(economicCountry(raw, 'AE', NOW).members.currency, a.members.currency);
  for (const code of ['US', 'DE', 'FR']) {
    const row = economicCountry(raw, code, NOW);
    assert.equal(row.members.currency, undefined);
    assert.equal(row.absent.currency.reason, 'not-applicable');
  }
});
test('missing history and stale inputs are absent, not zero, and countries remain published', () => {
  const raw = inputs();
  raw.currency.rates = [];
  raw.inflation.countries.KP.points = cpi.slice(0, 5);
  const p = buildEconomicStress(raw, NOW);
  assert.equal(p.countries.KP.measured, false);
  assert.deepEqual(p.countries.KP.members, {});
  assert.equal(p.countries.KP.absent.inflation.reason, 'stale');
  assert.equal(p.countries.KP.label, 'economic stress not measured');
  assert.equal(Object.keys(p.countries).length, 31);
  const old = inputs(); delete old.currency.rates.find(x => x.countryCode === 'AE').daily90;
  assert.equal(economicCountry(old, 'AE', NOW).absent.currency.reason, 'insufficient-history');
});
test('CPI mirrors supply one member and a stale mirror cannot hide a fresh one', () => {
  const raw = inputs();
  raw.eurostat.countries.DE = { frequency: 'M', points: cpi };
  raw.inflation.countries.DE = { frequency: 'M', points: cpi.slice(0, 5) };
  const row = economicCountry(raw, 'DE', NOW);
  assert.equal(row.members.inflation.sourceKey, INPUT_KEYS.eurostat);
  assert.equal(Object.keys(row.members).length, 1);
  assert.ok(Math.abs(row.members.inflation.value) < 1e-10);
});
test('OQ9 publishes readable partial coverage instead of treating absence as failure', async () => {
  const raw = inputs();
  raw.currency.rates = [];
  raw.inflation.countries = {};
  let published, activated = false;
  await seedEconomicStress({
    read: async key => raw[Object.keys(INPUT_KEYS).find(id => INPUT_KEYS[id] === key)],
    publish: async options => { published = options.data; return true; },
    activateKey: async () => { activated = true; }, nowMs: NOW,
  });
  assert.equal(published.measuredCount, 1); // US CPI is still readable and fresh.
  assert.equal(published.countries.AE.measured, false);
  assert.equal(Object.keys(published.countries).length, 31);
  assert.equal(activated, true);
});
test('monthly yield change uses twelve distinct preceding months, including negative yields', () => {
  const raw = inputs();
  const curves = Array.from({ length: 13 }, (_, i) => ({ date: new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 10), tenors: { '10y': i === 12 ? 1 : -1 } }));
  raw.yield.countries.DE = { curves };
  assert.equal(economicCountry(raw, 'DE', NOW).members.yield.value, 2);
  curves.splice(2, 1);
  assert.equal(economicCountry(raw, 'DE', NOW).absent.yield.reason, 'insufficient-history');
});
test('25 measured countries stay healthy when India loses CPI but has fresh currency', () => {
  const raw = inputs();
  for (const code of ['KP','CU','SY','YE','MM','AF']) { delete raw.inflation.countries[code]; raw.currency.rates = raw.currency.rates.filter(x => x.countryCode !== code); }
  raw.inflation.countries.IN.points = cpi.slice(0, 5);
  const p = buildEconomicStress(raw, NOW);
  assert.equal(p.measuredCount, 25);
  const check = payload => health.composeCiiEconomicStressHealth({ status: 'OK' }, JSON.stringify(payload), false, NOW);
  assert.equal(check(p).status, 'OK');
  p.countries.IN.members.currency.expiresAt = NOW - 1;
  assert.equal(check(p).measuredCount, 24);
  assert.equal(check(p).status, 'COVERAGE_PARTIAL');
  assert.deepEqual(check(p).missingExpectedCountries, ['IN']);
  p.countries.RU.members = {};
  assert.equal(check(p).measuredCount, 23);
  assert.equal(check(p).status, 'COVERAGE_PARTIAL');
  p.countries.IR.members = {};
  assert.equal(check(p).measuredCount, 22);
  assert.equal(check(p).status, 'COVERAGE_PARTIAL');
});
test('unreadable keys and failed publication cannot activate or overwrite last-good data', async () => {
  let writes = 0, activations = 0;
  const raw = inputs();
  const read = async key => raw[Object.keys(INPUT_KEYS).find(k => INPUT_KEYS[k] === key)];
  await assert.rejects(seedEconomicStress({ read: async () => null, publish: async () => { writes++; }, activateKey: async () => { activations++; }, nowMs: NOW }), /Unreadable/);
  assert.equal(writes, 0);
  await assert.rejects(seedEconomicStress({ read, publish: async () => false, activateKey: async () => { activations++; }, nowMs: NOW }), /publication failed/);
  assert.equal(activations, 0);
  await seedEconomicStress({ read, dryRun: true, publish: async () => { writes++; }, activateKey: async () => { activations++; }, nowMs: NOW });
  assert.equal(writes, 0);
});
test('calendar freshness boundaries retain dates and never carry a stale numeric member', () => {
  const raw = inputs();
  raw.currency.rates = [];
  raw.inflation.countries.IN.points = cpi.filter(p => p.date <= '2026-07');
  const before = economicCountry(raw, 'IN', Date.UTC(2026, 10, 30, 23, 59, 59));
  assert.ok(before.members.inflation);
  const after = economicCountry(raw, 'IN', Date.UTC(2026, 11, 1));
  assert.equal(after.measured, false);
  assert.equal(after.absent.inflation.observedAt, '2026-07-31');
  assert.equal(after.absent.inflation.value, undefined);
});
test('health does not trust metadata counts and clears containment even on stale data', () => {
  const p = buildEconomicStress(inputs(), NOW);
  for (const row of Object.values(p.countries)) for (const member of Object.values(row.members)) member.expiresAt = NOW - 1;
  p.measuredCount = 31;
  const proofs = new Map([['ciiEconomicStress', {}]]);
  const entry = health.composeCiiEconomicStressHealth({ status: 'STALE_SEED' }, JSON.stringify(p), false, NOW, proofs);
  assert.equal(entry.measuredCount, 0);
  assert.equal(proofs.size, 0);
  assert.equal(health.composeCiiEconomicStressHealth({ status: 'OK' }, null, true, NOW).status, 'REDIS_PARTIAL');
});
test('depreciation is proportional and quarterly inflation expires after seven calendar months', () => {
  const raw = inputs();
  const row = raw.currency.rates.find(x => x.countryCode === 'AE');
  const fallen = flatDaily().map((p, i) => ({ ...p, close: i >= 100 ? 0.9 : 1 }));
  row.daily90 = cleanDailyQuotes(fallen);
  assert.ok(Math.abs(economicCountry(raw, 'AE', NOW).members.currency.value - 10) < 1e-10);
  row.daily90 = cleanDailyQuotes(fallen.map(p => ({ ...p, close: p.close * 100 })));
  assert.ok(Math.abs(economicCountry(raw, 'AE', NOW).members.currency.value - 10) < 1e-10);
  raw.currency.rates = [];
  raw.inflation.countries.IR = { frequency: 'Q', points: [
    { date: '2024-Q1', value: 100 }, { date: '2025-Q1', value: 110 }, { date: '2026-Q1', value: 121 },
  ] };
  assert.ok(economicCountry(raw, 'IR', Date.UTC(2026, 9, 31)).members.inflation);
  assert.equal(economicCountry(raw, 'IR', Date.UTC(2026, 10, 1)).absent.inflation.reason, 'stale');
});
