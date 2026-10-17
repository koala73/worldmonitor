import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { validate } from './helpers/json-schema-mini.mjs';

const originalFetch = globalThis.fetch;

it('get_health_signals advertises and preserves source-distinct public outbreak evidence', () => {
  const tool = TOOL_REGISTRY.find(tool => tool.name === 'get_health_signals');
  assert.ok(tool, 'health tool must be registered');
  const bucketSchema = tool.outputSchema.properties.data.properties['disease-outbreaks'];
  const rowProperties = bucketSchema.properties.outbreaks.items.properties;
  const publicFields = ['id', 'disease', 'location', 'countryCode', 'alertLevel', 'summary', 'sourceUrl', 'publishedAt', 'sourceName', 'lat', 'lng', 'cases'];
  assert.deepEqual(publicFields.filter(field => !Object.hasOwn(rowProperties, field)), [], 'advertised schema must describe existing public outbreak evidence');
  assert.deepEqual(['fetchedAt', 'alertLevelMethodologyVersion'].filter(field => !Object.hasOwn(bucketSchema.properties, field)), [], 'advertised schema must describe existing snapshot clock and methodology');
  assert.equal(Object.hasOwn(rowProperties, 'evidence'), false, 'private evidence is not part of the advertised public contract');
  const rows = [
    { id: 'who-ru-plague', disease: 'Plague', location: 'Russia', countryCode: 'RU', alertLevel: 'warning', summary: 'Controlled WHO report', sourceUrl: 'https://www.unognewsroom.org/story/en/1/plague', publishedAt: 1791244800000, sourceName: 'WHO', lat: 52.28, lng: 104.28, cases: 0 },
    { id: 'cidrap-ru-plague', disease: 'Plague', location: 'Irkutsk', countryCode: 'RU', alertLevel: 'watch', summary: 'Controlled CIDRAP report', sourceUrl: 'https://www.cidrap.umn.edu/plague/new', publishedAt: 1791158400000, sourceName: 'CIDRAP', lat: 52.28, lng: 104.28 },
    { id: 'who-us-measles', disease: 'Measles', location: 'United States', countryCode: 'US', sourceName: 'WHO', sourceUrl: 'https://www.who.int/example' },
  ];
  const snapshot = { outbreaks: rows, fetchedAt: 1791331200000, alertLevelMethodologyVersion: 'v1' };
  const filter = (data, params = {}) => tool._postFilter(structuredClone(data), params);
  const result = filter({ 'disease-outbreaks': snapshot }, { country: 'Russia', disease: 'plague', limit: 2 })['disease-outbreaks'];
  assert.deepEqual(result, { ...snapshot, outbreaks: rows.slice(0, 2) }, 'both sources and exact evidence/clocks survive filtering');
  assert.equal(result.outbreaks[0].cases, 0, 'producer zero means an unknown count');
  assert.equal(Object.hasOwn(result.outbreaks[1], 'cases'), false, 'absent counts are not manufactured as zero');
  assert.deepEqual(validate(bucketSchema, result), []);
  assert.deepEqual(filter({ 'disease-outbreaks': snapshot }, { country: 'RU', limit: 1 })['disease-outbreaks'].outbreaks, [rows[0]], 'cap retains supplied order');
  assert.deepEqual(filter({ 'disease-outbreaks': snapshot }, { country: 'Japan' })['disease-outbreaks'].outbreaks, [], 'no matching coverage is empty');
  assert.deepEqual(filter({ 'disease-outbreaks': null }), { 'disease-outbreaks': null }, 'unavailable remains null');
  assert.deepEqual(filter({}), {}, 'missing bucket remains absent');
  assert.deepEqual(filter({ 'disease-outbreaks': { outbreaks: [] } }), { 'disease-outbreaks': { outbreaks: [] } }, 'old optional clocks remain absent');
  assert.deepEqual(validate(bucketSchema, { outbreaks: [] }), []);
  assert.deepEqual(validate(bucketSchema, null), []);
});
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
  ['get_country_macro', 'macro'],
  ['get_eu_housing_cycle', 'house-prices'],
  ['get_eu_quarterly_gov_debt', 'gov-debt-q'],
  ['get_eu_industrial_production', 'industrial-production'],
]) {
  it(`${name} returns no other countries when the requested country has no coverage`, () => {
    const tool = TOOL_REGISTRY.find(tool => tool.name === name);
    const fixture = { [label]: { countries: { DE: { value: 2 } } } };
    const result = tool._postFilter(structuredClone(fixture), { countries: ['Japan'] });
    assert.deepEqual(result[label].countries, {});
  });
}

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
