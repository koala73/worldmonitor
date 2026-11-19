import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildBundle } from '../scripts/build-openapi-json.mjs';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

const collection = JSON.parse(readFileSync(new URL('../public/worldmonitor.postman_collection.json', import.meta.url)));
const variables = Object.fromEntries(collection.variable.map(({ key, value }) => [key, value]));
const anonymous = collection.item.find(({ auth }) => auth?.type === 'noauth');
const authenticated = collection.item.find(({ name }) => name === '2. REST examples');

describe('Postman quickstart', () => {
  it('keeps credentials empty and off anonymous discovery requests', () => {
    assert.equal(variables.apiKey, '');
    assert.equal(collection.auth.type, 'apikey');
    const auth = Object.fromEntries(collection.auth.apikey.map(({ key, value }) => [key, value]));
    assert.equal(auth.key, 'X-WorldMonitor-Key');
    assert.equal(auth.value, '{{apiKey}}');
    assert.equal(auth.in, 'header');
    assert.equal(variables.baseUrl, 'https://api.worldmonitor.app');
    assert.equal(variables.mcpUrl, 'https://worldmonitor.app/mcp');
    assert.ok(anonymous.item.length > 0);
    for (const { request } of anonymous.item) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url.raw, '{{mcpUrl}}');
      assert.equal(request.auth, undefined);
      assert.ok(!request.header.some(({ key }) => /authorization|api.?key|worldmonitor-key/i.test(key)));
      const rpc = JSON.parse(request.body.raw);
      assert.equal(rpc.jsonrpc, '2.0');
      assert.ok(rpc.method === 'tools/list' || (rpc.method === 'tools/call' && rpc.params.name === 'get_sources'));
    }
  });

  it('keeps REST example methods, queries, and required inputs aligned with the final public OpenAPI bundle', () => {
    const { spec } = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    const resolve = (value) => value.$ref
      ? value.$ref.slice(2).split('/').reduce((node, key) => node[key], spec)
      : value;
    for (const { request } of authenticated.item) {
      assert.equal(request.auth, undefined);
      const path = `/${request.url.path.join('/')}`;
      const operation = spec.paths[path]?.[request.method.toLowerCase()];
      assert.ok(operation, `${request.method} ${path} must exist in the served contract`);
      const params = [...(spec.paths[path].parameters ?? []), ...(operation.parameters ?? [])].map(resolve);
      const query = request.url.query ?? [];
      for (const { key, value } of query) {
        const parameter = params.find((p) => p.in === 'query' && p.name === key);
        assert.ok(parameter, `${key} must be a supported query parameter for ${path}`);
        if (parameter.schema?.pattern) assert.match(value, new RegExp(parameter.schema.pattern));
        if (parameter.schema?.type === 'integer') assert.ok(Number.isInteger(Number(value)));
      }
      for (const parameter of params.filter((p) => p.in === 'query' && p.required)) {
        assert.ok(query.some(({ key, value }) => key === parameter.name && value), `${path} needs ${parameter.name}`);
      }
    }
  });
});
