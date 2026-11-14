'use strict';

// Live lanes for the national air traffic series. Each test spawns the real
// relay with ais-relay-test-preload.cjs, feeds fixture OpenSky snapshots, and
// reads the points the relay wrote to a stateful in-memory Upstash.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { US_HUBS } = require('./shared/air-traffic-regions.cjs');

const ATL = US_HUBS.find((hub) => hub.iata === 'ATL');
const row = (lat, lon, { alt = 10000, ground = false, vr = 0 } = {}) =>
  ['abc123', 'TEST1   ', 'US', 0, 0, lon, lat, alt, ground, 200, 90, vr, null, null];
const repeat = (n, make) => Array.from({ length: n }, make);

// 10,000 states with hand-counted totals.
const GLOBAL_SNAPSHOT = [
  ...repeat(1000, () => row(35, -100)),
  ...repeat(200, () => row(35, -100, { alt: 1000, vr: 5 })),
  ...repeat(300, () => row(ATL.lat, ATL.lon, { ground: true, alt: null })),
  ...repeat(2000, () => row(50, 10)),
  ...repeat(6500, () => row(-20, 130)),
];
const GLOBAL_TOTALS = { usSeen: 1500, usAirborne: 1200, usLowClimbing: 200, euAirborne: 2000 };
const EUROPE_ONLY = repeat(400, () => row(50, 10));

function createRedis() {
  const strings = new Map();
  const hashes = new Map();
  const expireAt = new Map();
  const run = ([verb, key, ...args]) => {
    switch (String(verb).toUpperCase()) {
      case 'GET': return strings.get(key) ?? null;
      case 'SET': strings.set(key, args[0]); return 'OK';
      case 'HGET': return hashes.get(key)?.get(args[0]) ?? null;
      case 'HSET': {
        if (!hashes.has(key)) hashes.set(key, new Map());
        const isNew = !hashes.get(key).has(args[0]);
        hashes.get(key).set(args[0], args[1]);
        return isNew ? 1 : 0;
      }
      case 'HSETNX': {
        if (!hashes.has(key)) hashes.set(key, new Map());
        if (hashes.get(key).has(args[0])) return 0;
        hashes.get(key).set(args[0], args[1]);
        return 1;
      }
      case 'EXPIREAT': expireAt.set(key, Number(args[0])); return 1;
      default: return null;
    }
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/get/')) {
        res.end(JSON.stringify({ result: run(['GET', decodeURIComponent(req.url.slice(5))]) }));
        return;
      }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not a command */ }
      if (req.url === '/pipeline' && Array.isArray(body)) {
        res.end(JSON.stringify(body.map((command) => ({ result: run(command) }))));
        return;
      }
      res.end(JSON.stringify({ result: Array.isArray(body) ? run(body) : null }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    env: {
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
    },
    points: (day) => [...(hashes.get(`aviation:traffic:history:v1:${day}`) ?? new Map()).values()]
      .map((value) => JSON.parse(value)).sort((a, b) => a.t - b.t),
    expireAtFor: (day) => expireAt.get(`aviation:traffic:history:v1:${day}`),
    get: (key) => strings.get(key) ?? null,
    close: () => new Promise((done) => server.close(done)),
  })));
}

function writeSnapshots(snapshots) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-traffic-lane-'));
  const file = path.join(dir, 'states.json');
  fs.writeFileSync(file, JSON.stringify(snapshots));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function spawnRelay(redis, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, 'ais-relay.cjs')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...redis.env,
      PORT: '0',
      RELAY_TEST_MODE: 'true',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      RELAY_OPENSKY_RATE_LIMIT_MAX: '1000',
      OPENSKY_CLIENT_ID: 'test-client',
      OPENSKY_CLIENT_SECRET: 'test-secret',
      OPENSKY_REQUEST_SPACING_MS: '1',
      OPENSKY_CACHE_TTL_MS: '1',
      OPENSKY_NEGATIVE_CACHE_TTL_MS: '1',
      OPENSKY_429_COOLDOWN_MS: '1',
      RELAY_TEST_AIR_TRAFFIC_LOOP: 'true',
      AIR_TRAFFIC_INTERVAL_MS: '1000',
      AIR_TRAFFIC_START_DELAY_MS: '0',
      RELAY_TEST_CLOCK_START_MS: String(Date.UTC(2026, 10, 13, 20, 30)),
      RELAY_TEST_CLOCK_RATE: '300',
      NODE_OPTIONS: `--require=${path.join(__dirname, 'ais-relay-test-preload.cjs')}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let port = null;
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    const match = output.match(/WebSocket relay on port (\d+)/);
    if (match) port = Number(match[1]);
  });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const lines = () => output.split('\n').filter((line) => line.startsWith('[AirTraffic] t='));
  const waitFor = async (predicate, label, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(`relay exited ${child.exitCode} while waiting for ${label}\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}\n${output}`);
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  return { output: () => output, lines, waitFor, port: () => port, stop };
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: requestPath }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    }).on('error', reject);
  });
}

async function lane(snapshots, extraEnv, body) {
  const redis = await createRedis();
  const fixture = snapshots ? writeSnapshots(snapshots) : null;
  const relay = spawnRelay(redis, fixture ? { RELAY_TEST_OPENSKY_STATES_FILE: fixture.file, ...extraEnv } : extraEnv);
  try {
    await relay.waitFor(() => relay.port() && relay.output().includes('[AirTraffic] loop starting'), 'relay ready');
    await body({ redis, relay });
  } finally {
    await relay.stop();
    await redis.close();
    fixture?.cleanup();
  }
}

test('lane 1: a global snapshot becomes one ok point with the hand-counted totals and a heartbeat', async () => {
  await lane([GLOBAL_SNAPSHOT], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1, 'first point');
    const [point] = redis.points('2026-11-13');
    assert.equal(point.status, 'ok');
    assert.equal(point.t % 300_000, 0);
    assert.deepEqual(
      { usSeen: point.usSeen, usAirborne: point.usAirborne, usLowClimbing: point.usLowClimbing, euAirborne: point.euAirborne },
      GLOBAL_TOTALS,
    );
    assert.deepEqual(point.hubs.ATL, { air: 0, ground: 300 });
    assert.equal(Object.keys(point.hubs).length, 20);
    assert.match(relay.lines()[0], /status=ok us=1500 usAirborne=1200 usLowClimbing=200 eu=2000 hubs=20/);
    assert.deepEqual(JSON.parse(redis.get('seed-meta:aviation:traffic-history')), { fetchedAt: point.t, recordCount: 10_000 });
    assert.equal(redis.get('seed-activated:aviation:traffic-history'), '1');
  });
});

test('lane 3: an OpenSky 429 and the cooldown after it record gaps, never zero counts or a heartbeat', async () => {
  // During the cooldown the proxy answers 200 with an empty states array.
  await lane(null, { RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '429', OPENSKY_429_COOLDOWN_MS: '3600000' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 3, 'three gap points');
    for (const point of redis.points('2026-11-13')) assert.deepEqual(point, { t: point.t, status: 'gap' });
    assert.ok(relay.lines().some((line) => /status=gap reason=cache (RATE-LIMITED|NEG)/.test(line)), relay.lines().join('\n'));
    assert.equal(redis.get('seed-meta:aviation:traffic-history'), null);
  });
});

test('lane 4: three timeouts record three gaps, then the next tick records an ok point while other routes keep serving', async () => {
  await lane([EUROPE_ONLY], { RELAY_TEST_OPENSKY_TIMEOUT_SEQUENCE: '1,1,1,0' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').some((p) => p.status === 'ok'), 'recovery');
    const statuses = redis.points('2026-11-13').map((p) => p.status);
    assert.deepEqual(statuses.slice(0, 4), ['gap', 'gap', 'gap', 'ok'], statuses.join(','));
    assert.ok(relay.lines().slice(0, 3).every((line) => /status=gap reason=http 504/.test(line)), relay.lines().join('\n'));
    assert.equal((await get(relay.port(), '/health')).status, 200);
  });
});

test('lane 5: points either side of UTC midnight land in two day hashes with their own expiry', async () => {
  await lane([EUROPE_ONLY], { RELAY_TEST_CLOCK_START_MS: String(Date.UTC(2026, 10, 13, 23, 55)) }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-14').length >= 1, 'a point after midnight');
    assert.ok(redis.points('2026-11-13').length >= 1);
    assert.equal(redis.expireAtFor('2026-11-13'), Date.UTC(2026, 10, 14) / 1000 + 35 * 86400);
    assert.equal(redis.expireAtFor('2026-11-14'), Date.UTC(2026, 10, 15) / 1000 + 35 * 86400);
  });
});

test('lane 6: two replicas on one Redis leave one ok point per bin and skip bins already recorded', async () => {
  const redis = await createRedis();
  const fixture = writeSnapshots([EUROPE_ONLY]);
  const env = { RELAY_TEST_OPENSKY_STATES_FILE: fixture.file, RELAY_TEST_CLOCK_RATE: '150' };
  const a = spawnRelay(redis, env);
  const b = spawnRelay(redis, env);
  try {
    await Promise.all([a, b].map((r) => r.waitFor(() => r.output().includes('[AirTraffic] loop starting'), 'ready')));
    await a.waitFor(() => redis.points('2026-11-13').length >= 3, 'three bins', 20_000);
    const points = redis.points('2026-11-13');
    assert.ok(points.every((p) => p.status === 'ok'), JSON.stringify(points.map((p) => p.status)));
    const written = [...a.lines(), ...b.lines()].filter((line) => /status=ok/.test(line)).map((line) => line.match(/t=(\S+)/)[1]);
    const skipped = [...a.lines(), ...b.lines()].filter((line) => /already recorded/.test(line));
    assert.equal(new Set(written).size, points.length, 'every bin in the hash was written, and no bin appears twice');
    assert.ok(skipped.length >= 1, `a replica skips a bin the other already recorded\n${a.output()}\n${b.output()}`);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
    await redis.close();
    fixture.cleanup();
  }
});

test('lane 7: a client /opensky request shares the cached global snapshot the loop fetched', async () => {
  await lane([GLOBAL_SNAPSHOT], { OPENSKY_CACHE_TTL_MS: '600000', RELAY_TEST_CLOCK_RATE: '1' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1, 'first point');
    const response = await get(relay.port(), '/opensky');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-cache'], 'HIT', 'the client is served from the fetch the loop already paid for');
  });
});

test('lane 9: a snapshot with no US states is an ok point with zero US counts and a normal Europe count', async () => {
  await lane([EUROPE_ONLY], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1, 'first point');
    const [point] = redis.points('2026-11-13');
    assert.equal(point.status, 'ok');
    assert.equal(point.usAirborne, 0);
    assert.equal(point.usSeen, 0);
    assert.equal(point.euAirborne, 400);
  });
});

test('lane 10: a body whose states is null records a gap and logs one warning per malformed tick', async () => {
  await lane([null], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1, 'gap point');
    const [point] = redis.points('2026-11-13');
    assert.deepEqual(point, { t: point.t, status: 'gap' });
    const gaps = relay.lines().filter((line) => /status=gap reason=malformed/.test(line)).length;
    const warnings = relay.output().split('\n').filter((line) => line.includes('[AirTraffic] Malformed OpenSky body')).length;
    assert.ok(gaps >= 1);
    assert.equal(warnings, gaps);
  });
});
