import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import handler from '../api/mcp.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';
import { validateToolArgs } from '../api/mcp/_validate-args.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const anomaly = (uuid, locationCode, locationName) => ({ uuid, type: 'ANOMALY', status: 'ONGOING', startDate: 1, endDate: 0,
  asn: '', asnName: '', locationCode, locationName, latitude: 50, longitude: 10 });
const ddos = {
  protocol: [{ label: 'UDP', percentage: 60 }, { label: 'TCP', percentage: 40 }],
  vector: [{ label: 'a', percentage: 5 }, { label: 'b', percentage: 4 }],
  dateRangeStart: '2026-09-23', dateRangeEnd: '2026-09-30',
  topTargetLocations: [{ countryCode: 'US', countryName: 'United States', percentage: 30, latitude: 1, longitude: 2 },
    { countryCode: 'DE', countryName: 'Germany', percentage: 20, latitude: 1, longitude: 2 }],
};
const outage = (country, severity) => ({ id: `cf-${country}`, title: `Internet disruption in ${country}`, description: '',
  detectedAt: 1, country, region: '', location: { latitude: 1, longitude: 2 }, severity, categories: [], cause: '', outageType: '', endedAt: 0 });
const tool = () => TOOL_REGISTRY.find(candidate => candidate.name === 'get_infrastructure_status');
const mcpCall = (name, args, headers = { 'X-WorldMonitor-Key': 'wm_infra_fixture' }) => handler(new Request('https://worldmonitor.app/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
}));

let store;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://infra-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
  process.env.WORLDMONITOR_VALID_KEYS = 'wm_infra_fixture';
  store = new Map([
    ['infra:outages:v1', { outages: [outage('Iran', 'major'), outage('United States', 'minor'), outage('United Kingdom', 'major'),
      outage('Bangladesh', 'minor'), outage('Germany', 'minor'), outage('Russia', 'major')] }],
    ['cf:radar:traffic-anomalies:v1', { anomalies: [anomaly('a', 'DE', 'Germany'), anomaly('b', 'DE', 'Germany'), anomaly('c', 'IR', 'Iran'),
      anomaly('d', 'US', 'United States'), anomaly('e', 'RU', 'Russia'), anomaly('f', 'AU', 'Australia'),
      anomaly('g', 'IN', 'India'), anomaly('h', 'CN', 'China')] }],
    ['cf:radar:ddos:v1', { ...ddos, _targetLocationsDegraded: true }],
    ...tool()._freshnessChecks.map(check => [check.key, { fetchedAt: Date.now(), recordCount: 3 }]),
  ]);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://infra-redis.test', 'this tool must not contact a provider or route');
    const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
    return Response.json({ result: store.has(key) ? JSON.stringify(store.get(key)) : null });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('get_infrastructure_status Radar datasets', () => {
  it('returns outages, traffic anomalies and the DDoS summary accepted by the advertised schema', async () => {
    const result = await executeTool(tool());
    assert.deepEqual(Object.keys(result.data).sort(), ['ddos', 'outages', 'traffic-anomalies']);
    assert.equal(result.data['traffic-anomalies'].totalCount, 8);
    assert.deepEqual(result.data.ddos, ddos);
    assert.equal(result.stale, false);
    const ajv = new Ajv2020({ allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false });
    const validate = ajv.compile(buildPublicTool(tool(), { compressDescriptions: true }).outputSchema.anyOf[0]);
    assert.ok(validate(result), JSON.stringify(validate.errors));
  });

  it('filters traffic by alpha-2, alpha-3 or name and keeps the global total', async () => {
    for (const country of ['DE', 'DEU', 'Germany']) {
      const traffic = (await executeTool(tool(), { dataset: ['traffic'], country, limit: 1 })).data['traffic-anomalies'];
      assert.deepEqual(traffic.anomalies.map(row => row.uuid), ['a'], country);
      assert.equal(traffic.totalCount, 8, `${country}: totalCount counts every anomaly before filtering`);
    }
  });

  it('selects exactly one country from a code or English name', async () => {
    const pick = async country => {
      const { data } = await executeTool(tool(), { country, limit: 0 });
      return { outages: data.outages.outages.map(row => row.country), traffic: data['traffic-anomalies'].anomalies.map(row => row.locationCode) };
    };
    assert.deepEqual(await pick('US'), { outages: ['United States'], traffic: ['US'] });
    assert.deepEqual(await pick('IN'), { outages: [], traffic: ['IN'] });
    assert.deepEqual(await pick('DE'), { outages: ['Germany'], traffic: ['DE', 'DE'] });
    assert.deepEqual(await pick('Russia'), { outages: ['Russia'], traffic: ['RU'] });
  });

  it('rejects an unresolved country, or a country on a DDoS-only call, before any read', () => {
    for (const args of [{ country: 'united' }, { country: 'Atlantis' }, { dataset: ['ddos'], country: 'US' }]) {
      assert.throws(() => validateToolArgs(tool(), args), error => error.name === 'RpcValidationError', JSON.stringify(args));
    }
    for (const args of [{ country: 'US' }, { dataset: ['ddos', 'traffic'], country: 'US' }, { limit: 0 }]) {
      assert.doesNotThrow(() => validateToolArgs(tool(), args), JSON.stringify(args));
    }
    for (const limit of [-1, 1.5, '3']) assert.throws(() => validateToolArgs(tool(), { limit }), error => error.name === 'RpcValidationError');
  });

  it('never filters the global DDoS summary by country and drops seeder-internal fields', async () => {
    const { data } = await executeTool(tool(), { country: 'DE' });
    assert.deepEqual(data.ddos, ddos);
  });

  it('caps every list independently and keeps a valid empty traffic list', async () => {
    const capped = await executeTool(tool(), { dataset: ['ddos'], limit: 1 });
    assert.deepEqual(Object.keys(capped.data), ['ddos']);
    assert.deepEqual(capped.data.ddos.vector, [{ label: 'a', percentage: 5 }]);
    assert.equal(capped.data.ddos.topTargetLocations.length, 1);
    store.set('cf:radar:traffic-anomalies:v1', { anomalies: [] });
    const empty = (await executeTool(tool(), { dataset: ['traffic'] })).data['traffic-anomalies'];
    assert.deepEqual(empty, { anomalies: [], totalCount: 0 });
  });

  it('is a free-account seeded read with standard cache weight', () => {
    assert.equal(toolAccess(tool()), 'free-account');
    assert.equal(toolWeight(tool()), 1);
  });

  it('keeps the retired get_internet_activity name working with a deprecation notice', async () => {
    const body = await (await mcpCall('get_internet_activity', { dataset: 'traffic', country: 'DEU', limit: 1 })).json();
    assert.equal(body.result?.isError, undefined, JSON.stringify(body));
    const content = body.result.structuredContent;
    assert.deepEqual(Object.keys(content.data), ['traffic-anomalies']);
    assert.deepEqual(content.data['traffic-anomalies'].anomalies.map(row => row.uuid), ['a']);
    assert.equal(content.deprecation.replacement, 'get_infrastructure_status');
    const rejected = await (await mcpCall('get_internet_activity', { dataset: 'outages' })).json();
    assert.match(JSON.stringify(rejected), /dataset must be one or more of traffic, ddos/);
  });

  it('requires authentication', async () => {
    assert.equal((await mcpCall('get_infrastructure_status', {}, {})).status, 401);
  });
});
