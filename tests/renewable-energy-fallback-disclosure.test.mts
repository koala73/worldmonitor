/**
 * Regression (sibling of #3758): the Renewable Energy panel silently fell
 * back to a hardcoded 2022 World Bank snapshot with no signal to the UI.
 * The fix tags every result from the service with a `source` so the panel
 * can disclose degraded state. These tests exercise the two non-hydrated
 * code paths (successful bootstrap fetch and total fetch failure) and
 * assert the tag is correct.
 *
 * The hydrated path is not covered here because the hydration cache is a
 * module-level Map populated only by fetchBootstrapData() (which hits the
 * network); manual / e2e verification covers it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchRenewableEnergyDataFresh } from '../src/services/renewable-energy-data.ts';

type FetchFn = typeof fetch;
const originalFetch: FetchFn | undefined = globalThis.fetch;

function buildSeedPayload() {
  // Matches the RenewableEnergyData shape produced by seed-wb-indicators.mjs.
  return {
    globalPercentage: 42,
    globalYear: 2024,
    historicalData: [
      { year: 2000, value: 18 },
      { year: 2012, value: 22 },
      { year: 2024, value: 42 },
    ],
    regions: [
      { code: 'EUU', name: 'European Union', percentage: 50, year: 2024 },
    ],
  };
}

describe('fetchRenewableEnergyDataFresh — fallback disclosure (sibling of #3758)', () => {
  beforeEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('tags result as "bootstrap" when /api/bootstrap returns seed data', async () => {
    const stub: FetchFn = async () =>
      new Response(JSON.stringify({ data: { renewableEnergy: buildSeedPayload() } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = stub;

    const result = await fetchRenewableEnergyDataFresh();
    assert.equal(result.source, 'bootstrap', 'source must reflect live bootstrap fetch');
    // Sanity: data came from the stub (42% in 2024), NOT the hardcoded
    // FALLBACK_DATA (29.6% in 2022).
    assert.equal(result.globalPercentage, 42, 'globalPercentage must come from stubbed seed');
    assert.equal(result.globalYear, 2024);
  });

  it('tags result as "fallback" when bootstrap fetch throws (network down)', async () => {
    const stub: FetchFn = async () => {
      throw new Error('simulated network failure');
    };
    globalThis.fetch = stub;

    const result = await fetchRenewableEnergyDataFresh();
    assert.equal(result.source, 'fallback', 'source must be fallback when fetch throws');
    // Sanity: data is the hardcoded FALLBACK_DATA snapshot (29.6%, 2022).
    assert.equal(result.globalPercentage, 29.6, 'globalPercentage must come from FALLBACK_DATA');
    assert.equal(result.globalYear, 2022, 'globalYear must come from FALLBACK_DATA');
  });

  it('tags result as "fallback" when bootstrap returns non-OK status', async () => {
    const stub: FetchFn = async () => new Response('upstream error', { status: 503 });
    globalThis.fetch = stub;

    const result = await fetchRenewableEnergyDataFresh();
    assert.equal(result.source, 'fallback');
  });

  it('tags result as "fallback" when bootstrap returns OK but empty payload', async () => {
    const stub: FetchFn = async () =>
      new Response(JSON.stringify({ data: { renewableEnergy: { historicalData: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = stub;

    const result = await fetchRenewableEnergyDataFresh();
    assert.equal(result.source, 'fallback', 'empty seed must trigger fallback');
  });
});
