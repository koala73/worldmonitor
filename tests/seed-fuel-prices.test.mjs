import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCREStationPrices, validateFuel, withFuelRetry, fetchUS_EIA } from '../scripts/seed-fuel-prices.mjs';

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
