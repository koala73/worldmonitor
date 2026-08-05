import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayScript = path.resolve(here, '..', 'scripts', 'ais-relay.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

function waitFor(predicate, description, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${description}`));
      }
    }, 20);
  });
}

async function waitForAsync(predicate, description, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function getJson(port, pathname, headers = {}) {
  const response = await get(port, pathname, headers);
  assert.equal(response.status, 200);
  return JSON.parse(response.body);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('AISstream 429 keeps one reconnect cooldown under snapshot traffic and degrades top-level health', async (t) => {
  let upstreamAttempts = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamAttempts++;
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('rate limited');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${upstreamPort}/stream`,
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const portMatch = output.match(/WebSocket relay on port (\d+)/);
  assert.ok(portMatch, `expected bound relay port in startup output:\n${output}`);
  const relayPort = Number(portMatch[1]);

  const auth = { 'x-relay-key': 'relay-secret' };
  const first = await get(relayPort, '/ais/snapshot', auth);
  assert.equal(first.status, 200);
  await waitFor(
    () => upstreamAttempts === 1 && output.includes('AIS reconnect scheduled'),
    'first 429 and scheduled reconnect',
  );

  for (let i = 0; i < 10; i++) {
    const snapshot = await get(relayPort, '/ais/snapshot', auth);
    assert.equal(snapshot.status, 200);
  }

  assert.equal(
    upstreamAttempts,
    1,
    'snapshot requests during the provider cooldown must not trigger more upstream handshakes',
  );

  const healthResponse = await get(relayPort, '/health');
  assert.equal(healthResponse.status, 200, 'process liveness remains HTTP 200');
  const health = JSON.parse(healthResponse.body);
  assert.equal(health.status, 'degraded');
  assert.equal(health.ingestion.status, 'degraded');
  assert.deepEqual(
    {
      enabled: health.ingestion.aisSnapshot.enabled,
      status: health.ingestion.aisSnapshot.status,
      connected: health.ingestion.aisSnapshot.connected,
      hasData: health.ingestion.aisSnapshot.hasData,
      requests: health.ingestion.aisSnapshot.requests,
      served: health.ingestion.aisSnapshot.served,
    },
    {
      enabled: true,
      status: 'degraded',
      connected: false,
      hasData: false,
      requests: 11,
      served: 0,
    },
  );

  const upstreamHealth = health.ingestion.aisSnapshot.upstream;
  assert.equal(upstreamHealth.connectionAttemptsSinceBoot, 1);
  assert.equal(upstreamHealth.throttlesSinceBoot, 1);
  assert.equal(upstreamHealth.lastFailure, 'http_429');
  assert.ok(upstreamHealth.reconnectCooldownRemainingMs > 0);
});

test('AIS recovery requires an accepted frame and snapshot freshness requires a current PositionReport', async (t) => {
  let upstreamAttempts = 0;
  const upstreamSockets = [];
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (socket) => {
    const attempt = ++upstreamAttempts;
    upstreamSockets[attempt] = socket;
    socket.once('message', () => {
      if (attempt === 2) {
        socket.send(JSON.stringify({ MessageType: 'Heartbeat', status: 'ok' }));
        return;
      }
      socket.send(JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: attempt === 1 ? '111000111' : '333000333',
          ShipName: `TEST ${attempt}`,
        },
        Message: {
          PositionReport: {
            Latitude: 25 + attempt,
            Longitude: 55 + attempt,
            Sog: 12,
            Cog: 90,
            TrueHeading: 90,
          },
        },
      }));
    });
  });
  const upstreamPort = await listen(upstream);

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${upstreamPort}/stream`,
      AIS_SNAPSHOT_INTERVAL_MS: '2000',
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopChild(child);
    for (const socket of upstreamSockets) socket?.terminate();
    await new Promise((resolve) => upstreamWss.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const portMatch = output.match(/WebSocket relay on port (\d+)/);
  assert.ok(portMatch, `expected bound relay port in startup output:\n${output}`);
  const relayPort = Number(portMatch[1]);
  const auth = { 'x-relay-key': 'relay-secret' };

  await getJson(relayPort, '/ais/snapshot', auth);
  const initiallyHealthy = await waitForAsync(async () => {
    if (upstreamAttempts !== 1) return null;
    await getJson(relayPort, '/ais/snapshot', auth);
    const health = await getJson(relayPort, '/health');
    return health.status === 'ok' && health.ingestion.aisSnapshot.currentPositionReady
      ? health
      : null;
  }, 'first accepted PositionReport');
  assert.equal(initiallyHealthy.ingestion.aisSnapshot.upstream.successfulConnectionsSinceBoot, 1);
  assert.equal(initiallyHealthy.ingestion.aisSnapshot.upstream.reconnectFailures, 0);
  const messagesBeforeJunk = initiallyHealthy.messages;

  upstreamSockets[1].close();
  const retainedFallback = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    if (health.status !== 'degraded'
        || health.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot !== 1) {
      return null;
    }
    const snapshot = await getJson(relayPort, '/ais/snapshot', auth);
    return { snapshot, health };
  }, 'degraded retained-data fallback after first disconnect');
  assert.equal(retainedFallback.snapshot.status.vessels, 1);
  assert.equal(retainedFallback.snapshot.status.currentPositionReady, false);
  assert.equal(retainedFallback.health.ingestion.aisSnapshot.hasData, true);
  assert.equal(retainedFallback.health.ingestion.aisSnapshot.currentPositionReady, false);
  assert.equal(retainedFallback.health.ingestion.aisSnapshot.upstream.reconnectFailures, 1);

  const junkHealth = await waitForAsync(async () => {
    if (upstreamAttempts !== 2) return null;
    const health = await getJson(relayPort, '/health');
    return health.messages > messagesBeforeJunk ? health : null;
  }, 'junk frame on the second connection');
  assert.equal(junkHealth.status, 'degraded');
  assert.equal(junkHealth.ingestion.aisSnapshot.currentPositionReady, false);
  assert.equal(junkHealth.ingestion.aisSnapshot.upstream.successfulConnectionsSinceBoot, 1);
  assert.equal(junkHealth.ingestion.aisSnapshot.upstream.reconnectFailures, 1);

  upstreamSockets[2].close();
  const terminalFailure = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot === 2
      ? health
      : null;
  }, 'terminal failure after the junk-only connection');
  assert.equal(terminalFailure.status, 'degraded');
  assert.equal(terminalFailure.ingestion.aisSnapshot.upstream.lastFailure, 'closed_without_data');
  assert.equal(terminalFailure.ingestion.aisSnapshot.upstream.reconnectFailures, 2);

  const recovered = await waitForAsync(async () => {
    if (upstreamAttempts !== 3) return null;
    await getJson(relayPort, '/ais/snapshot', auth);
    const health = await getJson(relayPort, '/health');
    return health.status === 'ok'
      && health.ingestion.aisSnapshot.currentPositionReady
      && health.ingestion.aisSnapshot.upstream.successfulConnectionsSinceBoot === 2
      ? health
      : null;
  }, 'valid PositionReport recovery after terminal failure', 25_000);
  assert.equal(recovered.ingestion.aisSnapshot.upstream.reconnectFailures, 0);
  assert.equal(recovered.ingestion.aisSnapshot.upstream.lastFailure, null);
});
