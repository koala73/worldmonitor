// Transport-layer MCP conformance. Unlike mcp-protocol-conformance.test.mjs,
// this suite binds the real handler to a localhost HTTP listener so socket,
// SSE, Last-Event-ID, and Mcp-Session-Id behavior are exercised on the wire.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import {
  HMAC_SECRET,
  PRO_BEARER,
  makeProDeps,
} from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };

function initBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'transport-test', version: '1.0' },
    },
  };
}

function rpcBody(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

function mcpHeaders(extra = {}) {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${PRO_BEARER}`,
    ...extra,
  };
}

async function readIncomingBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function webHeadersFromIncoming(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

async function startMcpServer(mcpHandler, deps) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncomingBody(incoming);
      const method = incoming.method ?? 'GET';
      const init = {
        method,
        headers: webHeadersFromIncoming(incoming),
      };
      if (method !== 'GET' && method !== 'HEAD' && body.byteLength > 0) {
        init.body = body;
        init.duplex = 'half';
      }

      const reqUrl = new URL(incoming.url ?? '/mcp', `http://${incoming.headers.host}`);
      const response = await mcpHandler(new Request(reqUrl, init), deps);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));

      if (!response.body) {
        outgoing.end();
        return;
      }

      Readable.fromWeb(response.body).pipe(outgoing);
    } catch (err) {
      outgoing.writeHead(500, { 'Content-Type': 'text/plain' });
      outgoing.end(err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server must expose a bound TCP address');

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function parseSseFrames(text) {
  return text
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.trim() !== '')
    .map((frame) => {
      const event = { id: '', data: '' };
      const dataLines = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('id:')) event.id = line.slice(3).trimStart();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      event.data = dataLines.join('\n');
      return event;
    });
}

async function readAllSseEvents(response) {
  return parseSseFrames(await response.text());
}

async function readFirstSseEventAndDrop(response, controller) {
  assert.ok(response.body, 'SSE response must expose a readable body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.search(/\r?\n\r?\n/);
    if (boundary !== -1) {
      const separator = buffer.match(/\r?\n\r?\n/);
      assert.ok(separator, 'SSE frame separator must be present');
      const firstFrame = buffer.slice(0, boundary);
      await reader.cancel();
      controller.abort();
      return parseSseFrames(`${firstFrame}\n\n`)[0];
    }
  }

  assert.fail(`SSE stream ended before the first event: ${buffer}`);
}

describe('api/mcp.ts — transport conformance over real HTTP', () => {
  let mcpHandler;
  let deps;
  let server;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
    deps = makeProDeps().deps;
    server = await startMcpServer(mcpHandler, deps);
  });

  afterEach(async () => {
    if (server) await server.close();
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('streams initialize over POST and resumes the dropped stream after Last-Event-ID', async () => {
    const controller = new AbortController();
    const initialize = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify(initBody(1)),
      signal: controller.signal,
    });

    assert.equal(initialize.status, 200);
    assert.match(initialize.headers.get('content-type') ?? '', /text\/event-stream/i);

    const sessionId = initialize.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize SSE response must emit Mcp-Session-Id');
    assert.match(initialize.headers.get('access-control-expose-headers') ?? '', /\bMcp-Session-Id\b/);

    const priming = await readFirstSseEventAndDrop(initialize, controller);
    assert.ok(priming.id, 'priming SSE event must carry an id for Last-Event-ID reconnect');
    assert.equal(priming.data, '', 'priming SSE event must carry an empty data field');

    const replay = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': priming.id,
      },
    });

    assert.equal(replay.status, 200);
    assert.match(replay.headers.get('content-type') ?? '', /text\/event-stream/i);

    const replayed = await readAllSseEvents(replay);
    assert.equal(replayed.length, 1, 'resume after the priming event must replay only later events');
    assert.notEqual(replayed[0].id, priming.id, 'resume must not duplicate the acknowledged event');

    const body = JSON.parse(replayed[0].data);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result?.protocolVersion, '2025-03-26');
    assert.equal(body.result?.serverInfo?.name, 'worldmonitor');

    const wrongSession = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': crypto.randomUUID(),
        'Last-Event-ID': priming.id,
      },
    });
    assert.equal(wrongSession.status, 404, 'a different session must not replay this stream');
    assert.match(
      (await wrongSession.json()).error?.message ?? '',
      /different server instance/,
      '404 replay miss must hint at cross-instance in-memory buffer misses',
    );

    deps.validateProMcpToken = async () => null;
    const revoked = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': priming.id,
      },
    });
    assert.equal(revoked.status, 401, 'GET replay must revalidate the Pro token before serving buffered events');
    assert.equal((await revoked.json()).error?.code, -32001);
  });

  it('uses replay-specific status codes for malformed GET replay requests', async () => {
    const missingAccept = await fetch(server.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': crypto.randomUUID(),
        'Last-Event-ID': 'stream:0',
      },
    });

    assert.equal(missingAccept.status, 406);
    assert.equal(missingAccept.headers.get('allow'), null, 'GET replay header errors must not advertise Allow');
    assert.match((await missingAccept.json()).error?.message ?? '', /Accept: text\/event-stream/);

    const missingLastEventId = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': crypto.randomUUID(),
      },
    });

    assert.equal(missingLastEventId.status, 400);
    assert.equal(missingLastEventId.headers.get('allow'), null, 'GET replay header errors must not advertise Allow');
    assert.match((await missingLastEventId.json()).error?.message ?? '', /Missing Last-Event-ID/);
  });

  it('accepts the initialized Mcp-Session-Id on a follow-up POST stream', async () => {
    const initialize = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify(initBody(10)),
    });
    const initializeEvents = await readAllSseEvents(initialize);
    const sessionId = initialize.headers.get('mcp-session-id');

    assert.ok(sessionId, 'initialize must emit a session id');
    assert.equal(initializeEvents.length, 2, 'initialize stream should include priming and response events');

    const ping = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders({ 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify(rpcBody(11, 'ping')),
    });

    assert.equal(ping.status, 200);
    assert.match(ping.headers.get('content-type') ?? '', /text\/event-stream/i);

    const pingEvents = await readAllSseEvents(ping);
    assert.equal(pingEvents.length, 2, 'follow-up session request should stream priming and response events');
    assert.equal(pingEvents[0].data, '');

    const pingBody = JSON.parse(pingEvents[1].data);
    assert.equal(pingBody.id, 11);
    assert.deepEqual(pingBody.result, {});

    const replay = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': pingEvents[0].id,
      },
    });
    const replayed = await readAllSseEvents(replay);
    assert.equal(replayed.length, 1, 'session replay should resume after the follow-up priming event');
    assert.deepEqual(JSON.parse(replayed[0].data).result, {});
  });

  it('honors Accept q=0 and preserves CORS on streamed JSON-RPC errors', async () => {
    const initialize = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders({ Accept: 'application/json, text/event-stream;q=0' }),
      body: JSON.stringify(initBody(20)),
    });

    assert.equal(initialize.status, 200);
    assert.match(initialize.headers.get('content-type') ?? '', /application\/json/i);
    assert.doesNotMatch(initialize.headers.get('content-type') ?? '', /text\/event-stream/i);
    assert.match(initialize.headers.get('access-control-expose-headers') ?? '', /\bMcp-Session-Id\b/);

    const sessionId = initialize.headers.get('mcp-session-id');
    assert.ok(sessionId, 'JSON initialize response must still emit Mcp-Session-Id');
    assert.equal((await initialize.json()).result?.serverInfo?.name, 'worldmonitor');

    const error = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders({ 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify(rpcBody(21, 'unknown/method')),
    });

    assert.equal(error.status, 200);
    assert.match(error.headers.get('content-type') ?? '', /text\/event-stream/i);
    assert.equal(error.headers.get('access-control-allow-origin'), '*');
    assert.match(error.headers.get('access-control-expose-headers') ?? '', /\bMcp-Session-Id\b/);

    const events = await readAllSseEvents(error);
    assert.equal(events.length, 2, 'streamed JSON-RPC error should still use priming + response events');
    const errorBody = JSON.parse(events[1].data);
    assert.equal(errorBody.id, 21);
    assert.equal(errorBody.error?.code, -32601);
  });
});
