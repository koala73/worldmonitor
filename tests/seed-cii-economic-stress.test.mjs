import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CII_COUNTRY_CODES } from '../shared/cii-weights.ts';
import { __testing__ as health } from '../api/health.js';
import { buildEconomicStress, economicCountry, seedEconomicStress, ECONOMIC_COUNTRIES, ECONOMIC_KEY, ECONOMIC_META_KEY, ECONOMIC_ACTIVATION_KEY, INPUT_KEYS } from '../scripts/seed-cii-economic-stress.mjs';
import { computeYoy } from '../scripts/seed-fx-yoy.mjs';
const NOW = Date.UTC(2026, 10, 13);
const cpi = Array.from({ length: 37 }, (_, i) => ({ date: new Date(Date.UTC(2023, 9 + i, 1)).toISOString().slice(0, 7), value: 100 * 1.01 ** i }));
const bars = Array.from({ length: 25 }, (_, i) => ({ t: Date.UTC(2024, 10 + i, i === 24 ? 12 : 1), close: 1 }));
function inputs() {
  const countries = Object.fromEntries(ECONOMIC_COUNTRIES.map(c => [c, { frequency: 'M', points: cpi }]));
  return { currency: { rates: ECONOMIC_COUNTRIES.map(countryCode => ({ countryCode, ...computeYoy(bars) })) },
    inflation: { countries }, eurostat: { countries: {} }, japan: { countries: {} }, usCpi: { components: { headline: cpi.map(p => ({ ...p, date: `${p.date}-01` })) } }, yield: { countries: {} } };
}
test('country, canonical key, metadata and activation contracts agree', () => {
  assert.deepEqual([...ECONOMIC_COUNTRIES].sort(), [...CII_COUNTRY_CODES].sort());
  assert.equal(health.STANDALONE_KEYS.ciiEconomicStress, ECONOMIC_KEY);
  assert.equal(health.SEED_META.ciiEconomicStress.key, ECONOMIC_META_KEY);
  assert.notEqual(ECONOMIC_KEY, ECONOMIC_META_KEY);
  assert.equal(health.ACTIVATION_MARKERS.ciiEconomicStress, ECONOMIC_ACTIVATION_KEY);
});
test('FX retains its downloaded bars, peg zero is observed and GDP does not affect the member', () => {
  const raw = inputs();
  assert.equal(raw.currency.rates[0].monthlyBars.length, bars.length);
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
  const old = inputs(); delete old.currency.rates.find(x => x.countryCode === 'AE').monthlyBars;
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
  row.monthlyBars.at(-1).value = 0.9;
  assert.ok(Math.abs(economicCountry(raw, 'AE', NOW).members.currency.value - 10) < 1e-10);
  row.monthlyBars.forEach(p => { p.value *= 100; });
  assert.ok(Math.abs(economicCountry(raw, 'AE', NOW).members.currency.value - 10) < 1e-10);
  raw.currency.rates = [];
  raw.inflation.countries.IR = { frequency: 'Q', points: [
    { date: '2024-Q1', value: 100 }, { date: '2025-Q1', value: 110 }, { date: '2026-Q1', value: 121 },
  ] };
  assert.ok(economicCountry(raw, 'IR', Date.UTC(2026, 9, 31)).members.inflation);
  assert.equal(economicCountry(raw, 'IR', Date.UTC(2026, 10, 1)).absent.inflation.reason, 'stale');
});
