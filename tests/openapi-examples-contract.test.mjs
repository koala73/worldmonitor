import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the generated OpenAPI examples injected by
// scripts/openapi-inject-examples.mjs (umbrella #4599, workstream #4610).
// The sebuf generator emits shape-only docs, so a fresh regenerate must be
// followed by the injector for every operation to keep request/response
// examples in the published specs.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const JSON_MEDIA = 'application/json';

const serviceSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();

function refName(ref) {
  assert.ok(ref.startsWith('#/components/schemas/'), `unsupported ref ${ref}`);
  return decodeURIComponent(ref.slice('#/components/schemas/'.length));
}

function resolveSchema(schema, spec) {
  if (!schema?.$ref) return schema;
  const name = refName(schema.$ref);
  const resolved = spec.components?.schemas?.[name];
  assert.ok(resolved, `missing schema ref ${schema.$ref}`);
  return resolved;
}

function schemaType(schema) {
  const t = Array.isArray(schema?.type) ? schema.type.find((v) => v !== 'null') : schema?.type;
  if (t) return t;
  if (schema?.properties || schema?.additionalProperties) return 'object';
  if (schema?.items) return 'array';
  return undefined;
}

function validateExample(value, schema, spec, label, seen = new Set()) {
  schema = schema ?? {};
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return;
    seen = new Set([...seen, schema.$ref]);
    schema = resolveSchema(schema, spec);
  }
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${label}: const mismatch`);
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), `${label}: enum mismatch`);
  if (schema.nullable && value === null) return;
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) validateExample(value, part, spec, label, seen);
    return;
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union)) {
    const matched = union.some((part) => {
      try {
        validateExample(value, part, spec, label, seen);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matched, `${label}: did not match any union member`);
    return;
  }

  const type = schemaType(schema);
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${label}: expected array`);
    for (const item of value) validateExample(item, schema.items ?? {}, spec, `${label}[]`, seen);
    return;
  }
  if (type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${label}: missing required property ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        validateExample(child, schema.properties[key], spec, `${label}.${key}`, seen);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateExample(child, schema.additionalProperties, spec, `${label}.${key}`, seen);
      }
    }
    return;
  }
  if (type === 'integer') {
    assert.equal(typeof value, 'number', `${label}: expected integer number`);
    assert.ok(Number.isInteger(value), `${label}: expected integer`);
  } else if (type === 'number') {
    assert.equal(typeof value, 'number', `${label}: expected number`);
  } else if (type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${label}: expected boolean`);
  } else if (type === 'string') {
    assert.equal(typeof value, 'string', `${label}: expected string`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum)) assert.ok(value >= schema.minimum, `${label}: below minimum`);
    if (Number.isFinite(schema.maximum)) assert.ok(value <= schema.maximum, `${label}: above maximum`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength)) assert.ok(value.length >= schema.minLength, `${label}: below minLength`);
    if (Number.isFinite(schema.maxLength)) assert.ok(value.length <= schema.maxLength, `${label}: above maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${label}: pattern mismatch`);
  }
}

function operationEntries(spec) {
  const entries = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      entries.push({ path, method, op });
    }
  }
  return entries;
}

function assertOperationExamples(spec, label) {
  let operations = 0;
  let requestExpected = 0;
  let responseExpected = 0;
  for (const { path, method, op } of operationEntries(spec)) {
    operations++;
    const opLabel = `${label}: ${method.toUpperCase()} ${path}`;

    for (const param of op.parameters ?? []) {
      requestExpected++;
      assert.notEqual(param.example, undefined, `${opLabel}: parameter ${param.name} missing example`);
      validateExample(param.example, param.schema, spec, `${opLabel} parameter ${param.name}`);
    }

    const requestMedia = op.requestBody?.content?.[JSON_MEDIA];
    if (requestMedia?.schema) {
      requestExpected++;
      assert.notEqual(requestMedia.example, undefined, `${opLabel}: request body missing example`);
      validateExample(requestMedia.example, requestMedia.schema, spec, `${opLabel} requestBody`);
    }

    const success = Object.entries(op.responses ?? {}).filter(([code, response]) =>
      /^2\d\d$/.test(code) && response?.content?.[JSON_MEDIA]?.schema,
    );
    assert.ok(success.length > 0, `${opLabel}: expected a JSON success response`);
    responseExpected++;
    for (const [code, response] of success) {
      const media = response.content[JSON_MEDIA];
      assert.notEqual(media.example, undefined, `${opLabel}: ${code} response missing example`);
      validateExample(media.example, media.schema, spec, `${opLabel} ${code} response`);
    }
  }
  return { operations, requestExpected, responseExpected };
}

describe('OpenAPI examples contract', () => {
  it('audits the known service operation surface', () => {
    assert.equal(serviceSpecs.length, 34, `expected 34 service specs, found ${serviceSpecs.length}`);
    const total = serviceSpecs.reduce((sum, file) => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      return sum + operationEntries(spec).length;
    }, 0);
    assert.equal(total, 192, `expected 192 OpenAPI operations, found ${total}`);
  });

  it('adds schema-valid request and response examples to every service JSON spec', () => {
    const totals = { operations: 0, requestExpected: 0, responseExpected: 0 };
    for (const file of serviceSpecs) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const result = assertOperationExamples(spec, file);
      totals.operations += result.operations;
      totals.requestExpected += result.requestExpected;
      totals.responseExpected += result.responseExpected;
    }
    assert.equal(totals.operations, 192);
    assert.ok(totals.requestExpected >= 137, `expected at least 137 request example targets, found ${totals.requestExpected}`);
    assert.equal(totals.responseExpected, 192);
  });

  it('adds request and response examples to every per-service YAML spec', () => {
    let operations = 0;
    for (const file of serviceSpecs) {
      const yamlFile = file.replace(/\.json$/, '.yaml');
      const spec = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      operations += assertOperationExamples(spec, yamlFile).operations;
    }
    assert.equal(operations, 192);
  });

  it('adds request and response examples to the unified OpenAPI bundle', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    const result = assertOperationExamples(bundle, 'worldmonitor.openapi.yaml');
    assert.equal(result.operations, 192);
    assert.equal(result.responseExpected, 192);
  });
});
