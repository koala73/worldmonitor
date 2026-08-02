'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

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

test('relay handlers expose bounded Google/OpenSky cooldowns and RSS fallback metrics', async () => {
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
      RELAY_GOOGLE_FLIGHTS_RATE_LIMIT_MAX: '1000',
      RELAY_OPENSKY_RATE_LIMIT_MAX: '1000',
      RELAY_RSS_RATE_LIMIT_MAX: '1000',
      RELAY_TEST_RSS_CACHE_TTL_MS: '10',
      GF_429_COOLDOWN_MS: '60000',
      OPENSKY_429_COOLDOWN_MS: '60000',
      OPENSKY_REQUEST_SPACING_MS: '1',
      OPENSKY_CLIENT_ID: 'test-client',
      OPENSKY_CLIENT_SECRET: 'test-secret',
      RELAY_TEST_GOOGLE_STATUS_SEQUENCE: '429',
      NODE_OPTIONS: `--require=${preload}`,
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

  try {
    await ready;

    const googleFirst = await get(port, '/google-flights/search?origin=DXB&destination=LHR&departure_date=2026-08-03');
    assert.equal(googleFirst.status, 502);
    assert.match(googleFirst.body, /Google Flights returned 429/);

    const googleDuringCooldown = await get(port, '/google-flights/search?origin=JFK&destination=LAX&departure_date=2026-08-04');
    assert.equal(googleDuringCooldown.status, 200);
    assert.equal(JSON.parse(googleDuringCooldown.body).cooldown, true);
    assert.ok(Number(googleDuringCooldown.headers['retry-after']) >= 1);

    const openskyFirst = await get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2');
    assert.equal(openskyFirst.status, 429);
    assert.ok(Number(openskyFirst.headers['retry-after']) >= 1);

    const openskyDuringCooldown = await get(port, '/opensky/states/all?lamin=3&lomin=3&lamax=4&lomax=4');
    assert.equal(openskyDuringCooldown.status, 200);
    assert.equal(openskyDuringCooldown.headers['x-cache'], 'RATE-LIMITED');
    assert.ok(Number(openskyDuringCooldown.headers['retry-after']) >= 1);

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
    assert.equal(health.status, 'ok');
    assert.equal(health.ingestion.status, 'degraded');
    assert.equal(health.ingestion.aisSnapshot.served, 0);
    assert.equal(health.ingestion.aisSnapshot.connected, false);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.googleFlights.requests, 2);
    assert.ok(metrics.googleFlights.throttle >= 2);
    assert.equal(metrics.googleFlights.fallback, 0, 'cooldown-only empty results are not usable fallback data');
    assert.ok(metrics.googleFlights.cooldownRemainingMs > 0);
    assert.equal(metrics.opensky.requests, 2);
    assert.ok(metrics.opensky.throttle >= 2);
    assert.ok(metrics.opensky.global429CooldownRemainingMs > 0);
    assert.ok(metrics.rss.requests >= 5);
    assert.ok(metrics.rss.fallback >= 1);
    assert.ok(metrics.rss.backoffActiveFeeds >= 2);
    assert.ok(metrics.rss.maxBackoffRemainingMs > 0);
    assert.equal(metrics.aisSnapshot.success, 0);
    assert.equal(metrics.aisSnapshot.served, 0);
    assert.ok(metrics.aisSnapshot.terminalFailure >= 1);
  } finally {
    await stop(child);
  }
});
