import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import handler from '../api/bootstrap.js';
import { NATURAL_EVENTS_CONE_MAX_POINTS } from '../api/_natural-events-dashboard.js';

const NATURAL_EVENTS_KEY = 'natural:events:v1';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function circleRing(count, lon0, lat0, radiusDeg) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * Math.PI * 2;
    points.push({
      lon: lon0 + Math.cos(theta) * radiusDeg + i * 1e-9,
      lat: lat0 + Math.sin(theta) * radiusDeg,
    });
  }
  points.push({ ...points[0] });
  return { points };
}

function installRedis(values) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('fake.upstash.io')) throw new Error(`unexpected fetch ${url}`);

    const commands = JSON.parse(init.body);
    calls.push(commands);
    return new Response(JSON.stringify(commands.map(([, key]) => ({
      result: values.has(key) ? JSON.stringify(values.get(key)) : null,
    }))));
  };
  return calls;
}

function makePublicSlowRequest() {
  return new Request('https://worldmonitor.app/api/bootstrap?tier=slow&public=1', {
    headers: { origin: 'https://worldmonitor.app' },
  });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  delete process.env.BOOTSTRAP_R2_SHADOW_MEASURE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test('public slow-tier Redis fallback returns a capped naturalEvents cone', async () => {
  const fatRing = circleRing(1939, -42.5, 13.5, 2.5);
  assert.ok(
    fatRing.points.length > NATURAL_EVENTS_CONE_MAX_POINTS,
    'fixture must start above the dashboard vertex cap',
  );
  const payload = {
    events: [{ id: 'nhc-AL04-3', title: 'Tropical Storm Dolly', conePolygon: [fatRing] }],
    fetchedAt: 1,
  };
  const calls = installRedis(new Map([[NATURAL_EVENTS_KEY, payload]]));

  const response = await handler(makePublicSlowRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(calls.some((commands) => commands.some((command) => (
    command[0] === 'GET' && command[1] === NATURAL_EVENTS_KEY
  ))), 'handler must read the canonical naturalEvents Redis key');

  const event = body.data.naturalEvents.events[0];
  assert.equal(event.id, 'nhc-AL04-3');
  const points = event.conePolygon[0].points;
  assert.ok(Array.isArray(points));
  assert.ok(
    points.length <= NATURAL_EVENTS_CONE_MAX_POINTS,
    `handler returned ${points.length} cone points, cap is ${NATURAL_EVENTS_CONE_MAX_POINTS}`,
  );
  assert.ok(
    points.length < fatRing.points.length,
    'public slow-tier fallback must not ship the raw NHC cone',
  );
});
