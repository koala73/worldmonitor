// #7099 — docker/redis-rest-proxy.mjs capped request bodies at 1MB and answered
// an over-cap body with `req.destroy()` and NO HTTP response. Two failures in one:
//
//   1. Every stock seeder may publish up to MAX_PAYLOAD_BYTES (5MB, see
//      scripts/_seed-utils.mjs) per key, and atomicPublish sends that payload as a
//      JSON *string* inside a command array — so the wire body is always LARGER
//      than the payload. 1MB was below every seeder's ceiling, not just the fire
//      seeder's; on a self-host install `wildfire:fires:v1` was never written.
//   2. Destroying the socket means the caller sees `write EPIPE` /
//      `other side closed` with no status, which reads as an UPSTREAM outage.
//      Six scheduled runs were misdiagnosed as a NASA FIRMS connectivity problem.
//
// The proxy connects to Redis and calls server.listen() as top-level side effects
// on import (and `redis` is only installed inside the container image), so it
// cannot be imported here — extract the real source of the body-limit helpers and
// eval them standalone, same as redis-rest-proxy-url-masking.test.mjs does for
// maskRedisUrl.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PAYLOAD_BYTES } from '../scripts/_seed-utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');

// Comments are stripped only for the wiring assertions, so a commented-out call
// site can never satisfy a "this is actually wired up" check. BOTH forms must go:
// leaving `/* ... */` intact would let a call site survive inside a block comment
// and still be counted — the exact vacuity this stripper exists to prevent. (It
// also drops the file's own JSDoc header, a second source of stray matches.)
const proxyCode = proxySrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const EXTRACTS = {
  checkAuthDeps: /const TOKEN = [^;]+;/,
  checkAuth: /function checkAuth\([\s\S]*?\n\}/,
  DEFAULT_MAX_BODY_BYTES: /const DEFAULT_MAX_BODY_BYTES = [^;]+;/,
  resolveMaxBodyBytes: /function resolveMaxBodyBytes\([\s\S]*?\n\}/,
  MAX_BODY_BYTES: /const MAX_BODY_BYTES = [^;]+;/,
  OVERSIZE_DRAIN_BYTES: /const OVERSIZE_DRAIN_BYTES = [^;]+;/,
  PayloadTooLargeError: /class PayloadTooLargeError extends Error \{[\s\S]*?\n\}/,
  readBody: /function readBody\([\s\S]*?\n\}/,
  respondError: /function respondError\([\s\S]*?\n\}/,
};

const sources = Object.fromEntries(
  Object.entries(EXTRACTS).map(([name, re]) => [name, proxySrc.match(re)?.[0]]),
);

function buildHelpers(env = {}) {
  const src = Object.values(sources).join('\n\n');
  const warnings = [];
  const fakeConsole = {
    warn: (...args) => warnings.push(args.join(' ')),
    log() {},
    error() {},
  };
  // eslint-disable-next-line no-new-func
  const helpers = new Function(
    'process',
    'console',
    'crypto',
    `${src}\nreturn { DEFAULT_MAX_BODY_BYTES, MAX_BODY_BYTES, OVERSIZE_DRAIN_BYTES, resolveMaxBodyBytes, PayloadTooLargeError, readBody, respondError, checkAuth };`,
  )({ env }, fakeConsole, crypto);
  return { ...helpers, warnings };
}

// The proxy has THREE body-reading POST routes — `/`, `/pipeline`, `/multi-exec`
// — and all three are live in production (server/_shared/redis.ts and
// scripts/_seed-utils.mjs batch through pipeline/multi-exec). The probe mirrors
// all three so a regression on any one of them fails behaviorally here, not just
// in a source scan. Body read through the real readBody, errors through the real
// respondError: anything the client observes here is what the container answers.
const BODY_ROUTES = ['/', '/pipeline', '/multi-exec'];

function startProbeServer({ limit, drainLimit, env } = {}) {
  const helpers = buildHelpers(env);
  // `useModuleDefaults` calls readBody(req) with NO size arguments, exactly as
  // docker/redis-rest-proxy.mjs's handlers do. Tests that inject limit/drainLimit
  // run fast but never execute the binding between the module constants and
  // runtime behaviour — so a one-line change to either constant could reintroduce
  // #7099 for every over-cap body while the suite stayed green.
  const useModuleDefaults = limit === undefined && drainLimit === undefined;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || !BODY_ROUTES.includes(req.url)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    try {
      const body = useModuleDefaults
        ? await helpers.readBody(req)
        : await helpers.readBody(
          req,
          limit ?? helpers.MAX_BODY_BYTES,
          drainLimit ?? helpers.OVERSIZE_DRAIN_BYTES,
        );
      res.writeHead(200);
      res.end(JSON.stringify({ result: 'OK', route: req.url, bytes: Buffer.byteLength(body, 'utf8') }));
    } catch (err) {
      helpers.respondError(res, err);
    }
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, helpers }));
  });
}

const openServers = [];
async function probeServer(opts) {
  const started = await startProbeServer(opts);
  openServers.push(started.server);
  return started;
}
after(() => {
  for (const server of openServers) server.close();
});

async function post(port, body, path = '/') {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

// Poll a condition instead of sleeping a fixed amount — a fixed sleep either
// flakes on a loaded CI box or wastes wall clock on every run.
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return false;
}

// A response object that records instead of writing, so respondError can be
// driven directly without a socket. Mirrors the fields respondError inspects.
function fakeRes(overrides = {}) {
  const rec = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    socket: { destroyed: false, remoteAddress: '127.0.0.1' },
    calls: [],
    writeHead(status) { rec.calls.push(['writeHead', status]); },
    end(body) { rec.calls.push(['end', body]); },
    destroy() { rec.calls.push(['destroy']); },
    ...overrides,
  };
  return rec;
}

// The exact wire shape atomicPublish sends: the canonical payload is a JSON
// string nested inside the command array, so every `"` in it is escaped.
function seedCommandBody(payloadBytes) {
  const record = JSON.stringify({
    id: '30.12345--100.54321-2026-08-24-0612',
    location: { latitude: 30.12345, longitude: -100.54321 },
    brightness: 331.5,
    frp: 12.3,
    confidence: 'nominal',
    satellite: 'N21',
    detectedAt: 1756000000000,
    region: 'North America',
    dayNight: 'D',
    possibleExplosion: false,
    source: 'firms',
    kind: 'active',
    emergency: true,
  });
  const copies = Math.max(1, Math.ceil(payloadBytes / (record.length + 1)));
  const payload = `{"fireDetections":[${new Array(copies).fill(record).join(',')}]}`;
  return JSON.stringify(['SET', 'wildfire:fires:v1', payload, 'EX', 7200]);
}

describe('redis-rest proxy body limit (#7099)', () => {
  it('exposes every body-limit helper the tests drive', () => {
    for (const [name, src] of Object.entries(sources)) {
      assert.ok(src, `${name} not found in docker/redis-rest-proxy.mjs`);
    }
  });

  it('accepts the ~5MB canonical publish the fire seeder deliberately produces', async () => {
    const { port } = await probeServer();
    // 5MB payload → ~5.7MB on the wire once escaped. Under the old 1MB cap this
    // never reached an HTTP status at all: `write EPIPE` / `other side closed`.
    const body = seedCommandBody(5 * 1024 * 1024);
    assert.ok(
      Buffer.byteLength(body, 'utf8') > 1024 * 1024,
      'probe body must exceed the old 1MB cap to reproduce the bug',
    );
    const resp = await post(port, body);
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.bytes, Buffer.byteLength(body, 'utf8'), 'body must arrive intact');
  });

  it('answers an over-cap body with 413 and a JSON error, never a destroyed socket', async () => {
    const limit = 4096;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    const resp = await post(port, 'x'.repeat(limit + 512));
    // The whole point of the fix: a status, not a transport failure. A rejected
    // fetch (EPIPE / "other side closed") fails this test by throwing above.
    assert.equal(resp.status, 413);
    const json = await resp.json();
    assert.match(json.error, /too large/i);
    assert.match(json.error, new RegExp(String(limit)), 'the limit must be in the error text');
  });

  it('logs the rejection server-side so the container log corroborates the 413', async () => {
    const limit = 4096;
    const { port, helpers } = await probeServer({ limit, drainLimit: limit * 2 });
    // Client-side diagnosability was only half of #7099: an operator running
    // `docker compose logs redis-rest` saw nothing at all. A 413 the proxy never
    // mentions leaves the same silence that sent six runs to the wrong culprit.
    assert.deepEqual(helpers.warnings, [], 'no warning before any request');
    const resp = await post(port, 'x'.repeat(limit + 512));
    assert.equal(resp.status, 413);
    assert.equal(helpers.warnings.length, 1, 'a rejected body must warn exactly once');
    assert.match(helpers.warnings[0], new RegExp(String(limit)), 'the log line must carry the limit');

    // A well-formed request must stay quiet — a log that fires on success is noise
    // an operator learns to ignore.
    const ok = await post(port, JSON.stringify(['PING']));
    assert.equal(ok.status, 200);
    assert.equal(helpers.warnings.length, 1, 'an accepted body must not warn');
  });

  it('413 is retryable-permanent for the seeder retry policy', async () => {
    const { PERMANENT_4XX_STATUSES } = await import('../scripts/_seed-utils.mjs');
    // Without this, atomicPublish burns all 3 attempts on a limit that will
    // never pass. 413 is already in the set — this pins the pairing.
    assert.ok(PERMANENT_4XX_STATUSES.has(413));
  });

  it('a body under the cap still round-trips byte-for-byte', async () => {
    const limit = 4096;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    const body = JSON.stringify(['SET', 'k', 'v'.repeat(limit - 64)]);
    const resp = await post(port, body);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).bytes, Buffer.byteLength(body, 'utf8'));
  });

  it('caps /pipeline and /multi-exec too, not just POST /', async () => {
    const limit = 4096;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    // server/_shared/redis.ts and scripts/_seed-utils.mjs batch real traffic
    // through both of these. A fix that only reached POST / would leave the
    // #7099 failure mode alive on the routes that carry multi-key writes.
    for (const route of ['/pipeline', '/multi-exec']) {
      const ok = await post(port, JSON.stringify([['PING']]), route);
      assert.equal(ok.status, 200, `${route} must accept an under-cap body`);
      assert.equal((await ok.json()).route, route);

      const rejected = await post(port, 'x'.repeat(limit + 512), route);
      assert.equal(rejected.status, 413, `${route} must answer over-cap with 413, not a dead socket`);
    }
  });

  it('keeps the connection usable after a 413 (the drain is what makes this true)', async () => {
    const limit = 4096;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    const sock = net.connect(port, '127.0.0.1');
    let seen = '';
    sock.on('data', (d) => { seen += d.toString('latin1'); });
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));

    const over = 'x'.repeat(limit + 512);
    sock.write(`POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${over.length}\r\n\r\n${over}`);
    await waitFor(() => seen.includes('\r\n\r\n'));
    assert.match(seen, /^HTTP\/1\.1 413 /, 'first response must be the 413');

    // Had readBody destroyed the socket (or left body bytes unread), this second
    // request on the SAME connection would be lost or mis-parsed as a continuation
    // of the rejected body.
    seen = '';
    const ping = JSON.stringify(['PING']);
    sock.write(`POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(ping)}\r\n\r\n${ping}`);
    await waitFor(() => seen.includes('\r\n\r\n'));
    sock.destroy();
    assert.match(seen, /^HTTP\/1\.1 200 /, 'the connection must still be usable after a 413');
  });

  it('rejects the readBody promise itself when the request errors', async () => {
    const { readBody } = buildHelpers();
    // Asserting only that a LATER request still works passes even if this
    // promise never settles — the leak is invisible from outside. Await the
    // promise directly so a dropped 'error' handler shows up as a timeout here.
    const fake = new EventEmitter();
    fake.headers = {};
    fake.socket = { remoteAddress: '127.0.0.1' };
    fake.off = fake.removeListener;
    const pending = readBody(fake, 1024, 2048);
    fake.emit('data', Buffer.alloc(16));
    fake.emit('error', new Error('client gone'));
    await assert.rejects(
      Promise.race([pending, delay(2000).then(() => { throw new Error('readBody never settled'); })]),
      /client gone/,
    );
  });

  it('settles rather than hanging when the client aborts mid-body', async () => {
    const limit = 1024 * 1024;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    let settledStatus = 'pending';
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    sock.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 900000\r\n\r\n');
    sock.write('x'.repeat(50_000));
    await delay(40); // let the server start reading before the connection dies
    sock.resetAndDestroy(); // RST mid-body -> 'error' on the server's request

    // A readBody whose error path stopped settling would leak this request's
    // promise forever. Prove the server is still healthy right after.
    const resp = await post(port, JSON.stringify(['PING']));
    settledStatus = resp.status;
    assert.equal(settledStatus, 200, 'the proxy must survive a mid-body client abort and keep serving');
  });

  it('answers a body far past the drain budget with 413, not a destroyed socket', { timeout: 20_000 }, async () => {
    const limit = 1024;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    // 200x the cap — far past any drain budget. A declared Content-Length is
    // rejected before a byte is buffered, so size alone can no longer push the
    // caller back onto a statusless EPIPE. Asserting the status directly is the
    // point: an "either outcome is acceptable" shape blesses the #7099 symptom
    // as a pass, which is how a regression here would ship green.
    const resp = await post(port, 'x'.repeat(limit * 200));
    assert.equal(resp.status, 413);
    assert.match((await resp.json()).error, /too large/i);
  });

  it('refuses an undeclared (chunked) over-drain body without hanging or dying', { timeout: 20_000 }, async () => {
    const limit = 1024;
    const { port } = await probeServer({ limit, drainLimit: limit * 2 });
    // No Content-Length, so the fast path cannot fire — this is the drain
    // budget's bounded-sink backstop. A transport error is the accepted outcome
    // here; what must not happen is accepting the body, hanging, or dying.
    let outcome;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            for (let i = 0; i < 200; i++) controller.enqueue(new Uint8Array(limit).fill(120));
            controller.close();
          },
        }),
      });
      outcome = `status:${resp.status}`;
      await resp.arrayBuffer();
    } catch (err) {
      outcome = `threw:${err?.cause?.code || err?.message}`;
    }
    assert.doesNotMatch(outcome, /^status:2/, `an over-cap body must never be accepted (got ${outcome})`);
    const alive = await post(port, JSON.stringify(['PING']));
    assert.equal(alive.status, 200, 'the proxy must stay healthy after refusing an unbounded body');
  });

  it('enforces the module-level constants, not just injected test limits', { timeout: 20_000 }, async () => {
    // Every other overflow test injects limit/drainLimit, so none of them
    // executes the binding between MAX_BODY_BYTES / OVERSIZE_DRAIN_BYTES and
    // runtime behaviour. This probe calls readBody(req) with no size arguments,
    // exactly as the shipped handlers do — without it, a one-line change to
    // either constant reintroduces #7099 for every over-cap body while the
    // suite reports all green.
    const { port } = await probeServer({ env: { SRH_MAX_BODY_BYTES: '4096' } });

    const under = await post(port, JSON.stringify(['SET', 'k', 'v'.repeat(2000)]));
    assert.equal(under.status, 200, 'a body under the configured cap must be accepted');

    const over = await post(port, 'x'.repeat(4096 + 512));
    assert.equal(over.status, 413, 'the configured cap must be enforced through the module constants');
    assert.match((await over.json()).error, /4096/, 'the error must name the configured limit, not a default');

    const wayOver = await post(port, 'x'.repeat(4096 * 20));
    assert.equal(wayOver.status, 413, 'past the derived drain budget must still be a status, not a reset');
  });

  describe('checkAuth byte-length guard', () => {
    const TOKEN = 'a'.repeat(64);
    const withToken = (value) => buildHelpers({ SRH_TOKEN: TOKEN }).checkAuth({
      headers: { authorization: value },
    });

    it('rejects a non-ASCII token of matching String.length instead of throwing', () => {
      // String.length counts UTF-16 code units; timingSafeEqual compares BYTES.
      // Node parses header values as latin1, so `ÿ` is one code unit but two
      // UTF-8 bytes: the old `provided.length !== TOKEN.length` guard let it
      // through and timingSafeEqual threw RangeError from ABOVE the handler's try
      // block — an unhandled rejection that exited the process. One
      // unauthenticated request killed the container.
      const evil = `${'a'.repeat(63)}ÿ`;
      assert.equal(evil.length, TOKEN.length, 'the attack needs matching code-unit length');
      assert.notEqual(Buffer.byteLength(evil), Buffer.byteLength(TOKEN), 'but differing byte length');
      assert.equal(withToken(`Bearer ${evil}`), false, 'must reject, not throw');
    });

    it('still accepts the correct token and rejects ordinary wrong ones', () => {
      assert.equal(withToken(`Bearer ${TOKEN}`), true);
      assert.equal(withToken(`Bearer ${'b'.repeat(64)}`), false);
      assert.equal(withToken(`Bearer ${'a'.repeat(63)}`), false, 'short token');
      assert.equal(withToken(`Bearer ${'a'.repeat(65)}`), false, 'long token');
      assert.equal(withToken('Basic whatever'), false, 'wrong scheme');
      assert.equal(withToken(undefined), false, 'absent header');
    });

    it('stays open when no token is configured', () => {
      assert.equal(buildHelpers({}).checkAuth({ headers: {} }), true);
    });
  });

  describe('respondError', () => {
    // The 500 branch runs far more often than the 413 one: every Redis error,
    // JSON.parse failure on a malformed body, and `Command not allowed` reaches
    // it. It is the proxy's only error surface, so it must not be shaped solely
    // around the new 413.
    it('maps an ordinary error to 500 and echoes its message', () => {
      const { respondError } = buildHelpers();
      const res = fakeRes();
      respondError(res, new Error('Command not allowed: FLUSHALL'));
      assert.deepEqual(res.calls[0], ['writeHead', 500]);
      assert.equal(JSON.parse(res.calls[1][1]).error, 'Command not allowed: FLUSHALL');
    });

    it('maps a PayloadTooLargeError to 413', () => {
      const { respondError, PayloadTooLargeError } = buildHelpers();
      const res = fakeRes();
      respondError(res, new PayloadTooLargeError(4096));
      assert.deepEqual(res.calls[0], ['writeHead', 413]);
    });

    it('falls back to a generic message rather than emitting "undefined"', () => {
      const { respondError } = buildHelpers();
      const res = fakeRes();
      respondError(res, {});
      assert.deepEqual(res.calls[0], ['writeHead', 500]);
      assert.equal(JSON.parse(res.calls[1][1]).error, 'Internal error');
    });

    it('does not write a second time when headers are already sent', () => {
      const { respondError } = buildHelpers();
      // Neither ended nor destroyed, so the writability guard alone lets this
      // through — and the second writeHead() throws ERR_HTTP_HEADERS_SENT from
      // inside an async catch, which exits the process.
      let destroyed = false;
      const res = fakeRes({ headersSent: true, destroy() { destroyed = true; } });
      respondError(res, new Error('boom'));
      assert.deepEqual(res.calls, [], 'must not write headers twice');
      assert.equal(destroyed, true, 'an un-finishable response must be torn down');
    });

    for (const [label, overrides] of [
      ['a finished response', { writableEnded: true }],
      ['a destroyed response', { destroyed: true }],
      ['a dead socket', { socket: { destroyed: true } }],
    ]) {
      it(`writes nothing to ${label}`, () => {
        const { respondError } = buildHelpers();
        const res = fakeRes(overrides);
        respondError(res, new Error('boom'));
        assert.deepEqual(res.calls, [], 'a second write would throw ERR_STREAM_WRITE_AFTER_END');
      });
    }

    it('still logs a 413 whose response can no longer be written', () => {
      const { respondError, PayloadTooLargeError, warnings } = buildHelpers();
      // Past the drain cap the socket is already gone, so the client gets
      // nothing — the container log is then the ONLY record that a rejection
      // happened. Logging after the guard would lose exactly that case.
      respondError(fakeRes({ socket: { destroyed: true } }), new PayloadTooLargeError(4096));
      assert.equal(warnings.length, 1, 'a rejection with no deliverable response must still be logged');
      assert.match(warnings[0], /4096/);
    });

    it('names the caller in the log even when the socket is already gone', () => {
      const { respondError, PayloadTooLargeError, warnings } = buildHelpers();
      // The dead-socket branch is precisely where res.socket is null, so an
      // address read at log time yields "unknown" exactly when the line is the
      // only record. readBody captures it before destroying; honour that.
      const err = new PayloadTooLargeError(4096);
      err.remoteAddress = '10.1.2.3';
      respondError(fakeRes({ socket: null }), err);
      assert.match(warnings[0], /10\.1\.2\.3/, 'the captured address must reach the log line');
    });
  });

  describe('MAX_BODY_BYTES sizing', () => {
    it('clears the worst-case JSON-command encoding of the largest stock seeder payload', () => {
      const { DEFAULT_MAX_BODY_BYTES } = buildHelpers();
      // atomicPublish nests the payload as a JSON string inside ["SET", key,
      // <payload>, "EX", ttl]. Escaping is at most 2x (a payload of nothing but
      // quotes), plus the command envelope. Raise MAX_PAYLOAD_BYTES and this
      // goes red — which is the point.
      const worstCase = 2 * MAX_PAYLOAD_BYTES + 1024;
      assert.ok(
        DEFAULT_MAX_BODY_BYTES >= worstCase,
        `DEFAULT_MAX_BODY_BYTES (${DEFAULT_MAX_BODY_BYTES}) must be >= ${worstCase} — the worst-case wire size of a ${MAX_PAYLOAD_BYTES}-byte seeder payload`,
      );
    });

    it('pairs the cap with a drain budget that is generous but bounded', () => {
      const { MAX_BODY_BYTES, OVERSIZE_DRAIN_BYTES } = buildHelpers();
      // Zero drain headroom puts us back on the destroyed socket for every
      // over-cap body; unbounded headroom turns the proxy into a free sink.
      assert.ok(
        OVERSIZE_DRAIN_BYTES > MAX_BODY_BYTES,
        'an over-cap body needs drain headroom, or it can never be answered with 413',
      );
      assert.ok(
        OVERSIZE_DRAIN_BYTES <= MAX_BODY_BYTES * 4,
        `drain budget ${OVERSIZE_DRAIN_BYTES} must stay a small multiple of the ${MAX_BODY_BYTES} cap`,
      );
    });

    it('lowering the cap does not shrink the window where a 413 is still deliverable', () => {
      // SELF_HOSTING.md tells operators they may lower SRH_MAX_BODY_BYTES and
      // promises a clear 413 rather than a connection error. A drain budget
      // derived purely from the cap breaks that promise: at a 2MB cap a normal
      // 5.98MB atomicPublish body lands past 2x and gets a destroyed socket —
      // #7099, re-created by the documented tuning knob.
      const { OVERSIZE_DRAIN_BYTES, DEFAULT_MAX_BODY_BYTES } = buildHelpers({ SRH_MAX_BODY_BYTES: '2097152' });
      const worstStockWireBody = 2 * MAX_PAYLOAD_BYTES;
      assert.ok(
        OVERSIZE_DRAIN_BYTES >= worstStockWireBody,
        `a lowered cap still drains ${OVERSIZE_DRAIN_BYTES} bytes, below the ${worstStockWireBody}-byte worst-case stock publish it must answer with 413`,
      );
      assert.ok(OVERSIZE_DRAIN_BYTES >= DEFAULT_MAX_BODY_BYTES, 'the drain floor is the default cap');
    });

    it('honours SRH_MAX_BODY_BYTES', () => {
      const { resolveMaxBodyBytes } = buildHelpers();
      assert.equal(resolveMaxBodyBytes({ SRH_MAX_BODY_BYTES: '2097152' }), 2097152);
    });

    it('falls back to the default for unset, empty, and nonsense values', () => {
      const { resolveMaxBodyBytes, DEFAULT_MAX_BODY_BYTES } = buildHelpers();
      for (const raw of [undefined, '', '   ', '0', '-1', 'lots', '1.5', 'NaN', 'Infinity']) {
        assert.equal(
          resolveMaxBodyBytes(raw === undefined ? {} : { SRH_MAX_BODY_BYTES: raw }),
          DEFAULT_MAX_BODY_BYTES,
          `SRH_MAX_BODY_BYTES=${JSON.stringify(raw)} must fall back to the default`,
        );
      }
    });

    it('warns about a bad SRH_MAX_BODY_BYTES rather than falling back silently', () => {
      // A silent fallback is how an operator's typo becomes an unexplained cap:
      // they set the var, the proxy ignores it, and nothing says so.
      const helpers = buildHelpers();
      helpers.resolveMaxBodyBytes({ SRH_MAX_BODY_BYTES: '16MB' });
      assert.equal(helpers.warnings.length, 1, 'an unusable value must be logged');
      assert.match(helpers.warnings[0], /SRH_MAX_BODY_BYTES/);

      helpers.resolveMaxBodyBytes({ SRH_MAX_BODY_BYTES: '4096' });
      assert.equal(helpers.warnings.length, 1, 'a usable value must not warn');
    });
  });

  describe('wiring', () => {
    it('the whole proxy destroys a request at exactly one site', () => {
      // Scoping this count to readBody's extracted source was the hole: a
      // `respondError(res, err); req.destroy();` added to the handler's own catch
      // writes the 413 and then kills an incomplete upload, so a slow client gets
      // EPIPE and #7099 is back — invisible to a readBody-only scan, and the
      // mirrored probe server never executes the real catch. Count across the
      // entire file so any new destroy has to be justified here.
      const destroys = [...proxyCode.matchAll(/\breq\.destroy\(/g)];
      assert.equal(
        destroys.length,
        1,
        'the proxy must destroy a request at exactly one site (readBody\'s drain-cap backstop)',
      );
      assert.ok(
        sources.readBody.includes('req.destroy('),
        'the single destroy must live in readBody, not in a request handler',
      );
    });

    it('the request handler catch does nothing but delegate to respondError', () => {
      // Anything else in the catch runs AFTER the status is chosen but while the
      // response may still be in flight — the exact window where an added
      // req.destroy()/res.destroy() turns a clean 413 into a transport error.
      // Anchored on the handler's own indentation (`  } catch` closing into
      // `  }\n});`) so it cannot drift onto the deeper /pipeline inner catch,
      // whose body legitimately does other work.
      const handlerCatch = proxyCode.match(/\n {2}\} catch \(err\) \{\n([\s\S]*?)\n {2}\}\n\}\);/);
      assert.ok(handlerCatch, 'could not locate the request handler catch block');
      assert.equal(
        handlerCatch[1].trim(),
        'respondError(res, err);',
        'the handler catch must contain only respondError(res, err)',
      );
    });

    it('readBody destroys the socket only past the drain cap, never on first overflow', () => {
      const body = sources.readBody.replace(/^\s*\/\/.*$/gm, '');
      const destroys = [...body.matchAll(/req\.destroy\(\)/g)];
      // Destroying the moment the body cap is passed is exactly the bug: the
      // caller loses the status and sees EPIPE. The one permitted destroy is the
      // bounded-sink backstop, and it must be guarded by the drain cap.
      assert.equal(destroys.length, 1, 'readBody must destroy the request at exactly one site');
      const guard = body.slice(0, destroys[0].index).match(/if \(totalLength > (\w+)\)\s*\{\s*$/m);
      assert.ok(guard, 'the destroy must sit directly under a totalLength comparison');
      assert.equal(guard[1], 'drainLimit', 'the destroy must be guarded by the drain cap, not the body cap');
    });

    it('every body-reading POST route goes through readBody', () => {
      // Non-global `match` is satisfied by a single occurrence, so it cannot tell
      // "all three routes read through readBody" from "one does". Count instead:
      // POST /, POST /pipeline, and POST /multi-exec each read a body.
      const callSites = [...proxyCode.matchAll(/await readBody\(req\)/g)];
      assert.equal(
        callSites.length,
        BODY_ROUTES.length,
        `expected ${BODY_ROUTES.length} readBody call sites (${BODY_ROUTES.join(', ')}), found ${callSites.length}`,
      );
    });

    it('errors go through respondError', () => {
      assert.match(proxyCode, /catch \(err\) \{\s*respondError\(res, err\);/, 'the handler catch must map status via respondError');
      assert.doesNotMatch(proxyCode, /catch \(err\) \{\s*res\.writeHead\(500\);/, 'a hardcoded 500 swallows the 413');
    });

    it('MAX_BODY_BYTES comes from resolveMaxBodyBytes, not a literal', () => {
      assert.match(proxyCode, /const MAX_BODY_BYTES = resolveMaxBodyBytes\(\);/);
    });
  });
});
