import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  projectJsonResponse,
  REST_JMESPATH_MAX_EXPR_BYTES,
  REST_JMESPATH_MAX_OUTPUT_BYTES,
} from '../server/_shared/response-projection.ts';

// Unit coverage for the REST gateway's universal `?jmespath=` projection helper
// (server/gateway.ts applies it to every JSON GET response). Mirrors the MCP
// jmespath contract (api/mcp/jmespath.ts): projects on success, returns a
// {_jmespath_error, original_keys} envelope on failure, never throws.

const BODY = JSON.stringify({ compositeScore: 42, compositeLabel: 'Greed', nested: { a: 1 } });

describe('projectJsonResponse', () => {
  it('projects a scalar field', () => {
    const r = projectJsonResponse(BODY, 'compositeScore');
    assert.deepEqual(r, { ok: true, body: '42' });
  });

  it('projects an object subtree', () => {
    const r = projectJsonResponse(BODY, 'nested');
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(r.body), { a: 1 });
  });

  it('supports keys(@) — the advertised example', () => {
    const r = projectJsonResponse(BODY, 'keys(@)');
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(r.body), ['compositeScore', 'compositeLabel', 'nested']);
  });

  it('returns JSON null when a path misses (never a bare undefined)', () => {
    const r = projectJsonResponse(BODY, 'doesNotExist');
    assert.deepEqual(r, { ok: true, body: 'null' });
  });

  it('returns an error envelope for an invalid expression', () => {
    const r = projectJsonResponse(BODY, 'a[[[');
    assert.equal(r.ok, false);
    assert.match(r.envelope._jmespath_error, /^invalid_expression:/);
    assert.deepEqual(r.envelope.original_keys, ['compositeScore', 'compositeLabel', 'nested']);
  });

  it('rejects an over-long expression before parsing', () => {
    const expr = 'a'.repeat(REST_JMESPATH_MAX_EXPR_BYTES + 1);
    const r = projectJsonResponse(BODY, expr);
    assert.equal(r.ok, false);
    assert.match(r.envelope._jmespath_error, /^expression_too_long:/);
  });

  it('rejects a projection that expands beyond the REST output cap', () => {
    const body = JSON.stringify({ blob: 'x'.repeat(Math.ceil(REST_JMESPATH_MAX_OUTPUT_BYTES / 2)) });
    const r = projectJsonResponse(body, '[@,@,@]');
    assert.equal(r.ok, false);
    assert.match(r.envelope._jmespath_error, /^projection_too_large:/);
    assert.deepEqual(r.envelope.original_keys, ['blob']);
  });

  it('passes an unparseable body through unchanged (never 400s on our own bug)', () => {
    const notJson = 'not-json<html>';
    const r = projectJsonResponse(notJson, 'compositeScore');
    assert.deepEqual(r, { ok: true, body: notJson });
  });

  it('reports an array shape in original_keys', () => {
    const r = projectJsonResponse('[1,2,3]', 'a[[[');
    assert.equal(r.ok, false);
    assert.deepEqual(r.envelope.original_keys, ['<array length=3>']);
  });
});
