import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

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

const serviceJsonSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();
const serviceYamlSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f))
  .sort();

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
    assert.ok(serviceJsonSpecs.length >= 34, `expected >= 34 JSON service specs, found ${serviceJsonSpecs.length}`);
    assert.equal(
      serviceYamlSpecs.length,
      serviceJsonSpecs.length,
      'expected a YAML sibling for every JSON service spec',
    );
  });

  it('per-service JSON specs advertise jmespath on every GET (181 total)', () => {
    const total = serviceJsonSpecs.reduce((sum, file) => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      return sum + assertJmespathContract(spec, file);
    }, 0);
    assert.equal(total, 181, `expected 181 GET operations, found ${total}`);
  });

  it('per-service YAML specs advertise jmespath on every GET (181 total)', () => {
    const total = serviceYamlSpecs.reduce((sum, file) => {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      return sum + assertJmespathContract(spec, file);
    }, 0);
    assert.equal(total, 181, `expected 181 GET operations, found ${total}`);
  });

  it('the unified bundle advertises jmespath on every GET (181 total)', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    const total = assertJmespathContract(bundle, 'worldmonitor.openapi.yaml');
    assert.equal(total, 181, `expected 181 GET operations, found ${total}`);
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
