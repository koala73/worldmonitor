// #8721 phase 5: every MCP JSON-RPC error carries `error.data.requestId`, the
// same `x-vercel-id` the wm_api_usage row records as `request_id`, so an agent
// can quote the failing call and a report joins to its usage row. Successful
// results stay byte-identical, and an existing `data` payload keeps its fields.
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpHandler } from '../api/mcp/handler.ts';
import { attachRequestIdToErrors } from '../api/mcp/request-id.ts';
import { HMAC_SECRET, PRO_BEARER, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
const REQUEST_ID = 'fra1::iad1::abc12-1730000000000-0123456789ab';
const MODERN = '2026-07-28';
const PV_KEY = 'io.modelcontextprotocol/protocolVersion';

function headers(extra = {}) {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${PRO_BEARER}`,
    'x-vercel-id': REQUEST_ID,
    ...extra,
  };
}

async function post(body, extraHeaders = {}) {
  const { deps } = makeProDeps();
  const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
    method: 'POST',
    headers: headers(extraHeaders),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), deps);
  const text = await res.text();
  const isJson = /application\/json/.test(res.headers.get('content-type') ?? '');
  return { res, text, json: text && isJson ? JSON.parse(text) : null };
}

function modernBody(id, method, params = {}) {
  return {
    jsonrpc: '2.0', id, method,
    params: {
      ...params,
      _meta: {
        [PV_KEY]: MODERN,
        'io.modelcontextprotocol/clientInfo': { name: 'rid-test', version: '1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

describe('MCP error envelopes carry data.requestId', () => {
  beforeEach(() => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  it('adds it to a legacy parse error', async () => {
    const { json } = await post('{not json');
    assert.equal(json.error.code, -32700);
    assert.equal(json.error.data.requestId, REQUEST_ID);
  });

  it('adds it to a legacy method-not-found error', async () => {
    const { json } = await post({ jsonrpc: '2.0', id: 7, method: 'no/such' });
    assert.equal(json.id, 7);
    assert.ok(json.error, JSON.stringify(json));
    assert.equal(json.error.data.requestId, REQUEST_ID);
  });

  it('adds it to a legacy session error framed as SSE', async () => {
    const { res, text } = await post({ jsonrpc: '2.0', id: 9, method: 'no/such' }, { 'Mcp-Session-Id': 'session-rid-test' });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const data = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    const json = JSON.parse(data);
    assert.equal(json.id, 9);
    assert.equal(json.error.data.requestId, REQUEST_ID);
  });

  it('adds it to a modern-era error, after modern shaping', async () => {
    process.env.MCP_PROTOCOL_2026_07_28 = 'on';
    const { json } = await post(modernBody(3, 'no/such'), { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'no/such' });
    assert.ok(json.error, JSON.stringify(json));
    assert.equal(json.error.data.requestId, REQUEST_ID);
  });

  it('leaves a successful result unchanged', async () => {
    const { json, text } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(Array.isArray(json.result?.tools));
    assert.equal(text.includes('requestId'), false);
  });

  it('omits the field when the platform sent no request id', async () => {
    const { deps } = makeProDeps();
    const h = headers();
    delete h['x-vercel-id'];
    const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: h, body: '{not json',
    }), deps);
    const json = await res.json();
    assert.equal(json.error.code, -32700);
    assert.equal(json.error.data?.requestId, undefined);
  });
});

describe('attachRequestIdToErrors', () => {
  const jsonRes = (body, init = {}) => new Response(JSON.stringify(body), {
    status: 400, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

  it('merges into an existing data object without dropping its fields', async () => {
    const res = await attachRequestIdToErrors(jsonRes({
      jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad', data: { violations: [{ field: 'x' }] } },
    }), REQUEST_ID);
    const json = await res.json();
    assert.deepEqual(json.error.data, { violations: [{ field: 'x' }], requestId: REQUEST_ID });
  });

  it('never overwrites a requestId already present', async () => {
    const res = await attachRequestIdToErrors(jsonRes({
      jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x', data: { requestId: 'upstream' } },
    }), REQUEST_ID);
    assert.equal((await res.json()).error.data.requestId, 'upstream');
  });

  it('leaves a non-object data value alone', async () => {
    const res = await attachRequestIdToErrors(jsonRes({
      jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x', data: 'detail' },
    }), REQUEST_ID);
    assert.equal((await res.json()).error.data, 'detail');
  });

  it('handles each error in a batch array', async () => {
    const res = await attachRequestIdToErrors(jsonRes([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } },
    ]), REQUEST_ID);
    const json = await res.json();
    assert.equal(json[0].result.requestId, undefined);
    assert.equal(json[1].error.data.requestId, REQUEST_ID);
  });

  it('returns the same Response for non-JSON, bodiless, empty-id and success responses', async () => {
    const sse = new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    assert.equal(await attachRequestIdToErrors(sse, REQUEST_ID), sse);
    const empty = new Response(null, { status: 202, headers: { 'Content-Type': 'application/json' } });
    assert.equal(await attachRequestIdToErrors(empty, REQUEST_ID), empty);
    const err = jsonRes({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } });
    assert.equal(await attachRequestIdToErrors(err, ''), err);
    const ok = jsonRes({ jsonrpc: '2.0', id: 1, result: {} }, { status: 200 });
    const out = await attachRequestIdToErrors(ok, REQUEST_ID);
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { jsonrpc: '2.0', id: 1, result: {} });
  });

  it('keeps status and headers, and recomputes a declared Content-Length', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'é' } });
    const res = await attachRequestIdToErrors(new Response(body, {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'Retry-After': '60' },
    }), REQUEST_ID);
    const text = await res.text();
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(text)));
    assert.equal(JSON.parse(text).error.data.requestId, REQUEST_ID);
  });

  it('passes through a JSON body that does not parse, even one naming "error"', async () => {
    const original = new Response('{"error":', {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
    const res = await attachRequestIdToErrors(original, REQUEST_ID);
    assert.equal(res, original);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), '{"error":');
  });
});
