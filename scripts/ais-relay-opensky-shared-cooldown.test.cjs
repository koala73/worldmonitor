'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  cooldownKeyForAccount,
  OPENSKY_LEGACY_COOLDOWN_KEY,
  OPENSKY_SHARED_FALLBACK_COOLDOWN_MS,
  OPENSKY_MAX_DEADLINE_SET_LUA,
  accountFingerprint,
  buildCooldownRecord,
  ttlSecondsForCooldown,
} = require('./_opensky-account-cooldown.cjs');
const OPENSKY_COOLDOWN_KEY = cooldownKeyForAccount(accountFingerprint('test-client'));

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath }, (response) => {
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

function spawnRelay(extraEnv) {
  const preload = path.join(__dirname, 'ais-relay-test-preload.cjs');
  const relay = path.join(__dirname, 'ais-relay.cjs');
  const child = spawn(process.execPath, [relay], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      RELAY_TEST_MODE: 'true',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      RELAY_OPENSKY_RATE_LIMIT_MAX: '1000',
      OPENSKY_429_COOLDOWN_MS: '60000',
      OPENSKY_REQUEST_SPACING_MS: '1',
      OPENSKY_CLIENT_ID: 'test-client',
      OPENSKY_CLIENT_SECRET: 'test-secret',
      OPENSKY_LEGACY_COOLDOWN_COMPAT_UNTIL: '2099-01-01T00:00:00.000Z',
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

  return { child, output: () => output, ready: ready.then(() => ({ child, port })) };
}

async function createUpstashMock({ getResponses = {}, failGets = false, getDelayMs = 0 } = {}) {
  const commands = [];
  const pendingTimers = new Set();
  const getWaiters = new Set();
  const getQueues = new Map(Object.entries(getResponses).map(([key, responses]) => [
    key,
    Array.isArray(responses) ? [...responses] : [responses],
  ]));
  const getCount = (key) => commands.filter(
    (entry) => entry.method === 'GET' && entry.path === '/get/' + encodeURIComponent(key),
  ).length;
  const notifyGetWaiters = () => {
    for (const waiter of [...getWaiters]) {
      if (getCount(waiter.key) < waiter.count) continue;
      clearTimeout(waiter.timer);
      getWaiters.delete(waiter);
      waiter.resolve();
    }
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let command = null;
      try { command = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* GET /get */ }
      commands.push({ method: req.method, path: req.url, command });
      if (req.method === 'GET' && req.url.startsWith('/get/')) notifyGetWaiters();
      const respond = () => {
        if (res.writableEnded) return;
        res.setHeader('Content-Type', 'application/json');
        if (failGets && req.method === 'GET') {
          res.statusCode = 500;
          res.end('redis down');
          return;
        }
        if (req.method === 'GET' && req.url.startsWith('/get/')) {
          const key = decodeURIComponent(req.url.slice('/get/'.length));
          const queue = getQueues.get(key);
          const next = queue?.length ? queue.shift() : { result: null };
          res.end(JSON.stringify(next));
          return;
        }
        res.end(JSON.stringify({ result: 'OK' }));
      };
      if (getDelayMs > 0 && req.method === 'GET') {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          respond();
        }, getDelayMs);
        pendingTimers.add(timer);
        res.on('close', () => {
          if (pendingTimers.delete(timer)) clearTimeout(timer);
        });
        return;
      }
      respond();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    commands,
    getsFor: (key) => commands.filter(
      (entry) => entry.method === 'GET' && entry.path === `/get/${encodeURIComponent(key)}`,
    ),
    waitForGets: (key, count, timeoutMs = 2_000) => {
      if (getCount(key) >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { key, count, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          getWaiters.delete(waiter);
          reject(new Error('timed out waiting for ' + count + ' GETs for ' + key));
        }, timeoutMs);
        getWaiters.add(waiter);
      });
    },
    setGetResponses: (key, responses) => {
      getQueues.set(key, Array.isArray(responses) ? [...responses] : [responses]);
    },
    setsFor: (key) => commands.filter(
      (entry) => Array.isArray(entry.command) && entry.command[0] === 'SET' && entry.command[1] === key,
    ),
    evalsFor: (key) => commands.filter((entry) => {
      if (!Array.isArray(entry.command) || entry.command[0] !== 'EVAL') return false;
      const keyCount = Number(entry.command[2]);
      return entry.command.slice(3, 3 + keyCount).includes(key);
    }),
    env: {
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
    },
    close: () => {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      for (const waiter of getWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Upstash mock closed while a GET waiter was pending'));
      }
      getWaiters.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function evalArgs(command) {
  const keyCount = Number(command[2]);
  return command.slice(3 + keyCount);
}

test('a header-less relay 429 persists a seeder-cadence fallback, not the 90s local default', async () => {
  const redis = await createUpstashMock();
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '429',
    // No RELAY_TEST_OPENSKY_RETRY_AFTER_SECONDS — the real writer must not
    // persist the relay's 90s/60s local default when the header is absent.
  });
  try {
    const { port } = await ready;
    const first = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(first.status, 429);
    assert.equal(redis.setsFor(OPENSKY_COOLDOWN_KEY).length, 0, 'relay must not last-write-wins SET the shared cooldown');
    const evals = redis.evalsFor(OPENSKY_COOLDOWN_KEY);
    assert.equal(evals.length, 1, 'relay must write the shared cooldown key on a header-less 429');
    assert.equal(evals[0].command[1], OPENSKY_MAX_DEADLINE_SET_LUA);
    const args = evalArgs(evals[0].command);
    const record = JSON.parse(args[0]);
    assert.equal(record.recordedBy, 'ais-relay');
    assert.equal(record.retryAfterSeconds, null);
    assert.equal(record.cooldownMs, OPENSKY_SHARED_FALLBACK_COOLDOWN_MS);
    assert.ok(
      record.until >= Date.now() + 300_000,
      `shared deadline ${record.until} must span the seeder */5 cadence`,
    );
    assert.equal(
      args[1],
      String(ttlSecondsForCooldown(OPENSKY_SHARED_FALLBACK_COOLDOWN_MS)),
      'Redis TTL must cover the persist fallback, not the short local cooldown',
    );
    const during = await get(port, '/opensky/states/all?lamin=3&lomin=3&lamax=4&lomax=4');
    assert.equal(during.status, 200);
    assert.equal(during.headers['x-cache'], 'RATE-LIMITED');
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a relay 429 persists the shared cooldown key the seeder reads (#6253)', async () => {
  const redis = await createUpstashMock();
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '429',
    RELAY_TEST_OPENSKY_RETRY_AFTER_SECONDS: '120',
  });
  try {
    const { port } = await ready;
    const first = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(first.status, 429);
    const sets = redis.setsFor(OPENSKY_COOLDOWN_KEY);
    assert.equal(sets.length, 0, 'relay must not last-write-wins SET the shared cooldown');
    const evals = redis.evalsFor(OPENSKY_COOLDOWN_KEY);
    assert.equal(evals.length, 1, 'relay must write the shared cooldown key on 429');
    assert.equal(evals[0].command[1], OPENSKY_MAX_DEADLINE_SET_LUA);
    const record = JSON.parse(evalArgs(evals[0].command)[0]);
    assert.equal(record.recordedBy, 'ais-relay');
    assert.equal(record.account, accountFingerprint('test-client'));
    assert.equal(record.retryAfterSeconds, 120);
    assert.ok(record.until > Date.now());
    assert.equal(evals[0].command[2], '2', 'the rollout write must update v2 and v1 in one EVAL');
    assert.equal(redis.evalsFor(OPENSKY_LEGACY_COOLDOWN_KEY).length, 1, 'old readers must see the new cooldown');
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a matching legacy v1 cooldown is honored and copied into the account v2 key', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: 900,
    account: accountFingerprint('test-client'),
    recordedBy: 'seed-military-flights',
  });
  const redis = await createUpstashMock({
    getResponses: {
      [OPENSKY_COOLDOWN_KEY]: { result: null },
      [OPENSKY_LEGACY_COOLDOWN_KEY]: { result: JSON.stringify(record) },
    },
  });
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
  });
  try {
    const { port } = await ready;
    const response = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-cache'], 'RATE-LIMITED');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 0);
    const migrations = redis.evalsFor(OPENSKY_COOLDOWN_KEY);
    assert.equal(migrations.length, 1);
    assert.deepEqual(JSON.parse(evalArgs(migrations[0].command)[0]), record);
    assert.equal(redis.evalsFor(OPENSKY_LEGACY_COOLDOWN_KEY).length, 0, 'v1 is read but never modified');
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('an expired legacy cutoff avoids v1 reads on clean v2 misses', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('test-client'),
    recordedBy: 'seed-military-flights',
  });
  const redis = await createUpstashMock({
    getResponses: {
      [OPENSKY_COOLDOWN_KEY]: [{ result: null }, { result: null }],
      [OPENSKY_LEGACY_COOLDOWN_KEY]: { result: JSON.stringify(record) },
    },
  });
  const { child, ready } = spawnRelay({
    ...redis.env,
    OPENSKY_LEGACY_COOLDOWN_COMPAT_UNTIL: '2000-01-01T00:00:00.000Z',
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
  });
  try {
    const { port } = await ready;
    const response = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(response.status, 200);
    assert.notEqual(response.headers['x-cache'], 'RATE-LIMITED');
    assert.equal(redis.getsFor(OPENSKY_LEGACY_COOLDOWN_KEY).length, 0);
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 1);
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a seeder-written shared cooldown makes the relay skip without an upstream fetch', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    retryAfterSeconds: 900,
    account: accountFingerprint('test-client'),
    recordedBy: 'seed-military-flights',
  });
  const redis = await createUpstashMock({
    getResponses: {
      [OPENSKY_COOLDOWN_KEY]: { result: JSON.stringify(record) },
    },
  });
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
  });
  try {
    const { port } = await ready;
    const response = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-cache'], 'RATE-LIMITED');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 0, 'seeder 429 must stop the relay before OpenSky is billed');
    assert.ok(metrics.opensky.global429CooldownRemainingMs > 0);
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a Redis read error fails open and the in-process 429 cooldown still works', async () => {
  const redis = await createUpstashMock({ failGets: true });
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '429,200',
    RELAY_TEST_OPENSKY_RETRY_AFTER_SECONDS: '90',
  });
  try {
    const { port } = await ready;
    const first = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(first.status, 429);
    const during = await get(port, '/opensky/states/all?lamin=3&lomin=3&lamax=4&lomax=4');
    assert.equal(during.status, 200);
    assert.equal(during.headers['x-cache'], 'RATE-LIMITED');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 1, 'in-process cooldown must still stop a second debit when Redis is down');
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a delayed Redis cooldown read fails open inside the 6s caller budget', async () => {
  const redis = await createUpstashMock({ getDelayMs: 4_000 });
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
  });
  try {
    const { port } = await ready;
    const started = Date.now();
    const response = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    const elapsedMs = Date.now() - started;
    assert.equal(response.status, 200);
    assert.notEqual(response.headers['x-cache'], 'RATE-LIMITED');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 1, 'slow Redis must fail open so OpenSky still answers');
    assert.equal(redis.getsFor(OPENSKY_COOLDOWN_KEY).length, 2, 'the queued fetch must re-check Redis immediately before OpenSky');
    assert.ok(
      elapsedMs < 3_000,
      `slow Redis must leave the 6s aviation hop enough time for OpenSky, took ${elapsedMs}ms`,
    );
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a cooldown written after a completed handler read stops a queued relay fetch', async () => {
  const redis = await createUpstashMock();
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200,200',
    RELAY_TEST_OPENSKY_RESPONSE_DELAY_MS: '250',
  });
  try {
    const { port } = await ready;
    const firstRequest = get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    await redis.waitForGets(OPENSKY_COOLDOWN_KEY, 2);
    await redis.waitForGets(OPENSKY_LEGACY_COOLDOWN_KEY, 2);

    const secondRequest = get(port, '/opensky/states/all?lamin=3&lomin=3&lamax=4&lomax=4');
    await redis.waitForGets(OPENSKY_COOLDOWN_KEY, 3);
    await redis.waitForGets(OPENSKY_LEGACY_COOLDOWN_KEY, 3);

    const seederCooldown = buildCooldownRecord({
      cooldownMs: 10 * 60_000,
      account: accountFingerprint('test-client'),
      recordedBy: 'seed-military-flights',
    });
    redis.setGetResponses(OPENSKY_COOLDOWN_KEY, {
      result: JSON.stringify(seederCooldown),
    });

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(first.status, 200);
    assert.notEqual(first.headers['x-cache'], 'RATE-LIMITED');
    assert.equal(second.status, 429, 'the queued boundary must reject the newly armed cooldown');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 1, 'a newly seeded cooldown must prevent a second billed OpenSky request');
    assert.equal(redis.getsFor(OPENSKY_COOLDOWN_KEY).length, 4, 'the second queued fetch must read the newly seeded cooldown');
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('a mismatched legacy v1 cooldown fails open and is not migrated', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('other-account'),
    recordedBy: 'seed-military-flights',
  });
  const redis = await createUpstashMock({
    getResponses: {
      [OPENSKY_COOLDOWN_KEY]: { result: null },
      [OPENSKY_LEGACY_COOLDOWN_KEY]: { result: JSON.stringify(record) },
    },
  });
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
  });
  try {
    const { port } = await ready;
    const response = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(response.status, 200);
    assert.notEqual(response.headers['x-cache'], 'RATE-LIMITED');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 1);
    assert.equal(redis.evalsFor(OPENSKY_COOLDOWN_KEY).length, 0);
  } finally {
    await stop(child);
    await redis.close();
  }
});

test('an account-mismatched shared record fails open so the relay still fetches', async () => {
  const record = buildCooldownRecord({
    cooldownMs: 10 * 60_000,
    account: accountFingerprint('other-account'),
    recordedBy: 'seed-military-flights',
  });
  const redis = await createUpstashMock({
    getResponses: {
      [OPENSKY_COOLDOWN_KEY]: { result: JSON.stringify(record) },
    },
  });
  const { child, ready } = spawnRelay({
    ...redis.env,
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '200',
  });
  try {
    const { port } = await ready;
    const response = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(response.status, 200);
    assert.notEqual(response.headers['x-cache'], 'RATE-LIMITED');
    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.opensky.upstreamFetches, 1);
  } finally {
    await stop(child);
    await redis.close();
  }
});
