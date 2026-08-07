import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayScript = path.resolve(here, '..', 'scripts', 'ais-relay.cjs');
const delayedCompressionHook = path.resolve(
  here,
  'fixtures',
  'delay-first-ais-snapshot-compression.cjs',
);

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
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawBody,
          body: rawBody.toString('utf8'),
        });
      });
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

function parseJsonResponse(response) {
  let body = response.rawBody;
  if (response.headers['content-encoding'] === 'gzip') {
    body = gunzipSync(body);
  } else if (response.headers['content-encoding'] === 'br') {
    body = brotliDecompressSync(body);
  }
  return JSON.parse(body.toString('utf8'));
}

async function getJsonResponse(port, pathname, headers = {}) {
  const response = await get(port, pathname, headers);
  assert.equal(response.status, 200);
  return { json: parseJsonResponse(response), response };
}

async function getJson(port, pathname, headers = {}) {
  const { json } = await getJsonResponse(port, pathname, headers);
  return json;
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

test('non-429 handshake errors record one terminal failure and keep the reconnect cooldown', async (t) => {
  let upstreamAttempts = 0;
  const upstream = net.createServer((socket) => {
    upstreamAttempts++;
    socket.destroy();
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

  await getJson(relayPort, '/ais/snapshot', auth);
  const failedHealth = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.lastFailure === 'connection_error'
      && health.ingestion.aisSnapshot.upstream.reconnectCooldownRemainingMs > 0
      ? health
      : null;
  }, 'non-429 handshake failure');
  assert.equal(failedHealth.status, 'degraded');
  assert.equal(failedHealth.ingestion.aisSnapshot.upstream.connectionAttemptsSinceBoot, 1);
  assert.equal(failedHealth.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot, 1);

  for (let i = 0; i < 5; i++) await getJson(relayPort, '/ais/snapshot', auth);
  assert.equal(upstreamAttempts, 1, 'snapshot traffic must preserve the error reconnect cooldown');
});

test('stalled WebSocket handshakes time out into the bounded reconnect schedule', async (t) => {
  let upstreamAttempts = 0;
  const upstreamSockets = new Set();
  const upstream = net.createServer((socket) => {
    upstreamAttempts++;
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${upstreamPort}/stream`,
      AIS_HANDSHAKE_TIMEOUT_MS: '1000',
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

  await getJson(relayPort, '/ais/snapshot', auth);
  const timedOutHealth = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.lastFailure === 'connection_error'
      && health.ingestion.aisSnapshot.upstream.reconnectCooldownRemainingMs > 0
      ? health
      : null;
  }, 'stalled handshake timeout', 5_000);

  assert.equal(timedOutHealth.status, 'degraded');
  assert.equal(timedOutHealth.ingestion.aisSnapshot.upstream.connectionAttemptsSinceBoot, 1);
  assert.equal(timedOutHealth.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot, 1);
  for (let i = 0; i < 5; i++) await getJson(relayPort, '/ais/snapshot', auth);
  assert.equal(upstreamAttempts, 1, 'snapshot traffic must preserve the timeout reconnect cooldown');
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
        socket.send(JSON.stringify({
          MessageType: 'PositionReport',
          MetaData: { MMSI: '222000222', ShipName: 'INVALID POSITION' },
          Message: {
            PositionReport: {
              Latitude: 91,
              Longitude: 181,
              Sog: 12,
              Cog: 90,
              TrueHeading: 90,
            },
          },
        }));
        return;
      }
      if (attempt === 3) {
        socket.send(JSON.stringify({
          MessageType: 'ShipStaticData',
          MetaData: { MMSI: '222000222', ShipName: 'STATIC ONLY' },
          Message: {
            ShipStaticData: {
              UserID: 222000222,
              Type: 85,
              Name: 'STATIC ONLY',
            },
          },
        }));
        return;
      }
      socket.send(JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: {
          MMSI: attempt === 1 ? '111000111' : '444000444',
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
  for (const encoding of ['gzip', 'br']) {
    await waitForAsync(async () => {
      const { response } = await getJsonResponse(relayPort, '/ais/snapshot', {
        ...auth,
        'accept-encoding': encoding,
      });
      return response.headers['content-encoding'] === encoding;
    }, `initial ${encoding} snapshot cache`);
  }

  upstreamSockets[1].close();
  const retainedFallback = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    if (health.status !== 'degraded'
        || health.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot !== 1) {
      return null;
    }
    const { json: snapshot } = await getJsonResponse(relayPort, '/ais/snapshot', {
      ...auth,
      'accept-encoding': 'gzip',
    });
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
  }, 'junk and invalid-position frames on the second connection');
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

  const staticOnly = await waitForAsync(async () => {
    if (upstreamAttempts !== 3) return null;
    const health = await getJson(relayPort, '/health');
    return health.status === 'degraded'
      && !health.ingestion.aisSnapshot.currentPositionReady
      && health.ingestion.aisSnapshot.upstream.successfulConnectionsSinceBoot === 2
      ? health
      : null;
  }, 'accepted ShipStaticData without current-position readiness', 25_000);
  assert.equal(staticOnly.ingestion.aisSnapshot.upstream.reconnectFailures, 0);
  assert.equal(staticOnly.ingestion.aisSnapshot.upstream.lastFailure, null);
  await waitForAsync(async () => {
    const { response } = await getJsonResponse(relayPort, '/ais/snapshot', {
      ...auth,
      'accept-encoding': 'br',
    });
    return response.headers['content-encoding'] === 'br';
  }, 'static-only Brotli snapshot cache');

  upstreamSockets[3].close();
  const staticDisconnect = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot === 3
      ? health
      : null;
  }, 'terminal failure after the static-data connection');
  assert.equal(staticDisconnect.ingestion.aisSnapshot.upstream.lastFailure, 'disconnected');
  assert.equal(staticDisconnect.ingestion.aisSnapshot.upstream.reconnectFailures, 1);

  const recovered = await waitForAsync(async () => {
    if (upstreamAttempts !== 4) return null;
    const health = await getJson(relayPort, '/health');
    return health.status === 'ok'
      && health.ingestion.aisSnapshot.currentPositionReady
      && health.ingestion.aisSnapshot.upstream.successfulConnectionsSinceBoot === 3
      ? health
      : null;
  }, 'valid PositionReport recovery after static-only connection', 30_000);
  const { json: recoveredSnapshot } = await getJsonResponse(relayPort, '/ais/snapshot', {
    ...auth,
    'accept-encoding': 'br',
  });
  assert.equal(recoveredSnapshot.status.currentPositionReady, true);
  assert.equal(recovered.ingestion.aisSnapshot.upstream.reconnectFailures, 0);
  assert.equal(recovered.ingestion.aisSnapshot.upstream.lastFailure, null);
});

test('late compression callbacks cannot overwrite a newer AIS snapshot generation', async (t) => {
  let upstreamSocket;
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (socket) => {
    upstreamSocket = socket;
  });
  const upstreamPort = await listen(upstream);

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${upstreamPort}/stream`,
      AIS_SNAPSHOT_INTERVAL_MS: '60000',
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${delayedCompressionHook}`,
      ].filter(Boolean).join(' '),
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopChild(child);
    upstreamSocket?.terminate();
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
  const initial = await getJson(relayPort, '/ais/snapshot', auth);
  assert.equal(initial.status.currentPositionReady, false);
  await waitFor(
    () => upstreamSocket?.readyState === 1,
    'upstream WebSocket connection',
  );

  upstreamSocket.send(JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: { MMSI: '666000666', ShipName: 'NEW GENERATION' },
    Message: {
      PositionReport: {
        Latitude: 25,
        Longitude: 55,
        Sog: 12,
        Cog: 90,
        TrueHeading: 90,
      },
    },
  }));

  await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.currentPositionReady;
  }, 'newer position-ready generation');
  const current = await getJson(relayPort, '/ais/snapshot', auth);
  assert.equal(current.status.currentPositionReady, true);
  await new Promise((resolve) => setTimeout(resolve, 650));

  for (const encoding of ['gzip', 'br']) {
    const { json, response } = await getJsonResponse(relayPort, '/ais/snapshot', {
      ...auth,
      'accept-encoding': encoding,
    });
    assert.equal(response.headers['content-encoding'], encoding);
    assert.equal(json.status.currentPositionReady, true);
    assert.equal(json.status.vessels, 1);
  }
});

test('AIS health expires an open stream that stops delivering current positions', async (t) => {
  let upstreamAttempts = 0;
  const upstreamSockets = [];
  const upstream = http.createServer();
  const upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (socket) => {
    const attempt = ++upstreamAttempts;
    upstreamSockets.push(socket);
    socket.once('message', () => {
      socket.send(JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: { MMSI: `55500055${attempt}`, ShipName: `SILENT STREAM ${attempt}` },
        Message: {
          PositionReport: {
            Latitude: 25,
            Longitude: 55,
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
      AIS_POSITION_FRESHNESS_MS: '1000',
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
    for (const socket of upstreamSockets) socket.terminate();
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
  await waitForAsync(async () => {
    await getJson(relayPort, '/ais/snapshot', auth);
    const health = await getJson(relayPort, '/health');
    return health.status === 'ok' && health.ingestion.aisSnapshot.currentPositionReady;
  }, 'initial current position');

  const timedOut = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.status === 'degraded'
      && health.ingestion.aisSnapshot.hasData
      && !health.ingestion.aisSnapshot.currentPositionReady
      && health.ingestion.aisSnapshot.upstream.lastFailure === 'position_timeout'
      ? health
      : null;
  }, 'position-silent stream timeout', 5_000);
  assert.equal(timedOut.ingestion.aisSnapshot.connected, false);
  assert.equal(timedOut.ingestion.aisSnapshot.upstream.terminalFailuresSinceBoot, 1);
  assert.equal(timedOut.ingestion.aisSnapshot.upstream.reconnectFailures, 1);

  const snapshot = await getJson(relayPort, '/ais/snapshot', auth);
  assert.equal(snapshot.status.connected, false);
  assert.equal(snapshot.status.currentPositionReady, false);
  assert.equal(snapshot.status.vessels, 1);

  const recovered = await waitForAsync(async () => {
    if (upstreamAttempts !== 2) return null;
    await getJson(relayPort, '/ais/snapshot', auth);
    const health = await getJson(relayPort, '/health');
    return health.status === 'ok'
      && health.ingestion.aisSnapshot.currentPositionReady
      && health.ingestion.aisSnapshot.upstream.successfulConnectionsSinceBoot === 2
      ? health
      : null;
  }, 'bounded reconnect after position timeout', 8_000);
  assert.equal(recovered.ingestion.aisSnapshot.upstream.reconnectFailures, 0);
});

test('sustained upstream throttling escalates the reconnect ceiling beyond the ordinary cap', async (t) => {
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
      // Compress the ladder so escalation is observable without waiting out
      // the production 5s base / 5min ceiling.
      AIS_RECONNECT_BASE_MS: '100',
      AIS_RECONNECT_MAX_MS: '300',
      AIS_THROTTLE_RECONNECT_MAX_MS: '60000',
      AIS_THROTTLE_ESCALATE_AFTER: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const relayPort = Number(output.match(/WebSocket relay on port (\d+)/)[1]);

  // Upstream connection is lazy — a snapshot request kicks off the first attempt,
  // after which the bounded reconnect timer drives the ladder on its own.
  await get(relayPort, '/ais/snapshot', { 'x-relay-key': 'relay-secret' });

  // Four consecutive 429s crosses the escalate-after=3 threshold.
  await waitFor(() => upstreamAttempts >= 4, 'four consecutive upstream throttles', 15_000);

  // Wait for escalation AND a live cooldown together. `throttleEscalated` is
  // sticky but `upstreamReconnectAt` is zeroed the instant the reconnect timer
  // fires, so sampling the cooldown separately can land mid-handshake and read 0.
  const escalated = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    const upstreamHealth = health.ingestion.aisSnapshot.upstream;
    return upstreamHealth.throttleEscalated === true
      && upstreamHealth.reconnectCooldownRemainingMs > 300
      ? upstreamHealth
      : null;
  }, 'escalated cooldown above the ordinary 300ms ceiling', 15_000);

  assert.ok(
    escalated.consecutiveThrottles >= 3,
    `expected consecutive throttles to be tracked, got ${escalated.consecutiveThrottles}`,
  );
});

test('a non-throttle failure resets throttle escalation back to the ordinary ceiling', async (t) => {
  let upstreamAttempts = 0;
  let throttling = true;
  const upstream = http.createServer((_req, res) => {
    upstreamAttempts++;
    if (throttling) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('rate limited');
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('upstream boom');
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
      AIS_RECONNECT_BASE_MS: '100',
      AIS_RECONNECT_MAX_MS: '300',
      AIS_THROTTLE_RECONNECT_MAX_MS: '4000',
      AIS_THROTTLE_ESCALATE_AFTER: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const relayPort = Number(output.match(/WebSocket relay on port (\d+)/)[1]);

  // Upstream connection is lazy — a snapshot request kicks off the first attempt.
  await get(relayPort, '/ais/snapshot', { 'x-relay-key': 'relay-secret' });

  await waitFor(() => upstreamAttempts >= 4, 'four consecutive upstream throttles', 15_000);
  await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.throttleEscalated === true ? health : null;
  }, 'throttle escalation engaged', 15_000);

  // Upstream stops throttling and starts failing for an unrelated reason.
  throttling = false;

  const reset = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    const upstreamHealth = health.ingestion.aisSnapshot.upstream;
    return upstreamHealth.throttleEscalated === false ? upstreamHealth : null;
  }, 'escalation cleared by a non-throttle failure', 30_000);

  assert.equal(reset.consecutiveThrottles, 0);
  assert.ok(
    reset.reconnectCooldownRemainingMs <= 300,
    `after reset the cooldown ${reset.reconnectCooldownRemainingMs}ms must fall back under the ordinary 300ms ceiling`,
  );
});

test('a throttle ceiling configured below the ordinary ceiling cannot shorten the backoff', async (t) => {
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
      AIS_RECONNECT_BASE_MS: '100',
      AIS_RECONNECT_MAX_MS: '2000',
      // Misconfigured BELOW the ordinary ceiling: escalation must clamp up to
      // the ordinary ceiling rather than reconnect faster while throttled.
      AIS_THROTTLE_RECONNECT_MAX_MS: '100',
      AIS_THROTTLE_ESCALATE_AFTER: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const relayPort = Number(output.match(/WebSocket relay on port (\d+)/)[1]);

  await get(relayPort, '/ais/snapshot', { 'x-relay-key': 'relay-secret' });
  await waitFor(() => upstreamAttempts >= 4, 'four consecutive upstream throttles', 15_000);

  // Same joint wait as above: a separate cooldown sample can race the reconnect
  // timer zeroing `upstreamReconnectAt` and read 0 mid-handshake.
  await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    const upstreamHealth = health.ingestion.aisSnapshot.upstream;
    return upstreamHealth.throttleEscalated === true
      && upstreamHealth.reconnectCooldownRemainingMs > 500
      ? upstreamHealth
      : null;
  }, 'escalated cooldown that did not collapse toward the misconfigured 100ms ceiling', 15_000);
});

// Throttle-escalated upstream that answers the first `throttleUpgrades` WebSocket
// upgrades with HTTP 429, then accepts. `onOpen` decides what the accepted socket
// does, which is what selects the production reset site under test.
async function startThrottleThenAcceptUpstream({ throttleUpgrades, onOpen }) {
  let upgradeAttempts = 0;
  const accepted = [];
  const upstream = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    upgradeAttempts += 1;
    if (upgradeAttempts <= throttleUpgrades) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      accepted.push(ws);
      onOpen(ws);
    });
  });
  const port = await listen(upstream);
  // http.Server#close waits for live connections to end, so an accepted socket
  // left open would stall teardown until the relay's position watchdog fires
  // (5 minutes by default). Terminate accepted sockets first.
  const close = () => new Promise((resolve) => {
    for (const ws of accepted) ws.terminate();
    upstream.close(resolve);
  });
  return { upstream, port, close, attempts: () => upgradeAttempts };
}

test('an accepted frame clears throttle escalation', async (t) => {
  // Accepted socket immediately delivers a valid PositionReport, so recovery runs
  // through the accepted-frame reset rather than any failure path.
  const { close: closeUpstream, port: upstreamPort } = await startThrottleThenAcceptUpstream({
    throttleUpgrades: 4,
    onOpen: (ws) => {
      const sendPosition = () => ws.send(JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: { MMSI: '111000111', ShipName: 'RECOVERED' },
        Message: {
          PositionReport: { Latitude: 25.5, Longitude: 55.5, Sog: 12, Cog: 90, TrueHeading: 90 },
        },
      }));
      ws.once('message', () => {
        sendPosition();
        // Keep the stream current so the position watchdog never fires. Without
        // this the socket goes silent, the watchdog closes it, and the
        // clean-close reset would clear the escalation instead — giving the
        // fixture a second path to the verdict and making this test vacuous.
        const keepAlive = setInterval(sendPosition, 250);
        ws.once('close', () => clearInterval(keepAlive));
      });
    },
  });
  t.after(closeUpstream);

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${upstreamPort}/stream`,
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
      AIS_RECONNECT_BASE_MS: '100',
      AIS_RECONNECT_MAX_MS: '300',
      AIS_THROTTLE_RECONNECT_MAX_MS: '2000',
      AIS_THROTTLE_ESCALATE_AFTER: '3',
      // Keep teardown bounded: without this the accepted socket stays open on the
      // production 5-minute default and stalls the suite.
      AIS_POSITION_FRESHNESS_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const relayPort = Number(output.match(/WebSocket relay on port (\d+)/)[1]);

  await get(relayPort, '/ais/snapshot', { 'x-relay-key': 'relay-secret' });
  await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.throttleEscalated === true ? health : null;
  }, 'throttle escalation engaged', 20_000);

  // `connected === true` is the isolation: the socket is still open, so no close
  // handler has run and the accepted-frame reset is the only path that could have
  // cleared the escalation.
  const recovered = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    const upstreamHealth = health.ingestion.aisSnapshot.upstream;
    return upstreamHealth.throttleEscalated === false
      && upstreamHealth.connected === true
      && upstreamHealth.successfulConnectionsSinceBoot > 0
      ? upstreamHealth
      : null;
  }, 'escalation cleared by an accepted frame on a still-open socket', 30_000);

  assert.equal(recovered.consecutiveThrottles, 0);
  assert.equal(recovered.connected, true, 'socket must still be open — no close path involved');
});

test('a clean close with no recorded error clears throttle escalation', async (t) => {
  // Accepted socket stays open and silent, so the position watchdog terminates it.
  // That close records no error, exercising the clean-close reset specifically.
  const { close: closeUpstream, port: upstreamPort } = await startThrottleThenAcceptUpstream({
    throttleUpgrades: 4,
    onOpen: () => { /* accept, then deliver nothing */ },
  });
  t.after(closeUpstream);

  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      AISSTREAM_API_KEY: 'test-key',
      AISSTREAM_URL: `ws://127.0.0.1:${upstreamPort}/stream`,
      RELAY_SHARED_SECRET: 'relay-secret',
      RELAY_TEST_MODE: 'true',
      NODE_ENV: 'test',
      PORT: '0',
      AIS_RECONNECT_BASE_MS: '100',
      AIS_RECONNECT_MAX_MS: '300',
      AIS_THROTTLE_RECONNECT_MAX_MS: '2000',
      AIS_THROTTLE_ESCALATE_AFTER: '3',
      AIS_POSITION_FRESHNESS_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stopChild(child));

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  await waitFor(() => output.includes('WebSocket relay on port'), 'relay startup');
  const relayPort = Number(output.match(/WebSocket relay on port (\d+)/)[1]);

  await get(relayPort, '/ais/snapshot', { 'x-relay-key': 'relay-secret' });
  await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    return health.ingestion.aisSnapshot.upstream.throttleEscalated === true ? health : null;
  }, 'throttle escalation engaged', 20_000);

  const recovered = await waitForAsync(async () => {
    const health = await getJson(relayPort, '/health');
    const upstreamHealth = health.ingestion.aisSnapshot.upstream;
    return upstreamHealth.throttleEscalated === false
      && upstreamHealth.lastFailure === 'position_timeout'
      ? upstreamHealth
      : null;
  }, 'escalation cleared by a silent-stream close', 30_000);

  assert.equal(recovered.consecutiveThrottles, 0);
  // position_timeout is only reachable via the close handler's no-error branch,
  // so this pins the clean-close reset rather than the non-throttle error reset.
  assert.equal(recovered.lastFailure, 'position_timeout');
});
