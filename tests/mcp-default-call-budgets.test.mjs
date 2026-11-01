// An argument-free call is the first thing a new client or directory reviewer
// sends. On production-size data these three tools answered it with a
// `_budget_exceeded` envelope and no data (2026-10-16). The fixtures are the
// exact production payloads from that day; each test drives real dispatch on
// the API-allowance path that reviewer key uses.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ratelimit } from '@upstash/ratelimit';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { readFixture } from './helpers/mcp-output-budget.mjs';
import { TOOL_ALIASES } from '../api/mcp/registry/index.ts';

// generate_forecasts is retired (unlisted) but still callable, so its cases stay.
const budgetOf = name => {
  const resolved = TOOL_ALIASES.resolve(name, {});
  if (resolved.kind !== 'registered' && resolved.kind !== 'retired') throw new Error(`not callable: ${name}`);
  return resolved.tool._outputBudgetBytes;
};
const apiDeps = () => makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: {
  tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' },
}, validUntil: Date.now() + 86400000 }) });

describe('argument-free calls fit their output budget on production-size data', () => {
  let handler, redis, forecastBodies, forecastResponse, originalFetch, originalLimiter;
  const originalEnv = { ...process.env };
  const invoke = async (name, args = {}) => {
    const response = await handler(proReq('POST', callBody(name, args)), apiDeps().deps);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  };
  const wireBytes = result => Buffer.byteLength(result.content[0].text);

  beforeEach(async () => {
    const now = Date.now();
    Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false',
      UPSTASH_REDIS_REST_URL: 'https://default-budget.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture-only' });
    delete process.env.LOCAL_API_MODE;
    originalLimiter = Ratelimit.slidingWindow;
    Ratelimit.slidingWindow = () => () => ({ limit: async () => ({ success: true, limit: 100, remaining: 99,
      reset: now + 60000, pending: Promise.resolve() }) });
    const natural = readFixture('oversized-get-natural-disasters.response.json').data;
    const imd = readFixture('oversized-get-imd-cyclone-marine.response.json').data.imd_cyclone_marine;
    redis = new Map([
      ['seismology:earthquakes:v1', natural.earthquakes],
      ['wildfire:fires:v1', natural.fires],
      ['natural:events:v1', natural.events],
      ['seed-meta:seismology:earthquakes', { fetchedAt: now, sourceState: 'ok' }],
      ['weather:imd-cyclone-marine:v1', imd],
      ['seed-meta:weather:imd-cyclone-marine', { fetchedAt: now, recordCount: 32, coverageState: 'ok', sourceState: 'ok' }],
    ]);
    forecastResponse = readFixture('rpc-generate-forecasts.response.json');
    forecastBodies = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith('/api/forecast/v1/get-forecasts')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        forecastBodies.push(body);
        const forecasts = forecastResponse.forecasts.filter(row => !body.domain || row.domain === body.domain);
        return Response.json({ ...forecastResponse, forecasts });
      }
      assert.equal(url.origin, 'https://default-budget.invalid', 'unexpected fetch ' + url);
      const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
      return Response.json({ result: redis.has(key) ? JSON.stringify(redis.get(key)) : null });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch; Ratelimit.slidingWindow = originalLimiter;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('generate_forecasts returns every forecast and reports omitted case files', async () => {
    const result = await invoke('generate_forecasts');
    const payload = result.structuredContent;
    assert.notEqual(payload._budget_exceeded, true, JSON.stringify(payload).slice(0, 300));
    assert.ok(wireBytes(result) <= budgetOf('generate_forecasts'));
    assert.equal(payload.forecasts.length, forecastResponse.forecasts.length);
    for (const [index, row] of payload.forecasts.entries()) {
      const { caseFile, ...expected } = forecastResponse.forecasts[index];
      assert.ok(caseFile, 'fixture rows carry a case file');
      assert.equal(row.caseFile, undefined);
      assert.deepEqual({ ...row, caseFileOmitted: undefined }, { ...expected, caseFileOmitted: undefined });
      assert.equal(row.caseFileOmitted, true);
    }
    assert.deepEqual(payload.transportCoverage, {
      field: 'forecasts[].caseFile', original_count: 7, returned_count: 0, omitted_count: 7, omission_reason: 'output_budget',
    });
  });

  it('generate_forecasts keeps case files when a narrowed result fits', async () => {
    const result = await invoke('generate_forecasts', { domain: 'market' });
    const payload = result.structuredContent;
    assert.equal(payload.forecasts.length, 2);
    assert.ok(payload.forecasts.every(row => row.caseFile && row.caseFileOmitted === undefined));
    assert.equal(payload.transportCoverage, undefined);
  });

  it('generate_forecasts rejects a domain the forecast feed never produces', async () => {
    const response = await handler(proReq('POST', callBody('generate_forecasts', { domain: 'energy' })), apiDeps().deps);
    const { error } = await response.json();
    assert.equal(error.code, -32602);
    assert.equal(error.data.violations[0].field, 'domain');
    assert.match(error.data.violations[0].description, /conflict, market, supply_chain/);
    assert.deepEqual(forecastBodies, [], 'an unknown domain must not reach the upstream as a silent empty filter');
  });

  it('get_natural_disasters simplifies storm cones and keeps every listed event', async () => {
    const source = readFixture('oversized-get-natural-disasters.response.json').data;
    const result = await invoke('get_natural_disasters');
    const payload = result.structuredContent;
    assert.notEqual(payload._budget_exceeded, true, JSON.stringify(payload).slice(0, 300));
    assert.ok(wireBytes(result) <= budgetOf('get_natural_disasters'));
    assert.deepEqual(payload.data.events.events.map(row => row.id), source.events.events.map(row => row.id));
    assert.equal(payload.data.earthquakes.earthquakes.length, source.earthquakes.earthquakes.length);
    assert.equal(payload.data.fires.fireDetections.length, source.fires.fireDetections.length);
    const cones = payload.transportCoverage.details.filter(item => item.field === 'conePolygon');
    assert.deepEqual(cones.map(item => item.event_id), ['nhc-EP21-12A', 'nhc-EP20-37']);
    assert.ok(cones.every(item => item.returned_count > 0 && item.returned_count < item.original_count));
  });

  it('get_natural_disasters still returns the original geometry to a projection that fits', async () => {
    const source = readFixture('oversized-get-natural-disasters.response.json').data;
    const result = await invoke('get_natural_disasters', { jmespath: 'data.events.events[0].conePolygon' });
    assert.deepEqual(result.structuredContent.projection, source.events.events[0].conePolygon);
  });

  it('get_imd_cyclone_marine keeps every sea-area and coastal bulletin', async () => {
    const source = readFixture('oversized-get-imd-cyclone-marine.response.json').data.imd_cyclone_marine;
    const result = await invoke('get_imd_cyclone_marine');
    const payload = result.structuredContent;
    assert.notEqual(payload._budget_exceeded, true, JSON.stringify(payload).slice(0, 300));
    assert.ok(wireBytes(result) <= budgetOf('get_imd_cyclone_marine'));
    const snapshot = payload.data.imd_cyclone_marine;
    assert.deepEqual(snapshot.seaBulletins, source.seaBulletins);
    assert.deepEqual(snapshot.coastalBulletins, source.coastalBulletins);
    assert.equal(snapshot.coverageState, source.coverageState);
    assert.deepEqual(snapshot.products, source.products);
    assert.equal(snapshot.attribution, source.attribution);
    const coverage = payload.transportCoverage.collections;
    for (const [name, item] of Object.entries(coverage)) {
      assert.equal(item.original_count, source[name].length, name);
      assert.equal(item.returned_count, snapshot[name].length, name);
      assert.equal(item.omitted_count, item.original_count - item.returned_count, name);
      assert.deepEqual(snapshot[name], source[name].slice(0, item.returned_count), name);
    }
    assert.ok(coverage.records, 'the duplicate combined list is the first one shed');
  });

  // A projection runs on the fitted payload, so it can select trimmed lists
  // and drop the coverage record beside them. The record rides outside the
  // projection, the way the attribution rider does.
  it('a projection of a fitted IMD response still reports the trimmed lists', async () => {
    const result = await invoke('get_imd_cyclone_marine', { jmespath: 'data.imd_cyclone_marine' });
    const payload = result.structuredContent;
    assert.notEqual(payload._budget_exceeded, true, JSON.stringify(payload).slice(0, 300));
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
    assert.equal(payload.data.marineBulletins.length, 29);
    assert.ok(payload._attribution, 'the attribution rider is unchanged');
    assert.deepEqual(payload.transportCoverage.collections.marineBulletins,
      { original_count: 30, returned_count: 29, omitted_count: 1, omission_reason: 'output_budget' });
  });

  it('a projection of fitted forecasts still reports the omitted case files', async () => {
    const result = await invoke('generate_forecasts', { jmespath: 'forecasts' });
    const payload = result.structuredContent;
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
    assert.equal(payload.projection.length, 7);
    assert.ok(payload.projection.every(row => row.caseFile === undefined));
    assert.equal(payload.transportCoverage.omitted_count, 7);
  });

  it('a projection that fits unfitted carries no coverage record', async () => {
    const result = await invoke('generate_forecasts', { domain: 'market', jmespath: 'forecasts' });
    assert.ok(result.structuredContent.projection.every(row => row.caseFile));
    assert.equal(result.structuredContent.transportCoverage, undefined);
  });
});
