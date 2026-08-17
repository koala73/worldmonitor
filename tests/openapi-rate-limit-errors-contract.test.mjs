import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import {
  discoverProtoServiceNames,
  loadUnifiedOpenApiSpec,
  openApiOperationIds,
  serviceOpenApiOperationIds,
} from './_lib/openapi-spec-cache.mjs';

// Guards scripts/openapi-inject-rate-limit-errors.mjs. These contracts are
// emitted by the gateway around every generated RPC, not by the proto handlers,
// so a fresh `make generate` must re-run the injector or the published spec
// loses real 429/header/default-error/malformed-body behavior.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const RATE_LIMIT_HEADERS = [
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Retry-After',
];

const serviceJson = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();
const serviceYaml = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f))
  .sort();
const jsonSpecsByFile = new Map(serviceJson.map((file) => [
  file,
  JSON.parse(readFileSync(resolve(apiDir, file), 'utf8')),
]));
const yamlSpecsByFile = new Map(serviceYaml.map((file) => [
  file,
  loadYaml(readFileSync(resolve(apiDir, file), 'utf8')),
]));
const jsonServiceOperationIds = serviceOpenApiOperationIds(jsonSpecsByFile);
const yamlServiceOperationIds = serviceOpenApiOperationIds(yamlSpecsByFile);
const jsonBundleOperationIds = [...jsonSpecsByFile.values()]
  .flatMap((spec) => openApiOperationIds(spec))
  .sort();

function assertExactOperationParity(actual, expected, message) {
  if (message === undefined) assert.deepEqual(actual, expected);
  else assert.deepEqual(actual, expected, message);
}

function operations(spec) {
  const out = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

function schemaIncludesRef(schema, ref) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref === ref) return true;
  return ['oneOf', 'anyOf', 'allOf'].some((key) =>
    Array.isArray(schema[key]) && schema[key].some((item) => schemaIncludesRef(item, ref)));
}

function assertSharedSchemas(spec, label) {
  const rateLimit = spec.components?.schemas?.RateLimitError;
  assert.ok(rateLimit, `${label}: RateLimitError schema missing`);
  assert.equal(rateLimit.properties?.error?.type, 'string', `${label}: RateLimitError.error must be string`);
  assert.deepEqual(rateLimit.required, ['error'], `${label}: RateLimitError must require error`);

  const gateway = spec.components?.schemas?.GatewayError;
  assert.ok(gateway, `${label}: GatewayError schema missing`);
  assert.ok(gateway.properties?.error, `${label}: GatewayError.error missing`);
  assert.deepEqual(gateway.required, ['error'], `${label}: GatewayError must require error`);

  const invalidBody = spec.components?.schemas?.InvalidRequestBodyError;
  assert.ok(invalidBody, `${label}: InvalidRequestBodyError schema missing`);
  assert.equal(invalidBody.properties?.message?.type, 'string', `${label}: InvalidRequestBodyError.message must be string`);
  assert.deepEqual(invalidBody.required, ['message'], `${label}: InvalidRequestBodyError must require message`);
}

function assertOperationContract({ path, method, op }, label) {
  const opLabel = `${label}: ${method.toUpperCase()} ${path}`;
  const rateLimit = op.responses?.['429'];
  assert.ok(rateLimit, `${opLabel}: missing 429 response`);
  const rateLimitSchema = rateLimit.content?.['application/json']?.schema;
  assert.ok(schemaIncludesRef(rateLimitSchema, '#/components/schemas/RateLimitError'), `${opLabel}: 429 must allow gateway {error} rate-limit bodies`);
  assert.ok(schemaIncludesRef(rateLimitSchema, '#/components/schemas/Error'), `${opLabel}: 429 must preserve handler {message} errors`);
  for (const header of RATE_LIMIT_HEADERS) {
    assert.ok(rateLimit.headers?.[header], `${opLabel}: 429 must document ${header}`);
    assert.equal(rateLimit.headers[header].schema?.type, 'string', `${opLabel}: ${header} header schema`);
  }

  const defaultSchema = op.responses?.default?.content?.['application/json']?.schema;
  assert.ok(schemaIncludesRef(defaultSchema, '#/components/schemas/Error'), `${opLabel}: default must still allow handler {message} errors`);
  assert.ok(schemaIncludesRef(defaultSchema, '#/components/schemas/GatewayError'), `${opLabel}: default must allow gateway {error} errors`);

  if (method === 'post') {
    const badRequest = op.responses?.['400']?.content?.['application/json']?.schema;
    assert.ok(
      schemaIncludesRef(badRequest, '#/components/schemas/InvalidRequestBodyError'),
      `${opLabel}: 400 must include malformed JSON {message} response`,
    );
    assert.match(
      op.responses?.['400']?.description ?? '',
      /malformed JSON request body/,
      `${opLabel}: 400 description must mention malformed JSON request bodies`,
    );
  }
}

describe('OpenAPI gateway rate-limit and error contracts', () => {
  it('audits the known operation surface', () => {
    assert.deepEqual(
      serviceJson.map((file) => file.replace(/\.openapi\.json$/, '')),
      discoverProtoServiceNames(),
      'JSON service specs must match the proto service universe exactly',
    );
    assert.deepEqual(
      serviceYaml.map((file) => file.replace(/\.openapi\.yaml$/, '')),
      discoverProtoServiceNames(),
      'YAML service specs must match the proto service universe exactly',
    );
    const discoveredOperations = [...jsonSpecsByFile.values()].flatMap(operations);
    const total = discoveredOperations.length;
    const postTotal = discoveredOperations.filter((op) => op.method === 'post').length;
    assert.ok(total > 0, 'service-operation discovery must not be empty');
    assert.ok(postTotal > 0, 'POST-operation discovery must not be empty');
    assertExactOperationParity(yamlServiceOperationIds, jsonServiceOperationIds, 'YAML and JSON service specs must expose the same service/method/path set');
  });

  for (const file of serviceJson) {
    it(`${file}: every operation documents gateway 429/default errors`, () => {
      const spec = jsonSpecsByFile.get(file);
      assertSharedSchemas(spec, file);
      for (const op of operations(spec)) assertOperationContract(op, file);
    });
  }

  for (const file of serviceYaml) {
    it(`${file}: every operation documents gateway 429/default errors`, () => {
      const spec = yamlSpecsByFile.get(file);
      assertSharedSchemas(spec, file);
      for (const op of operations(spec)) assertOperationContract(op, file);
    });
  }

  it('the unified bundle documents the same gateway contracts', () => {
    const bundle = loadUnifiedOpenApiSpec();
    const ops = operations(bundle);
    const bundleOperationIds = openApiOperationIds(bundle);
    assert.equal(new Set(jsonBundleOperationIds).size, jsonBundleOperationIds.length, 'per-service operation paths must be globally unique for the unified bundle');
    assertExactOperationParity(bundleOperationIds, jsonBundleOperationIds, 'unified and per-service specs must expose the same method/path set');
    assertSharedSchemas(bundle, 'worldmonitor.openapi.yaml');
    for (const op of ops) assertOperationContract(op, 'worldmonitor.openapi.yaml');
  });

  it('exact operation identities reject a same-cardinality substitution', () => {
    const baseline = openApiOperationIds({ paths: { '/api/fixture/v1/original': { get: {} } } });
    const substituted = openApiOperationIds({ paths: { '/api/fixture/v1/substituted': { get: {} } } });
    assert.equal(baseline.length, substituted.length, 'fixture must preserve aggregate cardinality');
    assert.throws(
      () => assertExactOperationParity(substituted, baseline),
      /Expected values to be strictly deep-equal/,
      'method/path parity must reject a same-cardinality substitution',
    );
  });

  it('the injector reports the specs as in-sync', () => {
    execFileSync('node', ['scripts/openapi-inject-rate-limit-errors.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });

  it('the injector preserves pre-existing POST 400 variants while adding malformed-body docs', () => {
    const fixtureDir = mkdtempSync(resolve(tmpdir(), 'wm-openapi-rate-limit-'));
    const fixtureJson = {
      openapi: '3.1.0',
      info: { title: 'FixtureService API', version: '1.0.0' },
      paths: {
        '/api/fixture/v1/create': {
          post: {
            responses: {
              '400': {
                description: 'Existing bad request variants',
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        { $ref: '#/components/schemas/ValidationError' },
                        { $ref: '#/components/schemas/CustomPostError' },
                      ],
                    },
                  },
                },
              },
              default: {
                description: 'Error response',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
              },
            },
          },
        },
        '/api/fixture/v1/single': {
          post: {
            responses: {
              '400': {
                description: 'Single bad request variant',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/CustomPostError' },
                  },
                },
              },
              default: {
                description: 'Error response',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
              },
            },
          },
        },
        '/api/fixture/v1/missing': {
          post: {
            responses: {
              default: {
                description: 'Error response',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Error: { type: 'object', properties: { message: { type: 'string' } } },
          ValidationError: { type: 'object' },
          CustomPostError: { type: 'object', properties: { code: { type: 'string' } } },
        },
      },
    };
    const fixtureYaml = `openapi: 3.1.0
info:
    title: FixtureService API
    version: 1.0.0
paths:
    /api/fixture/v1/create:
        post:
            responses:
                "400":
                    description: Existing bad request variants
                    content:
                        application/json:
                            schema:
                                oneOf:
                                    - $ref: '#/components/schemas/ValidationError'
                                    - $ref: '#/components/schemas/CustomPostError'
                default:
                    description: Error response
                    content:
                        application/json:
                            schema:
                                $ref: '#/components/schemas/Error'
    /api/fixture/v1/single:
        post:
            responses:
                "400":
                    description: Single bad request variant
                    content:
                        application/json:
                            schema:
                                $ref: '#/components/schemas/CustomPostError'
                default:
                    description: Error response
                    content:
                        application/json:
                            schema:
                                $ref: '#/components/schemas/Error'
    /api/fixture/v1/missing:
        post:
            responses:
                default:
                    description: Error response
                    content:
                        application/json:
                            schema:
                                $ref: '#/components/schemas/Error'
components:
    schemas:
        Error:
            type: object
            properties:
                message:
                    type: string
        ValidationError:
            type: object
        CustomPostError:
            type: object
            properties:
                code:
                    type: string
`;
    writeFileSync(resolve(fixtureDir, 'FixtureService.openapi.json'), JSON.stringify(fixtureJson));
    writeFileSync(resolve(fixtureDir, 'FixtureService.openapi.yaml'), fixtureYaml);
    writeFileSync(resolve(fixtureDir, 'worldmonitor.openapi.yaml'), fixtureYaml);

    execFileSync('node', ['scripts/openapi-inject-rate-limit-errors.mjs'], {
      cwd: root,
      env: { ...process.env, WM_OPENAPI_API_DIR: fixtureDir },
      stdio: 'pipe',
    });

    const updatedJson = JSON.parse(readFileSync(resolve(fixtureDir, 'FixtureService.openapi.json'), 'utf8'));
    const updatedYaml = loadYaml(readFileSync(resolve(fixtureDir, 'FixtureService.openapi.yaml'), 'utf8'));
    for (const [label, spec] of Object.entries({ json: updatedJson, yaml: updatedYaml })) {
      const badRequest = spec.paths['/api/fixture/v1/create'].post.responses['400'];
      assert.ok(schemaIncludesRef(badRequest.content['application/json'].schema, '#/components/schemas/CustomPostError'), `${label}: custom 400 variant must survive`);
      assert.ok(schemaIncludesRef(badRequest.content['application/json'].schema, '#/components/schemas/InvalidRequestBodyError'), `${label}: malformed-body 400 variant must be added`);

      const singleBadRequest = spec.paths['/api/fixture/v1/single'].post.responses['400'];
      assert.ok(schemaIncludesRef(singleBadRequest.content['application/json'].schema, '#/components/schemas/CustomPostError'), `${label}: single-schema 400 variant must survive`);
      assert.ok(schemaIncludesRef(singleBadRequest.content['application/json'].schema, '#/components/schemas/InvalidRequestBodyError'), `${label}: malformed-body 400 variant must be added to single-schema 400`);

      const missingBadRequest = spec.paths['/api/fixture/v1/missing'].post.responses['400'];
      assert.ok(missingBadRequest, `${label}: missing 400 response must be created`);
      assert.ok(schemaIncludesRef(missingBadRequest.content['application/json'].schema, '#/components/schemas/InvalidRequestBodyError'), `${label}: malformed-body 400 variant must be created when 400 is missing`);
    }
  });
});
