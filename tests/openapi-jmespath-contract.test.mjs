import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import {
  discoverProtoServiceNames,
  loadUnifiedOpenApiSpec,
  openApiOperationIds,
  serviceOpenApiOperationIds,
} from './_lib/openapi-spec-cache.mjs';

// Guards the universal `?jmespath=` response-projection parameter injected by
// scripts/openapi-inject-jmespath.mjs. The REST gateway
// (server/gateway.ts + server/_shared/response-projection.ts) genuinely honors
// this parameter on every JSON GET response — parity with the MCP server's
// `jmespath` tool argument. Advertising it on every GET operation also keeps
// ora.ai / orank's `api-schema-analysis` at "fully documented" (a parameterless
// operation reads as "not typed"). If a regenerate lands without the injector,
// these assertions flag the drop.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const GET_METHOD = new Set(['get']);
const PROJECTION_DISABLED_OPERATION_IDS = new Set(['GetResilienceIndicators']);
const serviceJsonSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();
const serviceYamlSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f))
  .sort();
const jsonSpecsByFile = new Map(serviceJsonSpecs.map((file) => [
  file,
  JSON.parse(readFileSync(resolve(apiDir, file), 'utf8')),
]));
const yamlSpecsByFile = new Map(serviceYamlSpecs.map((file) => [
  file,
  loadYaml(readFileSync(resolve(apiDir, file), 'utf8')),
]));
const jsonServiceGetIds = serviceOpenApiOperationIds(jsonSpecsByFile, { methods: GET_METHOD });
const yamlServiceGetIds = serviceOpenApiOperationIds(yamlSpecsByFile, { methods: GET_METHOD });
const jsonBundleGetIds = [...jsonSpecsByFile.values()]
  .flatMap((spec) => openApiOperationIds(spec, { methods: GET_METHOD }))
  .sort();

function assertExactOperationParity(actual, expected, message) {
  if (message === undefined) assert.deepEqual(actual, expected);
  else assert.deepEqual(actual, expected, message);
}

function findJmespathParam(op) {
  return (op.parameters ?? []).filter((p) => p && p.name === 'jmespath');
}

function schemaIncludesRef(schema, ref) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref === ref) return true;
  return ['oneOf', 'anyOf', 'allOf'].some((key) =>
    Array.isArray(schema[key]) && schema[key].some((item) => schemaIncludesRef(item, ref)));
}

function assertJmespathErrorSchema(spec, label) {
  const schema = spec.components?.schemas?.JmespathProjectionError;
  assert.ok(schema, `${label}: must define JmespathProjectionError`);
  assert.equal(schema.type, 'object', `${label}: JmespathProjectionError must be an object`);
  assert.equal(schema.properties?._jmespath_error?.type, 'string', `${label}: _jmespath_error must be a string`);
  assert.equal(schema.properties?.original_keys?.type, 'array', `${label}: original_keys must be an array`);
  assert.equal(schema.properties?.original_keys?.items?.type, 'string', `${label}: original_keys items must be strings`);
  assert.deepEqual(schema.required, ['_jmespath_error', 'original_keys'], `${label}: error schema required fields drifted`);
}

// Every GET carries exactly one well-formed jmespath param; no other method does
// (POSTs are already typed via their requestBody, and the gateway only projects
// GET responses).
function assertJmespathContract(spec, label) {
  assertJmespathErrorSchema(spec, label);
  let getOps = 0;
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      const matches = findJmespathParam(op);
      if (method === 'get') {
        getOps++;
        if (PROJECTION_DISABLED_OPERATION_IDS.has(op.operationId)) {
          assert.equal(matches.length, 0, `${label}: GET ${path} must not advertise jmespath`);
          const badRequestSchema = op.responses?.['400']?.content?.['application/json']?.schema;
          assert.equal(
            schemaIncludesRef(badRequestSchema, '#/components/schemas/JmespathProjectionError'),
            false,
            `${label}: GET ${path} must not advertise a JMESPath projection error`,
          );
          continue;
        }
        assert.equal(matches.length, 1, `${label}: GET ${path} must carry exactly one jmespath param`);
        const param = matches[0];
        assert.equal(param.in, 'query', `${label}: GET ${path} jmespath must be a query param`);
        assert.equal(param.required, false, `${label}: GET ${path} jmespath must be optional`);
        assert.equal(param.schema?.type, 'string', `${label}: GET ${path} jmespath schema must be string`);
        assert.equal(
          Object.prototype.hasOwnProperty.call(param.schema ?? {}, 'maxLength'),
          false,
          `${label}: GET ${path} jmespath schema must not advertise a character maxLength for a UTF-8 byte limit`,
        );
        assert.notEqual(param.example, undefined, `${label}: GET ${path} jmespath must have an example`);
        assert.match(
          String(param.description ?? ''),
          /1024 UTF-8 bytes/,
          `${label}: GET ${path} jmespath must document the expression byte limit`,
        );
        assert.match(
          String(param.description ?? ''),
          /JMESPath/,
          `${label}: GET ${path} jmespath must document the projection`,
        );
        assert.match(
          String(param.description ?? ''),
          /256 KB output cap/,
          `${label}: GET ${path} jmespath must document the projected-output cap`,
        );
        const badRequestSchema = op.responses?.['400']?.content?.['application/json']?.schema;
        assert.ok(badRequestSchema, `${label}: GET ${path} must document a JSON 400 response`);
        assert.ok(
          schemaIncludesRef(badRequestSchema, '#/components/schemas/JmespathProjectionError'),
          `${label}: GET ${path} 400 response must include the JMESPath projection error envelope`,
        );
      } else {
        assert.equal(matches.length, 0, `${label}: ${method.toUpperCase()} ${path} must NOT carry a jmespath param`);
      }
    }
  }
  return getOps;
}

describe('OpenAPI jmespath projection parameter contract', () => {
  it('audits the full known service surface', () => {
    assert.deepEqual(
      serviceJsonSpecs.map((file) => file.replace(/\.openapi\.json$/, '')),
      discoverProtoServiceNames(),
      'JSON service specs must match the proto service universe exactly',
    );
    assert.deepEqual(
      serviceYamlSpecs.map((file) => file.replace(/\.openapi\.yaml$/, '')),
      discoverProtoServiceNames(),
      'YAML service specs must match the proto service universe exactly',
    );
  });

  it('per-service JSON specs advertise jmespath on every eligible discovered GET', () => {
    for (const file of serviceJsonSpecs) assertJmespathContract(jsonSpecsByFile.get(file), file);
    assert.ok(jsonServiceGetIds.length > 0, 'GET-operation discovery must not be empty');
  });

  it('per-service YAML specs advertise jmespath on every eligible discovered GET', () => {
    for (const file of serviceYamlSpecs) assertJmespathContract(yamlSpecsByFile.get(file), file);
    assertExactOperationParity(yamlServiceGetIds, jsonServiceGetIds, 'YAML and JSON service specs must expose the same service/method/path set');
  });

  it('the unified bundle advertises jmespath on every eligible discovered GET', () => {
    const bundle = loadUnifiedOpenApiSpec();
    assertJmespathContract(bundle, 'worldmonitor.openapi.yaml');
    const bundleGetIds = openApiOperationIds(bundle, { methods: GET_METHOD });
    assert.equal(new Set(jsonBundleGetIds).size, jsonBundleGetIds.length, 'per-service GET paths must be globally unique for the unified bundle');
    assertExactOperationParity(bundleGetIds, jsonBundleGetIds, 'unified and per-service specs must expose the same method/path set');
  });

  it('exact operation identities reject a same-cardinality substitution', () => {
    const baseline = openApiOperationIds({ paths: { '/api/fixture/v1/original': { get: {} } } }, { methods: GET_METHOD });
    const substituted = openApiOperationIds({ paths: { '/api/fixture/v1/substituted': { get: {} } } }, { methods: GET_METHOD });
    assert.equal(baseline.length, substituted.length, 'fixture must preserve aggregate cardinality');
    assert.throws(
      () => assertExactOperationParity(substituted, baseline),
      /Expected values to be strictly deep-equal/,
      'method/path parity must reject a same-cardinality substitution',
    );
  });

  it('the injector reports the specs as in-sync (idempotent)', () => {
    // A regenerate that dropped the injection step, or an edit that de-synced a
    // spec, would make --check exit non-zero (execFileSync throws).
    execFileSync('node', [resolve(root, 'scripts/openapi-inject-jmespath.mjs'), '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });
});
