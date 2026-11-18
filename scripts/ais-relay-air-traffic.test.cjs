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
const { describe, it } = require('node:test');
// Each lane spawns its own relay against its own in-memory Upstash on port 0
// and spends most of its time waiting on the relay's clock, so run serially
// the file kept the CPU 16% busy and set the sidecar suite's wall at ~55s.
// Four lanes at a time, one per vCPU on a hosted runner, took it to ~20s.
// Tests are collected here and registered in one concurrent suite at the end.
const cases = [];
const test = (name, fn) => { cases.push([name, fn]); };
const { US_HUBS } = require('./shared/air-traffic-regions.cjs');

const ATL = US_HUBS.find((hub) => hub.iata === 'ATL');
const row = (lat, lon, { alt = 10000, ground = false, vr = 0, callsign = 'TEST1   ' } = {}) =>
  ['abc123', callsign, 'US', 0, 0, lon, lat, alt, ground, 200, 90, vr, null, null];
const repeat = (n, make) => Array.from({ length: n }, make);

// 10,000 states with hand-counted totals.
const GLOBAL_SNAPSHOT = [
  ...repeat(1000, () => row(35, -100)),
  ...repeat(50, () => row(35, -100, { alt: 1000, vr: 5 })),
  ...repeat(150, () => row(35, -100, { alt: 1000, vr: 5, callsign: 'DAL123  ' })),
  ...repeat(300, () => row(ATL.lat, ATL.lon, { ground: true, alt: null })),
  ...repeat(2000, () => row(50, 10)),
  ...repeat(6500, () => row(-20, 130)),
];
const GLOBAL_TOTALS = { usSeen: 1500, usAirborne: 1200, usLowClimbing: 200, usLowClimbingAirline: 150, euAirborne: 2000 };
const EUROPE_ONLY = repeat(400, () => row(50, 10));

function createRedis({ abortPipelines = 0, firstPipelineDelayMs = 0, seedHashes = null, failHgetallPipelines = 0, seedStrings = null, failGetKey = null } = {}) {
  let getFailures = failGetKey ? failGetKey.times : 0;
  let pipelinesToAbort = abortPipelines;
  let hgetallFailures = failHgetallPipelines;
  let pipelineDelayMs = firstPipelineDelayMs;
  const strings = new Map(seedStrings ?? []);
  const hashes = new Map(seedHashes ?? []);
  const lists = new Map();
  const expireAt = new Map();
  const run = ([verb, key, ...args]) => {
    switch (String(verb).toUpperCase()) {
      case 'GET': return strings.get(key) ?? null;
      case 'SET':
        if (args.includes('NX') && strings.has(key)) return null;
        strings.set(key, args[0]);
        return 'OK';
      case 'HGET': return hashes.get(key)?.get(args[0]) ?? null;
      case 'HGETALL': return [...(hashes.get(key) ?? new Map())].flat();
      case 'LPUSH': {
        if (!lists.has(key)) lists.set(key, []);
        lists.get(key).unshift(args[0]);
        return lists.get(key).length;
      }
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
      if (req.url === '/pipeline' && Array.isArray(body) && getFailures > 0
        && body.some((command) => String(command[0]).toUpperCase() === 'GET' && command[1] === failGetKey.key)) {
        getFailures -= 1;
        res.end(JSON.stringify(body.map((command) => (String(command[0]).toUpperCase() === 'GET' && command[1] === failGetKey.key
          ? (failGetKey.missingResult ? {} : { error: 'ERR max requests limit exceeded' })
          : { result: run(command) }))));
        return;
      }
      if (req.url === '/pipeline' && Array.isArray(body) && hgetallFailures > 0
        && body.some((command) => String(command[0]).toUpperCase() === 'HGETALL')) {
        hgetallFailures -= 1;
        // Upstash reports a failed command inside a 200 pipeline response.
        res.end(JSON.stringify(body.map((command) => (String(command[0]).toUpperCase() === 'HGETALL'
          ? { error: 'ERR max requests limit exceeded' }
          : { result: run(command) }))));
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
    points: (day, prefix = 'aviation:traffic:history:v1') => [...(hashes.get(`${prefix}:${day}`) ?? new Map()).values()]
      .map((value) => JSON.parse(value)).sort((a, b) => a.t - b.t),
    expireAtFor: (day) => expireAt.get(`aviation:traffic:history:v1:${day}`),
    get: (key) => strings.get(key) ?? null,
    list: (key) => lists.get(key) ?? [],
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

// Every bin of the UTC days from..to holds the same ordinary OpenSky point, the
// detector's four weeks of history.
function historyHashes(from, to, point) {
  const hashes = new Map();
  for (let day = Date.parse(`${from}T00:00:00Z`); day <= Date.parse(`${to}T00:00:00Z`); day += 86_400_000) {
    const bins = new Map();
    for (let t = day; t < day + 86_400_000; t += 300_000) bins.set(String(t), JSON.stringify({ t, status: 'ok', ...point }));
    hashes.set(`aviation:traffic:history:v1:${new Date(day).toISOString().slice(0, 10)}`, bins);
  }
  return hashes;
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
      {
        usSeen: point.usSeen, usAirborne: point.usAirborne, usLowClimbing: point.usLowClimbing,
        usLowClimbingAirline: point.usLowClimbingAirline, euAirborne: point.euAirborne,
      },
      GLOBAL_TOTALS,
    );
    assert.deepEqual(point.hubs.ATL, { air: 0, ground: 300, dep: 0 });
    assert.equal(Object.keys(point.hubs).length, 20);
    assert.match(relay.lines()[0], /status=ok us=1500 usAirborne=1200 usLowClimbing=200 usLowClimbingAirline=150 eu=2000 hubs=20/);
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

const WINGBITS_PREFIX = 'aviation:traffic:history:wingbits:v1';
const WINGBITS_FLIGHTS = [
  { h: 'a00001', la: ATL.lat, lo: ATL.lon, ab: 2000, og: false },
  { h: 'a00002', la: ATL.lat, lo: ATL.lon, og: true },
  { h: '400001', la: 51.47, lo: -0.45, ab: 36000, og: false },
  // Reported two minutes ago: where it was, not where it is.
  { h: 'a00003', la: 35, lo: -100, ab: 30000, og: false, ageMs: 120_000 },
];

async function wingbitsLane(statusSequence, body, extraEnv = {}, flights = WINGBITS_FLIGHTS) {
  const redis = await createRedis();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingbits-lane-'));
  const file = path.join(dir, 'flights.json');
  fs.writeFileSync(file, JSON.stringify(flights));
  const relay = spawnRelay(redis, {
    RELAY_TEST_AIR_TRAFFIC_LOOP: 'false',
    RELAY_TEST_WINGBITS_TRAFFIC_LOOP: 'true',
    RELAY_TEST_WINGBITS_TRAFFIC_FILE: file,
    RELAY_TEST_WINGBITS_TRAFFIC_STATUS_SEQUENCE: statusSequence,
    WINGBITS_API_KEY: 'test-wingbits-key',
    ...extraEnv,
  });
  const lines = () => relay.output().split('\n').filter((line) => line.startsWith('[AirTrafficWingbits] t='));
  const firstPoint = () => relay.waitFor(() => redis.points('2026-11-13', WINGBITS_PREFIX).length >= 1 && lines().length >= 1, 'first Wingbits point');
  try {
    await relay.waitFor(() => relay.output().includes('[AirTrafficWingbits] loop starting') || relay.output().includes('[AirTrafficWingbits] Disabled'), 'Wingbits loop ready');
    await body({ redis, relay, lines, firstPoint });
  } finally {
    await relay.stop();
    await redis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('lane 16: one Wingbits request records a point in its own series, counting overlapping areas once', async () => {
  await wingbitsLane('', async ({ redis, lines, firstPoint }) => {
    await firstPoint();
    const [point] = redis.points('2026-11-13', WINGBITS_PREFIX);
    assert.equal(point.status, 'ok', lines().join('\n'));
    assert.deepEqual(point.hubs.ATL, { air: 1, ground: 1 }, 'every area returns the same flights, counted once');
    assert.equal(point.usSeen, 2, 'the two-minute-old report is left out');
    assert.equal(point.euAirborne, 1);
    assert.equal('usLowClimbing' in point, false, 'Wingbits has no vertical rate, so climbers are not stored as 0');
    assert.match(lines()[0], /status=ok us=2 usAirborne=1 eu=1 hubs=20 attempts=1$/);
    assert.ok(JSON.parse(redis.get('seed-meta:aviation:traffic-history-wingbits')).fetchedAt > 0);
    assert.equal(redis.get('seed-activated:aviation:traffic-history-wingbits'), '1');
    assert.deepEqual(redis.points('2026-11-13'), [], 'the OpenSky series is untouched');
    assert.equal(redis.get('seed-meta:aviation:traffic-history'), null);
  });
});

test('lane 17: a failed Wingbits request is retried inside the bin', async () => {
  await wingbitsLane('503', async ({ redis, lines, firstPoint }) => {
    await firstPoint();
    assert.equal(redis.points('2026-11-13', WINGBITS_PREFIX)[0].status, 'ok', lines().join('\n'));
    assert.match(lines()[0], /attempts=2$/);
  });
});

test('lane 18: three failed attempts make the bin a gap with no heartbeat', async () => {
  await wingbitsLane('503,503,503', async ({ redis, lines, firstPoint }) => {
    await firstPoint();
    const [point] = redis.points('2026-11-13', WINGBITS_PREFIX);
    assert.deepEqual(point, { t: point.t, status: 'gap' });
    assert.match(lines()[0], /status=gap reason=http 503 attempts=3$/);
    assert.equal(redis.get('seed-meta:aviation:traffic-history-wingbits'), null);
  });
});

test('lane 19: without a Wingbits key the loop stays off', async () => {
  await wingbitsLane('', async ({ relay }) => {
    assert.match(relay.output(), /\[AirTrafficWingbits\] Disabled \(WINGBITS_API_KEY not set\)/);
    assert.doesNotMatch(relay.output(), /\[AirTrafficWingbits\] loop starting/);
  }, { WINGBITS_API_KEY: '' });
});

test('lane 20: a response with one area missing is a gap, never a partial count', async () => {
  await wingbitsLane('short,short,short', async ({ redis, lines, firstPoint }) => {
    await firstPoint();
    assert.equal(redis.points('2026-11-13', WINGBITS_PREFIX)[0].status, 'gap');
    assert.match(lines()[0], /status=gap reason=malformed attempts=3$/);
  });
});

test('lane 21: a response whose every report is stale is a gap, never an empty sky', async () => {
  await wingbitsLane('', async ({ redis, lines, firstPoint }) => {
    await firstPoint();
    assert.equal(redis.points('2026-11-13', WINGBITS_PREFIX)[0].status, 'gap');
    assert.match(lines()[0], /status=gap reason=empty attempts=3$/);
  }, {}, WINGBITS_FLIGHTS.map((f) => ({ ...f, ageMs: 120_000 })));
});

test('lane 22: a Wingbits response that lands after its bin ends makes that bin a gap', async () => {
  // At 300x, 1.2 real seconds is longer than a bin.
  await wingbitsLane('', async ({ redis, relay, lines }) => {
    const t = Date.UTC(2026, 10, 13, 20, 30);
    const line = () => lines().find((l) => l.includes('t=2026-11-13T20:30:00.000Z'));
    await relay.waitFor(() => line(), 'the 20:30 Wingbits line');
    assert.deepEqual(redis.points('2026-11-13', WINGBITS_PREFIX).find((p) => p.t === t), { t, status: 'gap' });
    assert.match(line(), /status=gap reason=bin ended attempts=1$/);
  }, { RELAY_TEST_WINGBITS_TRAFFIC_FIRST_DELAY_MS: '1200' });
});

test('lane 23: a Wingbits body that finishes after its bin ends makes that bin a gap', async () => {
  // Headers arrive in the bin; the body takes 1.2 real seconds, longer than a bin at 300x.
  await wingbitsLane('', async ({ redis, relay, lines }) => {
    const t = Date.UTC(2026, 10, 13, 20, 30);
    const line = () => lines().find((l) => l.includes('t=2026-11-13T20:30:00.000Z'));
    await relay.waitFor(() => line(), 'the 20:30 Wingbits line');
    assert.deepEqual(redis.points('2026-11-13', WINGBITS_PREFIX).find((p) => p.t === t), { t, status: 'gap' });
    assert.match(line(), /status=gap reason=bin ended attempts=1$/);
  }, { RELAY_TEST_WINGBITS_TRAFFIC_FIRST_BODY_DELAY_MS: '1200' });
});

test('lane 24: a response that repeats one area and omits another is a gap, never a partial count', async () => {
  await wingbitsLane('dup,dup,dup', async ({ redis, lines, firstPoint }) => {
    await firstPoint();
    assert.equal(redis.points('2026-11-13', WINGBITS_PREFIX)[0].status, 'gap');
    assert.match(lines()[0], /status=gap reason=malformed attempts=3$/);
  });
});

// The detector runs after each OpenSky point. Four weeks of history read 150
// airline departures per bin; the live snapshots drop to 30 (ratio 0.2) with
// the national count unchanged, so the coverage check passes.
const DEPARTURES_STOPPED = [
  ...repeat(1000, () => row(35, -100)),
  ...repeat(170, () => row(35, -100, { alt: 1000, vr: 5 })),
  ...repeat(30, () => row(35, -100, { alt: 1000, vr: 5, callsign: 'DAL123  ' })),
  ...repeat(300, () => row(ATL.lat, ATL.lon, { ground: true, alt: null })),
  ...repeat(2000, () => row(50, 10)),
  ...repeat(6500, () => row(-20, 130)),
];
const ORDINARY_HISTORY = { usSeen: 1500, euAirborne: 2000, usLowClimbingAirline: 150 };

test('lane 25: two bins of collapsed departures against four weeks of history queue one critical alert', async () => {
  const seedHashes = historyHashes('2026-10-14', '2026-11-08', ORDINARY_HISTORY);
  await lane([GLOBAL_SNAPSHOT, DEPARTURES_STOPPED, DEPARTURES_STOPPED, DEPARTURES_STOPPED, DEPARTURES_STOPPED], {}, async ({ redis, relay }) => {
    const queued = () => redis.list('wm:events:queue').map((m) => JSON.parse(m));
    const usState = () => JSON.parse(redis.get('aviation:traffic:detector:v2') || '{}').US?.state;
    await relay.waitFor(() => usState() === 'collapsed', 'the saved collapse');
    await relay.waitFor(() => redis.points('2026-11-13').length >= 5, 'two more bins after the collapse');
    const events = queued();
    assert.equal(events.length, 1, 'one event per collapse, not one per bin');
    const [event] = events;
    assert.equal(event.eventType, 'aviation_traffic_collapse');
    assert.equal(event.severity, 'critical');
    assert.equal(event.payload.countryCode, 'US');
    assert.equal(event.payload.onset, '2026-11-13T20:35:00.000Z');
    assert.match(event.payload.title, /^US airline departures fell to 20% of normal since 20:35 UTC$/);
    assert.match(relay.output(), /\[AirTraffic\] US collapse entered ratio=0\.20 onset=20:35Z/);
    assert.match(relay.output(), /\[AirTrafficDetector\] t=2026-11-13T20:30:00\.000Z market=US verdict=normal state=normal ratio=1\.00 control=1\.00 coverage=1\.00\(baseline\)/);
    assert.equal(JSON.parse(redis.get('aviation:traffic:detector:v2')).US.state, 'collapsed');
  }, { seedHashes });
});

test('lane 26: with under two weeks of history the detector stays silent', async () => {
  const seedHashes = historyHashes('2026-11-05', '2026-11-08', ORDINARY_HISTORY);
  await lane([GLOBAL_SNAPSHOT, DEPARTURES_STOPPED], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.points('2026-11-13').length >= 4, 'four bins');
    assert.equal(redis.list('wm:events:queue').length, 0);
    assert.match(relay.output(), /verdict=insufficient-baseline/);
  }, { seedHashes });
});

test('lane 27: a baseline read that fails per command is retried on the next bin, not cached as empty', async () => {
  const seedHashes = historyHashes('2026-10-14', '2026-11-08', ORDINARY_HISTORY);
  await lane([GLOBAL_SNAPSHOT, DEPARTURES_STOPPED, DEPARTURES_STOPPED, DEPARTURES_STOPPED, DEPARTURES_STOPPED], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => redis.list('wm:events:queue').length >= 1, 'the collapse event after the failed read');
    assert.match(relay.output(), /\[AirTrafficDetector\] baseline read failed; skipping this bin/);
    assert.doesNotMatch(relay.output(), /market=US verdict=insufficient-baseline/);
  }, { seedHashes, failHgetallPipelines: 1 });
});

test('lane 28: a tick whose bin ends before it records evaluates its own bin, and skips it once a newer bin is evaluated', async () => {
  const seedHashes = historyHashes('2026-10-14', '2026-11-08', ORDINARY_HISTORY);
  await lane([EUROPE_ONLY], {}, async ({ redis, relay }) => {
    await relay.waitFor(() => relay.lines().some((line) => line.includes('t=2026-11-13T20:30:00.000Z status=gap')), 'the delayed 20:30 tick');
    await relay.waitFor(() => redis.points('2026-11-13').length >= 3, 'the bin after');
    // The 20:35 tick evaluates first; the slow 20:30 tick then finds a newer
    // state and leaves it alone rather than evaluating 20:35 a second time.
    const lines = relay.output().split('\n').filter((line) => line.startsWith('[AirTrafficDetector] t='));
    const evaluated = lines.filter((line) => line.includes(' market=US verdict=')).map((line) => line.match(/t=(\S+)/)[1]);
    assert.equal(new Set(evaluated).size, evaluated.length, `each bin once: ${evaluated.join(' ')}`);
    assert.ok(lines.some((line) => /t=2026-11-13T20:30:00\.000Z skipped: 2026-11-13T20:35:00\.000Z already evaluated/.test(line)), lines.join('\n'));
  }, { seedHashes, firstPipelineDelayMs: 1200 });
});

for (const [name, failure] of [['an error', {}], ['no result', { missingResult: true }]]) test(`lane 29: a state read with ${name} leaves an active collapse in place, so its recovery is still sent`, async () => {
  const seedHashes = historyHashes('2026-10-14', '2026-11-08', ORDINARY_HISTORY);
  const onset = Date.parse('2026-11-13T19:00:00Z');
  const collapsed = { state: 'collapsed', run: 0, onset, lastT: Date.parse('2026-11-13T20:25:00Z'), prior: null, verdict: 'collapsed' };
  await lane([GLOBAL_SNAPSHOT], {}, async ({ redis, relay }) => {
    const queued = () => redis.list('wm:events:queue').map((m) => JSON.parse(m));
    await relay.waitFor(() => queued().length >= 1, 'the recovery event');
    assert.equal(queued()[0].payload.kind, 'recovery');
    assert.equal(queued()[0].payload.onset, '2026-11-13T19:00:00.000Z');
    assert.match(relay.output(), /\[AirTrafficDetector\] state read failed; skipping this bin/);
  }, {
    seedHashes,
    seedStrings: [['aviation:traffic:detector:v2', JSON.stringify({ US: collapsed })]],
    failGetKey: { key: 'aviation:traffic:detector:v2', times: 1, ...failure },
  });
});

test('lane 31: a US collapse saved under the v1 key before the upgrade still gets its recovery', async () => {
  const seedHashes = historyHashes('2026-10-14', '2026-11-08', ORDINARY_HISTORY);
  const onset = Date.parse('2026-11-13T19:00:00Z');
  const collapsed = { state: 'collapsed', run: 0, onset, lastT: Date.parse('2026-11-13T20:25:00Z'), prior: null, verdict: 'collapsed' };
  await lane([GLOBAL_SNAPSHOT], {}, async ({ redis, relay }) => {
    const queued = () => redis.list('wm:events:queue').map((m) => JSON.parse(m));
    await relay.waitFor(() => queued().length >= 1, 'the recovery event');
    assert.equal(queued()[0].payload.kind, 'recovery');
    assert.equal(queued()[0].payload.onset, '2026-11-13T19:00:00.000Z');
    await relay.waitFor(() => JSON.parse(redis.get('aviation:traffic:detector:v2') || '{}').US?.state === 'normal', 'the migrated state');
  }, {
    seedHashes,
    seedStrings: [['aviation:traffic:detector:v1', JSON.stringify(collapsed)]],
  });
});

// A UK stop: departures around the London, Manchester and other UK hubs fall
// to a fifth of four weeks of history while the US, the control for Europe,
// flies as usual.
const LHR = { lat: 51.47, lon: -0.4543 };
const uk = (departures) => [
  ...repeat(1200, () => row(35, -100)),
  ...repeat(150, () => row(35, -100, { alt: 1000, vr: 5, callsign: 'DAL123  ' })),
  ...repeat(2000, () => row(50, 10)),
  ...repeat(100 - departures, () => row(LHR.lat, LHR.lon, { ground: true, alt: null })),
  ...repeat(departures, () => row(LHR.lat, LHR.lon, { alt: 800, vr: 6, callsign: 'BAW12   ' })),
  ...repeat(6500, () => row(-20, 130)),
];
const UK_HISTORY = { usSeen: 1350, usAirborne: 1350, euAirborne: 2100, usLowClimbingAirline: 150, markets: { GB: { seen: 100, dep: 20 } } };

test('lane 30: a UK departure collapse queues one critical alert scoped to GB, and the US stays normal', async () => {
  const seedHashes = historyHashes('2026-10-14', '2026-11-08', UK_HISTORY);
  await lane([uk(20), uk(4), uk(4), uk(4), uk(4), uk(4), uk(4)], {}, async ({ redis, relay }) => {
    const queued = () => redis.list('wm:events:queue').map((m) => JSON.parse(m));
    const gbState = () => JSON.parse(redis.get('aviation:traffic:detector:v2') || '{}').GB?.state;
    await relay.waitFor(() => gbState() === 'collapsed', 'the saved UK collapse');
    await relay.waitFor(() => redis.points('2026-11-13').length >= 7, 'two more bins after the collapse');
    const events = queued();
    assert.equal(events.length, 1, events.map((e) => e.payload.title).join(' | '));
    assert.equal(events[0].severity, 'critical');
    assert.equal(events[0].payload.countryCode, 'GB');
    // The series starts at 20:30, so the first full window ends at 20:45, and
    // entry waits until four checked bins fill it: the run starts at 21:00.
    assert.match(events[0].payload.title, /^UK airline departures fell to 20% of normal since 21:00 UTC$/);
    assert.match(relay.output(), /market=GB verdict=entered state=collapsed ratio=0\.20 control=1\.00 coverage=1\.00\(baseline\)/);
    const states = JSON.parse(redis.get('aviation:traffic:detector:v2'));
    assert.equal(states.GB.state, 'collapsed');
    assert.equal(states.US.state, 'normal');
    assert.equal(redis.points('2026-11-13')[1].markets.GB.dep, 4);
  }, { seedHashes });
});

describe('air traffic lanes', { concurrency: 4 }, () => {
  for (const [name, fn] of cases) it(name, fn);
});
