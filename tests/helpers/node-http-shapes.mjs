// Request/response shapes for driving a Vercel Node-runtime route handler
// (`handler(req, res)` with http.IncomingMessage / http.ServerResponse) and a
// fake `https.request` for the mcp-proxy pinned-transport seam — all without
// a network. Shared by tests/mcp-proxy*.test.mjs.
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

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

/**
 * Verbatim port of @vercel/node's `restoreBody`
 * (packages/node/src/serverless-functions/helpers.ts). With helpers enabled —
 * the default for Node functions — the platform buffers the whole request
 * body BEFORE the handler runs, then re-exposes it through a PassThrough that
 * intercepts exactly `req.on('data' | 'end')` (and `req.read`). Every other
 * stream surface (`'readable'`, `'close'`, `pause()`, `resume()`,
 * `stream.finished()`) still points at the original, already-consumed
 * IncomingMessage. Apply this after draining `req` to reproduce production.
 */
export function applyVercelHelpersBodyShim(req, body) {
  const replicateBody = new PassThrough();
  const on = replicateBody.on.bind(replicateBody);
  const originalOn = req.on.bind(req);
  req.read = replicateBody.read.bind(replicateBody);
  req.on = req.addListener = (name, cb) =>
    (name === 'data' || name === 'end' ? on(name, cb) : originalOn(name, cb));
  replicateBody.write(body);
  replicateBody.end();
}

function responseHeadersFromRecorder(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * Drive a Node-style `(req, res)` handler with a fetch `Request` and return
 * the written response as a fetch `Response`. Lets a suite written against
 * the Web signature exercise the Node adapter on every call: the URL is
 * rebuilt from `host` / `x-forwarded-proto`, headers arrive as a plain
 * object, and the body arrives as Node stream chunks.
 */
export async function invokeNodeHandler(handler, request, { proto = 'https' } = {}) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers) headers[name] = value;
  headers.host ??= url.host;
  headers['x-forwarded-proto'] ??= proto;
  const body = request.body ? [Buffer.from(await request.arrayBuffer())] : [];
  const req = makeIncomingMessage({
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    body,
  });
  const { res, state } = makeServerResponse();
  await handler(req, res);
  const status = state.statusCode ?? res.statusCode;
  const payload = Buffer.concat(
    [...state.writes, ...state.endPayloads].map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))),
  );
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : payload, {
    status,
    headers: responseHeadersFromRecorder(state.headers),
  });
}

function nodeStyleAbortError(reason) {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  error.cause = reason;
  return error;
}

/**
 * Fake `https.request` for the mcp-proxy node-request seam
 * (`Symbol.for('worldmonitor.mcpProxy.nodeRequestForTest')`). Runs the
 * request's `lookup` hook exactly like net.connect would (recording the
 * address it pins to in `seen`), then serves the upstream response from
 * `fetchImpl()` — the same `globalThis.fetch` mocks the suite already uses
 * for MCP servers — so the module's real transport code (option assembly,
 * lookup, response bridging, abort mapping) runs on every upstream call.
 */
export function makeFakeNodeRequest({ fetchImpl = () => globalThis.fetch, seen = [] } = {}) {
  return (options, onResponse) => {
    const req = new EventEmitter();
    const chunks = [];
    let destroyed = false;
    let incoming = null;
    const signal = options.signal;

    req.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    req.setTimeout = () => req;
    req.destroy = (error) => {
      if (destroyed) return req;
      destroyed = true;
      if (incoming) incoming.destroy(error);
      else if (error) queueMicrotask(() => req.emit('error', error));
      return req;
    };

    const onAbort = () => req.destroy(nodeStyleAbortError(signal.reason));
    if (signal) {
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    req.end = () => {
      options.lookup(options.hostname, { family: options.family }, async (error, address, family) => {
        if (error) {
          req.destroy(error);
          return;
        }
        const port = options.port && String(options.port) !== '443' ? `:${options.port}` : '';
        const url = `https://${options.hostname}${port}${options.path}`;
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
        seen.push({ options, address, family, body });
        let response;
        try {
          response = await fetchImpl()(url, {
            method: options.method,
            headers: options.headers,
            body,
            redirect: 'manual',
            signal,
          });
        } catch (err) {
          if (!destroyed) req.destroy(err);
          return;
        }
        if (destroyed) return;
        incoming = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
        incoming.statusCode = response.status;
        incoming.statusMessage = response.statusText;
        incoming.headers = {};
        for (const [name, value] of response.headers) incoming.headers[name] = value;
        onResponse(incoming);
      });
    };

    return req;
  };
}

/**
 * Minimal MCP server for the fake transport: answers initialize / tools/list
 * / tools/call over streamable HTTP with plain JSON-RPC responses.
 */
export function makeMcpFetch({ initStatus = 200, listStatus = 200, callStatus = 200, tools = [], callResult = { content: [] } } = {}) {
  return async (_url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body.method === 'initialize' || body.method === 'notifications/initialized') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }), {
        status: initStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.method === 'tools/list') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }), {
        status: listStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.method === 'tools/call') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: callResult }), {
        status: callStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}
