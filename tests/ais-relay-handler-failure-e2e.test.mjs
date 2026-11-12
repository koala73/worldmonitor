// Drives the real relay process into a throw inside a request handler. The
// router was an async createServer callback with no catch, and several async
// route handlers were dispatched without return or await, so any throw that
// escaped (the router's own awaits, or a handler's catch block) became an
// unhandled rejection and Node 24 exited the relay, taking AIS, Telegram and
// every other route down with it. Faults are injected by
// tests/_lib/ais-relay-handler-fault-preload.cjs, with no real network.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const preload = fileURLToPath(new URL('./_lib/ais-relay-handler-fault-preload.cjs', import.meta.url));
const RELAY_SECRET = 'relay-secret';

function request(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: pathname,
      timeout: 5000,
      headers: { 'x-relay-key': RELAY_SECRET },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => resolve({ error }));
    });
    req.on('timeout', () => { req.destroy(new Error('relay did not answer')); });
    req.on('error', (error) => resolve({ error }));
  });
}

function waitFor(predicate, description, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timeout: ${description}`)); }
    }, 20);
  });
}

async function startRelay(t, fault) {
  // The AIS upstream answers 429 so the relay never opens a real stream.
  const ws = http.createServer((_req, res) => { res.writeHead(429); res.end(); });
  ws.listen(0, '127.0.0.1');
  await once(ws, 'listening');
  t.after(() => new Promise((resolve) => ws.close(resolve)));

  const child = spawn(process.execPath, ['--require', preload, relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${ws.address().port}/stream`,
      RELAY_SHARED_SECRET: RELAY_SECRET,
      RELAY_TEST_MODE: 'true',
      RELAY_TEST_FAULT: fault,
      NODE_ENV: 'test',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  const log = { text: '' };
  child.stdout.on('data', (chunk) => { log.text += chunk; });
  child.stderr.on('data', (chunk) => { log.text += chunk; });
  await waitFor(() => log.text.includes('WebSocket relay on port'), 'relay startup');
  const port = Number(log.text.match(/WebSocket relay on port (\d+)/)[1]);
  return { child, port, log };
}

async function assertSurvives(child, port, log, pathname) {
  const res = await request(port, pathname);
  // Give a crash on the next tick time to surface before the liveness probe.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, `${pathname} must not exit the relay:\n${log.text.slice(-2000)}`);
  assert.equal(res.error, undefined, `${pathname} must answer, not drop the connection`);
  assert.equal(res.status, 500, `${pathname} answers 500`);
  const health = await request(port, '/health');
  assert.equal(health.status, 200, `relay still serves /health after ${pathname}`);
}

test('relay: a throw escaping a dispatched async handler is a 500 and the relay keeps serving', async (t) => {
  const { child, port, log } = await startRelay(t, 'ucdp');
  await assertSurvives(child, port, log, '/ucdp-events');
  assert.match(log.text, /\[Relay\] request handler failed: TypeError /);
  // A second cold fetch reaches the handler again: the in-progress flag was released.
  await assertSurvives(child, port, log, '/ucdp-events');
});

test("relay: a throw from the router's own await is a 500 and the relay keeps serving", async (t) => {
  const { child, port, log } = await startRelay(t, 'status');
  await assertSurvives(child, port, log, '/status');
  assert.match(log.text, /\[Relay\] request handler failed: Error budget store unavailable/);
});

// The streamed-response branch cannot be reached through the real relay
// without a handler that fails mid-body, so it runs the shared failure helper
// directly against the real source.
test('relay request failure helper: 500 before headers, socket destroyed after', () => {
  const source = readFileSync(relayScript, 'utf8');
  const sectionOf = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Missing relay section: ${start}`);
    return source.slice(from, to);
  };
  const logged = [];
  const fail = vm.runInNewContext([
    sectionOf('function safeEnd(', 'const WORLD_BANK_COUNTRY_ALLOWLIST'),
    sectionOf('function handleRelayRequestFailure(', '\n}\n') + '\n}',
    'handleRelayRequestFailure;',
  ].join('\n'), { console: { error: (...args) => logged.push(args.join(' ')) } });

  const fresh = { headersSent: false, writableEnded: false, destroyed: false };
  fresh.writeHead = (status) => { fresh.status = status; fresh.headersSent = true; };
  fresh.end = () => { fresh.writableEnded = true; };
  fresh.destroy = () => { fresh.destroyed = true; };
  fail(fresh, new TypeError('boom'));
  assert.equal(fresh.status, 500);
  assert.equal(fresh.writableEnded, true);
  assert.equal(fresh.destroyed, false);

  const streaming = { headersSent: true, writableEnded: false, destroyed: false };
  streaming.writeHead = () => { throw new Error('headers already sent'); };
  streaming.end = () => { throw new Error('must not end a half-written body as complete'); };
  streaming.destroy = () => { streaming.destroyed = true; };
  fail(streaming, null);
  assert.equal(streaming.destroyed, true, 'a half-written response is cut so the client sees a failure');

  const finished = { headersSent: true, writableEnded: true, destroyed: false };
  finished.destroy = () => { finished.destroyed = true; };
  fail(finished, new Error('late'));
  assert.equal(finished.destroyed, false, 'a completed response keeps its keep-alive socket');

  assert.deepEqual(logged, [
    '[Relay] request handler failed: TypeError boom',
    '[Relay] request handler failed: Error ',
    '[Relay] request handler failed: Error late',
  ]);
});
