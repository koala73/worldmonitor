// A native install (the FreeBSD port) runs the relay outside Docker, where
// nothing sits between "all interfaces" and the network. RELAY_BIND_HOST lets
// it stay on loopback; unset keeps the all-interfaces bind Railway needs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));

function waitFor(predicate, description, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timeout: ${description}`)); }
    }, 20);
  });
}

async function startRelay(t, extraEnv) {
  const ws = http.createServer((_req, res) => { res.writeHead(429); res.end(); });
  ws.listen(0, '127.0.0.1');
  await once(ws, 'listening');
  t.after(() => new Promise((resolve) => ws.close(resolve)));

  const env = {
    ...process.env,
    AISSTREAM_API_KEY: 'test-key',
    AISSTREAM_URL: `ws://127.0.0.1:${ws.address().port}/stream`,
    RELAY_SHARED_SECRET: 'relay-secret',
    RELAY_TEST_MODE: 'true',
    NODE_ENV: 'test',
    PORT: '0',
    ...extraEnv,
  };
  if (!('RELAY_BIND_HOST' in extraEnv)) delete env.RELAY_BIND_HOST;
  const child = spawn(process.execPath, [relayScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  const log = { text: '' };
  child.stdout.on('data', (chunk) => { log.text += chunk; });
  child.stderr.on('data', (chunk) => { log.text += chunk; });
  await waitFor(() => /WebSocket relay on port \d+/.test(log.text), 'relay startup');
  return log.text.match(/WebSocket relay on port \d+, host (\S+?)[ ,)]/)?.[1];
}

test('RELAY_BIND_HOST keeps the relay on loopback', async (t) => {
  assert.equal(await startRelay(t, { RELAY_BIND_HOST: '127.0.0.1' }), '127.0.0.1');
});

test('the relay still binds every interface when RELAY_BIND_HOST is unset', async (t) => {
  const host = await startRelay(t, {});
  assert.ok(host === '::' || host === '0.0.0.0', `expected an all-interfaces bind, got ${host}`);
});
