// Drives the real relay process with a widget-agent POST whose body is valid
// JSON but not an object. `handleWidgetAgentRequest` read `body.tier` off the
// parsed value, so `null` threw a TypeError inside an async handler that the
// router calls without awaiting. The rejection was unhandled and Node exited
// the relay, taking AIS, Telegram and every other route down with it. The
// edge forwarded such bodies unchanged, so one browser request was enough.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const WIDGET_KEY = 'test-widget-key';

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      timeout: 5000,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Widget-Key': WIDGET_KEY },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('relay did not answer')); });
    req.on('error', reject);
    req.end(body);
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

test('relay /widget-agent: a JSON body that is not an object is a 400 and the relay keeps serving', async (t) => {
  // The AIS upstream answers 429 so the relay never opens a real stream.
  const ws = http.createServer((_req, res) => { res.writeHead(429); res.end(); });
  ws.listen(0, '127.0.0.1');
  await once(ws, 'listening');
  t.after(() => new Promise((resolve) => ws.close(resolve)));

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${ws.address().port}/stream`,
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
      WIDGET_AGENT_KEY: WIDGET_KEY,
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  const log = { text: '' };
  child.stdout.on('data', (chunk) => { log.text += chunk; });
  child.stderr.on('data', (chunk) => { log.text += chunk; });
  await waitFor(() => log.text.includes('WebSocket relay on port'), 'relay startup');
  const port = Number(log.text.match(/WebSocket relay on port (\d+)/)[1]);

  for (const body of ['null', '[]', '42', '"widget"', 'true']) {
    const res = await request(port, 'POST', '/widget-agent', body);
    assert.equal(res.status, 400, `body ${body}`);
    // Give a crash on the next tick time to surface before the liveness probe.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(child.exitCode, null, `body ${body} must not exit the relay`);
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 200, `relay still serves after body ${body}`);
  }

  const suspicious = log.text.split('\n').filter((line) => /TypeError|Unhandled|uncaught/i.test(line));
  assert.deepEqual(suspicious, []);
});
