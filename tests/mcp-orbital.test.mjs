import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { TOOL_DESCRIPTION_MAX_BYTES } from '../api/mcp/constants.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { ORBITAL_TOOLS } from '../api/mcp/registry/_orbital.ts';

const tool = (name) => ORBITAL_TOOLS.find((t) => t.name === name);
const POINT = 'get_point_satellite_passes';
const COUNTRY = 'get_country_imagery_evidence';
const ORBITAL_KEYS = ['orbital:catalog:v1', 'orbital:sites:v1', 'seed-meta:orbital:catalog', 'seed-meta:orbital:sites'];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const call = (name, args) => tool(name)._execute(args, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'wm_orbital_fixture' });

describe('orbital MCP tools', () => {
  // #10768: listed once Orbital Watch is launched; while dark (#10721) they were unlisted.
  it('are in the published catalog', () => {
    const listed = TOOL_REGISTRY.map((t) => t.name);
    for (const name of [POINT, COUNTRY, 'get_watched_site_imagery']) assert.ok(listed.includes(name), `${name} must be listed`);
  });

  it('refuse free accounts: both are subscription tools', () => {
    for (const name of [POINT, COUNTRY]) {
      assert.equal(tool(name)?._subscriptionOnly, true, name);
      assert.equal(toolAccess(tool(name)), 'subscription', name);
    }
  });

  it('keep their descriptions under the byte cap', () => {
    for (const name of [POINT, COUNTRY]) {
      assert.ok(Buffer.byteLength(tool(name).description) <= TOOL_DESCRIPTION_MAX_BYTES, name);
    }
  });

  it('own the orbital keys, so a never-seeded key marks only these tools stale', () => {
    assert.deepEqual(tool(POINT)._coverageKeys, ['orbital:catalog:v1']);
    assert.deepEqual(tool(COUNTRY)._coverageKeys, ['orbital:sites:v1']);
    // get_watched_site_imagery reads one site from orbital:sites:v1, as the country tool does.
    for (const other of TOOL_REGISTRY.filter((t) => ![POINT, COUNTRY, 'get_watched_site_imagery'].includes(t.name))) {
      const keys = [...(other._cacheKeys ?? []), ...(other._coverageKeys ?? []), ...(other._freshnessChecks ?? []).map((c) => c.key)];
      assert.deepEqual(keys.filter((k) => ORBITAL_KEYS.includes(k)), [], `${other.name} must not read orbital keys`);
    }
  });

  it('reject an out-of-range point before any fetch', () => {
    for (const args of [{ lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: '10', lon: 0 }, { lon: 0 }]) {
      assert.throws(() => tool(POINT)._validateArgs(args), RpcValidationError, JSON.stringify(args));
    }
  });

  it('read the point endpoint with the caller point and return its passes', async () => {
    const requests = [];
    const body = { point: { lat: 39.74, lon: -104.99 }, computedAt: 1, stale: false, passes: [{ noradId: 1, tier: 'confirmed-image' }], acquisitions: [], archiveStatus: 'complete' };
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), key: new Headers(init?.headers).get('X-WorldMonitor-Key') });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    assert.deepEqual(await call(POINT, { lat: 39.7392, lon: -104.9903 }), {
      ...body, passCounts: { 'confirmed-image': 1 }, listedTiers: ['confirmed-image', 'likely-imaged', 'daily-mosaic', 'opportunity'], passLimit: 50, omittedPasses: 0,
    });
    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, '/api/orbital/v1/get-point-passes');
    assert.deepEqual([url.searchParams.get('lat'), url.searchParams.get('lon')], ['39.7392', '-104.9903']);
  });

  it('resolve a country name and read the country endpoint', async () => {
    const requests = [];
    const body = { countryCode: 'UA', stale: false, siteCount: 0, confirmedFlagCount: 0, sites: [] };
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    assert.deepEqual(await call(COUNTRY, { country_code: 'Ukraine' }), body);
    assert.equal(new URL(requests[0]).searchParams.get('country_code'), 'UA');
  });

  it('surface a REST validation error as invalid params', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ violations: [{ field: 'lat', description: 'lat is required and must be a number from -90 to 90' }] }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(call(POINT, { lat: 1, lon: 1 }), RpcValidationError);
  });

  // #10849: a production answer lists thousands of passes (Longyearbyen: 11,467, 4 MB), so a bare
  // call returned only the budget stub. The tool lists the evidence tiers by default and counts the rest.
  const HOUR = 3_600_000;
  const NOW = Date.parse('2026-11-16T10:00:00Z');
  const PASS_BYTES_LIKE_PRODUCTION = { name: 'SENTINEL-2A', profileId: 'sentinel-2', category: 'open-optical', groundDistanceKm: 312.4, side: 'left', elevationDeg: 41.2, incidenceDeg: 44.9, sunElevationDeg: 12.3, edgeOfSwath: false, coverage: true, tierNote: '', orbitAgeDays: 0.42, acquisitionKey: '' };
  // Pass counts measured at Longyearbyen on 2026-11-16, the largest of five production points.
  const LONGYEARBYEN = { 'capability-overhead': 5173, 'within-reach': 2093, 'passed-overhead': 2053, 'daily-mosaic': 246, 'confirmed-image': 7, 'likely-imaged': 1, opportunity: 1894 };
  function productionShaped(counts = LONGYEARBYEN) {
    const passes = [];
    let id = 1;
    for (const [tier, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        const future = tier === 'opportunity';
        const timeMs = future ? NOW + (i + 1) * 60_000 : NOW - (i + 1) * 60_000;
        passes.push({ ...PASS_BYTES_LIKE_PRODUCTION, noradId: id++, timeMs, opportunity: future, tier });
      }
    }
    passes.sort((a, b) => a.timeMs - b.timeMs);
    return { point: { lat: 78.22, lon: 15.65 }, windowStartMs: NOW - 168 * HOUR, windowEndMs: NOW + 72 * HOUR, computedAt: NOW, inventoryVersion: 'v', catalogFetchedAt: NOW, stale: false, passes, outOfFootprintPasses: 0, acquisitions: [], archiveStatus: 'complete', failedSources: [], unansweredProfiles: [] };
  }
  const serve = (body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const tierCounts = (passes) => {
    const counts = {};
    for (const p of passes) counts[p.tier] = (counts[p.tier] ?? 0) + 1;
    return counts;
  };

  it('fits a plain lat/lon answer from the largest production point inside its output budget', async () => {
    serve(productionShaped());
    const result = await call(POINT, { lat: 78.22, lon: 15.65 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= tool(POINT)._outputBudgetBytes, `${Buffer.byteLength(JSON.stringify(result))} bytes`);
    assert.deepEqual(Object.keys(tierCounts(result.passes)).sort(), ['confirmed-image', 'daily-mosaic', 'likely-imaged', 'opportunity']);
    assert.deepEqual(result.passCounts, LONGYEARBYEN);
    assert.equal(result.omittedPasses, 11467 - result.passes.length);
  });

  it('keeps every confirmed and likely pass, and the passes nearest now when a tier is capped', async () => {
    serve(productionShaped());
    const { passes, passLimit } = await call(POINT, { lat: 78.22, lon: 15.65 });
    const counts = tierCounts(passes);
    assert.equal(counts['confirmed-image'], 7);
    assert.equal(counts['likely-imaged'], 1);
    assert.equal(counts.opportunity, passLimit);
    const upcoming = passes.filter((p) => p.tier === 'opportunity').map((p) => p.timeMs);
    assert.deepEqual(upcoming, Array.from({ length: passLimit }, (_, i) => NOW + (i + 1) * 60_000), 'the soonest upcoming passes');
    const mosaics = passes.filter((p) => p.tier === 'daily-mosaic').map((p) => p.timeMs);
    assert.equal(Math.min(...mosaics), NOW - passLimit * 60_000, 'the newest daily mosaics');
    assert.deepEqual(passes.map((p) => p.timeMs), [...passes.map((p) => p.timeMs)].sort((a, b) => a - b), 'still oldest first');
  });

  it('lists the tiers a caller asks for, up to its limit', async () => {
    serve(productionShaped());
    const result = await call(POINT, { lat: 78.22, lon: 15.65, tiers: ['within-reach'], limit: 10 });
    assert.deepEqual(tierCounts(result.passes), { 'within-reach': 10 });
    assert.equal(result.passLimit, 10);
    assert.equal(result.omittedPasses, 11467 - 10);
  });

  it('rejects an unknown tier and a limit out of range before any fetch', () => {
    for (const args of [{ tiers: ['imaged'] }, { tiers: 'confirmed-image' }, { tiers: [] }, { limit: 0 }, { limit: 501 }, { limit: 2.5 }]) {
      assert.throws(() => tool(POINT)._validateArgs({ lat: 1, lon: 1, ...args }), RpcValidationError, JSON.stringify(args));
    }
  });

  it('lowers the per-tier limit until an explicit all-tier request fits the budget', async () => {
    serve(productionShaped());
    const t = tool(POINT);
    const args = { lat: 78.22, lon: 15.65, tiers: Object.keys(LONGYEARBYEN), limit: 500 };
    const full = await call(POINT, args);
    assert.ok(Buffer.byteLength(JSON.stringify(full)) > t._outputBudgetBytes, 'the fixture must start over budget');
    const fitted = t._fitToBudget(full, t._outputBudgetBytes, args);
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= t._outputBudgetBytes);
    assert.ok(fitted.passLimit < 500);
    assert.equal(fitted.omittedPasses, 11467 - fitted.passes.length);
    assert.deepEqual(fitted.passCounts, LONGYEARBYEN);
  });
});
