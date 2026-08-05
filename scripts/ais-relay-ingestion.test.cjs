'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

  return { child, ready: ready.then(() => ({ child, port })) };
}

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
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    assert.equal(metrics.theaterPosture.lastRun.seedMetaOk, true);
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
    // without consulting Wingbits and the cycle publishes vessel-only.
    const second = await get(port, '/__test/seed-theater-posture');
    assert.equal(second.status, 200, `trigger 2 failed: ${second.body}`);

    const seedMetaSets = upstash.setsFor('seed-meta:theater-posture');
    assert.equal(seedMetaSets.length, 2);
    assert.equal(JSON.parse(seedMetaSets[0].command[2]).sourceVersion, 'adsb.lol');
    const quietMeta = JSON.parse(seedMetaSets[1].command[2]);
    assert.equal(quietMeta.sourceVersion, 'vessel-only');
    assert.equal(quietMeta.recordCount, 0);

    const metricsAfterQuiet = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(
      metricsAfterQuiet.opensky.requests,
      0,
      'healthy adsb.lol cycles must not debit the authenticated OpenSky budget',
    );

    metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'vessel-only');
    // The Wingbits stub would have contributed a flight had the chain
    // consulted it: adsb.lol's authoritative empty answer stops the chain.
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 0);
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 1, wingbits: 0, vesselOnly: 1 });

    // Cycle 3: adsb.lol returns malformed success, so Wingbits is the recovery source. OpenSky is
    // last-resort only and must not be touched while Wingbits is usable.
    const third = await get(port, '/__test/seed-theater-posture');
    assert.equal(third.status, 200, `trigger 3 failed: ${third.body}`);
    metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.theaterPosture.lastRun.source, 'wingbits');
    assert.equal(metrics.theaterPosture.lastRun.flightCount, 1);
    assert.equal(metrics.opensky.requests, 0, 'Wingbits recovery must precede authenticated OpenSky');
    assert.deepEqual(metrics.theaterPosture.sourceCountsSinceBoot, { opensky: 0, adsbLol: 1, wingbits: 1, vesselOnly: 1 });
  } finally {
    await stop(child);
    await upstash.close();
  }
});
