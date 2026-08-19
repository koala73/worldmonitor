import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

// Guards ora.ai / orank `api-schema-analysis`: every published operation must
// be self-describing — unique operationId, a description, typed parameters or
// requestBody, and a typed responses["200"] schema. Scanners credit only the
// inline 200 (not 202 / 2XX), so an always-202 enqueue or a webhook that only
// documents 2XX reads as "partially documented".

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

function schemaIsTyped(schema) {
  if (!schema || typeof schema !== 'object') return false;
  return Boolean(
    schema.type
    || schema.$ref
    || schema.anyOf
    || schema.oneOf
    || schema.allOf
    || schema.properties,
  );
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
  assert.ok(operations.length > 0, `${label}: expected published operations`);

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
    for (const [index, param] of parameters.entries()) {
      if (!param) {
        issues.push(`${opLabel}: parameters[${index}] is a dangling $ref`);
        continue;
      }
      if (!schemaIsTyped(param.schema)) {
        issues.push(`${opLabel}: parameter ${param.name ?? index} is untyped`);
      }
    }

    const requestSchema = operation.requestBody?.content?.['application/json']?.schema;
    const typedInput = parameters.length > 0 || schemaIsTyped(requestSchema);
    if (!typedInput) issues.push(`${opLabel}: no typed parameters or requestBody`);
    if (operation.requestBody && !schemaIsTyped(requestSchema)) {
      issues.push(`${opLabel}: requestBody is untyped`);
    }

    const ok = operation.responses?.['200'];
    if (!ok) {
      const other2xx = Object.keys(operation.responses ?? {}).filter((code) => /^2/.test(code));
      issues.push(`${opLabel}: missing responses["200"] (has ${other2xx.join(',') || 'no 2xx'})`);
      continue;
    }
    if (!schemaIsTyped(ok.content?.['application/json']?.schema)) {
      issues.push(`${opLabel}: responses["200"] has no typed application/json schema`);
    }
  }

  for (const [operationId, sites] of ids) {
    if (sites.length > 1) issues.push(`${label}: duplicate operationId ${operationId} at ${sites.join('; ')}`);
  }

  assert.deepEqual(issues, [], issues.join('\n'));
}

describe('OpenAPI self-describing operations (orank api-schema-analysis)', () => {
  it('gives every unified-bundle path and webhook a unique id, description, typed input, and typed 200', () => {
    assertSelfDescribing(loadUnifiedOpenApiSpec(), 'worldmonitor.openapi.yaml');
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
