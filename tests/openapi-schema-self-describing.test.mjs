import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import {
  loadUnifiedOpenApiSpec,
  loadYamlSpecCached,
  openApiOperationIds,
  serviceOpenApiOperationIds,
} from './_lib/openapi-spec-cache.mjs';

// Guards ora.ai / orank `api-schema-analysis`: every published operation must
// be self-describing — unique operationId, a description, typed parameters or
// requestBody, and a typed success schema. Most operations return 200; narrow
// exemptions preserve truthful 202-only and body-agnostic 2XX contracts.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

// Operations that legitimately have no exact 200, keyed by operation kind,
// method, and published path/name. Each exemption names the real success
// response and its body contract so this gate verifies the truth instead of
// simply skipping it.
const NO_200_EXEMPT = new Map([
  ['path POST /api/scenario/v1/run-scenario', { successCode: '202', body: 'typed-json' }],
  ['webhook POST chokepoint.disruption', { successCode: '2XX', body: 'status-only' }],
]);

// A schema counts as typed only if it carries real information. A bare key
// presence check is not enough: `{$ref: '#/components/schemas/Nope'}` names a
// component that does not exist, and `{anyOf: []}` is a composition that
// matches nothing — both would sail through a `Boolean(schema.$ref || ...)`
// test while telling a client precisely nothing.
const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

function schemaIsTyped(schema, spec, seenRefs = new Set()) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref) {
    const ref = String(schema.$ref);
    const local = /^#\/components\/schemas\/(.+)$/u.exec(ref);
    // Only local component pointers are resolvable here; every $ref in
    // docs/api today is one, so an unrecognised shape is a red flag.
    if (!local) return false;
    const name = local[1];
    if (seenRefs.has(name)) return false;
    const target = spec?.components?.schemas?.[name];
    if (!target || typeof target !== 'object') return false;
    return schemaIsTyped(target, spec, new Set([...seenRefs, name]));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (key in schema) {
      return Array.isArray(schema[key])
        && schema[key].length > 0
        && schema[key].every((member) => schemaIsTyped(member, spec, seenRefs));
    }
  }
  if ('properties' in schema) {
    return schema.properties !== null
      && typeof schema.properties === 'object'
      && Object.keys(schema.properties).length > 0;
  }
  if (schema.type === 'array') return schemaIsTyped(schema.items, spec, seenRefs);
  if (Array.isArray(schema.type)) {
    return schema.type.length > 0 && schema.type.every((type) => JSON_SCHEMA_TYPES.has(type));
  }
  return JSON_SCHEMA_TYPES.has(schema.type);
}

function resolveParameter(param, spec) {
  if (!param || typeof param !== 'object') return null;
  if (!param.$ref) return param;
  const name = String(param.$ref).split('/').pop();
  return spec.components?.parameters?.[name] ?? null;
}

function collectOperations(spec) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      operations.push({ kind: 'path', path, method, operation });
    }
  }
  for (const [name, pathItem] of Object.entries(spec.webhooks ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      operations.push({ kind: 'webhook', path: name, method, operation });
    }
  }
  return operations;
}

function assertSelfDescribing(spec, label) {
  const operations = collectOperations(spec);
  // Per-KIND floors, not one floor over the union. `paths` and `webhooks` land
  // in the same array, so a single `operations.length > 0` is satisfied by the
  // lone injected webhook — this gate stayed green with all 218 REST paths
  // deleted. A path floor is what makes a wiped-out bundle red.
  assert.ok(
    operations.some((op) => op.kind === 'path'),
    `${label}: expected published REST path operations`,
  );

  const issues = [];
  const ids = new Map();
  for (const { kind, path, method, operation } of operations) {
    const opLabel = `${label} ${kind} ${method.toUpperCase()} ${path}`;
    const operationId = String(operation.operationId ?? '').trim();
    if (!operationId) issues.push(`${opLabel}: missing operationId`);
    else ids.set(operationId, (ids.get(operationId) ?? []).concat(opLabel));

    if (!String(operation.description ?? '').trim()) {
      issues.push(`${opLabel}: missing description`);
    }

    const parameters = (operation.parameters ?? []).map((param) => resolveParameter(param, spec));
    let typedParameters = 0;
    for (const [index, param] of parameters.entries()) {
      if (!param) {
        issues.push(`${opLabel}: parameters[${index}] is a dangling $ref`);
        continue;
      }
      if (schemaIsTyped(param.schema, spec)) typedParameters++;
      else issues.push(`${opLabel}: parameter ${param.name ?? index} is untyped`);
    }

    // Count only TYPED parameters toward "has typed input" — otherwise a lone
    // untyped parameter satisfies the typed-input clause and the operation
    // reads as self-describing on the strength of the very thing that is not.
    const requestSchema = operation.requestBody?.content?.['application/json']?.schema;
    const typedInput = typedParameters > 0 || schemaIsTyped(requestSchema, spec);
    if (!typedInput) issues.push(`${opLabel}: no typed parameters or requestBody`);
    if (operation.requestBody && !schemaIsTyped(requestSchema, spec)) {
      issues.push(`${opLabel}: requestBody is untyped`);
    }

    const identity = `${kind} ${method.toUpperCase()} ${path}`;
    const exemption = NO_200_EXEMPT.get(identity);
    const ok = operation.responses?.['200'];
    if (!ok) {
      if (exemption) {
        const declared = operation.responses?.[exemption.successCode];
        if (!declared) {
          issues.push(`${opLabel}: NO_200_EXEMPT expects responses["${exemption.successCode}"]`);
          continue;
        }
        if (
          exemption.body === 'typed-json'
          && !schemaIsTyped(declared.content?.['application/json']?.schema, spec)
        ) {
          issues.push(`${opLabel}: responses["${exemption.successCode}"] has no typed application/json schema`);
        }
        if (exemption.body === 'status-only' && declared.content !== undefined) {
          issues.push(`${opLabel}: responses["${exemption.successCode}"] must remain body-agnostic`);
        }
        continue;
      }
      const other2xx = Object.keys(operation.responses ?? {}).filter((code) => /^2/.test(code));
      issues.push(`${opLabel}: missing responses["200"] (has ${other2xx.join(',') || 'no 2xx'})`);
      continue;
    }
    if (exemption) {
      issues.push(`${opLabel}: documents a 200 but is listed in NO_200_EXEMPT — drop the exemption`);
    }
    if (!schemaIsTyped(ok.content?.['application/json']?.schema, spec)) {
      issues.push(`${opLabel}: responses["200"] has no typed application/json schema`);
    }
  }

  for (const [operationId, sites] of ids) {
    if (sites.length > 1) issues.push(`${label}: duplicate operationId ${operationId} at ${sites.join('; ')}`);
  }

  assert.deepEqual(issues, [], issues.join('\n'));
}

describe('OpenAPI self-describing operations (orank api-schema-analysis)', () => {
  it('gives every unified-bundle path and webhook a unique id, description, typed input, and truthful success', () => {
    assertSelfDescribing(loadUnifiedOpenApiSpec(), 'worldmonitor.openapi.yaml');
  });

  // A per-kind floor catches a wiped bundle; only a parity check catches a
  // PARTIAL one. Anchor the bundle's population to the per-service specs (the
  // source the bundler builds it from) so losing one service's routes is red
  // here rather than relying on a neighbouring suite to notice.
  it('publishes exactly the per-service operation population in the bundle', () => {
    const files = readdirSync(apiDir).filter((file) => /Service\.openapi\.yaml$/.test(file)).sort();
    assert.ok(files.length > 0, 'expected per-service YAML specs');
    const specsByFile = files.map((file) => [file, loadYamlSpecCached(resolve(apiDir, file))]);
    const expected = serviceOpenApiOperationIds(specsByFile)
      .map((id) => id.replace(/^[^:]+::/u, ''))
      .sort();
    const actual = openApiOperationIds(loadUnifiedOpenApiSpec()).sort();
    assert.deepEqual(actual, expected, 'bundle operations must equal the union of the per-service specs');
  });

  it('gives every per-service JSON spec the same self-describing contract', () => {
    const files = readdirSync(apiDir).filter((file) => /Service\.openapi\.json$/.test(file)).sort();
    assert.ok(files.length > 0, 'expected per-service JSON specs');
    for (const file of files) {
      assertSelfDescribing(JSON.parse(readFileSync(resolve(apiDir, file), 'utf8')), file);
    }
  });

  it('gives every per-service YAML spec the same self-describing contract', () => {
    const files = readdirSync(apiDir).filter((file) => /Service\.openapi\.yaml$/.test(file)).sort();
    assert.ok(files.length > 0, 'expected per-service YAML specs');
    for (const file of files) {
      assertSelfDescribing(loadYaml(readFileSync(resolve(apiDir, file), 'utf8')), file);
    }
  });
});

describe('schemaIsTyped', () => {
  it('rejects empty and malformed referenced component schemas', () => {
    const spec = {
      components: {
        schemas: {
          Empty: {},
          EmptyProperties: { properties: {} },
          ArrayWithoutItems: { type: 'array' },
          InvalidType: { type: 'sometimes' },
        },
      },
    };

    for (const name of Object.keys(spec.components.schemas)) {
      assert.equal(
        schemaIsTyped({ $ref: `#/components/schemas/${name}` }, spec),
        false,
        `${name} must not count as typed`,
      );
    }
  });

  it('follows local reference chains and rejects pure reference cycles', () => {
    const spec = {
      components: {
        schemas: {
          Alias: { $ref: '#/components/schemas/Value' },
          Value: { type: 'string' },
          CycleA: { $ref: '#/components/schemas/CycleB' },
          CycleB: { $ref: '#/components/schemas/CycleA' },
        },
      },
    };

    assert.equal(schemaIsTyped({ $ref: '#/components/schemas/Alias' }, spec), true);
    assert.equal(schemaIsTyped({ $ref: '#/components/schemas/CycleA' }, spec), false);
  });
});
