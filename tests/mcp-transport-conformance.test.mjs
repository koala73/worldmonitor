// Transport-layer MCP conformance. Unlike mcp-protocol-conformance.test.mjs,
// this suite binds the real handler to a localhost HTTP listener so socket,
// SSE, Last-Event-ID, and Mcp-Session-Id behavior are exercised on the wire.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
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

  it('streams initialize as a single JSON-RPC event and guards the Last-Event-ID replay channel', async () => {
    const initialize = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify(initBody(1)),
    });

    assert.equal(initialize.status, 200);
    assert.match(initialize.headers.get('content-type') ?? '', /text\/event-stream/i);

    const sessionId = initialize.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize SSE response must emit Mcp-Session-Id');
    assert.match(initialize.headers.get('access-control-expose-headers') ?? '', /\bMcp-Session-Id\b/);

    // The stream carries EXACTLY ONE event and it is the JSON-RPC result — there
    // is no leading empty-`data:` priming event (a strict handshake scanner
    // reads the first event and JSON.parse()s its data; an empty first event is
    // scored as a failed handshake — see the dedicated guard test below).
    const events = await readAllSseEvents(initialize);
    assert.equal(events.length, 1, 'initialize stream must be a single result event (no priming event)');
    const resultEvent = events[0];
    assert.ok(resultEvent.id, 'result SSE event must carry an id for the Last-Event-ID replay channel');

    const body = JSON.parse(resultEvent.data);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result?.protocolVersion, '2025-03-26');
    assert.equal(body.result?.serverInfo?.name, 'worldmonitor');

    // Resuming after the only event yields an empty stream (nothing follows the
    // delivered response), but the replay channel still authenticates and stays
    // session-scoped.
    const replay = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': resultEvent.id,
      },
    });

    assert.equal(replay.status, 200);
    assert.match(replay.headers.get('content-type') ?? '', /text\/event-stream/i);

    const replayed = await readAllSseEvents(replay);
    assert.equal(replayed.length, 0, 'resume after the sole delivered event must replay nothing');

    const wrongSession = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': crypto.randomUUID(),
        'Last-Event-ID': resultEvent.id,
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
        'Last-Event-ID': resultEvent.id,
      },
    });
    assert.equal(revoked.status, 401, 'GET replay must revalidate the Pro token before serving buffered events');
    assert.equal((await revoked.json()).error?.code, -32001);
  });

  it('emits the JSON-RPC result as the FIRST SSE event so strict handshake scanners parse it', async () => {
    // orank's `mcp-server` handshake check (and any non-SDK scanner) reads the
    // FIRST SSE event of a POST initialize and JSON.parse()s its `data`. A
    // leading empty-`data:` priming event dispatches a `message` with
    // `data === ''` (WHATWG SSE spec still fires the event), so `JSON.parse('')`
    // throws and the handshake is scored as failed — this was orank Access
    // `mcp-server` 3/6 while every other MCP check passed. Guard that the first
    // event is the real, non-empty JSON-RPC result.
    const initialize = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify(initBody(30)),
    });
    assert.equal(initialize.status, 200);
    assert.match(initialize.headers.get('content-type') ?? '', /text\/event-stream/i);

    const events = await readAllSseEvents(initialize);
    assert.ok(events.length >= 1, 'stream must contain at least one event');

    const first = events[0];
    assert.notEqual(first.data, '', 'the FIRST SSE event must not be an empty-data priming event');
    const parsed = JSON.parse(first.data); // must not throw — this is the orank handshake invariant
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 30);
    assert.equal(parsed.result?.serverInfo?.name, 'worldmonitor');
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

    // A GET WITHOUT Last-Event-ID is NOT a malformed replay — it is a client
    // opening the OPTIONAL standalone server->client SSE stream. This route
    // offers none, so the MCP Streamable HTTP spec requires 405 Method Not
    // Allowed (MCP SDK clients treat 405 as the graceful "no standalone stream"
    // signal and complete the handshake). Unlike the replay-specific 400/406
    // header errors, a 405 MUST advertise Allow (RFC 9110 §15.5.6).
    const bareGetNoStream = await fetch(server.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': crypto.randomUUID(),
      },
    });

    assert.equal(bareGetNoStream.status, 405);
    assert.match(bareGetNoStream.headers.get('allow') ?? '', /\bPOST\b/, '405 must advertise Allow (RFC 9110 §15.5.6)');
  });

  it('answers a bare GET (standalone SSE stream open) with 405 even when unauthenticated', async () => {
    // The exact agent-readiness-scanner / SDK path: the transport opens the
    // optional standalone GET SSE stream with `resumptionToken: undefined` (no
    // Last-Event-ID) and no credentials during connect(). It MUST see 405, not
    // 401 — a 401 here surfaces as `Failed to open SSE stream: Unauthorized` and
    // is reported as a failed protocol handshake.
    const bareGet = await fetch(server.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });

    assert.equal(bareGet.status, 405, 'unauthenticated standalone SSE-stream open must be 405, never 401');
    assert.match(bareGet.headers.get('allow') ?? '', /\bPOST\b/, '405 must advertise Allow (RFC 9110 §15.5.6)');
    assert.equal(bareGet.headers.get('access-control-allow-origin'), '*', 'CORS preserved on the 405');
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
    assert.equal(initializeEvents.length, 1, 'initialize stream is a single result event');

    const ping = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders({ 'Mcp-Session-Id': sessionId }),
      body: JSON.stringify(rpcBody(11, 'ping')),
    });

    assert.equal(ping.status, 200);
    assert.match(ping.headers.get('content-type') ?? '', /text\/event-stream/i);

    const pingEvents = await readAllSseEvents(ping);
    assert.equal(pingEvents.length, 1, 'follow-up session request streams a single result event');

    const pingBody = JSON.parse(pingEvents[0].data);
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
    assert.equal(replayed.length, 0, 'resume after the sole follow-up event replays nothing');
  });

  it('completes the handshake for browser clients from ANY origin (issue #4802)', async () => {
    // The endpoint advertises `access-control-allow-origin: *`, so the preflight
    // succeeds for every origin — the actual POST must not then be rejected by an
    // Origin allowlist. Auth is API-key/Bearer (no cookies), so a cross-origin
    // browser request carries no ambient credentials and there is no CSRF surface;
    // MCP-spec Origin validation targets DNS rebinding against localhost servers,
    // not public HTTPS endpoints. Regression: a claude.ai/claude.com-only allowlist
    // 403'd ChatGPT web connectors, MCP Inspector (localhost origin), and every
    // other browser-context client AFTER their preflight had already succeeded.
    for (const origin of ['https://chatgpt.com', 'http://localhost:3000', 'https://ora.ai']) {
      // The exact browser flow the bug broke: preflight succeeds (204 + wildcard),
      // then the actual POST must succeed too — not 403 after a green preflight.
      const preflight = await fetch(server.url, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      });
      assert.equal(preflight.status, 204, `OPTIONS preflight from ${origin} must be 204`);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

      // Accept: application/json returns a single complete JSON-RPC body (no open
      // SSE stream to drain), so the response settles immediately.
      const res = await fetch(server.url, {
        method: 'POST',
        headers: mcpHeaders({ Origin: origin, Accept: 'application/json' }),
        body: JSON.stringify(initBody(40)),
      });
      assert.equal(res.status, 200, `POST initialize with Origin: ${origin} must be 200, got ${res.status}`);
      assert.equal(res.headers.get('access-control-allow-origin'), '*',
        'CORS wildcard must hold on the actual response, not just preflight');
      // Load-bearing invariant that makes wildcard CORS safe here: /mcp must NEVER
      // pair `ACAO: *` with credentialed CORS. If a refactor swapped /mcp onto the
      // reflected-origin + Allow-Credentials helper, ambient-credential CSRF would
      // reopen on a now-gateless endpoint — pin it closed.
      assert.equal(res.headers.get('access-control-allow-credentials'), null,
        '/mcp must not emit Access-Control-Allow-Credentials alongside wildcard ACAO');
      assert.equal((await res.json()).result?.serverInfo?.name, 'worldmonitor',
        'foreign-origin POST must complete a real initialize, not just return 200');
    }
  });

  it('does not 403 the GET branches for a foreign origin either (issue #4802)', async () => {
    // The removed allowlist sat before method dispatch, so it previously 403'd GET
    // as well as POST. Both GET sub-paths must now reach their normal handling for
    // a browser origin — never the old pre-auth 403.
    const bareGet = await fetch(server.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Origin: 'https://chatgpt.com' },
    });
    assert.equal(bareGet.status, 405, 'bare GET from a foreign origin must be 405 (no standalone stream), not 403');
    assert.match(bareGet.headers.get('allow') ?? '', /\bPOST\b/);

    // A GET+Last-Event-ID without the required Accept is a replay header error
    // (406) — the point is it reaches replay validation instead of the old 403.
    const replay = await fetch(server.url, {
      method: 'GET',
      headers: {
        Origin: 'https://chatgpt.com',
        Authorization: `Bearer ${PRO_BEARER}`,
        'Mcp-Session-Id': crypto.randomUUID(),
        'Last-Event-ID': 'stream:0',
      },
    });
    assert.notEqual(replay.status, 403, 'foreign-origin SSE replay must reach the authed replay path, not a pre-auth 403');
    assert.equal(replay.status, 406, 'replay without Accept: text/event-stream is a 406 header error');
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
    assert.equal(events.length, 1, 'streamed JSON-RPC error is a single result event');
    const errorBody = JSON.parse(events[0].data);
    assert.equal(errorBody.id, 21);
    assert.equal(errorBody.error?.code, -32601);
  });
});

// ---------------------------------------------------------------------------
// /.well-known/mcp dual-role (manifest GET + live Streamable HTTP endpoint)
// ---------------------------------------------------------------------------
// vercel.json rewrites /.well-known/mcp into the same handler. Agent-readiness
// scanners (orank `mcp-server`) POST `initialize` AT the well-known URL — when
// a static file answered that with a bodyless 405, the check scored "MCP
// manifest found at /.well-known/mcp but protocol handshake failed" (3/6).
// GET keeps serving the server card so manifest fetchers are unaffected, and
// an SSE-flavored GET falls through to the endpoint's standalone-stream 405.
describe('api/mcp.ts — /.well-known/mcp dual-role alias', () => {
  let mcpHandler;
  let deps;
  let server;
  let aliasUrl;
  let staticFetchCalls;
  const realFetch = globalThis.fetch;
  const cardText = readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8');
  const guideText = readFileSync(new URL('../public/mcp-server.md', import.meta.url), 'utf8');

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}-wk`);
    mcpHandler = mod.mcpHandler;
    deps = makeProDeps().deps;
    server = await startMcpServer(mcpHandler, deps);
    aliasUrl = server.url.replace('/mcp', '/.well-known/mcp');
    staticFetchCalls = [];
    // The handler self-fetches the static card asset; the localhost harness
    // has no static file server, so serve the on-disk card for that one URL
    // and delegate everything else (including the test's own requests).
    globalThis.fetch = (input, init) => {
      const href = typeof input === 'string' ? input : input.url ?? String(input);
      if (href.endsWith('/.well-known/mcp/server-card.json')) {
        staticFetchCalls.push({ href, init });
        return Promise.resolve(new Response(cardText, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (href.endsWith('/mcp-server.md')) {
        staticFetchCalls.push({ href, init });
        return Promise.resolve(new Response(guideText, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
      }
      return realFetch(input, init);
    };
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (server) await server.close();
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('plain GET serves the server card (manifest role), even with a foreign Origin', async () => {
    const res = await fetch(aliasUrl, {
      headers: { Accept: 'application/json', Origin: 'https://ora.ai' },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/i);
    const card = await res.json();
    // Endpoint must be readable under EVERY manifest dialect scanners parse:
    // top-level `url` + `kind` (ora.ai /.well-known/mcp.json convention),
    // `serverUrl` (SEP-1649 server card), and registry-style `remotes`.
    assert.equal(card.url, 'https://worldmonitor.app/mcp');
    assert.equal(card.kind, 'product');
    assert.equal(card.serverUrl, 'https://worldmonitor.app/mcp');
    assert.equal(card.remotes?.[0]?.url, 'https://worldmonitor.app/mcp');
    const cardFetch = staticFetchCalls.find(({ href }) => href.endsWith('/.well-known/mcp/server-card.json'));
    assert.ok(cardFetch, 'server card must be loaded through the deployment self-fetch');
    assert.equal(
      new Headers(cardFetch.init?.headers).get('user-agent'),
      'WorldMonitor-MCP/1.0 (+https://worldmonitor.app)',
      'server-side fetches must identify WorldMonitor to the deployment edge',
    );
    // The manifest is a static, immutable-per-deploy asset — it must stay
    // cacheable (it was `public, max-age=3600` as a static file). The MCP
    // no-store CORS bundle must NOT clobber that on the manifest GET, or every
    // discovery fetch (orank + every MCP client) re-hits the function.
    assert.match(res.headers.get('cache-control') ?? '', /max-age=3600/,
      'server card GET must be cacheable, not the endpoint no-store');
    assert.doesNotMatch(res.headers.get('cache-control') ?? '', /no-store/);
  });

  it('serves the card at the /.well-known/mcp.json alias too', async () => {
    const res = await fetch(`${aliasUrl}.json`, { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.equal(card.url, 'https://worldmonitor.app/mcp');
  });

  it('plain GET /mcp serves the human-readable server guide (crawler-accessible discovery)', async () => {
    const res = await fetch(server.url, {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    assert.equal(res.status, 200, 'a plain GET /mcp must not be the transport 405 (Search Console reads it as "cannot access")');
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/i);
    const body = await res.text();
    assert.match(body, /# World Monitor MCP Server/, 'must be the mcp-server.md guide, not the JSON card');
    assert.match(body, /https:\/\/worldmonitor\.app\/mcp/, 'guide must advertise the apex transport URL');
    assert.match(res.headers.get('link') ?? '', /<https:\/\/worldmonitor\.app\/mcp>;\s*rel="canonical"/,
      'discovery representation must declare the apex endpoint canonical');
  });

  it('redirects discovery reads when deployment static-asset self-fetches fail', async () => {
    // Import the implementation directly with a unique query so its module-scope
    // document caches start empty; api/mcp.ts re-exports a shared handler module.
    const fresh = await import(`../api/mcp/handler.ts?fallback=${Date.now()}-${Math.random()}`);
    const fallbackServer = await startMcpServer(fresh.mcpHandler, deps);
    const fallbackAliasUrl = fallbackServer.url.replace('/mcp', '/.well-known/mcp');
    const successfulStaticFetch = globalThis.fetch;

    globalThis.fetch = (input, init) => {
      const href = typeof input === 'string' ? input : input.url ?? String(input);
      if (href.endsWith('/.well-known/mcp/server-card.json')) {
        return Promise.reject(new Error('deployment self-fetch failed'));
      }
      if (href.endsWith('/mcp-server.md')) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return realFetch(input, init);
    };

    try {
      const cardFallback = await fetch(fallbackAliasUrl, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      assert.equal(cardFallback.status, 302);
      assert.equal(cardFallback.headers.get('location'), '/.well-known/mcp/server-card.json');
      assert.match(cardFallback.headers.get('vary') ?? '', /\bAccept\b(?!-)/i);
      assert.match(cardFallback.headers.get('vary') ?? '', /\bLast-Event-ID\b/i);

      const guideFallback = await fetch(fallbackServer.url, {
        headers: { Accept: 'text/html,*/*' },
        redirect: 'manual',
      });
      assert.equal(guideFallback.status, 302);
      assert.equal(guideFallback.headers.get('location'), '/mcp-server.md');
      assert.match(guideFallback.headers.get('vary') ?? '', /\bAccept\b(?!-)/i);
      assert.match(guideFallback.headers.get('vary') ?? '', /\bLast-Event-ID\b/i);

      const cardHeadFallback = await fetch(fallbackAliasUrl, {
        method: 'HEAD',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      assert.equal(cardHeadFallback.status, cardFallback.status);
      assert.equal(cardHeadFallback.headers.get('location'), cardFallback.headers.get('location'));

      const guideHeadFallback = await fetch(fallbackServer.url, {
        method: 'HEAD',
        headers: { Accept: 'text/html,*/*' },
        redirect: 'manual',
      });
      assert.equal(guideHeadFallback.status, guideFallback.status);
      assert.equal(guideHeadFallback.headers.get('location'), guideFallback.headers.get('location'));
    } finally {
      globalThis.fetch = successfulStaticFetch;
      await fallbackServer.close();
    }
  });

  // ── cache-key contract ────────────────────────────────────────────────────
  // Regression net for a bug reproduced on production: /.well-known/mcp served
  // a `public, max-age=3600` card with no Vary, and Vercel's edge (which keys
  // on URL alone) replayed that stored 200 to a subsequent
  // `Accept: text/event-stream` GET — handing an SDK client a JSON body where
  // the transport contract requires 405. Any cacheable discovery 200 on these
  // URLs MUST carry Vary; the transport URL must not be cacheable at all.
  it('server card 200 is cacheable ONLY because it varies on the negotiating headers', async () => {
    const res = await fetch(aliasUrl, { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=3600/,
      'server card GET must stay cacheable');
    const vary = res.headers.get('vary') ?? '';
    // `(?!-)` is load-bearing: `-` is a word boundary, so a naive /\bAccept\b/
    // also matches the `accept-encoding` an edge adds on its own — the check
    // would pass against an origin sending no Vary at all.
    assert.match(vary, /\bAccept\b(?!-)/i,
      'a cacheable 200 negotiated on Accept MUST Vary on Accept, or a shared cache serves it to an SSE GET');
    assert.match(vary, /\bLast-Event-ID\b/i,
      'the same URL branches on Last-Event-ID into authenticated replay — that must be part of the cache key too');
  });

  it('the /mcp transport URL never emits a cacheable 200 body', async () => {
    const res = await fetch(server.url, { headers: { Accept: '*/*' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/,
      '/mcp is the live transport URL — a stored 200 here can be replayed to an SSE or replay GET');
    assert.match(res.headers.get('vary') ?? '', /\bAccept\b(?!-)/i);
  });

  it('an SSE-flavoured GET /mcp still gets the transport 405, never the guide', async () => {
    const res = await fetch(server.url, { headers: { Accept: 'text/event-stream' } });
    assert.equal(res.status, 405, 'standalone SSE stream open must keep its graceful 405 signal');
    assert.match(res.headers.get('allow') ?? '', /\bPOST\b/);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/markdown/i);
  });

  it('classifies SSE Accept values case-insensitively and honors q=0', async () => {
    const mixedCaseSse = await fetch(server.url, { headers: { Accept: 'Text/Event-Stream' } });
    assert.equal(mixedCaseSse.status, 405, 'media types are case-insensitive, so mixed-case SSE remains transport');

    const rejectedSse = await fetch(server.url, { headers: { Accept: 'text/event-stream;q=0, text/html' } });
    assert.equal(rejectedSse.status, 200, 'q=0 explicitly rejects SSE and must select the discovery guide');
    assert.match(rejectedSse.headers.get('content-type') ?? '', /text\/markdown/i);
  });

  it('HEAD /mcp preserves discovery, stream-open, and replay GET semantics', async () => {
    const discovery = await fetch(server.url, { method: 'HEAD' });
    assert.equal(discovery.status, 200);
    assert.match(discovery.headers.get('content-type') ?? '', /text\/markdown/i,
      'HEAD must not claim application/json when GET returns markdown');
    assert.match(discovery.headers.get('cache-control') ?? '', /\bno-store\b/i);
    assert.match(discovery.headers.get('vary') ?? '', /\bAccept\b(?!-)/i);
    assert.match(discovery.headers.get('vary') ?? '', /\bLast-Event-ID\b/i);
    assert.match(discovery.headers.get('link') ?? '', /<https:\/\/worldmonitor\.app\/mcp>;\s*rel="canonical"/,
      'HEAD must retain the matching guide GET canonical link');

    const manifest = await fetch(aliasUrl, { method: 'HEAD', headers: { Accept: 'application/json' } });
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') ?? '', /application\/json/i);
    assert.match(manifest.headers.get('cache-control') ?? '', /max-age=3600/,
      'HEAD must advertise the matching manifest GET cache policy');
    assert.doesNotMatch(manifest.headers.get('cache-control') ?? '', /no-store/);
    assert.match(manifest.headers.get('vary') ?? '', /\bAccept\b(?!-)/i);
    assert.match(manifest.headers.get('vary') ?? '', /\bLast-Event-ID\b/i);

    const streamOpen = await fetch(server.url, {
      method: 'HEAD',
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(streamOpen.status, 405, 'HEAD must preserve the equivalent standalone-stream GET status');
    assert.match(streamOpen.headers.get('allow') ?? '', /\bPOST\b/);

    const replay = await fetch(server.url, {
      method: 'HEAD',
      headers: { Accept: 'application/json', 'Last-Event-ID': 'smoke-canary' },
    });
    assert.equal(replay.status, 401, 'HEAD must preserve the equivalent authenticated replay GET status');
    assert.match(replay.headers.get('www-authenticate') ?? '', /^Bearer\b/i);
  });

  it('advertises transport-aware HEAD through CORS preflight', async () => {
    const res = await fetch(server.url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://claude.ai',
        'Access-Control-Request-Method': 'HEAD',
        'Access-Control-Request-Headers': 'Last-Event-ID, Mcp-Session-Id',
      },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /\bHEAD\b/,
      'cross-origin replay-shaped HEAD must pass preflight');
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /\bLast-Event-ID\b/i);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /\bMcp-Session-Id\b/i);
  });

  it('POST initialize completes the live Streamable HTTP handshake at the well-known URL', async () => {
    const res = await fetch(aliasUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(initBody(31)),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result?.serverInfo?.name, 'worldmonitor');
    assert.ok(res.headers.get('mcp-session-id'), 'well-known endpoint role must mint a session like /mcp');
  });

  it('GET asking for text/event-stream falls through to the standalone-stream 405', async () => {
    const res = await fetch(aliasUrl, {
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 405);
    assert.match(res.headers.get('allow') ?? '', /\bPOST\b/);
  });
});
