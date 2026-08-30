'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const test = require('node:test');

function get(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
  });
}

async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

// Spawns the relay with the test preload and resolves { child, port } once
// test mode is ready. extraEnv layers on top of the shared baseline.
function spawnRelay(extraEnv) {
  const preload = path.join(__dirname, 'ais-relay-test-preload.cjs');
  const relay = path.join(__dirname, 'ais-relay.cjs');
  const child = spawn(process.execPath, [relay], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      RELAY_TEST_MODE: 'true',
      TELEGRAM_RPC_MIN_INTERVAL_MS: '1',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      RELAY_OPENSKY_RATE_LIMIT_MAX: '1000',
      OPENSKY_429_COOLDOWN_MS: '60000',
      OPENSKY_REQUEST_SPACING_MS: '1',
      OPENSKY_CLIENT_ID: 'test-client',
      OPENSKY_CLIENT_SECRET: 'test-secret',
      NODE_OPTIONS: `--require=${preload}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let port;
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk.toString();
      const portMatch = output.match(/WebSocket relay on port (\d+)/);
      if (portMatch) port = Number(portMatch[1]);
      if (port && output.includes('Test mode enabled')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`relay exited ${code}: ${output}`));
    });
  });

  return {
    child,
    getOutput: () => output,
    ready: ready.then(() => ({ child, port })),
  };
}

test('Telegram custom lookups honor the relay startup delay', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '5000',
    RELAY_TEST_TELEGRAM: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const response = await get(port, '/telegram/resolve?username=test_channel');
    assert.equal(response.status, 503);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(Number(response.headers['retry-after']) >= 1);
    // Public copy only: the relay's internal phrasing ('startup delay active',
    // 'session invalidated (AUTH_KEY_DUPLICATED)', raw MTProto text) must not
    // reach a browser holding a free session token.
    assert.match(response.body, /temporarily unavailable/);
    assert.doesNotMatch(response.body, /startup delay/);
    assert.doesNotMatch(relay.getOutput(), /Telegram client connected/);
  } finally {
    await stop(child);
  }
});

test('concurrent Telegram custom lookups share one cold connection', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_CONNECT_DELAY_MS: '100',
  });
  const { child, port } = await relay.ready;

  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => get(port, '/telegram/resolve?username=test_channel')),
    );
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200, 200, 200]);
    assert.equal(
      (relay.getOutput().match(/Telegram client connected/g) || []).length,
      1,
      'all cold requests must await one connection attempt',
    );
    assert.equal((relay.getOutput().match(/getEntity test_channel/g) || []).length, 1);
    assert.equal((relay.getOutput().match(/getFullChannel test_channel/g) || []).length, 1);
  } finally {
    await stop(child);
  }
});

test('Telegram channel lookups coalesce and normalize representative posts', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_RPC_DELAY_MS: '20',
    RELAY_TEST_TELEGRAM_MESSAGES: JSON.stringify([
      { id: 1, date: 1_700_000_000, message: 'Older update' },
      { id: 2, date: 1_700_000_100, message: '' },
      { id: 3, date: 1_700_000_200, message: 'Newer update' },
    ]),
  });
  const { child, port } = await relay.ready;

  try {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => get(port, '/telegram/channel?username=test_channel&limit=20')),
    );
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
    const payload = JSON.parse(responses[0].body);
    assert.equal(responses[0].headers['cache-control'], 'no-store');
    assert.equal(responses[0].headers['cdn-cache-control'], 'no-store');
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.items.map(item => item.id), ['test_channel:3', 'test_channel:1']);
    assert.equal(payload.items[0].url, 'https://t.me/test_channel/3');
    assert.equal(payload.items[0].topic, 'osint');
    assert.equal((relay.getOutput().match(/getEntity test_channel/g) || []).length, 1);
    assert.equal((relay.getOutput().match(/getMessages 20/g) || []).length, 1);
  } finally {
    await stop(child);
  }
});

test('timed-out Telegram RPCs reset the client and allow a clean reconnect', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_CHANNEL_TIMEOUT_MS: '25',
    TELEGRAM_RPC_MAX_CONCURRENCY: '1',
    // A client reset now needs a RUN of timeouts, so pin the threshold to 1 to
    // keep exercising the reset-and-reconnect path this test is about. The
    // "one slow channel fails alone" test covers the below-threshold case.
    TELEGRAM_MAX_CONSECUTIVE_RPC_TIMEOUTS: '1',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_RPC_NEVER_USERNAMES: 'stuck_channel',
    RELAY_TEST_TELEGRAM_DISCONNECT_DELAY_MS: '60',
    RELAY_TEST_TELEGRAM_DISCONNECT_REJECT: 'true',
    RELAY_TEST_TELEGRAM_SKIP_FULL_CHANNEL: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const timedOut = await get(port, '/telegram/resolve?username=stuck_channel');
    const reconnectStartedAt = Date.now();
    const recovered = await get(port, '/telegram/resolve?username=recovery_channel');
    // 504, not 502: a timeout is a gateway timeout, and the explicit status is
    // what lets the negative cache back a chronically slow channel off.
    assert.equal(timedOut.status, 504);
    assert.equal(recovered.status, 200);
    assert.ok(Date.now() - reconnectStartedAt >= 50, 'reconnect must wait for the old client to disconnect');
    assert.equal((relay.getOutput().match(/\[Relay\]\[TestTelegram\] connect/g) || []).length, 2);
    assert.equal((relay.getOutput().match(/getEntity recovery_channel/g) || []).length, 1);
  } finally {
    await stop(child);
  }
});

test('a hung member-count lookup degrades to null instead of failing the channel', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_CHANNEL_TIMEOUT_MS: '25',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_FULL_NEVER_USERNAMES: 'stuck_channel',
    RELAY_TEST_TELEGRAM_MESSAGES: JSON.stringify([
      { id: 1, date: 1_700_000_000, message: 'Still readable' },
    ]),
  });
  const { child, port } = await relay.ready;

  try {
    const stuck = await get(port, '/telegram/channel?username=stuck_channel&limit=20');
    // getFullChannel is explicitly best-effort (it only decorates the preview
    // with a member count), so its timeout must not fail the read. Previously
    // it tore the shared client down and surfaced as a 503.
    assert.equal(stuck.status, 200);
    const payload = JSON.parse(stuck.body);
    assert.equal(payload.count, 1);
    assert.equal(payload.items[0].text, 'Still readable');
    assert.equal((relay.getOutput().match(/getMessages 20 stuck_channel/g) || []).length, 1);

    const recovered = await get(port, '/telegram/channel?username=recovery_channel&limit=20');
    assert.equal(recovered.status, 200);
    // No teardown, so no reconnect: one connect for the whole test.
    assert.equal((relay.getOutput().match(/\[Relay\]\[TestTelegram\] connect/g) || []).length, 1);
  } finally {
    await stop(child);
  }
});

test('Telegram RPC queue rejects excess and expired work with 429', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_CHANNEL_TIMEOUT_MS: '500',
    TELEGRAM_RPC_MAX_CONCURRENCY: '1',
    TELEGRAM_RPC_MAX_QUEUE: '1',
    TELEGRAM_RPC_QUEUE_TIMEOUT_MS: '25',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_RPC_DELAY_MS: '100',
    RELAY_TEST_TELEGRAM_SKIP_FULL_CHANNEL: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const responses = await Promise.all([
      get(port, '/telegram/resolve?username=first_channel'),
      get(port, '/telegram/resolve?username=second_channel'),
      get(port, '/telegram/resolve?username=third_channel'),
    ]);
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.equal(responses.filter(response => response.status === 429).length, 2);
    assert.ok(responses.filter(response => response.status === 429)
      .every(response => Number(response.headers['retry-after']) >= 1));
  } finally {
    await stop(child);
  }
});

test('Telegram lookup failures are negative-cached by username', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_INVALID_USERNAMES: 'missing_channel',
  });
  const { child, port } = await relay.ready;

  try {
    const first = await get(port, '/telegram/resolve?username=missing_channel');
    const second = await get(port, '/telegram/resolve?username=missing_channel');
    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
    assert.equal((relay.getOutput().match(/getEntity missing_channel/g) || []).length, 1);
  } finally {
    await stop(child);
  }
});

test('Telegram FLOOD_WAIT opens a relay-wide cooldown with Retry-After', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_FLOOD_USERNAME: 'flood_channel',
    RELAY_TEST_TELEGRAM_FLOOD_SECONDS: '3',
  });
  const { child, port } = await relay.ready;

  try {
    const first = await get(port, '/telegram/resolve?username=flood_channel');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const cached = await get(port, '/telegram/resolve?username=flood_channel');
    const duringCooldown = await get(port, '/telegram/resolve?username=other_channel');
    assert.equal(first.status, 429);
    assert.equal(cached.status, 429);
    assert.equal(duringCooldown.status, 429);
    assert.ok(Number(first.headers['retry-after']) >= 2);
    assert.ok(Number(cached.headers['retry-after']) < Number(first.headers['retry-after']));
    assert.ok(Number(duringCooldown.headers['retry-after']) >= 1);
    assert.doesNotMatch(relay.getOutput(), /getEntity other_channel/);
  } finally {
    await stop(child);
  }
});

test('Telegram connect timeout clears the shared initializer for recovery', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_CONNECT_TIMEOUT_MS: '25',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_CONNECT_HANG_ATTEMPTS: '1',
  });
  const { child, port } = await relay.ready;

  try {
    const timedOut = await get(port, '/telegram/resolve?username=test_channel');
    const recovered = await get(port, '/telegram/resolve?username=test_channel');
    // A connect timeout is a gateway timeout like any other; getTelegramErrorStatus
    // now classifies the shared TIMEOUT shape explicitly instead of defaulting to 502.
    assert.equal(timedOut.status, 504);
    assert.equal(recovered.status, 200);
    assert.equal((relay.getOutput().match(/\[Relay\]\[TestTelegram\] connect/g) || []).length, 2);
  } finally {
    await stop(child);
  }
});

// Regression: a username is attacker-controlled and gramjs interpolates it
// verbatim into its lookup errors, so parsing a flood duration out of
// error.message let one GET park the process-wide cooldown ~31 trillion years
// out and permanently stop the curated poll along with every lookup.
test('a username shaped like FLOOD_WAIT cannot open a cooldown', async () => {
  const hostile = 'flood_wait_999999999';
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_INVALID_USERNAMES: hostile,
  });
  const { child, port } = await relay.ready;

  try {
    const attack = await get(port, `/telegram/resolve?username=${hostile}`);
    assert.equal(attack.status, 404, 'a non-existent username is a 404, never a flood');
    assert.equal(attack.headers['retry-after'], undefined, 'no cooldown may be derived from the username');

    // The real proof: an unrelated lookup still reaches Telegram afterwards.
    // Before the fix this returned 429 'FLOOD_WAIT cooldown active' forever.
    const bystander = await get(port, '/telegram/resolve?username=healthy_channel');
    assert.equal(bystander.status, 200);
    assert.match(relay.getOutput(), /getEntity healthy_channel/);
  } finally {
    await stop(child);
  }
});

test('a genuine FLOOD_WAIT is capped so one upstream value cannot wedge the relay', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_MAX_FLOOD_WAIT_MS: '2000',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_FLOOD_USERNAME: 'flood_channel',
    RELAY_TEST_TELEGRAM_FLOOD_SECONDS: '86400',
  });
  const { child, port } = await relay.ready;

  try {
    const flooded = await get(port, '/telegram/resolve?username=flood_channel');
    assert.equal(flooded.status, 429);
    assert.ok(
      Number(flooded.headers['retry-after']) <= 2,
      `expected the cap to clamp a 24h flood, got ${flooded.headers['retry-after']}s`,
    );
  } finally {
    await stop(child);
  }
});

test('non-channel and private entities are rejected without revealing which', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_USER_USERNAMES: 'a_real_person',
    RELAY_TEST_TELEGRAM_PRIVATE_USERNAMES: 'private_channel',
    RELAY_TEST_TELEGRAM_INVALID_USERNAMES: 'never_existed',
  });
  const { child, port } = await relay.ready;

  try {
    const user = await get(port, '/telegram/resolve?username=a_real_person');
    const private_ = await get(port, '/telegram/resolve?username=private_channel');
    const missing = await get(port, '/telegram/resolve?username=never_existed');

    assert.equal(user.status, 404, 'a user account is not a public channel');
    assert.equal(private_.status, 404, 'a channel with no public username is not resolvable');
    // Identical status AND body: a distinct 400 here was a username-existence
    // oracle paid for out of the shared account's resolve budget.
    assert.equal(missing.status, 404);
    assert.equal(user.body, missing.body);
    assert.equal(private_.body, missing.body);
  } finally {
    await stop(child);
  }
});

test('a Telegram disconnect that never settles does not wedge later lookups', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_CHANNEL_TIMEOUT_MS: '25',
    TELEGRAM_MAX_CONSECUTIVE_RPC_TIMEOUTS: '1',
    TELEGRAM_DISCONNECT_TIMEOUT_MS: '50',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_RPC_NEVER_USERNAMES: 'stuck_channel',
    RELAY_TEST_TELEGRAM_DISCONNECT_NEVER: 'true',
    RELAY_TEST_TELEGRAM_SKIP_FULL_CHANNEL: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const timedOut = await get(port, '/telegram/resolve?username=stuck_channel');
    assert.equal(timedOut.status, 504);

    // initTelegramClientIfNeeded awaits the disconnect promise before anything
    // else, so an unbounded await here blocked every future request forever.
    const recovered = await get(port, '/telegram/resolve?username=recovery_channel');
    assert.equal(recovered.status, 200);
  } finally {
    await stop(child);
  }
});

test('one slow channel fails alone instead of resetting the shared client', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    TELEGRAM_CHANNEL_TIMEOUT_MS: '25',
    TELEGRAM_MAX_CONSECUTIVE_RPC_TIMEOUTS: '3',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_TEST_TELEGRAM_RPC_NEVER_USERNAMES: 'stuck_channel',
    RELAY_TEST_TELEGRAM_SKIP_FULL_CHANNEL: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const timedOut = await get(port, '/telegram/resolve?username=stuck_channel');
    assert.equal(timedOut.status, 504);
    const recovered = await get(port, '/telegram/resolve?username=healthy_channel');
    assert.equal(recovered.status, 200);
    // A single timeout must not have torn the client down: exactly one connect.
    assert.equal(
      (relay.getOutput().match(/\[Relay\]\[TestTelegram\] connect/g) || []).length,
      1,
      'one slow channel must not reconnect the shared client',
    );
  } finally {
    await stop(child);
  }
});

test('the relay rejects a malformed username on its own, independent of the edge', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const bad = await get(port, '/telegram/resolve?username=bad%20handle');
    const short = await get(port, '/telegram/channel?username=abc&limit=20');
    assert.equal(bad.status, 400);
    assert.equal(short.status, 400);
    assert.doesNotMatch(relay.getOutput(), /getEntity bad/);
  } finally {
    await stop(child);
  }
});

test('the Telegram routes require the relay shared secret', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: '0',
    RELAY_TEST_TELEGRAM: 'true',
    RELAY_SHARED_SECRET: 'test-relay-secret',
    I_UNDERSTAND_THIS_DISABLES_AUTH: '',
  });
  const { child, port } = await relay.ready;

  try {
    // Every other Telegram test runs with auth disabled, so nothing pinned
    // these routes behind the gate. They are R4 post bodies on a public host.
    for (const route of ['/telegram/resolve?username=test_channel', '/telegram/channel?username=test_channel&limit=5', '/telegram/feed?limit=5']) {
      const anonymous = await get(port, route);
      assert.equal(anonymous.status, 401, `${route} must not be publicly readable`);
    }

    const authorized = await get(port, '/telegram/resolve?username=test_channel', {
      'x-relay-key': 'test-relay-secret',
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stop(child);
  }
});

test('malformed Telegram startup delay keeps the safe default', async () => {
  const relay = spawnRelay({
    TELEGRAM_API_ID: '123',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_STARTUP_DELAY_MS: 'not-a-number',
    RELAY_TEST_TELEGRAM: 'true',
  });
  const { child, port } = await relay.ready;

  try {
    const response = await get(port, '/telegram/resolve?username=test_channel');
    assert.equal(response.status, 503);
    assert.ok(Number(response.headers['retry-after']) >= 100);
    assert.doesNotMatch(relay.getOutput(), /\[Relay\]\[TestTelegram\] connect/);
  } finally {
    await stop(child);
  }
});

// Mock Upstash REST endpoint: records every command, acknowledges writes, and
// can return a deterministic response sequence for a specific Redis key.
async function createUpstashMock({ setResponses = {} } = {}) {
  const commands = [];
  const responseQueues = new Map(Object.entries(setResponses).map(([key, responses]) => [
    key,
    Array.isArray(responses) ? [...responses] : [responses],
  ]));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let command = null;
      try { command = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* non-JSON body */ }
      commands.push({ path: req.url, command });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/pipeline') {
        res.end(JSON.stringify((Array.isArray(command) ? command : []).map(() => ({ result: null }))));
        return;
      }
      const key = Array.isArray(command) ? command[1] : null;
      const queue = responseQueues.get(key);
      const response = queue?.length
        ? queue.shift()
        : (command?.[0] === 'EVAL' ? { result: 1 } : { result: 'OK' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    commands,
    setsFor: (key) => commands.filter(
      (entry) => Array.isArray(entry.command) && entry.command[0] === 'SET' && entry.command[1] === key,
    ),
    env: {
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('relay handlers expose bounded Google/OpenSky cooldowns and RSS fallback metrics', async () => {
  const { child, ready } = spawnRelay({
    RELAY_GOOGLE_FLIGHTS_RATE_LIMIT_MAX: '1000',
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    GF_429_COOLDOWN_MS: '60000',
    RELAY_TEST_GOOGLE_STATUS_SEQUENCE: '429',
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '429,200',
    RELAY_TEST_OPENSKY_RETRY_AFTER_SECONDS: '999999',
    RELAY_TEST_OPENSKY_REMAINING_CREDITS: '0',
    RELAY_TEST_OPENSKY_MALFORMED_ENCODING: '1',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;

    const googleFirst = await get(port, '/google-flights/search?origin=DXB&destination=LHR&departure_date=2026-08-03');
    assert.equal(googleFirst.status, 502);
    assert.match(googleFirst.body, /Google Flights returned 429/);

    const googleDuringCooldown = await get(port, '/google-flights/search?origin=JFK&destination=LAX&departure_date=2026-08-04');
    assert.equal(googleDuringCooldown.status, 200);
    assert.equal(JSON.parse(googleDuringCooldown.body).cooldown, true);
    assert.ok(Number(googleDuringCooldown.headers['retry-after']) >= 1);

    const [openskyFirst, openskyQueued] = await Promise.all([
      get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2'),
      get(port, '/opensky/states/all?lamin=3&lomin=3&lamax=4&lomax=4'),
    ]);
    assert.equal(openskyFirst.status, 429);
    assert.equal(openskyQueued.headers['x-cache'], 'RATE-LIMITED', 'queued bbox must stop before a second upstream debit');
    assert.ok(Number(openskyFirst.headers['retry-after']) >= 86_000, 'relay must honor the bounded provider reset window');
    assert.ok(Number(openskyFirst.headers['retry-after']) <= 86_400, 'provider reset must be capped at 24 hours');
    assert.ok(Number(openskyQueued.headers['retry-after']) >= 86_000, 'queued response must share the provider reset window');

    const openskyDuringCooldown = await get(port, '/opensky/states/all?lamin=5&lomin=5&lamax=6&lomax=6');
    assert.equal(openskyDuringCooldown.status, 200);
    assert.equal(openskyDuringCooldown.headers['x-cache'], 'RATE-LIMITED');
    assert.ok(Number(openskyDuringCooldown.headers['retry-after']) >= 86_000);

    const noCacheFeed = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=no-cache';
    const rssFirstFailure = await get(port, `/rss?url=${encodeURIComponent(noCacheFeed)}`);
    assert.equal(rssFirstFailure.status, 502);
    assert.ok(Number(rssFirstFailure.headers['retry-after']) >= 1);
    const rssBackoffFailure = await get(port, `/rss?url=${encodeURIComponent(noCacheFeed)}`);
    assert.equal(rssBackoffFailure.status, 503);
    assert.ok(Number(rssBackoffFailure.headers['retry-after']) >= 1);

    const staleFeed = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=stale';
    const rssFresh = await get(port, `/rss?url=${encodeURIComponent(staleFeed)}`);
    assert.equal(rssFresh.status, 200);
    await sleep(25);
    const rssStale = await get(port, `/rss?url=${encodeURIComponent(staleFeed)}`);
    assert.equal(rssStale.status, 200);
    assert.equal(rssStale.headers['x-cache'], 'STALE');
    const rssBackoffStale = await get(port, `/rss?url=${encodeURIComponent(staleFeed)}`);
    assert.equal(rssBackoffStale.status, 200);
    assert.equal(rssBackoffStale.headers['x-cache'], 'BACKOFF-STALE');

    const aisEmpty = await get(port, '/ais/snapshot');
    assert.equal(aisEmpty.status, 200);

    const health = JSON.parse((await get(port, '/health')).body);
    assert.equal(health.status, 'degraded', 'top-level JSON status must not hide degraded ingestion');
    assert.equal(health.ingestion.status, 'degraded');
    assert.equal(health.ingestion.aisSnapshot.served, 0);
    assert.equal(health.ingestion.aisSnapshot.connected, false);
    assert.ok(!('theaterPosture' in health.ingestion), 'public /health must not expose theaterPosture (#3802 surface discipline)');

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.googleFlights.requests, 2);
    assert.ok(metrics.googleFlights.throttle >= 2);
    assert.equal(metrics.googleFlights.fallback, 0, 'cooldown-only empty results are not usable fallback data');
    assert.ok(metrics.googleFlights.cooldownRemainingMs > 0);
    assert.equal(metrics.opensky.requests, 3);
    assert.ok(metrics.opensky.throttle >= 3);
    assert.equal(metrics.opensky.upstreamFetches, 1, 'one upstream 429 must atomically stop queued bbox work');
    assert.equal(metrics.opensky.rateLimitRemaining, 0);
    assert.ok(metrics.opensky.global429CooldownRemainingMs >= 86_000_000);
    assert.ok(metrics.rss.requests >= 5);
    assert.ok(metrics.rss.fallback >= 1);
    assert.ok(metrics.rss.backoffActiveFeeds >= 2);
    assert.ok(metrics.rss.maxBackoffRemainingMs > 0);
    assert.equal(metrics.aisSnapshot.success, 0);
    assert.equal(metrics.aisSnapshot.served, 0);
    assert.ok(metrics.aisSnapshot.terminalFailure >= 1);

    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const agedHealth = JSON.parse((await get(port, '/health')).body);
    assert.equal(agedHealth.ingestion.aviation.coverage.requests, 0, 'request samples must age out of the rolling window');
    assert.equal(agedHealth.ingestion.aviation.coverage.status, 'degraded', 'active provider reset must remain visible after samples age out');
  } finally {
    await stop(child);
  }
});

test('RSS keeps serving the last good body after an upstream 403 enters backoff', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=forbidden';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;

    const fresh = await get(port, requestPath);
    assert.equal(fresh.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const stale = await get(port, requestPath);
    assert.equal(stale.status, 200, stale.body);
    assert.equal(stale.headers['x-cache'], 'STALE');
    assert.match(stale.body, /<rss>/);

    const backoffStale = await get(port, requestPath);
    assert.equal(backoffStale.status, 200, backoffStale.body);
    assert.equal(backoffStale.headers['x-cache'], 'BACKOFF-STALE');
    assert.match(backoffStale.body, /<rss>/);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.rss.authRejection >= 1, 'the upstream 403 must remain observable');
    assert.ok(metrics.rss.fallback >= 2, 'both stale responses must be counted as fallback');
    assert.equal(metrics.rss.served, 3, 'fresh plus both stale responses must be served');
  } finally {
    await stop(child);
  }
});

test('RSS keeps serving the last good body after upstream 5xx and timeout failures', async () => {
  for (const [mode, outcome] of [['server-error', 'terminalFailure'], ['timeout', 'timeout']]) {
    const { child, ready } = spawnRelay({
      RELAY_RSS_RATE_LIMIT_MAX: '1000',
      RELAY_TEST_RSS_CACHE_TTL_MS: '10',
      RELAY_METRICS_WINDOW_SECONDS: '10',
    });

    try {
      const { port } = await ready;
      const feedUrl = `https://feeds.bbci.co.uk/news/world/rss.xml?test=${mode}`;
      const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;

      assert.equal((await get(port, requestPath)).status, 200);
      await sleep(25);

      const stale = await get(port, requestPath);
      assert.equal(stale.status, 200, stale.body);
      assert.equal(stale.headers['x-cache'], 'STALE');
      assert.match(stale.body, /<rss>/);

      const metrics = JSON.parse((await get(port, '/metrics')).body);
      assert.ok(metrics.rss[outcome] >= 1, `${mode} must remain observable`);
      assert.ok(metrics.rss.fallback >= 1, `${mode} must serve stale fallback`);
    } finally {
      await stop(child);
    }
  }
});

test('RSS counts concurrent stale deduplication as fallback', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=dedup';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;
    assert.equal((await get(port, requestPath)).status, 200);
    await sleep(25);

    const responses = await Promise.all([get(port, requestPath), get(port, requestPath)]);
    assert.ok(responses.every((response) => response.status === 200), responses.map((response) => response.body).join('\n'));
    assert.deepEqual(new Set(responses.map((response) => response.headers['x-cache'])), new Set(['STALE', 'DEDUP-STALE']));

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.rss.authRejection >= 2, 'leader and dedup follower must retain the upstream rejection outcome');
    assert.ok(metrics.rss.fallback >= 2, 'leader and dedup follower must count as fallback');
    assert.equal(metrics.rss.served, 3, 'fresh, stale leader, and stale dedup follower must be served');
  } finally {
    await stop(child);
  }
});

test('RSS keeps concurrent timeout followers on the stale no-store path', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=dedup-timeout';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;
    assert.equal((await get(port, requestPath)).status, 200);
    await sleep(25);

    const responses = await Promise.all([get(port, requestPath), get(port, requestPath)]);
    assert.ok(responses.every((response) => response.status === 200), responses.map((response) => response.body).join('\n'));
    assert.deepEqual(new Set(responses.map((response) => response.headers['x-cache'])), new Set(['STALE', 'DEDUP-STALE']));

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.rss.timeout >= 2, 'leader and dedup follower must retain the timeout outcome');
    assert.ok(metrics.rss.fallback >= 2, 'leader and dedup follower must count as fallback');
    assert.equal(metrics.rss.served, 3, 'fresh, stale leader, and stale dedup follower must be served');
  } finally {
    await stop(child);
  }
});

test('RSS retains stale bodies while cleanup runs during active backoff', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_TEST_RSS_CACHE_CLEANUP_INTERVAL_MS: '1000',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=forbidden';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;
    assert.equal((await get(port, requestPath)).status, 200);
    await sleep(25);
    assert.equal((await get(port, requestPath)).headers['x-cache'], 'STALE');

    await sleep(1200);
    const backoffStale = await get(port, requestPath);
    assert.equal(backoffStale.status, 200, backoffStale.body);
    assert.equal(backoffStale.headers['x-cache'], 'BACKOFF-STALE');
  } finally {
    await stop(child);
  }
});

test('Wingbits bbox relay tiles wide viewports without silently clipping coverage', async () => {
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    RELAY_TEST_WINGBITS_ECHO_AREAS: '1',
  });

  try {
    const { port } = await ready;
    const response = await get(port, '/wingbits/track?lamin=0&lomin=0&lamax=60&lomax=60');
    assert.equal(response.status, 200, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.positions.length, 4, '60 by 60 degrees must be covered by four bounded tiles');
    assert.ok(payload.positions.every((position) =>
      position.lat >= 0 && position.lat <= 60 && position.lon >= 0 && position.lon <= 60
    ));
  } finally {
    await stop(child);
  }
});

test('theater-posture Wingbits fallback publication is attributed to Wingbits, not OpenSky recovery', async () => {
  const upstash = await createUpstashMock();
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    ...upstash.env,
  });

  try {
    const { port } = await ready;

    // adsb.lol is stubbed to 503, so Wingbits carries the cycle without
    // consulting OpenSky. Two cycles prove the per-source counter accumulates.
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const trigger = await get(port, '/__test/seed-theater-posture');
      assert.equal(trigger.status, 200, `trigger ${cycle} failed: ${trigger.body}`);
      assert.equal(JSON.parse(trigger.body).ok, true);
    }

    const seedMetaSets = upstash.setsFor('seed-meta:theater-posture');
    assert.equal(seedMetaSets.length, 2, `expected two seed-meta writes, saw: ${JSON.stringify(upstash.commands.map((e) => e.command?.[1]))}`);
    for (const entry of seedMetaSets) {
      const seedMeta = JSON.parse(entry.command[2]);
      assert.equal(seedMeta.sourceVersion, 'wingbits', 'seed-meta must attribute the publishing source');
      assert.equal(seedMeta.producer, 'ais-relay', 'seed-meta must name which of the two writers produced it');
      assert.ok(seedMeta.recordCount >= 1);
    }

    const canonicalSets = upstash.setsFor('theater-posture:sebuf:v1');
    assert.equal(canonicalSets.length, 2, 'canonical theater posture must still publish');
    for (let i = 0; i < canonicalSets.length; i += 1) {
      const canonical = JSON.parse(canonicalSets[i].command[2]);
      const meta = JSON.parse(seedMetaSets[i].command[2]);
      assert.equal(canonical._seed.groupId, meta.publicationId, 'canonical envelope and seed-meta must identify one publication');
    }

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.theaterPosture, '/metrics must expose a theaterPosture section');
    assert.equal(metrics.theaterPosture.lastRun.source, 'wingbits');
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 1);
    assert.equal(metrics.theaterPosture.lastRun.redisOk, true);
    assert.equal(metrics.theaterPosture.lastRun.seedMetaOk, true);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 0, wingbits: 2, vesselOnly: 0 });

    // The acceptance gate itself: fallback publication must not read as OpenSky recovery.
    assert.equal(metrics.opensky.success, 0);
    assert.equal(metrics.opensky.served, 0);
    assert.equal(metrics.opensky.requests, 0);
    assert.equal(metrics.opensky.upstreamFetches, 0);
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture rejects Wingbits rows without usable theater coordinates', async () => {
  const upstash = await createUpstashMock();
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    RELAY_TEST_WINGBITS_GHOST_ROWS: '1',
    ...upstash.env,
  });

  try {
    const { port } = await ready;
    const trigger = await get(port, '/__test/seed-theater-posture');
    assert.equal(trigger.status, 200, `trigger failed: ${trigger.body}`);

    assert.equal(upstash.setsFor('theater-posture:sebuf:v1').length, 0);
    assert.equal(upstash.setsFor('theater_posture:sebuf:stale:v1').length, 0);
    assert.equal(upstash.setsFor('theater-posture:sebuf:backup:v1').length, 0);
    assert.equal(upstash.setsFor('seed-meta:theater-posture').length, 0);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'vessel-only');
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 0);
    assert.equal(metrics.theaterPosture.lastRun.published, false);
    assert.equal(metrics.theaterPosture.lastRun.reason, 'no-input-records');
    assert.equal(metrics.theaterPosture.emptyRejectionsSinceBoot, 1);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 0, wingbits: 0, vesselOnly: 0 });
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture publishes valid vessel-only evidence', async () => {
  const upstash = await createUpstashMock();
  const { child, ready } = spawnRelay({
    RELAY_TEST_ADSB_MODE_SEQUENCE: 'empty',
    RELAY_TEST_THEATER_VESSEL: '1',
    ...upstash.env,
  });

  try {
    const { port } = await ready;
    const trigger = await get(port, '/__test/seed-theater-posture');
    assert.equal(trigger.status, 200, `trigger failed: ${trigger.body}`);

    const seedMetaSets = upstash.setsFor('seed-meta:theater-posture');
    assert.equal(seedMetaSets.length, 1);
    const seedMeta = JSON.parse(seedMetaSets[0].command[2]);
    assert.equal(seedMeta.sourceVersion, 'vessel-only');
    assert.equal(seedMeta.recordCount, 1);
    assert.equal(upstash.setsFor('theater-posture:sebuf:v1').length, 1);
    assert.equal(upstash.setsFor('theater_posture:sebuf:stale:v1').length, 1);
    assert.equal(upstash.setsFor('theater-posture:sebuf:backup:v1').length, 1);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'vessel-only');
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 0);
    assert.equal(metrics.theaterPosture.lastRun.vesselCount, 1);
    assert.equal(metrics.theaterPosture.lastRun.published, true);
    assert.equal(metrics.theaterPosture.emptyRejectionsSinceBoot, 0);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 0, wingbits: 0, vesselOnly: 1 });
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture reports a canonical envelope write failure separately', async () => {
  const upstash = await createUpstashMock({
    setResponses: {
      'theater-posture:sebuf:v1': [{ result: 'ERR canonical unavailable' }],
    },
  });
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    ...upstash.env,
  });

  try {
    const { port } = await ready;
    const trigger = await get(port, '/__test/seed-theater-posture');
    assert.equal(trigger.status, 200, `trigger failed: ${trigger.body}`);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.redisOk, false);
    assert.equal(metrics.theaterPosture.lastRun.seedMetaOk, false);
    assert.equal(metrics.theaterPosture.lastRun.published, false);
    assert.equal(metrics.theaterPosture.lastRun.reason, 'write-failed');
    assert.ok(metrics.theaterPosture.lastRun.attemptedAt);
    assert.ok(!('seededAt' in metrics.theaterPosture.lastRun));
    assert.equal(upstash.setsFor('seed-meta:theater-posture').length, 0);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 0, wingbits: 0, vesselOnly: 0 });
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture reports a seed-meta write failure separately', async () => {
  const upstash = await createUpstashMock({
    setResponses: {
      'seed-meta:theater-posture': [{ result: 'ERR seed-meta unavailable' }],
    },
  });
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    ...upstash.env,
  });

  try {
    const { port } = await ready;
    const trigger = await get(port, '/__test/seed-theater-posture');
    assert.equal(trigger.status, 200, `trigger failed: ${trigger.body}`);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.redisOk, true);
    assert.equal(metrics.theaterPosture.lastRun.seedMetaOk, false);
    assert.equal(metrics.theaterPosture.lastRun.published, false);
    assert.equal(metrics.theaterPosture.lastRun.reason, 'write-failed');
    assert.ok(metrics.theaterPosture.lastRun.attemptedAt);
    assert.ok(!('seededAt' in metrics.theaterPosture.lastRun));
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 0, wingbits: 0, vesselOnly: 0 });
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture does not publish while the shared producer lock is held', async () => {
  const upstash = await createUpstashMock({
    setResponses: {
      'seed-lock:theater-posture': [{ result: null }],
    },
  });
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    ...upstash.env,
  });

  try {
    const { port } = await ready;
    const trigger = await get(port, '/__test/seed-theater-posture');
    assert.equal(trigger.status, 200, `trigger failed: ${trigger.body}`);
    assert.equal(upstash.setsFor('theater-posture:sebuf:v1').length, 0);
    assert.equal(upstash.setsFor('seed-meta:theater-posture').length, 0);
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture OpenSky success is attributed to opensky, and /metrics stays auth-gated', async () => {
  const upstash = await createUpstashMock();
  const { child, ready } = spawnRelay({
    RELAY_SHARED_SECRET: 'test-relay-secret',
    I_UNDERSTAND_THIS_DISABLES_AUTH: '',
    // One 200 is all a cycle should need — the seed issues a single global query.
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
    ...upstash.env,
  });
  const auth = { 'x-relay-key': 'test-relay-secret' };

  try {
    const { port } = await ready;

    // theaterPosture attribution must never ship on an unauthenticated surface.
    const unauthorized = await get(port, '/metrics');
    assert.equal(unauthorized.status, 401, '/metrics must stay auth-gated');

    // The seed cycle's own /opensky self-request runs through the authed
    // route (x-relay-key), matching the production configuration.
    const trigger = await get(port, '/__test/seed-theater-posture', auth);
    assert.equal(trigger.status, 200, `trigger failed: ${trigger.body}`);

    const seedMetaSets = upstash.setsFor('seed-meta:theater-posture');
    assert.equal(seedMetaSets.length, 1);
    assert.equal(JSON.parse(seedMetaSets[0].command[2]).sourceVersion, 'opensky');

    const metrics = JSON.parse((await get(port, '/metrics', auth)).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'opensky');
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 1);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 1, adsbLol: 0, wingbits: 0, vesselOnly: 0 });
    assert.ok(metrics.opensky.success >= 1, 'a real OpenSky 200 must be recorded as opensky success');
    // Credit budget (#6222): one seed cycle must debit exactly ONE upstream
    // /states/all. Every bbox above 400 sq° costs the same 4 credits as a
    // global query, so a per-region loop multiplies spend against the
    // 4,000/day quota while seeing less. upstreamFetches is the credit
    // counter — cache hits and dedup do not increment it.
    assert.equal(
      metrics.opensky.upstreamFetches, 1,
      `theater-posture debited ${metrics.opensky.upstreamFetches} OpenSky upstream fetches in one ` +
      'cycle; expected exactly 1 global query.',
    );
  } finally {
    await stop(child);
    await upstash.close();
  }
});

test('theater-posture uses adsb.lol, then Wingbits, without routine OpenSky debits', async () => {
  const upstash = await createUpstashMock();
  const { child, ready } = spawnRelay({
    RELAY_TEST_ADSB_MODE_SEQUENCE: 'flight,empty,malformed',
    WINGBITS_API_KEY: 'test-wingbits-key',
    ...upstash.env,
  });

  try {
    const { port } = await ready;

    // Cycle 1: adsb.lol serves one military aircraft — the win must be
    // attributed to adsb.lol, not Wingbits (catches swapped fallback arms).
    const first = await get(port, '/__test/seed-theater-posture');
    assert.equal(first.status, 200, `trigger 1 failed: ${first.body}`);
    let metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'adsb.lol');
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 1);

    // Cycle 2: adsb.lol answers an authoritative empty — the chain stops
    // without consulting Wingbits, but no evidence means there is no valid
    // posture publication. Preserve the last-known-good Redis envelopes and
    // metadata instead of replacing them with a fresh zero-record snapshot.
    const second = await get(port, '/__test/seed-theater-posture');
    assert.equal(second.status, 200, `trigger 2 failed: ${second.body}`);

    const seedMetaSets = upstash.setsFor('seed-meta:theater-posture');
    assert.equal(seedMetaSets.length, 1);
    assert.equal(JSON.parse(seedMetaSets[0].command[2]).sourceVersion, 'adsb.lol');
    assert.equal(upstash.setsFor('theater-posture:sebuf:v1').length, 1);
    assert.equal(upstash.setsFor('theater_posture:sebuf:stale:v1').length, 1);
    assert.equal(upstash.setsFor('theater-posture:sebuf:backup:v1').length, 1);

    const metricsAfterQuiet = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(
      metricsAfterQuiet.opensky.requests,
      0,
      'healthy adsb.lol cycles must not debit the authenticated OpenSky budget',
    );

    metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'vessel-only');
    assert.equal(metrics.theaterPosture.lastRun.published, false);
    assert.equal(metrics.theaterPosture.lastRun.reason, 'no-input-records');
    assert.equal(metrics.theaterPosture.emptyRejectionsSinceBoot, 1);
    // The Wingbits stub would have contributed a flight had the chain
    // consulted it: adsb.lol's authoritative empty answer stops the chain.
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 0);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 1, wingbits: 0, vesselOnly: 0 });

    // Cycle 3: adsb.lol returns malformed success, so Wingbits is the recovery source. OpenSky is
    // last-resort only and must not be touched while Wingbits is usable.
    const third = await get(port, '/__test/seed-theater-posture');
    assert.equal(third.status, 200, `trigger 3 failed: ${third.body}`);
    metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'wingbits');
    assert.equal(metrics.theaterPosture.lastRun.published, true);
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 1);
    assert.equal(metrics.opensky.requests, 0, 'Wingbits recovery must precede authenticated OpenSky');
    assert.equal(metrics.theaterPosture.emptyRejectionsSinceBoot, 1);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 1, wingbits: 1, vesselOnly: 0 });
  } finally {
    await stop(child);
    await upstash.close();
  }
});
