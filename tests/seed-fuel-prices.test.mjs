import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCREStationPrices, validateFuel, withFuelRetry, fetchUS_EIA, regionalFuelEntries, FUEL_FX_CURRENCIES } from '../scripts/seed-fuel-prices.mjs';
import { SHARED_FX_FALLBACKS } from '../scripts/_seed-utils.mjs';

test('withFuelRetry returns the first success without retrying', async () => {
  let calls = 0;
  const r = await withFuelRetry('T', async () => { calls++; return 'ok'; }, { baseDelayMs: 0 });
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
});

test('withFuelRetry retries transient failures then succeeds', async () => {
  let calls = 0;
  const r = await withFuelRetry('T', async () => {
    calls++;
    if (calls < 3) throw new Error('boom');
    return 'ok';
  }, { baseDelayMs: 0 });
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
});

test('withFuelRetry throws the last error after exhausting tries', async () => {
  let calls = 0;
  await assert.rejects(
    withFuelRetry('T', async () => { calls++; throw new Error(`fail-${calls}`); }, { tries: 3, baseDelayMs: 0 }),
    /fail-3/,
  );
  assert.equal(calls, 3);
});

// Regression: prod log 2026-06-23 showed a single `[US] fetchUS_EIA error: HTTP 502`
// rejecting the ENTIRE multi-source publish (US is critical + untolerated), because
// fetchUS_EIA did a bare fetch with no retry. A transient 502 must be retried.
test('fetchUS_EIA recovers from a transient 502 instead of failing the critical source', async () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.EIA_API_KEY;
  process.env.EIA_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('bad gateway', { status: 502 });
    return new Response(JSON.stringify({
      response: { data: [
        { series: 'EMM_EPMR_PTE_NUS_DPG', value: 3.10, period: '2026-06-16' },
        { series: 'EMD_EPD2DXL0_PTE_NUS_DPG', value: 3.60, period: '2026-06-16' },
      ] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    // baseDelayMs: 0 threads through to withFuelRetry so the retry is instant
    // (no 1.5s real sleep) — the seam's whole point.
    const out = await fetchUS_EIA({ baseDelayMs: 0 });
    assert.ok(calls >= 2, 'should have retried after the 502');
    assert.equal(out.length, 1);
    assert.equal(out[0].code, 'US');
    assert.ok(out[0].gasoline.usdPrice > 0, 'US gasoline price should be present after recovery');
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = origKey;
  }
});

test('parseCREStationPrices extracts regular + diesel per-station prices from CRE XML', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<places>
  <place place_id="1">
    <gas_price type="regular">22.95</gas_price>
    <gas_price type="premium">26.91</gas_price>
  </place>
  <place place_id="2">
    <gas_price type="regular">24.7</gas_price>
    <gas_price type="diesel">29.5</gas_price>
  </place>
</places>`;
  const { regular, diesel } = parseCREStationPrices(xml);
  assert.deepEqual(regular, [22.95, 24.7]);
  assert.deepEqual(diesel, [29.5]);
});

test('parseCREStationPrices filters out-of-range prices', () => {
  // 0.01 and 1000.0 are clearly bad (placeholder/test rows); 15 and 50 are valid MXN/L.
  const xml = `<places>
    <place><gas_price type="regular">0.01</gas_price></place>
    <place><gas_price type="regular">15</gas_price></place>
    <place><gas_price type="regular">1000.0</gas_price></place>
    <place><gas_price type="regular">50</gas_price></place>
  </places>`;
  const { regular } = parseCREStationPrices(xml);
  assert.deepEqual(regular, [15, 50]);
});

test('parseCREStationPrices handles empty XML', () => {
  const { regular, diesel } = parseCREStationPrices('<places></places>');
  assert.deepEqual(regular, []);
  assert.deepEqual(diesel, []);
});

const HEALTHY_COUNTRIES = [
  { code: 'US' }, { code: 'GB' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
  ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
];

test('validateFuel accepts healthy snapshot (all sources fresh, 33 countries, US+GB+MY present)', () => {
  assert.equal(validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: [] }), true);
});

test('validateFuel rejects when an untolerated source failed (no silent degraded publishes)', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Mexico'] }),
    false,
    'a non-tolerated source failure must block publish; cache TTL serves last healthy snapshot',
  );
});

test('validateFuel accepts when only a TOLERATED source (Brazil) failed', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Brazil'] }),
    true,
    'Brazil ANP is structurally unreachable from Railway; must not gate publish or Railway crash-loops',
  );
});

test('validateFuel accepts when only TOLERATED New Zealand failed (Incapsula bot-wall)', () => {
  // MBIE moved behind an Incapsula JS bot-wall ~2026-05-20 — unreachable by plain
  // fetch from any IP (residential/datacenter/proxy). It must not gate the whole
  // multi-source publish, or fuel-prices goes STALE_SEED while ≥30 countries +
  // US/GB/MY are present. Same rationale as Brazil.
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['New Zealand'] }),
    true,
    'NZ MBIE is JS-bot-walled; must not gate publish (≥30 countries + US/GB/MY still required)',
  );
});

test('validateFuel still accepts when BOTH tolerated sources (Brazil + New Zealand) failed', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Brazil', 'New Zealand'] }),
    true,
  );
});

test('validateFuel still REJECTS a tolerated + an untolerated failure together', () => {
  // Tolerating NZ must not weaken the gate for a real critical-source outage.
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['New Zealand', 'Mexico'] }),
    false,
    'an untolerated failure (Mexico) must still reject even when a tolerated one (NZ) is also present',
  );
});

test('validateFuel rejects when country count < 30', () => {
  const countries = [
    { code: 'US' }, { code: 'GB' }, { code: 'MY' },
    ...Array.from({ length: 25 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, '28 countries should fail >=30');
});

test('validateFuel rejects when critical source US is missing', () => {
  const countries = [
    { code: 'GB' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing US fails gate');
});

test('validateFuel rejects when critical source GB is missing', () => {
  const countries = [
    { code: 'US' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing GB fails gate');
});

test('validateFuel rejects when critical source MY is missing', () => {
  const countries = [
    { code: 'US' }, { code: 'GB' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing MY fails gate');
});

test('validateFuel rejects null/undefined/empty', () => {
  assert.equal(validateFuel(null), false);
  assert.equal(validateFuel(undefined), false);
  assert.equal(validateFuel({}), false);
  assert.equal(validateFuel({ countries: [] }), false);
});

// Fiji, Papua New Guinea and Guatemala prices come from the regional energy
// feeds already in Redis (#9893); Brazil's ANP feed backs up the direct fetch.
const obs = (period, value, unit, area, metric = 'fuel.retail_price') => ({ metric, period, value, unit, area });
const NOW = Date.parse('2026-11-02T12:00:00Z');

test('regionalFuelEntries maps the newest regional retail prices to fuel-panel rows', () => {
  const entries = regionalFuelEntries({
    mem: { sourceId: 'mem', observations: [
      obs('2026-10-28', 32.07, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
      obs('2026-10-27', 32.5, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
      obs('2026-10-28', 42.69, 'GTQ/gal', 'Diésel; Guatemala City'),
      obs('2026-10-28', 26.99, 'GTQ/gal', 'Bunker; Guatemala City', 'fuel.price'),
    ] },
    fccc: { sourceId: 'fccc', observations: [
      obs('2026-11-01', 3.7, 'FJD/l', 'Motor Spirit; Schedule 1'),
      obs('2026-11-01', 3.9, 'FJD/l', 'Motor Spirit; Schedule 2'),
      obs('2026-11-01', 3.86, 'FJD/l', 'Diesel; Schedule 1'),
    ] },
    iccc: { sourceId: 'iccc', observations: [
      obs('2026-10-08', 4.69, 'PGK/l', 'Petrol; Port Moresby'),
      obs('2026-10-08', 5.9, 'PGK/l', 'Diesel; Port Moresby'),
      obs('2026-10-08', 7.31, 'PGK/l', 'Diesel; Port Moresby', 'fuel.retail_price.unsubsidized'),
    ] },
    anp: { sourceId: 'anp', observations: [
      obs('2026-10-24', 6.49, 'BRL/l', 'GASOLINA COMUM'),
      obs('2026-10-24', 6.99, 'BRL/l', 'OLEO DIESEL'),
      obs('2026-10-24', 7.32, 'BRL/l', 'OLEO DIESEL S10'),
    ] },
  }, NOW);
  const by = Object.fromEntries(entries.map(e => [e.code, e]));
  assert.deepEqual(Object.keys(by).sort(), ['BR', 'FJ', 'GT', 'PG']);

  // MEM publishes per US gallon; the panel is per litre.
  assert.equal(by.GT.currency, 'GTQ');
  assert.equal(by.GT.gasoline.localPrice, 8.472);
  assert.equal(by.GT.gasoline.observedAt, '2026-10-28');
  assert.equal(by.GT.gasoline.source, 'mem.gob.gt');
  assert.equal(by.GT.diesel.localPrice, 11.2775);
  assert.equal(by.FJ.gasoline.localPrice, 3.7, 'Schedule 1: Viti Levu, the main schedule');
  assert.equal(by.FJ.diesel.localPrice, 3.86);
  assert.equal(by.PG.diesel.localPrice, 5.9, 'retail, not the unsubsidised price');
  assert.equal(by.PG.gasoline.localPrice, 4.69);
  assert.equal(by.BR.gasoline.localPrice, 6.49);
  assert.equal(by.BR.diesel.localPrice, 6.99);
});

test('validateFuel tolerates an unavailable regional feed set', () => {
  const countries = [{ code: 'US' }, { code: 'GB' }, { code: 'MY' }, ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` }))];
  assert.equal(validateFuel({ countries, failedSources: ['Regional feeds'] }), true);
});

test('regionalFuelEntries skips stale, missing and unexpected-unit series', () => {
  const entries = regionalFuelEntries({
    // A Guatemala price three months old is not shown as current.
    mem: { sourceId: 'mem', observations: [obs('2026-08-01', 32, 'GTQ/gal', 'Gasolina Regular; Guatemala City')] },
    // A changed unit is not converted by guesswork.
    iccc: { sourceId: 'iccc', observations: [obs('2026-10-08', 469, 'toea/l', 'Petrol; Port Moresby')] },
    // Diesel only: the row keeps an empty gasoline cell.
    fccc: { sourceId: 'fccc', observations: [obs('2026-11-01', 3.86, 'FJD/l', 'Diesel; Schedule 1')] },
    // A record for another source is ignored.
    anp: { sourceId: 'mem', observations: [obs('2026-10-24', 6.49, 'BRL/l', 'GASOLINA COMUM')] },
  }, NOW);
  assert.deepEqual(entries.map(e => e.code), ['FJ']);
  assert.equal(entries[0].gasoline, null);
  assert.equal(entries[0].diesel.localPrice, 3.86);
});

test('FX currencies without a fallback rate are requested first, inside the point-of-use budget', () => {
  // getSharedFxRates fetches at most five currencies from Yahoo when the shared cache is cold
  // or missing them; later ones fall back to SHARED_FX_FALLBACKS, so rows without one would vanish.
  const withoutFallback = FUEL_FX_CURRENCIES.filter(c => SHARED_FX_FALLBACKS[c] == null);
  for (const c of ['GTQ', 'FJD', 'PGK']) assert.ok(withoutFallback.includes(c), c);
  assert.ok(withoutFallback.length <= 5, `only five point-of-use FX requests fit; ${withoutFallback.length} lack a fallback`);
  assert.deepEqual(FUEL_FX_CURRENCIES.slice(0, withoutFallback.length), withoutFallback);
});

test('EUR stays inside the five cold-cache FX requests, since every EU row is priced in EUR', () => {
  assert.ok(FUEL_FX_CURRENCIES.slice(0, 5).includes('EUR'), FUEL_FX_CURRENCIES.slice(0, 5).join(','));
  // EU rows are all published as EUR, so a BGN quote is never used.
  assert.ok(!FUEL_FX_CURRENCIES.includes('BGN'));
});
