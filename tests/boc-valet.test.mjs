import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOC_VALET_HOST,
  BOND_YIELDS_URL,
  FX_RATES_DAILY_URL,
  MIN_FX_RATE_COUNT,
  POLICY_RATE_URL,
  bocValetCacheKey,
  bocContentMeta,
  buildBocPayload,
  declareBocRecords,
  fetchApprovedValetJson,
  parsePolicyRateHistory,
  parseValetObservations,
  validateBocPayload,
} from '../scripts/lib/boc-valet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fxDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/boc-valet/fx-rates-daily-recent-1.json'), 'utf8'));
const policyDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/boc-valet/v39079-recent-5.json'), 'utf8'));
const yieldsDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/boc-valet/bond-yields-recent-1.json'), 'utf8'));
const libSrc = readFileSync(resolve(here, '../scripts/lib/boc-valet.mjs'), 'utf8');
const seederSrc = readFileSync(resolve(here, '../scripts/seed-boc-valet.mjs'), 'utf8');
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');

test('captured FX_RATES_DAILY recent=1 fixture parses USD/CAD and enough pairs', () => {
  const parsed = parseValetObservations(fxDoc);
  const usd = parsed.series.find((row) => row.seriesId === 'FXUSDCAD');
  assert.ok(usd);
  assert.equal(usd.date, '2026-08-13');
  assert.equal(usd.value, 1.3938);
  assert.ok(parsed.series.length >= MIN_FX_RATE_COUNT);
});

test('policy-rate history keeps the current overnight target and does not invent a move', () => {
  const policy = parsePolicyRateHistory(policyDoc);
  assert.equal(policy.rate, 2.25);
  assert.equal(policy.observedAt, '2026-08-12');
  assert.equal(policy.change, null);
  assert.equal(policy.observationCount, 5);
});

test('buildBocPayload publishes CAD-per-unit FX, overnight target, and benchmark yields', () => {
  const payload = buildBocPayload({ fxDoc, policyDoc, yieldsDoc, seededAtMs: Date.parse('2026-08-13T21:00:00Z') });
  assert.equal(payload.quoteCurrency, 'CAD');
  assert.equal(payload.effectiveDate, '2026-08-13');
  assert.equal(payload.rates.USD.rate, 1.3938);
  assert.equal(payload.policyRate.rate, 2.25);
  assert.equal(payload.bondYields['10y'].rate, 3.69);
  assert.equal(validateBocPayload(payload), true);
  assert.ok(declareBocRecords(payload) >= MIN_FX_RATE_COUNT + 1);
});

test('discontinued FX relics are not published as current rates', () => {
  const payload = buildBocPayload({ fxDoc, policyDoc, yieldsDoc, seededAtMs: Date.parse('2026-08-13T21:00:00Z') });
  assert.equal(payload.effectiveDate, '2026-08-13');
  assert.equal(payload.rates.VND, undefined);
  assert.equal(payload.rates.RUB, undefined);
  assert.equal(payload.rates.SAR, undefined);
  assert.ok(payload.rates.USD);
  assert.ok(payload.rates.EUR);
  for (const [code, row] of Object.entries(payload.rates)) {
    assert.equal(row.date, '2026-08-13', `${code} must be the live close, not a relic`);
  }
});

test('cache keys include recent=1 for FX and the Valet query string', () => {
  assert.match(FX_RATES_DAILY_URL, /recent=1/);
  assert.ok(bocValetCacheKey(FX_RATES_DAILY_URL).includes('recent=1'));
  assert.ok(bocValetCacheKey(FX_RATES_DAILY_URL).includes(FX_RATES_DAILY_URL));
  assert.match(BOND_YIELDS_URL, /recent=1/);
  assert.ok(bocValetCacheKey(POLICY_RATE_URL).includes('recent=5'));
});

test('allowlist rejects a non-Valet host, errors on redirects, caps bytes, and sends Chrome UA', async () => {
  await assert.rejects(
    fetchApprovedValetJson('https://example.com/valet/observations/group/FX_RATES_DAILY/json?recent=1'),
    /UNTRUSTED_SOURCE_HOST/,
  );

  let init;
  const cache = new Map();
  const doc = await fetchApprovedValetJson(FX_RATES_DAILY_URL, {
    fetchFn: async (_url, options) => {
      init = options;
      return new Response(JSON.stringify(fxDoc), { headers: { 'content-type': 'application/json' } });
    },
    cache,
  });
  assert.equal(init.redirect, 'error');
  assert.match(init.headers['User-Agent'], /Chrome/);
  assert.equal(doc.groupDetail.label, 'Daily exchange rates');
  assert.ok(cache.has(bocValetCacheKey(FX_RATES_DAILY_URL)));

  await assert.rejects(
    fetchApprovedValetJson(FX_RATES_DAILY_URL, {
      maxBytes: 10,
      fetchFn: async () => new Response(JSON.stringify(fxDoc)),
    }),
    /RESPONSE_TOO_LARGE/,
  );
});

test('content-age clocks FX and policy observations, not the seeder now', () => {
  const payload = buildBocPayload({ fxDoc, policyDoc, yieldsDoc, seededAtMs: Date.parse('2026-08-13T21:00:00Z') });
  const meta = bocContentMeta(payload, Date.parse('2026-08-13T21:00:00Z'));
  assert.ok(meta);
  assert.ok(meta.newestItemAt <= Date.parse('2026-08-13T21:00:00Z'));
  assert.notEqual(meta.newestItemAt, Date.parse('2026-08-13T21:00:00Z'));
});

test('tests import the lib, not the seeder main; neither binds fetch', () => {
  assert.doesNotMatch(testSrc, /from ['"][^'"]*seed-boc-valet/);
  assert.doesNotMatch(libSrc, /fetch\.bind/);
  assert.doesNotMatch(seederSrc, /fetch\.bind/);
  assert.doesNotMatch(libSrc, /fetch\.bind\(globalThis\)/);
  assert.equal(BOC_VALET_HOST, 'www.bankofcanada.ca');
  assert.match(seederSrc, /from '\.\/lib\/boc-valet\.mjs'/);
});
