// #9217 item 6: the AIS relay publishes `chokepoint_disruption` when a
// chokepoint enters the red band, once per crossing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EVENT_TYPE,
  RED_THRESHOLD,
  STATE_KEY,
  publishChokepointDisruptionAlerts,
} = require('../scripts/lib/chokepoint-disruption-alerts.cjs');
const { scoreToStatus } = await import('../server/worldmonitor/supply-chain/v1/_scoring.mjs');

const NOW = Date.parse('2026-10-17T12:00:00Z');

function chokepoint(overrides = {}) {
  return {
    id: 'hormuz_strait',
    name: 'Strait of Hormuz',
    disruptionScore: 72,
    status: 'red',
    activeWarnings: 2,
    congestionLevel: 'elevated',
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    description: 'must not reach the payload',
    ...overrides,
  };
}

function harness({ publishOk = true, readFails = false } = {}) {
  const store = new Map();
  const published = [];
  const deps = {
    now: () => NOW,
    readState: async (key, onFailure) => {
      if (readFails) {
        onFailure('timeout');
        return null;
      }
      return store.get(key) ?? null;
    },
    writeState: async (key, value, ttl) => {
      store.set(key, structuredClone(value));
      store.set(`${key}:ttl`, ttl);
      return true;
    },
    publish: async (event) => {
      published.push(event);
      return typeof publishOk === 'function' ? publishOk(event) : publishOk;
    },
  };
  const tick = (chokepoints) => publishChokepointDisruptionAlerts({ chokepoints }, deps);
  return { store, published, tick };
}

describe('chokepoint disruption alerts', () => {
  it('uses the red band the status scorer draws', () => {
    assert.equal(scoreToStatus(RED_THRESHOLD), 'red');
    assert.notEqual(scoreToStatus(RED_THRESHOLD - 1), 'red');
  });

  it('publishes one critical event on the crossing and nothing while it stays red', async () => {
    const h = harness();
    await h.tick([chokepoint({ disruptionScore: 45 })]);
    assert.equal(h.published.length, 0);
    const summary = await h.tick([chokepoint()]);
    assert.deepEqual(summary, { published: 1, failed: 0, stateWritten: true, skipped: null });
    await h.tick([chokepoint({ disruptionScore: 80 })]);
    assert.equal(h.published.length, 1);

    const [event] = h.published;
    assert.equal(event.eventType, EVENT_TYPE);
    assert.equal(event.severity, 'critical');
    assert.deepEqual(event.payload, {
      title: 'Strait of Hormuz: disruption score 72/100',
      source: 'Chokepoint Monitor',
      chokepointId: 'hormuz_strait',
      chokepointName: 'Strait of Hormuz',
      disruptionScore: 72,
      status: 'red',
      activeWarnings: 2,
      congestionLevel: 'elevated',
      triggeredAt: new Date(NOW).toISOString(),
      coalesceKey: `chokepoint_disruption:hormuz_strait:${new Date(NOW).toISOString()}`,
    });
    assert.equal(h.store.get(`${STATE_KEY}:ttl`), 7 * 24 * 60 * 60);
  });

  it('re-arms below the threshold and publishes the next crossing', async () => {
    const h = harness();
    await h.tick([chokepoint()]);
    await h.tick([chokepoint({ disruptionScore: 30 })]);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 2);
  });

  it('does not re-arm on a reading taken with a source missing', async () => {
    const h = harness();
    await h.tick([chokepoint()]);
    await h.tick([chokepoint({ disruptionScore: 30, aisSnapshotAvailable: false })]);
    await h.tick([chokepoint({ disruptionScore: 30, navigationalWarningsAvailable: false })]);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 1);
  });

  it('tracks each chokepoint separately', async () => {
    const h = harness();
    await h.tick([chokepoint(), chokepoint({ id: 'suez', name: 'Suez Canal', disruptionScore: 10 })]);
    await h.tick([chokepoint(), chokepoint({ id: 'suez', name: 'Suez Canal', disruptionScore: 55 })]);
    assert.deepEqual(h.published.map((e) => e.payload.chokepointId), ['hormuz_strait', 'suez']);
  });

  it('keeps a chokepoint armed when its publish fails, so the next tick retries', async () => {
    let fail = true;
    const h = harness({ publishOk: () => !fail });
    const first = await h.tick([chokepoint()]);
    assert.deepEqual(first, { published: 0, failed: 1, stateWritten: true, skipped: null });
    fail = false;
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 2);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 2);
  });

  it('reports a lost state write so the relay can log the coming re-publish', async () => {
    const h = harness();
    const deps = {
      now: () => NOW,
      readState: async () => null,
      writeState: async () => false,
      publish: async () => true,
    };
    const summary = await publishChokepointDisruptionAlerts({ chokepoints: [chokepoint()] }, deps);
    assert.equal(summary.stateWritten, false);
    assert.equal(h.published.length, 0);
  });

  it('publishes nothing when the state cannot be read', async () => {
    const h = harness({ readFails: true });
    assert.equal(await h.tick([chokepoint()]), null);
    assert.equal(h.published.length, 0);
    assert.equal(h.store.has(STATE_KEY), false);
  });

  it('ignores an empty response and a non-numeric score', async () => {
    const h = harness();
    assert.deepEqual(await h.tick([]), { published: 0, failed: 0, stateWritten: false, skipped: 'no_chokepoints' });
    await h.tick([chokepoint({ disruptionScore: null })]);
    assert.equal(h.published.length, 0);
  });
});

describe('alert-rule chokepoint ids', () => {
  it('match the chokepoint registry ids and order', async () => {
    const { CHOKEPOINT_ALERT_IDS } = await import('../shared/chokepoint-alert-ids.ts');
    const { CHOKEPOINT_REGISTRY } = await import('../server/_shared/chokepoint-registry.ts');
    assert.deepEqual([...CHOKEPOINT_ALERT_IDS], CHOKEPOINT_REGISTRY.map((entry) => entry.id));
  });
});

describe('relay wiring', () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const warmPing = relay.slice(relay.indexOf('async function seedChokepointWarmPing()'), relay.indexOf('function startChokepointWarmPingLoop()'));

  it('runs the alerts on the chokepoints the warm-ping fetched', () => {
    assert.match(warmPing, /publishChokepointDisruptionAlerts\(data,/);
    assert.match(warmPing, /readState: upstashGet/);
    assert.match(warmPing, /writeState: upstashSet/);
  });

  it('reports queue success from publishNotificationEvent', () => {
    const fn = relay.slice(relay.indexOf('async function publishNotificationEvent('), relay.indexOf('let upstreamSocket'));
    assert.match(fn, /return true;/);
    assert.match(fn, /return false;/);
  });
});
