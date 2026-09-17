// #8265 — every POST /multi-exec against the bundled proxy answered 403
// {"error":"multi.sendCommand is not a function"}. `sendCommand` is a method on
// the node-redis CLIENT; the v4 transaction chain queues raw commands with
// `addCommand`. The TypeError was swallowed by the try/catch that exists to turn
// a gate rejection into a 403, so a pure code defect reached operators as an
// authorization failure — seed-fred-rates and seed-bis-extended, which publish
// exclusively through /multi-exec, failed every pass with "HTTP 403" and sent
// six months of self-host debugging at REDIS_TOKEN.
//
// Verified against the real library (the version docker/Dockerfile.redis-rest
// installs, `npm install redis@4` → 4.7.1):
//
//   const m = createClient().multi();
//   typeof m.sendCommand  // 'undefined'
//   typeof m.addCommand   // 'function'
//
// so the multi stub below deliberately exposes `addCommand` ONLY. A stub that
// also answered `sendCommand` — which is exactly what the mock in
// redis-rest-proxy-auth.test.mjs used to do — is what let this ship green.
//
// The proxy connects to Redis and calls server.listen() at import time, and
// `redis` is only installed inside the container image, so it cannot be
// imported. Boot the whole file through the same AsyncFunction harness
// redis-rest-proxy-auth.test.mjs uses and drive the real request handler.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { STORY_ALIAS_PUBLISH_SCRIPT } from '../shared/story-alias-publish-script.mjs';

const source = readFileSync(new URL('../docker/redis-rest-proxy.mjs', import.meta.url), 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('process', 'http', 'crypto', 'createClient', 'console', source);

const TOKEN = 'a'.repeat(64);

// The only two members of node-redis v4's RedisClientMultiCommand the proxy is
// allowed to touch. Captured from redis@4.7.1, the version
// docker/Dockerfile.redis-rest installs via `npm install redis@4`:
//
//   const m = createClient().multi();
//   typeof m.addCommand   // 'function'   (queues a raw command, returns the chain)
//   typeof m.exec         // 'function'
//   typeof m.sendCommand  // 'undefined'  <- #8265 called this one
//
// The chain also carries a camelCase method per Redis command (m.set, m.get,
// …, ~500 of them). The proxy deliberately uses none: it forwards
// caller-supplied command arrays, which is what addCommand is for. Re-run the
// snippet above if the pinned major ever moves.
const MULTI_V4_METHODS_USED = new Set(['addCommand', 'exec']);

// node-redis v4's RedisClientMultiCommand: addCommand(args) queues and returns
// the chain for further queuing; exec() resolves the replies in order — EXCEPT
// when a command inside the executed transaction replies with an error, where
// it REJECTS with MultiErrorReply and hides the ordered replies on err.replies.
// Verified against redis@4.7.1 by answering EXEC with
// `*2\r\n+OK\r\n-WRONGTYPE ...\r\n`:
//
//   exec REJECTED: MultiErrorReply - 1 commands failed, see .replies and
//   .errorIndexes for more information
//   err.replies: ["OK", <ErrorReply: WRONGTYPE ...>]
//
// `onExec` lets a test install either shape.
function makeMulti({ onAddCommand, onExec } = {}) {
  const queued = [];
  let execCalls = 0;
  const multi = {
    addCommand(args) {
      if (onAddCommand) onAddCommand(args);
      queued.push(args);
      return multi;
    },
    async exec() {
      execCalls += 1;
      if (onExec) return onExec(queued);
      return queued.map((args) => (String(args[0]).toUpperCase() === 'GET' ? 'hello' : 'OK'));
    },
  };
  return { multi, queued, execCalls: () => execCalls };
}

// node-redis's ErrorReply — what a `-ERR ...` RESP reply becomes. The class
// NAME is the contract the proxy duck-types on, so it must match exactly.
class ErrorReply extends Error {}

// node-redis's MultiErrorReply, reduced to the two properties the handler reads.
function multiErrorReply(replies) {
  const err = new Error(
    `${replies.filter((r) => r instanceof Error).length} commands failed, see .replies and .errorIndexes for more information`,
  );
  err.replies = replies;
  err.errorIndexes = replies.map((r, i) => (r instanceof Error ? i : -1)).filter((i) => i >= 0);
  return err;
}

async function boot({ onAddCommand, onExec } = {}) {
  const stderr = [];
  let handler;
  let transaction = null;
  const client = {
    on() {},
    async connect() {},
    async sendCommand() { return 'PONG'; },
    multi() {
      transaction = makeMulti({ onAddCommand, onExec });
      return transaction.multi;
    },
  };
  await run({ env: { SRH_TOKEN: TOKEN } }, {
    createServer(callback) {
      handler = callback;
      return { listen() {} };
    },
  }, crypto, () => client, { log() {}, error: (...a) => stderr.push(a.join(' ')), warn() {} });

  return {
    stderr,
    transaction: () => transaction,
    async post(url, body) {
      const payload = Buffer.from(JSON.stringify(body));
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(payload.length) },
        socket: { remoteAddress: '127.0.0.1' },
        off(...args) { return this.removeListener(...args); },
      });
      const res = {
        status: 0,
        body: undefined,
        headersSent: false,
        setHeader() {},
        writeHead(status) { this.status = status; this.headersSent = true; },
        end(chunk) { this.body = chunk; this.writableEnded = true; },
        destroy() { this.destroyed = true; },
      };
      const done = handler(req, res);
      // readBody() subscribes synchronously inside the route branch; feed the
      // body once the handler has reached its first await.
      setImmediate(() => { req.emit('data', payload); req.emit('end'); });
      await done;
      return res;
    },
  };
}

describe('redis-rest-proxy POST /multi-exec', () => {
  it('queues every authorized command on the node-redis v4 chain and returns the exec replies', async () => {
    const app = await boot();
    // Deliberately NOT already-normalized input: a lower-case verb and a
    // numeric argument. commandForExecution upper-cases the verb and String()s
    // every argument, so the queue can only match below if the handler queued
    // the GATE'S OUTPUT. With a pre-normalized fixture like
    // [['SET','t:a','hello']] the gate's output is byte-identical to the input,
    // and `multi.addCommand(cmd)` — calling the gate for its throw side effect
    // and then queuing the caller's unvalidated array — passes just as green.
    // That matters because the gate already rewrites arguments today
    // (LEGACY_EVAL_REPLACEMENTS swaps the pinned script text).
    const res = await app.post('/multi-exec', [['set', 't:a', 1], ['get', 't:a']]);

    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.body}`);
    assert.deepEqual(JSON.parse(res.body), [{ result: 'OK' }, { result: 'hello' }]);
    assert.deepEqual(app.transaction().queued, [['SET', 't:a', '1'], ['GET', 't:a']]);
    assert.equal(app.transaction().execCalls(), 1);
  });

  it('calls only transaction-chain methods node-redis v4 actually provides, and the fixture mirrors exactly those', () => {
    // This is the guard #8265 needed and did not have. Asserting
    // `typeof stub.sendCommand === 'undefined'` would restate the fixture —
    // true whether or not the proxy is broken. Instead, read which methods the
    // proxy calls on the chain and check them against the real v4 surface.
    //
    // Comments are stripped first, on the same reasoning as
    // redis-rest-proxy-body-limit.test.mjs: a call site quoted in a comment
    // must not count as a call site, in either direction.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const called = [...new Set([...code.matchAll(/\bmulti\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].sort();

    assert.ok(called.length > 0, 'found no multi.<method>() call sites — the scan broke, not the proxy');
    assert.deepEqual(called, [...MULTI_V4_METHODS_USED].sort(),
      `docker/redis-rest-proxy.mjs calls multi.${called.join('(), multi.')}() on the transaction chain; `
      + `node-redis v4 provides ${[...MULTI_V4_METHODS_USED].join(', ')} (sendCommand is a CLIENT method — #8265)`);

    // And the fixture must expose exactly that surface: a stub richer than the
    // library hides a call site that throws in production, a poorer one fails
    // for the wrong reason.
    assert.deepEqual(Object.keys(makeMulti().multi).sort(), [...MULTI_V4_METHODS_USED].sort());
  });

  it('rejects a blocked command with 403 and never executes a partial transaction', async () => {
    const app = await boot();
    const res = await app.post('/multi-exec', [['SET', 't:a', 'hello'], ['FLUSHALL']]);

    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error, /Command not allowed: FLUSHALL/);
    assert.equal(app.transaction().execCalls(), 0, 'a rejected batch must not run EXEC');
    assert.ok(app.stderr.some((line) => /Command not allowed: FLUSHALL/.test(line)),
      'a rejection must leave a server-side record');
  });

  // EVAL is the reason the single gate exists: the proxy's own comment says a
  // command added to ALLOWED_COMMANDS "would have run unpinned inside a MULTI".
  // That risk was theoretical while nothing on /multi-exec ever reached Redis.
  // It is real now, so both directions get behavioral coverage here.
  it('refuses an unpinned EVAL on the transaction path and runs nothing', async () => {
    const app = await boot();
    const res = await app.post('/multi-exec', [['SET', 't:a', 'hello'], ['EVAL', 'return 1', '0']]);

    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error, /Command not allowed: EVAL \(script not in the pinned allowlist\)/);
    assert.equal(app.transaction().execCalls(), 0);
  });

  it('queues an EVAL whose script text is on the pinned allowlist', async () => {
    const app = await boot();
    const res = await app.post('/multi-exec', [
      ['EVAL', STORY_ALIAS_PUBLISH_SCRIPT, '2', 'lease:key', 'alias:key', 'lease-token', 'payload', '60'],
    ]);

    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.body}`);
    // The proxy bundles a byte-identical PINNED COPY of the shared script (the
    // image ships one file and cannot import shared/). Asserting against the
    // shared module's text is what makes this a parity check and not a
    // restatement of the proxy's own constant.
    assert.deepEqual(app.transaction().queued, [
      ['EVAL', STORY_ALIAS_PUBLISH_SCRIPT, '2', 'lease:key', 'alias:key', 'lease-token', 'payload', '60'],
    ]);
    assert.equal(app.transaction().execCalls(), 1);
  });

  it('returns the executed transaction as an ordered array when one command errors', async () => {
    // Upstash answers a transaction whose commands ran but one of which failed
    // with HTTP 200 and an ordered array carrying {error} for that entry —
    // the shape /pipeline emits and the shape server/_shared/redis.ts scans
    // with `data.find((item) => item.error || item.result === 'ERR')`. Before
    // #8265 nothing was ever queued, so this path never ran; the first real
    // WRONGTYPE would otherwise have become an opaque, retryable 500.
    const app = await boot({
      onExec: () => Promise.reject(multiErrorReply([
        'OK',
        new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
        'OK',
      ])),
    });
    const res = await app.post('/multi-exec', [['SET', 't:a', 'hello'], ['LPUSH', 't:a', 'x'], ['SET', 't:b', 'written']]);

    assert.equal(res.status, 200, `expected 200, got ${res.status} ${res.body}`);
    assert.deepEqual(JSON.parse(res.body), [
      { result: 'OK' },
      { error: 'WRONGTYPE Operation against a key holding the wrong kind of value' },
      { result: 'OK' },
    ]);
  });

  it('answers a queue-time Redis refusal with a permanent 4xx, not a retryable 500', async () => {
    // Redis can also refuse a command when it is QUEUED (bad arity, unknown
    // command). Nothing runs, so there is no reply array — node-redis rejects
    // with a bare ErrorReply. That failure is deterministic: the identical
    // request fails identically forever. As a 500 it is retryable
    // (isRetryableHttpStatus, scripts/_seed-utils.mjs) and burns a caller's
    // whole retry budget; 400 is in PERMANENT_4XX_STATUSES, so atomicPublish
    // aborts on the first attempt and surfaces Redis's own message.
    const app = await boot({
      onExec: () => Promise.reject(new ErrorReply("ERR wrong number of arguments for 'hset' command")),
    });
    const res = await app.post('/multi-exec', [['SET', 't:a', 'hello'], ['HSET', 'h:a', 'field']]);

    assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.body}`);
    assert.match(JSON.parse(res.body).error, /ERR wrong number of arguments for 'hset' command/);
    assert.ok(app.stderr.some((line) => /Transaction refused by Redis.*wrong number of arguments/.test(line)),
      `a 4xx is where the caller stops retrying, so it must be on stderr; got ${JSON.stringify(app.stderr)}`);
  });

  it('still reports a transport failure as 500', async () => {
    // A dropped connection is neither a per-command error nor a refusal: there
    // is no reply array and Redis said nothing. It is genuinely transient, so
    // it must stay retryable. This is the case the 400 above must NOT swallow.
    const app = await boot({ onExec: () => Promise.reject(new Error('Socket closed unexpectedly')) });
    const res = await app.post('/multi-exec', [['SET', 't:a', 'hello']]);

    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).error, /Socket closed unexpectedly/);
  });

  it('reports an unexpected queueing failure as 500, not as an authorization error', async () => {
    // The 403 in the queue loop means one thing: the gate refused the command.
    // Anything else — the #8265 TypeError being the case in point — is a server
    // defect and must not be dressed up as a credentials problem.
    const app = await boot({
      onAddCommand(args) {
        if (String(args[0]).toUpperCase() === 'GET') throw new TypeError('multi.addCommand exploded');
      },
    });
    const res = await app.post('/multi-exec', [['GET', 't:a']]);

    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).error, /multi\.addCommand exploded/);
  });

  it('reports a malformed command element as 500, not as an authorization error', async () => {
    // Narrowing the try around commandForExecution is not sufficient: the gate
    // itself throws a TypeError (not a refusal) on a null element, because
    // assertCommandAllowed opens with String(args[0]). Before the throw was
    // tagged, a caller whose .map() produced one null entry got
    // 403 "Cannot read properties of null (reading '0')" — the #8265
    // misdirection surviving one layer in.
    const app = await boot();
    const res = await app.post('/multi-exec', [['SET', 't:a', 'hello'], null]);

    assert.equal(res.status, 500, `expected 500, got ${res.status} ${res.body}`);
    assert.doesNotMatch(JSON.parse(res.body).error, /Command not allowed/);
    assert.equal(app.transaction().execCalls(), 0);
  });

  it('leaves a server-side record for a 500 as well as for a refusal', async () => {
    // A blocked command logs itself in assertCommandAllowed; a 500 used to log
    // nothing at all, and the main caller keeps only the status
    // (`[redis] runRedisTransaction HTTP 500` in server/_shared/redis.ts). A
    // re-run of #8265 would then leave `docker compose logs redis-rest` silent —
    // the blind spot that hid the HSETNX/HINCRBY gap (#6937).
    const app = await boot({ onExec: () => Promise.reject(new Error('Socket closed unexpectedly')) });
    await app.post('/multi-exec', [['SET', 't:a', 'hello']]);

    assert.ok(app.stderr.some((line) => /HTTP 500.*Socket closed unexpectedly/.test(line)),
      `expected the failure on stderr, got ${JSON.stringify(app.stderr)}`);
  });
});
