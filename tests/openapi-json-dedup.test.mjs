import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

import { dedupeErrorResponses, dedupeSharedParameters, ensureInlineTypedInput } from '../scripts/openapi-dedup-responses.mjs';
import {
  dedupeRepeatedInt64Schemas,
  dedupeRepeatedChinaDateSchemas,
  dedupeSharedChinaProvenanceSchemas,
  dedupeSharedResponseHeaders,
} from '../scripts/openapi-dedup-schemas.mjs';
import { buildBundle } from '../scripts/build-openapi-json.mjs';
import { SCANNER_BUDGET_BYTES } from '../scripts/openapi-capacity-report.mjs';

// Guards the served public/openapi.json against the ~1 MB scanner body cap.
// On 2026-07-05 the per-op rate-limit/idempotency/example doc injections grew
// the minified JSON from ~752 KB to ~1.04 MB and ora.ai/orank's Access
// "function-calling compatibility" check flipped from PASS ("192/192 with
// typed schemas") to WARN ("API spec found but couldn't validate function
// calling compatibility") — the same error path its validator hits on
// elevenlabs' 1.8 MB and openrouter's 1.5 MB specs, while sub-800 KB specs get
// computed verdicts. build-openapi-json.mjs now $ref-dedupes repeated non-2xx
// error responses and the shared China provenance value schemas when emitting
// the JSON artifact; these tests prove the transforms are lossless, keep
// scanner-credited 2xx responses inline, and keep the artifact under budget so
// the next injector cannot silently re-cross the cap.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildScriptPath = resolve(root, 'scripts/build-openapi-json.mjs');

// Leave headroom under the ~1 MB cap: the spec sat at ~752 KB when the check
// last passed and ~853 KB deduped today. If this fails, either extend the
// dedup (more shared structure) or trim the newest per-op injection — do NOT
// raise the budget past 1 MB.
//
// The value lives in scripts/openapi-capacity-report.mjs so the gate and the
// CI capacity report cannot disagree about where the wall is, and is pinned
// literally below so raising it stays a deliberate two-file edit rather than a
// one-line workaround (#6558).
const SIZE_BUDGET_BYTES = SCANNER_BUDGET_BYTES;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function operationResponses(spec) {
  const out = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !op?.responses) continue;
      for (const [statusCode, response] of Object.entries(op.responses)) {
        out.push({ path, method, statusCode, response });
      }
    }
  }
  return out;
}

function resolveResponseRefs(spec) {
  for (const site of operationResponses(spec)) {
    const ref = site.response?.$ref;
    if (!ref) continue;
    const name = ref.replace('#/components/responses/', '');
    const target = spec.components?.responses?.[name];
    assert.ok(target, `${site.method.toUpperCase()} ${site.path} ${site.statusCode}: dangling ${ref}`);
    spec.paths[site.path][site.method].responses[site.statusCode] = structuredClone(target);
  }
  delete spec.components?.responses;
  if (spec.components && Object.keys(spec.components).length === 0) delete spec.components;
  return spec;
}

function resolveParameterRefs(spec) {
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !Array.isArray(op?.parameters)) continue;
      op.parameters.forEach((param, index) => {
        const ref = param?.$ref;
        if (!ref) return;
        const name = ref.replace('#/components/parameters/', '');
        const target = spec.components?.parameters?.[name];
        assert.ok(target, `${method.toUpperCase()} ${path} parameters[${index}]: dangling ${ref}`);
        op.parameters[index] = structuredClone(target);
      });
    }
  }
  delete spec.components?.parameters;
  if (spec.components && Object.keys(spec.components).length === 0) delete spec.components;
  return spec;
}

function resolveSharedChinaProvenanceRefs(spec) {
  const refPrefix =
    '#/components/schemas/worldmonitor_intelligence_v1_ChinaDecisionSignalProvenanceClaims/';
  const resolvePointer = (ref) =>
    ref
      .slice(2)
      .split('/')
      .reduce(
        (value, segment) => value[segment.replaceAll('~1', '/').replaceAll('~0', '~')],
        spec,
      );
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const child = value[index];
        if (child?.$ref?.startsWith(refPrefix)) value[index] = structuredClone(resolvePointer(child.$ref));
        else visit(child);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (child?.$ref?.startsWith(refPrefix)) value[key] = structuredClone(resolvePointer(child.$ref));
      else visit(child);
    }
  };
  visit(spec);
  return spec;
}

function resolveAddedComponentRefs(spec, { headerNames = [], schemaNames = [] }) {
  const targets = new Map([
    ...headerNames.map((name) => [`#/components/headers/${name}`, spec.components.headers[name]]),
    ...schemaNames.map((name) => [`#/components/schemas/${name}`, spec.components.schemas[name]]),
  ]);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const target = child?.$ref ? targets.get(child.$ref) : null;
      if (target) value[key] = structuredClone(target);
      else visit(child);
    }
  };
  for (const [name, schema] of Object.entries(spec.components.schemas ?? {})) {
    if (!schemaNames.includes(name)) visit(schema);
  }
  for (const pathItem of Object.values(spec.paths ?? {})) visit(pathItem);
  for (const name of headerNames) delete spec.components.headers[name];
  for (const name of schemaNames) delete spec.components.schemas[name];
  if (Object.keys(spec.components.headers ?? {}).length === 0) delete spec.components.headers;
  return spec;
}

describe('dedupeErrorResponses (fixture)', () => {
  const fixture = () => ({
    openapi: '3.1.0',
    paths: {
      '/a': {
        get: {
          responses: {
            200: { description: 'a-ok', content: {} },
            429: { description: 'slow down', headers: { 'Retry-After': {} } },
            400: { description: 'bad a' },
          },
        },
      },
      '/b': {
        post: {
          responses: {
            200: { description: 'b-ok', content: {} },
            429: { description: 'slow down', headers: { 'Retry-After': {} } },
            400: { description: 'bad b' },
          },
        },
      },
    },
  });

  it('hoists repeated non-2xx responses and leaves unique + 2xx responses inline', () => {
    const spec = fixture();
    const stats = dedupeErrorResponses(spec);
    assert.equal(stats.hoisted, 1, 'only the repeated 429 group is hoisted');
    assert.equal(stats.replacedRefs, 2);
    assert.deepEqual(spec.components.responses.E429, {
      description: 'slow down',
      headers: { 'Retry-After': {} },
    });
    assert.deepEqual(spec.paths['/a'].get.responses[429], {
      $ref: '#/components/responses/E429',
    });
    assert.deepEqual(spec.paths['/b'].post.responses[429], {
      $ref: '#/components/responses/E429',
    });
    // Unique 400s and both 200s stay put.
    assert.equal(spec.paths['/a'].get.responses[400].description, 'bad a');
    assert.equal(spec.paths['/b'].post.responses[400].description, 'bad b');
    assert.equal(spec.paths['/a'].get.responses[200].description, 'a-ok');
    assert.equal(spec.paths['/b'].post.responses[200].description, 'b-ok');
  });

  it('never hoists 2xx responses even when identical', () => {
    const spec = fixture();
    spec.paths['/a'].get.responses[200] = { description: 'same' };
    spec.paths['/b'].post.responses[200] = { description: 'same' };
    dedupeErrorResponses(spec);
    assert.equal(spec.paths['/a'].get.responses[200].description, 'same');
    assert.equal(spec.paths['/b'].post.responses[200].description, 'same');
  });

  it('avoids colliding with pre-existing component names', () => {
    const spec = fixture();
    spec.components = { responses: { E429: { description: 'taken' } } };
    dedupeErrorResponses(spec);
    assert.equal(spec.components.responses.E429.description, 'taken');
    assert.equal(spec.components.responses.E429_2.description, 'slow down');
    assert.equal(
      spec.paths['/a'].get.responses[429].$ref,
      '#/components/responses/E429_2',
    );
  });
});

describe('dedupeSharedChinaProvenanceSchemas (fixture)', () => {
  it('reuses only structurally identical known-value schemas across the two China surfaces', () => {
    const sharedKnownValue = { type: 'string', minLength: 1 };
    const spec = {
      components: {
        schemas: {
          worldmonitor_supply_chain_v1_ChinaCorridorProvenance: {
            properties: {
              claims: {
                properties: {
                  publisher: {
                    oneOf: [
                      {
                        properties: {
                          status: { const: 'known' },
                          value: structuredClone(sharedKnownValue),
                        },
                      },
                      { type: 'null' },
                    ],
                  },
                  revision: {
                    oneOf: [
                      {
                        properties: {
                          status: { const: 'known' },
                          value: { type: 'number' },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          worldmonitor_intelligence_v1_ChinaDecisionSignalProvenanceClaims: {
            properties: {
              publisher: {
                oneOf: [
                  {
                    properties: {
                      status: { const: 'known' },
                      value: structuredClone(sharedKnownValue),
                    },
                  },
                ],
              },
              revision: {
                oneOf: [
                  {
                    properties: {
                      status: { const: 'known' },
                      value: { type: 'integer' },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };

    const stats = dedupeSharedChinaProvenanceSchemas(spec);
    assert.deepEqual(stats, { compared: 2, replacedRefs: 1 });
    assert.equal(
      spec.components.schemas.worldmonitor_supply_chain_v1_ChinaCorridorProvenance
        .properties.claims.properties.publisher.oneOf[0].properties.value.$ref,
      '#/components/schemas/worldmonitor_intelligence_v1_ChinaDecisionSignalProvenanceClaims/properties/publisher/oneOf/0/properties/value',
    );
    assert.deepEqual(
      spec.components.schemas.worldmonitor_supply_chain_v1_ChinaCorridorProvenance
        .properties.claims.properties.revision.oneOf[0].properties.value,
      { type: 'number' },
    );
  });
});

describe('additional lossless schema dedupe (fixtures)', () => {
  it('hoists structurally identical response headers and leaves unique headers inline', () => {
    const shared = { schema: { type: 'boolean' }, description: 'replayed response' };
    const spec = {
      paths: {
        '/a': { post: { responses: { 200: { headers: { 'Idempotent-Replayed': structuredClone(shared) } } } } },
        '/b': { post: { responses: { 200: { headers: { 'Idempotent-Replayed': structuredClone(shared) } } } } },
        '/c': { post: { responses: { 200: { headers: { 'X-Unique': { schema: { type: 'string' } } } } } } },
      },
    };

    const stats = dedupeSharedResponseHeaders(spec);
    assert.deepEqual(stats, { hoisted: 1, replacedRefs: 2 });
    assert.deepEqual(spec.components.headers.IdempotentReplayedHeader, shared);
    assert.deepEqual(spec.paths['/a'].post.responses[200].headers['Idempotent-Replayed'], {
      $ref: '#/components/headers/IdempotentReplayedHeader',
    });
    assert.deepEqual(spec.paths['/b'].post.responses[200].headers['Idempotent-Replayed'], {
      $ref: '#/components/headers/IdempotentReplayedHeader',
    });
    assert.deepEqual(spec.paths['/c'].post.responses[200].headers['X-Unique'], {
      schema: { type: 'string' },
    });
  });

  it('reuses only the exact generated int64 precision-warning schema', () => {
    const repeated = {
      type: 'integer',
      format: 'int64',
      description: 'Warning: Values > 2^53 may lose precision in JavaScript',
    };
    const spec = {
      components: {
        schemas: {
          A: { properties: { measuredAt: structuredClone(repeated) } },
          B: { properties: { fetchedAt: structuredClone(repeated) } },
          C: { properties: { id: { type: 'integer', format: 'int64' } } },
        },
      },
    };

    const stats = dedupeRepeatedInt64Schemas(spec);
    assert.deepEqual(stats, { replacedRefs: 2 });
    assert.deepEqual(spec.components.schemas.WorldMonitorInt64, repeated);
    assert.deepEqual(spec.components.schemas.A.properties.measuredAt, {
      $ref: '#/components/schemas/WorldMonitorInt64',
    });
    assert.deepEqual(spec.components.schemas.B.properties.fetchedAt, {
      $ref: '#/components/schemas/WorldMonitorInt64',
    });
    assert.deepEqual(spec.components.schemas.C.properties.id, { type: 'integer', format: 'int64' });
  });

  it('reuses identical China decision-signal date-precision unions', () => {
    const repeated = { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'string', format: 'date' }] };
    const spec = {
      components: {
        schemas: {
          worldmonitor_intelligence_v1_ChinaDecisionSignalItem: {
            properties: {
              effectiveAt: { oneOf: [structuredClone(repeated), { type: 'null' }] },
              observedAt: { oneOf: [structuredClone(repeated), { type: 'null' }] },
              unrelated: { oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
        },
      },
    };

    const stats = dedupeRepeatedChinaDateSchemas(spec);
    assert.deepEqual(stats, { replacedRefs: 2 });
    assert.deepEqual(spec.components.schemas.WorldMonitorChinaDatePrecision, repeated);
    assert.deepEqual(
      spec.components.schemas.worldmonitor_intelligence_v1_ChinaDecisionSignalItem.properties.effectiveAt.oneOf[0],
      { $ref: '#/components/schemas/WorldMonitorChinaDatePrecision' },
    );
    assert.deepEqual(
      spec.components.schemas.worldmonitor_intelligence_v1_ChinaDecisionSignalItem.properties.unrelated,
      { oneOf: [{ type: 'number' }, { type: 'null' }] },
    );
  });
});

describe('ensureInlineTypedInput (fixture)', () => {
  it('inlines one $ref parameter only when the operation has no other typed input', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/only-ref': {
          get: {
            parameters: [{ $ref: '#/components/parameters/JmespathParam' }],
          },
        },
        '/has-path': {
          get: {
            parameters: [
              { name: 'id', in: 'path', schema: { type: 'string' } },
              { $ref: '#/components/parameters/JmespathParam' },
            ],
          },
        },
        '/has-body': {
          post: {
            parameters: [{ $ref: '#/components/parameters/IdempotencyKeyParam' }],
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } },
            },
          },
        },
      },
      components: {
        parameters: {
          JmespathParam: { name: 'jmespath', in: 'query', schema: { type: 'string' } },
          IdempotencyKeyParam: { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
        },
        schemas: { Body: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      },
    };

    const stats = ensureInlineTypedInput(spec);
    assert.equal(stats.inlined, 1);
    assert.equal(spec.paths['/only-ref'].get.parameters[0].name, 'jmespath');
    assert.equal(spec.paths['/has-path'].get.parameters[1].$ref, '#/components/parameters/JmespathParam');
    assert.equal(spec.paths['/has-body'].post.parameters[0].$ref, '#/components/parameters/IdempotencyKeyParam');
  });
});

describe('public OpenAPI dedupe (real bundle)', () => {
  const original = loadUnifiedOpenApiSpec();
  const deduped = structuredClone(original);
  const stats = dedupeErrorResponses(deduped);
  const schemaStats = dedupeSharedChinaProvenanceSchemas(deduped);
  const chinaDateStats = dedupeRepeatedChinaDateSchemas(deduped);
  const int64Stats = dedupeRepeatedInt64Schemas(deduped);
  const headerStats = dedupeSharedResponseHeaders(deduped);
  const paramStats = dedupeSharedParameters(deduped);

  it('is lossless: resolving the $refs reproduces the original spec exactly', () => {
    assert.deepEqual(
      resolveResponseRefs(resolveSharedChinaProvenanceRefs(resolveParameterRefs(resolveAddedComponentRefs(
        structuredClone(deduped),
        {
          headerNames: ['IdempotentReplayedHeader', 'IdempotencyKeyHeader'],
          schemaNames: ['WorldMonitorChinaDatePrecision', 'WorldMonitorInt64'],
        },
      )))),
      original,
    );
  });

  it('keeps every 2xx response inline (orank credits only the inline responses["200"])', () => {
    for (const site of operationResponses(deduped)) {
      if (!/^2/.test(site.statusCode)) continue;
      assert.equal(
        site.response.$ref,
        undefined,
        `${site.method.toUpperCase()} ${site.path} ${site.statusCode} must stay inline`,
      );
    }
  });

  it('actually engages on the injected error docs (429 et al.)', () => {
    assert.ok(
      deduped.components.responses.E429,
      'the per-op 429 rate-limit block must dedupe into components.responses.E429',
    );
    assert.ok(stats.replacedRefs >= 500, `expected wide dedup, got ${stats.replacedRefs} refs`);
  });

  it('reuses the shared China provenance value schemas only after exact comparison', () => {
    assert.equal(schemaStats.compared, 17);
    assert.equal(schemaStats.replacedRefs, 17);
  });

  it('engages the exact repeated headers and generated scalar/date schemas', () => {
    assert.deepEqual(headerStats, { hoisted: 2, replacedRefs: 34 });
    assert.equal(int64Stats.replacedRefs, 38);
    assert.equal(chinaDateStats.replacedRefs, 9);
  });

  it('actually engages on the fleet-wide injected parameters (jmespath et al.)', () => {
    assert.ok(
      deduped.components.parameters.JmespathParam,
      'the injector-stamped jmespath param must dedupe into components.parameters.JmespathParam',
    );
    assert.ok(paramStats.replacedRefs >= 200, `expected fleet-wide dedup, got ${paramStats.replacedRefs} refs`);
  });

  it('gives every JSON operation an inline typed parameter or requestBody without following parameter $refs', () => {
    // ora.ai / orank fetch /openapi.json and score "partially documented" when
    // every typed input is a components.parameters $ref. Schema $refs for
    // requestBody/200 remain resolver-credited; parameter $refs are not.
    const { spec, inlineTypedStats } = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    assert.ok(inlineTypedStats.inlined >= 50, `expected GETs restored to inline typed input, got ${inlineTypedStats.inlined}`);

    const issues = [];
    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem ?? {})) {
        if (!HTTP_METHODS.has(method.toLowerCase()) || !operation) continue;
        const inlineTypedParam = (operation.parameters ?? []).some((param) =>
          param && !param.$ref && param.schema && (
            param.schema.type
            || param.schema.$ref
            || param.schema.properties
            || param.schema.anyOf
            || param.schema.oneOf
            || param.schema.allOf
          ),
        );
        const body = operation.requestBody?.content?.['application/json']?.schema;
        const typedBody = Boolean(body && (body.type || body.$ref || body.properties || body.anyOf || body.oneOf || body.allOf));
        if (!inlineTypedParam && !typedBody) {
          issues.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    assert.deepEqual(issues, [], `JSON operations missing inline typed input:\n${issues.join('\n')}`);
  });

  it('documents Deprecation/Sunset header objects and the static policy URL on the JSON bundle', () => {
    const { spec } = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    assert.match(String(spec.info?.description ?? ''), /api-versioning\.md/);
    assert.ok(spec.components?.headers?.Deprecation, 'JSON bundle must declare components.headers.Deprecation');
    assert.ok(spec.components?.headers?.Sunset, 'JSON bundle must declare components.headers.Sunset');
    assert.match(spec.components.headers.Deprecation.description, /RFC 9745/);
    assert.match(spec.components.headers.Sunset.description, /RFC 8594/);
  });

  it('the budget is 950,000 bytes and raising it is not the remedy', () => {
    // A literal pin, not a restatement: the guard below reads the shared
    // constant, so without this a crossing could be "fixed" by editing one
    // number in one file. The cap belongs to the scanner (#4852) — moving our
    // number does not move it.
    assert.equal(SIZE_BUDGET_BYTES, 950_000);
  });

  it(`keeps the served JSON under the ${SIZE_BUDGET_BYTES}-byte scanner budget`, () => {
    // Measured through buildBundle — the same call that writes the artifact —
    // so the gate can never guard a document the build does not emit. It
    // applies one transform this file's `deduped` fixture does not (the
    // unreachable-schema drop), and it counts UTF-8 BYTES: `String#length` is
    // UTF-16 code units and undercut the served size by 264 bytes on the
    // 2026-08-13 bundle, against a cap expressed in bytes.
    const { bytes } = buildBundle({ spec: loadUnifiedOpenApiSpec() });
    assert.ok(
      bytes <= SIZE_BUDGET_BYTES,
      `public/openapi.json is ${bytes} bytes (budget ${SIZE_BUDGET_BYTES}). ` +
        'Scanners cap spec bodies around 1 MB (orank function-calling-compat degrades to ' +
        '"couldn\'t validate" above it). Extend scripts/openapi-dedup-responses.mjs or slim ' +
        'the newest per-op injection instead of raising this budget. ' +
        '`node scripts/openapi-capacity-report.mjs` ranks what is worth collapsing next.',
    );
  });
});

describe('build-openapi-json wiring', () => {
  it('the build script applies response and shared-provenance dedupe before writing JSON', () => {
    const src = readFileSync(buildScriptPath, 'utf8');
    assert.match(src, /from '\.\/openapi-dedup-responses\.mjs'/);
    assert.match(src, /from '\.\/openapi-dedup-schemas\.mjs'/);
    assert.match(src, /dedupeErrorResponses\(spec\)/);
    assert.match(src, /dedupeSharedChinaProvenanceSchemas\(spec\)/);
    assert.match(src, /dedupeRepeatedChinaDateSchemas\(spec\)/);
    assert.match(src, /dedupeRepeatedInt64Schemas\(spec\)/);
    assert.match(src, /dedupeSharedResponseHeaders\(spec\)/);
    assert.match(src, /dedupeSharedParameters\(spec\)/);
    assert.match(src, /ensureInlineTypedInput\(spec\)/);
    assert.match(src, /injectDeprecationPolicyMetadata\(spec\)/);
  });

  it('every transform actually engaged on the bundle it emits', () => {
    // The source match above proves the calls are written down; this proves
    // they did something. A transform that silently stops finding work is the
    // regression the byte budget notices last and from the wrong direction.
    const {
      stats,
      schemaStats,
      chinaDateStats,
      int64Stats,
      headerStats,
      paramStats,
      inlineTypedStats,
      unreachableStats,
    } = buildBundle({
      spec: loadUnifiedOpenApiSpec(),
    });
    assert.ok(stats.replacedRefs >= 500, `error-response dedup: ${stats.replacedRefs} refs`);
    assert.ok(paramStats.replacedRefs >= 200, `parameter dedup: ${paramStats.replacedRefs} refs`);
    assert.ok(inlineTypedStats.inlined >= 50, `inline typed-input restore: ${inlineTypedStats.inlined}`);
    // `replacedRefs === compared` alone passes at 0 === 0, which is exactly the
    // silent-disengagement case this test exists for.
    assert.ok(schemaStats.compared > 0, 'China provenance dedup compared nothing');
    assert.equal(schemaStats.replacedRefs, schemaStats.compared);
    assert.ok(chinaDateStats.replacedRefs >= 5, `China date dedup: ${chinaDateStats.replacedRefs} refs`);
    assert.ok(int64Stats.replacedRefs >= 30, `int64 dedup: ${int64Stats.replacedRefs} refs`);
    assert.ok(headerStats.replacedRefs >= 30, `response-header dedup: ${headerStats.replacedRefs} refs`);
    assert.ok(unreachableStats.dropped >= 150, `unreachable drop: ${unreachableStats.dropped} schemas`);
  });
});
