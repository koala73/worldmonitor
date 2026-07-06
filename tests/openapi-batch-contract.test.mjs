/**
 * Contract test for the generic REST batch endpoint's published spec.
 *
 * Agent-readiness scanners (ora.ai / orank "REST batch / bulk endpoint")
 * look for a batch operation that accepts an ARRAY of operations in one
 * request, formally defined in the OpenAPI spec — resource-scoped batch
 * RPCs (get-aircraft-details-batch etc.) don't satisfy it. This test pins:
 *
 *   1. POST /api/batch/v1/execute exists in the unified bundle AND the
 *      per-service BatchService specs (a fresh `make generate` must keep it);
 *   2. the request schema is an array of operations bounded 1..N where N
 *      matches the handler's MAX_BATCH_OPERATIONS (drift guard, source-text
 *      extraction — same pattern as the other generated-vs-source guards);
 *   3. the per-result `body` schema stays a FREE-FORM object (a
 *      google.protobuf.Struct regression would document proto structural
 *      encoding — fields/numberValue — that the handler never returns);
 *   4. the published request example is runnable verbatim: its path must be
 *      a documented GET operation in the same bundle.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BATCH_PATH = '/api/batch/v1/execute';

const bundle = loadYaml(readFileSync(resolve(root, 'docs/api/worldmonitor.openapi.yaml'), 'utf8'));
const serviceJson = JSON.parse(readFileSync(resolve(root, 'docs/api/BatchService.openapi.json'), 'utf8'));
const serviceYaml = loadYaml(readFileSync(resolve(root, 'docs/api/BatchService.openapi.yaml'), 'utf8'));

const handlerSource = readFileSync(
  resolve(root, 'server/worldmonitor/batch/v1/execute-batch.ts'),
  'utf8',
);
const maxOpsMatch = handlerSource.match(/MAX_BATCH_OPERATIONS = (\d+)/);
assert.ok(maxOpsMatch, 'execute-batch.ts must declare MAX_BATCH_OPERATIONS');
const MAX_OPS = Number(maxOpsMatch[1]);

function resolveRef(spec, schema) {
  const ref = schema?.$ref;
  if (!ref) return schema;
  const name = decodeURIComponent(ref.slice('#/components/schemas/'.length));
  const resolved = spec.components?.schemas?.[name];
  assert.ok(resolved, `missing schema ref ${ref}`);
  return resolved;
}

describe('openapi batch endpoint contract', () => {
  for (const [label, spec] of [['bundle', bundle], ['BatchService.json', serviceJson], ['BatchService.yaml', serviceYaml]]) {
    it(`${label}: documents POST ${BATCH_PATH} accepting an array of operations`, () => {
      const post = spec.paths?.[BATCH_PATH]?.post;
      assert.ok(post, `${label} must document POST ${BATCH_PATH}`);
      assert.match(String(post.description ?? ''), /batch/i);

      const reqSchema = resolveRef(spec, post.requestBody?.content?.['application/json']?.schema);
      const operations = resolveRef(spec, reqSchema?.properties?.operations);
      assert.equal(operations?.type, 'array', 'operations must be an array');
      assert.equal(operations?.minItems, 1);
      assert.equal(operations?.maxItems, MAX_OPS, 'spec maxItems must match handler MAX_BATCH_OPERATIONS');

      const item = resolveRef(spec, operations.items);
      assert.ok(item?.properties?.path, 'operation items must carry a path property');
    });

    it(`${label}: keeps the per-result body a free-form object (no proto Struct encoding)`, () => {
      const post = spec.paths?.[BATCH_PATH]?.post;
      const resSchema = resolveRef(spec, post.responses?.['200']?.content?.['application/json']?.schema);
      const results = resolveRef(spec, resSchema?.properties?.results);
      const result = resolveRef(spec, results?.items);
      const body = resolveRef(spec, result?.properties?.body);
      assert.equal(body?.type, 'object');
      assert.equal(body?.properties, undefined, 'body must stay free-form — a Struct regression adds fields/numberValue properties agents never receive');
    });
  }

  it('bundle: the request example is runnable — its path is a documented GET operation', () => {
    const post = bundle.paths[BATCH_PATH].post;
    const example = post.requestBody?.content?.['application/json']?.example;
    const examplePath = example?.operations?.[0]?.path;
    assert.ok(typeof examplePath === 'string' && examplePath.startsWith('/api/'), 'example must carry an absolute API path');
    const pathname = examplePath.split('?')[0];
    const target = bundle.paths?.[pathname];
    assert.ok(target?.get, `example path ${pathname} must be a documented GET operation in the bundle`);
  });
});
