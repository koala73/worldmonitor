import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MCP_TELEMETRY']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const cases = [
  ['get_news_intelligence', 'country', { insights: { topStories: [{ countryCode: 'IQ' }, { countryCode: 'IR' }] } }],
  ['get_cyber_threats', 'country', { 'threats-bootstrap': { threats: [{ country: 'IQ' }, { country: 'IR' }] } }],
  ['get_economic_data', 'country', { 'fuel-prices': { countries: [{ code: 'IQ' }, { code: 'IR' }] } }],
  ['get_sanctions_data', 'country', { entities: [{ cc: 'IQ' }, { cc: 'IR' }] }],
  ['get_health_signals', 'country', { 'disease-outbreaks': { outbreaks: [{ countryCode: 'IQ' }, { countryCode: 'IR' }] } }],
  ['get_energy_intelligence', 'country', { _countries: ['IQ', 'IR'] }],
  ['get_climate_data', 'country', { disasters: { disasters: [{ countryCode: 'IQ' }, { countryCode: 'IR' }] } }],
  ['get_tariff_trends', 'country', { bigmac: { countries: [{ code: 'IQ' }, { code: 'IR' }] } }],
  ['get_country_macro', 'countries', { macro: { countries: { IQ: { value: 1 }, IR: { value: 2 } } } }],
  ['get_displacement_data', 'countries', { summary: { countries: [{ code: 'IRQ' }, { code: 'IRN' }], topFlows: [{ originCode: 'IRQ', asylumCode: 'DEU' }, { originCode: 'SYR', asylumCode: 'IRQ' }, { originCode: 'IRN', asylumCode: 'DEU' }] } }],
];
for (const [name, field, fixture] of cases) {
  it(`${name} resolves country filters and rejects unresolved entries`, () => {
    const tool = TOOL_REGISTRY.find((tool) => tool.name === name);
    assert.ok(tool, name);
    const filter = (input) => tool._postFilter(structuredClone(fixture), input);
    const expected = filter({ [field]: 'IQ' });
    assert.notDeepEqual(expected, filter({}), 'fixture must prove narrowing');
    assert.match(JSON.stringify(expected), /"IQ"|"IRQ"/, 'matching country must remain');
    assert.doesNotMatch(JSON.stringify(expected), /"IR"|"IRN"/, 'other country must be excluded');
    for (const value of ['Iraq', 'IRQ', ' iq ', ['Iraq']]) {
      assert.deepEqual(filter({ [field]: value }), expected);
    }
    for (const value of ['Atlantis', ['IQ', 'Atlantis'], 123, { toString: 'x' }]) {
      assert.throws(() => filter({ [field]: value }), RpcValidationError);
    }
    assert.deepEqual(filter({ [field]: [] }), filter({}));
  });
}

it('country validation reaches callers as Invalid params through dispatch', async () => {
  process.env.MCP_TELEMETRY = 'false';
  installRedis({ 'cyber:threats-bootstrap:v2': { threats: [{ country: 'IQ' }] } });
  for (const [name, field, value] of [
    ['get_cyber_threats', 'country', 'Atlantis'],
    ['get_focal_points', 'country_code', 'Atlantis'],
    ['get_focal_points', 'country_code', 'Iraq'],
  ]) {
    const response = await dispatchToolsCall(
      new Request('http://localhost/mcp'), { kind: 'env_key', apiKey: 'test' }, {},
      { id: 42, params: { name, arguments: { [field]: value } } }, {},
    );
    const body = await response.json();
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error.data.violations[0].field, field);
    assert.equal(body.result, undefined);
  }
});

for (const [name, label] of [
  ['get_eu_housing_cycle', 'house-prices'],
  ['get_eu_quarterly_gov_debt', 'gov-debt-q'],
  ['get_eu_industrial_production', 'industrial-production'],
]) {
  it(`${name} preserves aggregate codes and maps Greece to Eurostat EL`, () => {
    const tool = TOOL_REGISTRY.find((tool) => tool.name === name);
    const fixture = { [label]: { countries: { EL: { value: 1 }, DE: { value: 2 }, EA20: { value: 3 }, EU27_2020: { value: 4 } } } };
    const filter = (countries) => tool._postFilter(structuredClone(fixture), { countries });
    for (const country of ['Greece', 'GRC', 'GR', 'EL']) {
      assert.deepEqual(Object.keys(filter([country])[label].countries), ['EL']);
    }
    assert.deepEqual(Object.keys(filter(['EA20', 'EU27_2020'])[label].countries), ['EA20', 'EU27_2020']);
    assert.throws(() => filter(['Atlantis']), RpcValidationError);
  });
}
