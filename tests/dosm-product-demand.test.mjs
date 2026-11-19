/**
 * Malaysia reports product trade to JODI but no product demand, so its shock
 * had no products table. DOSM publishes Malaysia's final energy consumption
 * by commodity every year (ktoe); the seeder converts it to kb/d.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dosmProductDemand, ktoeToKbd } from '../scripts/_dosm-product-demand.mjs';
import { productDemandNationalSection } from '../scripts/seed-oil-trade-series.mjs';

// Live DOSM energy_consumption_commodity rows, 2018-2024.
const DOSM = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/dosm-my-energy-consumption-2026-10-28.json', import.meta.url), 'utf8'));

describe('DOSM product demand (Malaysia)', () => {
  it('converts the latest complete year to kb/d for each modeled product', () => {
    const d = dosmProductDemand(DOSM.rows);
    assert.equal(d.year, 2024);
    assert.deepEqual(d.ktoe, { gasoline: 15460, diesel: 12128, jet: 3079, lpg: 2687 });
    assert.deepEqual(d.products, { gasoline: 340.5, diesel: 240.7, jet: 62.9, lpg: 77.5 });
  });

  it('a year missing any product falls back to the previous complete year', () => {
    const d = dosmProductDemand([...DOSM.rows, { date: '2025-01-01', commodity: 'petrol', consumption: 16000 }]);
    assert.equal(d.year, 2024);
  });

  it('a negative or non-numeric value makes the year incomplete', () => {
    const rows = DOSM.rows.map((r) => (r.date === '2024-01-01' && r.commodity === 'diesel' ? { ...r, consumption: null } : r));
    assert.equal(dosmProductDemand(rows).year, 2023);
    assert.equal(dosmProductDemand([]), null);
  });

  it('divides by the calendar days of the year', () => {
    assert.ok(ktoeToKbd(1000, 'diesel', 2023) > ktoeToKbd(1000, 'diesel', 2024));
    assert.equal(Math.round(ktoeToKbd(1000, 'diesel', 2023) * 1000) / 1000, Math.round(((1000 * 41.868 / 43.0) * 7.46 / 365) * 1000) / 1000);
  });
});

describe('productDemandNational section', () => {
  const fetchedAt = '2026-10-28T03:00:00.000Z';
  it('publishes Malaysia from DOSM', () => {
    const s = productDemandNationalSection({ rows: DOSM.rows, fetchedAt });
    assert.equal(s.status, 'ok');
    assert.equal(s.unit, 'kbd');
    assert.equal(s.countries.MY.source, 'DOSM');
    assert.equal(s.countries.MY.year, 2024);
    assert.equal(s.countries.MY.products.gasoline, 340.5);
    assert.match(s.source, /final energy consumption/);
  });

  it('a failed or empty fetch carries the previous section forward', () => {
    const previous = productDemandNationalSection({ rows: DOSM.rows, fetchedAt });
    const failed = productDemandNationalSection({ error: new Error('HTTP 503'), fetchedAt: '2026-11-04T03:00:00.000Z', previous });
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.carriedForward, true);
    assert.equal(failed.fetchedAt, fetchedAt);
    assert.deepEqual(failed.countries, previous.countries);
    const empty = productDemandNationalSection({ rows: [], fetchedAt: '2026-11-04T03:00:00.000Z', previous });
    assert.equal(empty.carriedForward, true);
    const first = productDemandNationalSection({ error: new Error('HTTP 503'), fetchedAt });
    assert.deepEqual(first.countries, {});
    assert.equal(first.status, 'unavailable');
  });
});
