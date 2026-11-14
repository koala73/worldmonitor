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

function createRedis({ abortPipelines = 0, firstPipelineDelayMs = 0 } = {}) {
  let pipelinesToAbort = abortPipelines;
  let pipelineDelayMs = firstPipelineDelayMs;
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
      if (req.url === '/pipeline' && Array.isArray(body) && pipelinesToAbort > 0) {
        pipelinesToAbort -= 1;
        // Headers and part of a body, then the connection drops.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[{"result":');
        setTimeout(() => res.socket.destroy(), 20);
        return;
      }
      if (req.url === '/pipeline' && Array.isArray(body) && pipelineDelayMs > 0) {
        const delayMs = pipelineDelayMs;
        pipelineDelayMs = 0;
        setTimeout(() => res.end(JSON.stringify(body.map((command) => ({ result: run(command) })))), delayMs);
        return;
      }
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
      AIR_TRAFFIC_START_DELAY_MS: '0',
      AIR_TRAFFIC_RETRY_DELAY_MS: '20',
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

async function lane(snapshots, extraEnv, body, redisOptions) {
  const redis = await createRedis(redisOptions);
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
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && relay.lines().length >= 1, 'first point and its log line');
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
    const meta = JSON.parse(redis.get('seed-meta:aviation:traffic-history'));
    assert.equal(meta.recordCount, 10_000);
    assert.ok(meta.fetchedAt >= point.t && meta.fetchedAt < point.t + 300_000, 'the heartbeat is the fetch time inside the bin');
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

test('lane 4: two timeouts in a bin are retried, so the bin still records an ok point', async () => {
  await lane([EUROPE_ONLY], { RELAY_TEST_OPENSKY_TIMEOUT_SEQUENCE: '1,1,0' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && relay.lines().length >= 1, 'first point and its log line');
    const [point] = redis.points('2026-11-13');
    assert.equal(point.t, Date.UTC(2026, 10, 13, 20, 30));
    assert.equal(point.status, 'ok', relay.output());
    assert.match(relay.lines()[0], /status=ok .* attempts=3$/);
    const retries = relay.output().split('\n').filter((line) => /\[AirTraffic\] Attempt \d for t=2026-11-13T20:30:00.000Z failed \(http 504\)/.test(line));
    assert.equal(retries.length, 2, relay.output());
    assert.equal((await get(relay.port(), '/health')).status, 200);
  });
});

test('lane 4b: a bin whose every attempt times out is one gap, then the next bin records an ok point', async () => {
  await lane([EUROPE_ONLY], { RELAY_TEST_OPENSKY_TIMEOUT_SEQUENCE: '1,1,1,0' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').some((p) => p.status === 'ok'), 'recovery');
    const statuses = redis.points('2026-11-13').map((p) => p.status);
    assert.deepEqual(statuses.slice(0, 2), ['gap', 'ok'], statuses.join(','));
    assert.match(relay.lines()[0], /status=gap reason=http 504 attempts=3$/);
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
  // Replica b ticks later in each bin than a, so it finds a's point.
  const a = spawnRelay(redis, env);
  const b = spawnRelay(redis, { ...env, AIR_TRAFFIC_BIN_OFFSET_MS: '200000' });
  try {
    await Promise.all([a, b].map((r) => r.waitFor(() => r.output().includes('[AirTraffic] loop starting'), 'ready')));
    const loggedBins = () => new Set([...a.lines(), ...b.lines()].filter((line) => /status=ok/.test(line)).map((line) => line.match(/t=(\S+)/)[1]));
    const bins = (points) => points.map((p) => new Date(p.t).toISOString());
    await a.waitFor(() => redis.points('2026-11-13').length >= 3, 'three bins', 20_000);
    const snapshot = bins(redis.points('2026-11-13'));
    await a.waitFor(() => snapshot.every((bin) => loggedBins().has(bin)), 'a log line for each stored bin');
    // A replica logs a bin only after Redis stores it, so the logs read here
    // are a subset of the points read after them, while the loops keep running.
    const logged = loggedBins();
    const stored = redis.points('2026-11-13');
    assert.ok(stored.every((p) => p.status === 'ok'), JSON.stringify(stored.map((p) => p.status)));
    assert.equal(new Set(bins(stored)).size, stored.length, 'one point per bin');
    for (const bin of logged) assert.ok(bins(stored).includes(bin), `logged bin ${bin} is stored`);
    const skipped = [...a.lines(), ...b.lines()].filter((line) => /already recorded/.test(line));
    assert.ok(skipped.length >= 1, `a replica skips a bin the other already recorded\n${a.output()}\n${b.output()}`);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
    await redis.close();
    fixture.cleanup();
  }
});

test('lane 6b: a cached snapshot older than the bin is a gap, never a repeat of the earlier count', async () => {
  // A long cache TTL serves the first snapshot to every later tick.
  await lane([GLOBAL_SNAPSHOT, EUROPE_ONLY], { OPENSKY_CACHE_TTL_MS: '3600000' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 3, 'three bins');
    const [first, ...later] = redis.points('2026-11-13');
    assert.equal(first.status, 'ok');
    for (const point of later) assert.deepEqual(point, { t: point.t, status: 'gap' });
    assert.ok(relay.lines().slice(1).every((line) => /status=gap reason=stale/.test(line)), relay.lines().join('\n'));
  });
});

test('lane 6c: a snapshot with no positioned aircraft is a gap, not a world with zero traffic', async () => {
  await lane([[]], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && relay.lines().length >= 1, 'first point and its log line');
    assert.deepEqual(redis.points('2026-11-13')[0], { t: redis.points('2026-11-13')[0].t, status: 'gap' });
    assert.match(relay.lines()[0], /status=gap reason=empty/);
  });
});

test('lane 7: a client /opensky request shares the cached global snapshot the loop fetched', async () => {
  await lane([GLOBAL_SNAPSHOT], { OPENSKY_CACHE_TTL_MS: '600000', RELAY_TEST_CLOCK_RATE: '1' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && relay.lines().length >= 1, 'first point and its log line');
    const response = await get(relay.port(), '/opensky');
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-cache'], 'HIT', 'the client is served from the fetch the loop already paid for');
  });
});

test('lane 9: a snapshot with no US states is an ok point with zero US counts and a normal Europe count', async () => {
  await lane([EUROPE_ONLY], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && relay.lines().length >= 1, 'first point and its log line');
    const [point] = redis.points('2026-11-13');
    assert.equal(point.status, 'ok');
    assert.equal(point.usAirborne, 0);
    assert.equal(point.usSeen, 0);
    assert.equal(point.euAirborne, 400);
  });
});

test('lane 10: a body whose states is null records a gap after every attempt warns once', async () => {
  await lane([null], {}, async ({ redis, relay }) => {
    const gaps = () => relay.lines().filter((line) => /status=gap reason=malformed attempts=3$/.test(line)).length;
    const warnings = () => relay.output().split('\n').filter((line) => line.includes('[AirTraffic] Malformed OpenSky body')).length;
    // Warnings and gap lines arrive on separate streams, so wait for them to agree.
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && gaps() >= 1 && warnings() >= 3 * gaps(), 'one warning per malformed attempt');
    const [point] = redis.points('2026-11-13');
    assert.deepEqual(point, { t: point.t, status: 'gap' });
  });
});

test('lane 11: a Redis response dropped mid-body settles the tick, so its bin is still recorded', async () => {
  // The first pipeline is the skip check. A request that never settles would
  // hang the first tick and leave the 20:30 bin empty.
  await lane([EUROPE_ONLY], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 2, 'two points');
    assert.equal(redis.points('2026-11-13')[0].t, Date.UTC(2026, 10, 13, 20, 30));
    assert.equal((await get(relay.port(), '/health')).status, 200);
  }, { abortPipelines: 1 });
});

test('lane 12: a deployment with a custom auth header still records traffic', async () => {
  await lane([EUROPE_ONLY], { RELAY_SHARED_SECRET: 'lane-secret', RELAY_AUTH_HEADER: 'X-Custom-Relay-Key' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 1 && relay.lines().length >= 1, 'first point and its log line');
    assert.equal(redis.points('2026-11-13')[0].status, 'ok', relay.lines().join('\n'));
  });
});

test('lane 13: ticks after the first start at the configured offset into their bin', async () => {
  await lane([EUROPE_ONLY], { AIR_TRAFFIC_BIN_OFFSET_MS: '60000' }, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 3, 'three bins');
    const { fetchedAt } = JSON.parse(redis.get('seed-meta:aviation:traffic-history'));
    const intoBin = fetchedAt % 300_000;
    // Timer jitter of a few real ms is a few fixture seconds at 300x.
    assert.ok(intoBin >= 60_000 && intoBin < 75_000, `fetched ${intoBin / 1000}s into its bin`);
  });
});

test('lane 14: a skip check that runs past the end of its bin still records that bin, as a gap', async () => {
  // The first pipeline is the skip check. At 300x, 1.2 real seconds is a full
  // bin, so no attempt can start inside the 20:30 bin.
  await lane([EUROPE_ONLY], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 2, 'two points');
    const [first] = redis.points('2026-11-13');
    assert.deepEqual(first, { t: Date.UTC(2026, 10, 13, 20, 30), status: 'gap' });
    // The delayed tick logs after the next bin's tick, so find its line by bin.
    await relay.waitFor(() => relay.lines().some((line) => line.includes('t=2026-11-13T20:30:00.000Z')), 'the 20:30 log line');
    assert.match(relay.lines().find((line) => line.includes('t=2026-11-13T20:30:00.000Z')), /status=gap reason=bin ended attempts=0$/);
  }, { firstPipelineDelayMs: 1200 });
});

test('lane 15: a leftover interval setting cannot stretch the wait past the next bin', async () => {
  // Twice the bin's real length at 300x. Every bin must still get a point.
  await lane([EUROPE_ONLY], { AIR_TRAFFIC_INTERVAL_MS: '2000' }, async ({ redis }) => {
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && redis.points('2026-11-13').length < 4) await new Promise((r) => setTimeout(r, 50));
    const ts = redis.points('2026-11-13').map((p) => p.t);
    assert.ok(ts.length >= 4, `only ${ts.length} points in 6s`);
    for (let i = 1; i < ts.length; i += 1) assert.equal(ts[i] - ts[i - 1], 300_000, `bins are consecutive: ${ts.map((t) => new Date(t).toISOString()).join(',')}`);
  });
});
