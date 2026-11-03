// Minimal MCP `JSONRPCMessage` union validator (spec schema 2025-03-26 /
// 2025-06-18), written against the schema rather than against our handler:
//
//   RequestId      = string | number          (NEVER null)
//   JSONRPCError   = { jsonrpc: "2.0", id: RequestId, error: { code: number,
//                      message: string, data?: unknown } }
//
// It exists because the failure this guards against is a CLIENT-side schema
// failure: an MCP client parses the response through the union above, and an
// `id: null` error envelope matches no member — the client reports
// `invalid_union` plus `Invalid input: expected string, received null` at `id`
// and cannot correlate the denial with its pending request (issue #7818).
// Asserting `body.id === 42` alone would not reproduce that; the union rule is
// what the client actually applies, so the union rule is what we encode.
//
// Deliberately hand-written and tiny: the repo carries no MCP SDK dependency,
// and pulling one in to check four fields would be new test infrastructure for
// a boundary existing tests can already reach.
import { strict as assert } from 'node:assert';

/** The spec's `RequestId`: a string or a number, and nothing else. */
export function isValidRequestId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

/**
 * Assert `body` is a spec-valid `JSONRPCError` carrying `expectedId`.
 * `expectedId` is compared with `Object.is` so a numeric id is never accepted
 * in string form and `0` cannot pass as `-0`.
 */
export function assertJsonRpcError(body, { id: expectedId, code, label = 'response' } = {}) {
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${label}: not a JSON-RPC object`);
  assert.equal(body.jsonrpc, '2.0', `${label}: jsonrpc must be "2.0"`);
  assert.equal('result' in body, false, `${label}: an error envelope must not also carry result`);
  assert.ok(
    isValidRequestId(body.id),
    `${label}: id must satisfy the spec RequestId union (string | number); got ${JSON.stringify(body.id)} — `
      + 'this is the exact `invalid_union` / "expected string, received null" failure MCP clients report',
  );
  if (expectedId !== undefined) {
    assert.ok(
      Object.is(body.id, expectedId),
      `${label}: id must echo the request id ${JSON.stringify(expectedId)}, got ${JSON.stringify(body.id)}`,
    );
  }
  assert.ok(body.error && typeof body.error === 'object', `${label}: error member missing`);
  assert.equal(typeof body.error.code, 'number', `${label}: error.code must be a number`);
  assert.equal(typeof body.error.message, 'string', `${label}: error.message must be a string`);
  if (code !== undefined) assert.equal(body.error.code, code, `${label}: unexpected error code`);
}

/**
 * Assert `body` is a spec-valid `JSONRPCResponse` (the success member of the
 * same union) carrying `expectedId`.
 */
export function assertJsonRpcResult(body, { id: expectedId, label = 'response' } = {}) {
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${label}: not a JSON-RPC object`);
  assert.equal(body.jsonrpc, '2.0', `${label}: jsonrpc must be "2.0"`);
  assert.equal('error' in body, false, `${label}: a result envelope must not also carry error`);
  assert.ok(isValidRequestId(body.id), `${label}: id must satisfy the spec RequestId union; got ${JSON.stringify(body.id)}`);
  if (expectedId !== undefined) {
    assert.ok(Object.is(body.id, expectedId), `${label}: id must echo the request id ${JSON.stringify(expectedId)}`);
  }
  assert.ok(body.result && typeof body.result === 'object', `${label}: result member missing`);
}
