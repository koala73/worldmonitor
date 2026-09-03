// RUN WITH: `npm run test:data` OR `npx tsx --test tests/mcp-proxy-node-entry.test.mjs`.
//
// Guard for the #4749 -> #4754 revert. On Vercel's Node runtime a
// default-exported function is invoked as `handler(req, res)` with a raw
// `http.IncomingMessage` / `http.ServerResponse` pair (@vercel/node
// serverless-handler: `return listener(req, res)`). The Web
// `(request: Request) => Response` signature is only dispatched for named
// GET/POST/... exports. #4749 declared `runtime: 'nodejs'` but kept the Web
// signature, so `req.headers.get()` threw on every request in production;
// `tests/mcp-proxy.test.mjs` never noticed because it hands the handler a
// `Request` object. This file drives the route's default export exactly the
// way the platform does — plain headers OBJECT, `method`, `url`, and a Node
// readable body — so the mismatch cannot ship again.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';

// The route imports server/_shared/premium-check, which loads api/_session.js
// at module scope; that module throws without a session secret.
process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';

/**
 * IncomingMessage-shaped request: a Node Readable carrying the raw body
 * chunks, with `method`, `url` (path + query, as Vercel passes it) and a
 * plain, lowercase-keyed `headers` object. Deliberately NOT a `Request` and
 * NOT a `Headers` instance.
 */
export function makeIncomingMessage({ method, url, headers = {}, body = [] }) {
  const chunks = body.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.httpVersion = '1.1';
  return req;
}

/**
 * ServerResponse-shaped recorder. Captures the status, headers, every
 * `write()` chunk and every `end()` payload so a test can assert that a
 * null-body status (204) is finished with `end()` and no body bytes at all.
 */
export function makeServerResponse() {
  const state = {
    statusCode: null,
    headers: {},
    writes: [],
    endPayloads: [],
    ended: false,
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
      return res;
    },
    getHeader(name) {
      return state.headers[String(name).toLowerCase()];
    },
    removeHeader(name) {
      delete state.headers[String(name).toLowerCase()];
    },
    writeHead(statusCode, reasonOrHeaders, maybeHeaders) {
      const headers = typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null
        ? reasonOrHeaders
        : maybeHeaders;
      state.statusCode = statusCode;
      res.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value);
      res.headersSent = true;
      return res;
    },
    write(chunk) {
      state.writes.push(chunk);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) state.endPayloads.push(chunk);
      if (state.statusCode === null) state.statusCode = res.statusCode;
      state.ended = true;
      return res;
    },
  };
  return { res, state };
}

describe('api/mcp-proxy Node runtime entry point (guard for #4749 / #4754)', () => {
  it('is not declared as an Edge function — the (req, res) contract below only holds on the Node runtime', async () => {
    const mod = await import('../api/mcp-proxy.ts');
    assert.notEqual(
      mod.config?.runtime,
      'edge',
      'api/mcp-proxy.ts must run on the Node runtime (socket pinning needs node:https)',
    );
  });

  it('answers an OPTIONS preflight from a raw IncomingMessage/ServerResponse pair with 204 and no body', async () => {
    const mod = await import('../api/mcp-proxy.ts');
    const handler = mod.default;
    assert.equal(typeof handler, 'function');

    const req = makeIncomingMessage({
      method: 'OPTIONS',
      url: '/api/mcp-proxy',
      headers: {
        host: 'worldmonitor.app',
        'x-forwarded-proto': 'https',
        origin: 'https://worldmonitor.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-worldmonitor-key',
      },
    });
    const { res, state } = makeServerResponse();

    // #4749's shape rejects here: `req.headers.get is not a function`.
    await handler(req, res);

    assert.equal(state.statusCode, 204, 'preflight must answer 204');
    assert.equal(state.ended, true, 'the response must be finished with res.end()');
    assert.deepEqual(state.writes, [], 'a 204 must not write body chunks');
    assert.deepEqual(state.endPayloads, [], 'a 204 must be ended without a payload (writing to a null-body status is a protocol error)');
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.equal(state.headers['access-control-allow-origin'], 'https://worldmonitor.app');
    assert.match(String(state.headers['access-control-allow-methods']), /OPTIONS/);
  });
});
