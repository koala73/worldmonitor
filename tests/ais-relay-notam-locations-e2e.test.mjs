// Drives the real relay process: /notam must forward only a list of ICAO
// location codes. A `locations` value carrying `&`, `#` or another parameter
// would otherwise be pasted into the ICAO query string, after the API key.
// The ICAO request is answered by tests/_lib/ais-relay-notam-preload.cjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const preload = fileURLToPath(new URL('./_lib/ais-relay-notam-preload.cjs', import.meta.url));
const SECRET = 'relay-secret';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: pathname, timeout: 8000,
      headers: { authorization: `Bearer ${SECRET}` },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error('relay did not answer')); });
    req.on('error', reject);
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

async function startRelay(t) {
  const ws = http.createServer((_req, res) => { res.writeHead(429); res.end(); });
  const wsPort = await listen(ws);
  t.after(() => new Promise((resolve) => ws.close(resolve)));

  const child = spawn(process.execPath, ['--require', preload, relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${wsPort}/stream`,
      ICAO_API_KEY: 'icao-test-key',
      RELAY_SHARED_SECRET: SECRET,
      RELAY_TEST_MODE: 'true',
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
  return { port, log };
}

const upstreamQueries = (log) => [...log.text.matchAll(/NOTAM_UPSTREAM_QUERY (\S+)/g)].map((m) => m[1]);

test('relay /notam: only ICAO location codes reach the upstream query', async (t) => {
  const { port, log } = await startRelay(t);

  for (const locations of ['KJFK&format=xml', 'KJFK#', 'KJFK,EGLL&locations=ZZZZ', 'kjfk', 'K JFK', 'KJFK,']) {
    const res = await get(port, `/notam?locations=${encodeURIComponent(locations)}`);
    assert.equal(res.status, 400, `rejects ${JSON.stringify(locations)}`);
  }
  assert.deepEqual(upstreamQueries(log), [], 'no rejected value reached ICAO');

  assert.equal((await get(port, `/notam?locations=${encodeURIComponent('KJFK,EGLL')}`)).status, 200);
  await waitFor(() => upstreamQueries(log).length === 1, 'upstream NOTAM request');
  const sent = new URLSearchParams(upstreamQueries(log)[0]);
  assert.deepEqual(sent.getAll('locations'), ['KJFK,EGLL']);
  assert.deepEqual(sent.getAll('format'), ['json']);
  assert.deepEqual(sent.getAll('api_key'), ['icao-test-key']);
});
