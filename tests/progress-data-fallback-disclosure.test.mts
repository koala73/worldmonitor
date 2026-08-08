/**
 * Regression for #3758: Human Progress panel silently fell back to
 * hardcoded World Bank series with no signal to the UI. The fix is for
 * the service to tag every result with a `source` so the panel can
 * disclose degraded state. These tests exercise the two non-hydrated
 * code paths -- successful bootstrap fetch and total fetch failure --
 * and assert that the tag is correct.
 *
 * The hydrated path is not covered here because the hydration cache is
 * a module-level Map populated only by `fetchBootstrapData()` (which
 * hits the network); manual / e2e verification covers it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchProgressDataFresh,
  PROGRESS_INDICATORS,
} from '../src/services/progress-data.ts';

type FetchFn = typeof fetch;
const originalFetch: FetchFn | undefined = globalThis.fetch;

function buildSeedPayload() {
  // Matches the shape produced by seed-wb-indicators.mjs: id + code +
  // ordered ProgressDataPoint[] + invertTrend.
  return PROGRESS_INDICATORS.map(ind => ({
    id: ind.id,
    code: ind.code,
    invertTrend: ind.invertTrend,
    data: [
      { year: 2000, value: 10 },
      { year: 2010, value: 20 },
      { year: 2020, value: 30 },
    ],
  }));
}

describe('fetchProgressDataFresh — fallback disclosure (#3758)', () => {
  beforeEach(() => {
    // Reset to a known state before each scenario; individual tests
    // install their own stub.
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('tags result as "bootstrap" when /api/bootstrap returns seed data', async () => {
    const stub: FetchFn = async () =>
      new Response(JSON.stringify({ data: { progressData: buildSeedPayload() } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = stub;

    const result = await fetchProgressDataFresh();
    assert.equal(result.source, 'bootstrap', 'source must reflect live bootstrap fetch');
    assert.equal(result.datasets.length, PROGRESS_INDICATORS.length);
    // Sanity: data came from the stub (value 30 in 2020), NOT from the
    // hardcoded FALLBACK_DATA (which has 73.3 for life expectancy 2023).
    const life = result.datasets.find(d => d.indicator.id === 'lifeExpectancy');
    assert.ok(life, 'lifeExpectancy dataset missing');
    assert.equal(life!.latestValue, 30, 'latestValue must come from stubbed seed');
  });

  it('tags result as "fallback" when bootstrap fetch throws (network down)', async () => {
    const stub: FetchFn = async () => {
      throw new Error('simulated network failure');
    };
    globalThis.fetch = stub;

    const result = await fetchProgressDataFresh();
    assert.equal(result.source, 'fallback', 'source must be fallback when fetch throws');
    assert.equal(result.datasets.length, PROGRESS_INDICATORS.length);
    // Sanity: data is the hardcoded FALLBACK_DATA snapshot — life
    // expectancy ends at 73.3 (Feb 2026 verified value).
    const life = result.datasets.find(d => d.indicator.id === 'lifeExpectancy');
    assert.ok(life, 'lifeExpectancy dataset missing');
    assert.equal(life!.latestValue, 73.3, 'latestValue must come from FALLBACK_DATA snapshot');
  });

  it('tags result as "fallback" when bootstrap returns non-OK status', async () => {
    const stub: FetchFn = async () =>
      new Response('upstream error', { status: 503 });
    globalThis.fetch = stub;

    const result = await fetchProgressDataFresh();
    assert.equal(result.source, 'fallback');
  });

  it('tags result as "fallback" when bootstrap returns OK but empty payload', async () => {
    const stub: FetchFn = async () =>
      new Response(JSON.stringify({ data: { progressData: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = stub;

    const result = await fetchProgressDataFresh();
    assert.equal(result.source, 'fallback', 'empty seed must trigger fallback');
  });
});
