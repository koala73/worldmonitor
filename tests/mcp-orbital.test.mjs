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
  // #10721: the orbital REST endpoints answer 404 while Orbital Watch is dark
  // (#10710), so a listed tool fails every call with -32603.
  it('stay out of the published catalog while Orbital Watch is dark', () => {
    const listed = TOOL_REGISTRY.map((t) => t.name);
    for (const name of [POINT, COUNTRY]) assert.ok(!listed.includes(name), `${name} must not be listed`);
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
    for (const other of TOOL_REGISTRY.filter((t) => t.name !== POINT && t.name !== COUNTRY)) {
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
    assert.deepEqual(await call(POINT, { lat: 39.7392, lon: -104.9903 }), body);
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
});
