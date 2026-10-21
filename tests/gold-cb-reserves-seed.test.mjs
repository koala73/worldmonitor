import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { latestMonth, monthOffset, buildReservesPayload, normalizePeriod } from '../scripts/seed-gold-cb-reserves.mjs';

describe('seed-gold-cb-reserves: normalizePeriod (SDMX 3.0 YYYY-MMM → ISO YYYY-MM)', () => {
  it('strips the M prefix from month component', () => {
    assert.equal(normalizePeriod('2026-M03'), '2026-03');
    assert.equal(normalizePeriod('2025-M12'), '2025-12');
    assert.equal(normalizePeriod('2024-M01'), '2024-01');
  });
  it('passes ISO YYYY-MM through unchanged', () => {
    assert.equal(normalizePeriod('2026-03'), '2026-03');
  });
  it('returns falsy/non-string inputs unchanged', () => {
    assert.equal(normalizePeriod(null), null);
    assert.equal(normalizePeriod(undefined), undefined);
  });
});

describe('seed-gold-cb-reserves: latestMonth', () => {
  it('returns the lexicographically latest YYYY-MM key', () => {
    assert.equal(latestMonth({ '2025-12': 1, '2026-01': 2, '2025-11': 3 }), '2026-01');
  });
  it('returns undefined on empty object', () => {
    assert.equal(latestMonth({}), undefined);
  });
});

describe('seed-gold-cb-reserves: monthOffset', () => {
  it('subtracts 12 months across year boundary', () => {
    assert.equal(monthOffset('2026-02', -12), '2025-02');
  });
  it('subtracts 1 month within year', () => {
    assert.equal(monthOffset('2026-04', -1), '2026-03');
  });
  it('handles January rollback to previous December', () => {
    assert.equal(monthOffset('2026-01', -1), '2025-12');
  });
});

describe('seed-gold-cb-reserves: buildReservesPayload (ounces indicator)', () => {
  // 1 tonne = 32150.7 troy oz. US holdings ~8133 tonnes → 261.5M oz.
  const raw = {
    USA: { name: 'United States', byMonth: { '2025-01': 261_500_000, '2026-01': 261_500_000 } },
    DEU: { name: 'Germany',       byMonth: { '2025-01': 108_000_000, '2026-01': 108_000_000 } },
    CHN: { name: 'China',         byMonth: { '2025-01':  70_000_000, '2026-01':  74_000_000 } },
    TUR: { name: 'Turkey',        byMonth: { '2025-01':  18_000_000, '2026-01':  20_000_000 } },
    // Two sellers
    UZB: { name: 'Uzbekistan',    byMonth: { '2025-01':  12_000_000, '2026-01':  10_000_000 } },
    CAN: { name: 'Canada',        byMonth: { '2025-01':   5_000_000, '2026-01':   4_000_000 } },
    // Aggregate that must be filtered out
    EU:  { name: 'European Union', byMonth: { '2025-01': 500_000_000, '2026-01': 500_000_000 } },
  };

  it('drops aggregate codes and sorts holders descending by tonnes', () => {
    const payload = buildReservesPayload(raw, 'RAFAGOLDV_OZT');
    assert.ok(payload !== null);
    assert.equal(payload.asOfMonth, '2026-01');
    assert.equal(payload.valueIsOunces, true);
    assert.ok(!payload.topHolders.some(h => h.iso3 === 'EU'), 'EU aggregate must be filtered');
    assert.equal(payload.topHolders[0].iso3, 'USA');
    assert.equal(payload.topHolders[1].iso3, 'DEU');
    assert.equal(payload.topHolders[2].iso3, 'CHN');
  });

  it('computes 12-month tonnage deltas correctly', () => {
    const payload = buildReservesPayload(raw, 'RAFAGOLDV_OZT');
    // China: +4M oz → +124.4 tonnes
    const cn = payload.topBuyers12m.find(m => m.iso3 === 'CHN');
    assert.ok(cn);
    assert.ok(Math.abs(cn.deltaTonnes12m - 124.4) < 0.5, `got ${cn.deltaTonnes12m}`);
    // Turkey: +2M oz → +62.2 tonnes
    const tr = payload.topBuyers12m.find(m => m.iso3 === 'TUR');
    assert.ok(Math.abs(tr.deltaTonnes12m - 62.2) < 0.5);
    // Uzbekistan: -2M oz → -62.2 tonnes (seller)
    const uz = payload.topSellers12m.find(m => m.iso3 === 'UZB');
    assert.ok(uz);
    assert.ok(uz.deltaTonnes12m < 0);
  });

  it('returns null when no non-aggregate data exists', () => {
    const payload = buildReservesPayload({ EU: { name: 'EU', byMonth: { '2026-01': 500_000_000 } } }, 'RAFAGOLDV_OZT');
    assert.equal(payload, null);
  });

  it('still drops countries with no value within the 2-month lookback window', () => {
    const partial = {
      USA: { name: 'United States', byMonth: { '2025-01': 261_500_000, '2026-04': 261_500_000 } },
      DEU: { name: 'Germany', byMonth: { '2025-01': 108_000_000 } }, // last data 2025-01, asOfMonth 2026-04 → out of window
    };
    const payload = buildReservesPayload(partial, 'RAFAGOLDV_OZT');
    assert.ok(payload);
    assert.equal(payload.topHolders.length, 1);
    assert.equal(payload.topHolders[0].iso3, 'USA');
  });

  it('keeps countries reporting 1-2 months behind the global asOfMonth', () => {
    // Regression: when ONE fast-reporting CB advances asOfMonth, lagging
    // reporters used to get filtered out, dropping topHolders below the
    // validateFn floor (>=10) and triggering the soft-skip EMPTY_DATA path.
    const raw = {
      USA: { name: 'United States', byMonth: { '2025-03': 261_500_000, '2026-03': 261_500_000 } },
      // Germany only has data through 2026-02 (one-month lag).
      DEU: { name: 'Germany',       byMonth: { '2025-02': 108_000_000, '2026-02': 108_500_000 } },
      // Italy only has data through 2026-01 (two-month lag).
      ITA: { name: 'Italy',         byMonth: { '2025-01':  78_000_000, '2026-01':  78_500_000 } },
    };
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO');
    assert.ok(payload);
    assert.equal(payload.asOfMonth, '2026-03');
    const isoSet = new Set(payload.topHolders.map(h => h.iso3));
    assert.ok(isoSet.has('USA'));
    assert.ok(isoSet.has('DEU'), 'DEU (1-month lag) must survive');
    assert.ok(isoSet.has('ITA'), 'ITA (2-month lag) must survive');
  });

  it('computes 12-month delta relative to per-country resolved month, not global asOfMonth', () => {
    // DEU's resolved month is 2026-02 (1 month behind global). Prior must be
    // 2025-02 (12 months before 2026-02), not 2025-03 (12 months before
    // global 2026-03) — otherwise the delta is off by one month and may
    // silently produce a phantom buy/sell signal.
    const raw = {
      USA: { name: 'United States', byMonth: { '2025-03': 261_500_000, '2026-03': 261_500_000 } },
      DEU: { name: 'Germany',       byMonth: { '2025-02': 100_000_000, '2026-02': 110_000_000 } },
    };
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO');
    const de = payload.topHolders.find(h => h.iso3 === 'DEU');
    assert.ok(de, 'Germany must be in topHolders');
    const buy = payload.topBuyers12m.find(m => m.iso3 === 'DEU');
    assert.ok(buy, 'Germany 12m buy delta must be computed against 2025-02 (its own -12m), not 2025-03');
    // +10M oz / 32150.7 oz-per-tonne ≈ 311.05 tonnes
    assert.ok(Math.abs(buy.deltaTonnes12m - 311.05) < 0.5, `expected ~311.05, got ${buy.deltaTonnes12m}`);
  });

  it('handles real SDMX 3.0 YYYY-MMM keys end-to-end after normalization', () => {
    // Fixture mirrors what the IMF SDMX endpoint actually returns post-fetch
    // (after normalizePeriod has been applied at ingest). This is the shape
    // buildReservesPayload sees today in production.
    const raw = {
      USA: { name: 'United States', byMonth: { '2025-03': 261_500_000, '2026-03': 261_500_000 } },
      DEU: { name: 'Germany',       byMonth: { '2025-03': 108_000_000, '2026-03': 108_500_000 } },
    };
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO');
    assert.ok(payload);
    assert.equal(payload.asOfMonth, '2026-03');
    assert.equal(payload.topHolders.length, 2);
    // Both deltas should be computed (was empty before SDMX format fix)
    const buys = payload.topBuyers12m.map(m => m.iso3);
    assert.ok(buys.includes('DEU'), 'DEU 12m buy delta should be present (was always empty pre-fix)');
  });
});

describe('seed-gold-cb-reserves: buildReservesPayload (USD indicator)', () => {
  it('keeps USD values but marks tonnes as 0 (unknown) and skips deltas', () => {
    const raw = {
      USA: { name: 'United States', byMonth: { '2025-01': 600_000_000_000, '2026-01': 700_000_000_000 } },
    };
    const payload = buildReservesPayload(raw, 'RAFAGOLD_USD');
    assert.ok(payload);
    assert.equal(payload.valueIsOunces, false);
    assert.equal(payload.topHolders[0].tonnes, 0); // USD series can't derive tonnes here
    // Delta stays zero because USD moves can be price-driven, not buying
    assert.equal(payload.topBuyers12m.length, 0);
  });
});

describe('seed-gold-cb-reserves: pctOfReserves computation', () => {
  it('computes gold share of total reserves when both USD series are supplied', () => {
    const raw = {
      USA: { name: 'United States', byMonth: { '2026-01': 261_500_000 } },
      DEU: { name: 'Germany',       byMonth: { '2026-01': 108_000_000 } },
      CHN: { name: 'China',         byMonth: { '2026-01':  74_000_000 } },
    };
    // Gold USD value per country (market value, approximate)
    const goldUsd = {
      USA: { byMonth: { '2026-01': 400_000_000_000 } },
      DEU: { byMonth: { '2026-01': 170_000_000_000 } },
      CHN: { byMonth: { '2026-01': 115_000_000_000 } },
    };
    // Total reserve assets per country
    const totalUsd = {
      USA: { byMonth: { '2026-01': 800_000_000_000 } },  // US: 50% gold share (synthetic)
      DEU: { byMonth: { '2026-01': 250_000_000_000 } },  // DE: 68% (synthetic, realistic)
      CHN: { byMonth: { '2026-01': 3_300_000_000_000 } }, // CN: ~3.5% (realistic — mostly FX)
    };
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO', goldUsd, totalUsd);
    assert.ok(payload);

    const by = Object.fromEntries(payload.topHolders.map(h => [h.iso3, h]));
    assert.equal(by.USA.pctOfReserves, 50);
    assert.equal(by.DEU.pctOfReserves, 68);
    assert.equal(by.CHN.pctOfReserves, 3.48);
  });

  it('falls back to pctOfReserves=0 when denominator series is missing for a country', () => {
    const raw = {
      USA: { name: 'United States', byMonth: { '2026-01': 261_500_000 } },
    };
    // Gold USD present, but total reserves missing for USA
    const goldUsd = { USA: { byMonth: { '2026-01': 400_000_000_000 } } };
    const totalUsd = {};
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO', goldUsd, totalUsd);
    assert.equal(payload.topHolders[0].pctOfReserves, 0, 'no denominator → 0');
  });

  it('accepts a denominator from 1-2 months before asOfMonth (per-country reporting lag)', () => {
    // Primary tonnage reports 2026-03. Total reserves only has 2026-02 (1mo lag).
    // Should still compute pctOfReserves using the 2026-02 denominator.
    const raw = {
      USA: { name: 'United States', byMonth: { '2026-03': 261_500_000 } },
    };
    const goldUsd = { USA: { byMonth: { '2026-03': 400_000_000_000 } } };
    const totalUsd = { USA: { byMonth: { '2026-02': 800_000_000_000 } } };
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO', goldUsd, totalUsd);
    assert.equal(payload.asOfMonth, '2026-03');
    assert.equal(payload.topHolders[0].pctOfReserves, 50, '2026-02 total is within the 2-month lookback window');
  });

  it('rejects a denominator older than the 2-month window (stale data shouldn\'t contaminate current pct)', () => {
    const raw = {
      USA: { name: 'United States', byMonth: { '2026-06': 261_500_000 } },
    };
    const goldUsd = { USA: { byMonth: { '2026-06': 400_000_000_000 } } };
    // Total reserves last reported 2026-01 — 5 months before; outside the window.
    const totalUsd = { USA: { byMonth: { '2026-01': 800_000_000_000 } } };
    const payload = buildReservesPayload(raw, 'IRFCLDT1_IRFCL56_FTO', goldUsd, totalUsd);
    assert.equal(payload.topHolders[0].pctOfReserves, 0, 'stale denominator (outside 2-month window) is dropped');
  });
});
