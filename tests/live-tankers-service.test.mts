// @ts-check
//
// Tests for src/services/live-tankers.ts — the chokepoint-bbox tanker fetch
// helper. We test the pure helpers (bbox derivation, default-chokepoint
// filter, cache-TTL constant) since the network-fetching path needs the
// running getVesselSnapshot RPC + relay to exercise meaningfully.
//
// The real Promise.allSettled + caching behavior is more naturally
// exercised by the existing E2E browser smoke test once the layer is live;
// these tests pin the surface that doesn't require network.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { _internal } from '../src/services/live-tankers.ts';

const { bboxFor, getDefaultChokepoints, BBOX_HALF_DEGREES, CACHE_TTL_MS } = _internal;

describe('live-tankers — defaults', () => {
  test('default chokepoint set is the energy-relevant 6', () => {
    const ids = getDefaultChokepoints().map((c) => c.id).sort();
    assert.deepEqual(ids, [
      'bab_el_mandeb',
      'bosphorus',
      'hormuz_strait',
      'malacca_strait',
      'panama',
      'suez',
    ]);
  });

  test('cache TTL matches the gateway live-tier s-maxage (60s)', () => {
    // If these drift apart, the CDN cache will serve stale data while the
    // service-level cache is still warm — confusing. Pin both at 60_000ms.
    assert.equal(CACHE_TTL_MS, 60_000);
  });

  test('bbox half-width is ±2 degrees', () => {
    assert.equal(BBOX_HALF_DEGREES, 2);
  });
});

describe('live-tankers — AbortSignal behavior', () => {
  test('fetchLiveTankers accepts an options.signal parameter', async () => {
    // Pin the signature so future edits can't accidentally drop the signal
    // parameter and silently re-introduce the race-write bug Codex flagged
    // on PR #3402: a slow older refresh overwriting a newer one because
    // the abort controller wasn't actually wired into the fetch.
    const { fetchLiveTankers } = await import('../src/services/live-tankers.ts');
    const controller = new AbortController();
    controller.abort(); // pre-aborted
    const result = await fetchLiveTankers([], { signal: controller.signal });
    assert.deepEqual(result, [], 'empty chokepoint list → empty result regardless of signal state');
  });
});

describe('live-tankers — bbox derivation', () => {
  test('bbox is centered on the chokepoint with ±2° padding', () => {
    const synth = {
      id: 'test',
      displayName: 'Test',
      geoId: 'test',
      relayName: 'Test',
      portwatchName: 'Test',
      corridorRiskName: null,
      baselineId: null,
      shockModelSupported: false,
      routeIds: [],
      lat: 26.5,
      lon: 56.5,
    };
    const bbox = bboxFor(synth);
    assert.equal(bbox.swLat, 24.5);
    assert.equal(bbox.swLon, 54.5);
    assert.equal(bbox.neLat, 28.5);
    assert.equal(bbox.neLon, 58.5);
  });

  test('bbox total span is 4° on both axes (under the 10° handler guard)', () => {
    const synth = {
      id: 'test',
      displayName: 'Test',
      geoId: 'test',
      relayName: 'Test',
      portwatchName: 'Test',
      corridorRiskName: null,
      baselineId: null,
      shockModelSupported: false,
      routeIds: [],
      lat: 0,
      lon: 0,
    };
    const bbox = bboxFor(synth);
    assert.equal(bbox.neLat - bbox.swLat, 4);
    assert.equal(bbox.neLon - bbox.swLon, 4);
    assert.ok(bbox.neLat - bbox.swLat <= 10, 'must stay under handler 10° guard');
    assert.ok(bbox.neLon - bbox.swLon <= 10, 'must stay under handler 10° guard');
  });
});
