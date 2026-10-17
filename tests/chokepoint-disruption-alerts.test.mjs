// #9217 item 6: the AIS relay publishes `chokepoint_disruption` when a
// chokepoint is red AND its live signals sit well above its standing threat
// level, once per crossing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EVENT_TYPE,
  RED_THRESHOLD,
  REFIRE_COOLDOWN_MS,
  DEDUP_TTL_SECONDS,
  THREAT_POINTS_BY_TIER,
  STATE_KEY,
  publishChokepointDisruptionAlerts,
} = require('../scripts/lib/chokepoint-disruption-alerts.cjs');
const { scoreToStatus, THREAT_LEVEL } = await import('../server/worldmonitor/supply-chain/v1/_scoring.mjs');

const T0 = Date.parse('2026-10-17T12:00:00Z');
const TICK = 30 * 60 * 1000;

// Bab el-Mandeb's standing level (critical, 40) plus live signals.
function chokepoint(overrides = {}) {
  return {
    id: 'bab_el_mandeb',
    name: 'Bab el-Mandeb',
    warRiskTier: 'WAR_RISK_TIER_CRITICAL',
    disruptionScore: 65,
    status: 'red',
    activeWarnings: 3,
    congestionLevel: 'normal',
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    transitSummary: { dataAvailable: true },
    description: 'must not reach the payload',
    ...overrides,
  };
}

function harness({ publishOk = true, readFails = false, writeOk = () => true } = {}) {
  const store = new Map();
  const published = [];
  const logs = [];
  let clock = T0;
  let writes = 0;
  const deps = {
    now: () => clock,
    log: (message) => logs.push(message),
    readState: async (key, onFailure) => {
      if (readFails) {
        onFailure(readFails);
        return null;
      }
      return store.get(key) ?? null;
    },
    writeState: async (key, value, ttl) => {
      writes += 1;
      if (!writeOk(writes)) return false;
      store.set(key, structuredClone(value));
      store.set(`${key}:ttl`, ttl);
      return true;
    },
    publish: async (event) => {
      published.push(event);
      return typeof publishOk === 'function' ? publishOk(event) : publishOk;
    },
  };
  const tick = async (chokepoints) => {
    const result = await publishChokepointDisruptionAlerts({ chokepoints }, deps);
    clock += TICK;
    return result;
  };
  return { store, published, logs, tick, advanceClock: (ms) => { clock += ms; } };
}

describe('chokepoint disruption alerts', () => {
  it('uses the scorer\'s red band and threat levels', async () => {
    assert.equal(scoreToStatus(RED_THRESHOLD), 'red');
    assert.notEqual(scoreToStatus(RED_THRESHOLD - 1), 'red');
    const { threatLevelToWarRiskTier } = await import('../server/worldmonitor/supply-chain/v1/_insurance-tier.ts');
    for (const [level, points] of Object.entries(THREAT_LEVEL)) {
      assert.equal(THREAT_POINTS_BY_TIER[threatLevelToWarRiskTier(level)], points, level);
    }
  });

  it('publishes one critical event on the crossing and nothing while it holds', async () => {
    const h = harness();
    await h.tick([chokepoint({ disruptionScore: 45, activeWarnings: 1 })]);
    assert.equal(h.published.length, 0);
    const summary = await h.tick([chokepoint()]);
    assert.deepEqual(summary, { published: 1, failed: 0, stateWritten: true, skipped: null });
    await h.tick([chokepoint({ disruptionScore: 70 })]);
    assert.equal(h.published.length, 1);

    const [event] = h.published;
    const crossingAt = new Date(T0 + TICK).toISOString();
    assert.equal(event.eventType, EVENT_TYPE);
    assert.equal(event.severity, 'critical');
    assert.equal(event.dedupTtl, DEDUP_TTL_SECONDS);
    assert.deepEqual(event.payload, {
      title: 'Bab el-Mandeb: disruption score 65/100',
      source: 'Chokepoint Monitor',
      chokepointId: 'bab_el_mandeb',
      chokepointName: 'Bab el-Mandeb',
      disruptionScore: 65,
      status: 'red',
      activeWarnings: 3,
      congestionLevel: 'normal',
      triggeredAt: crossingAt,
      coalesceKey: `chokepoint_disruption:bab_el_mandeb:${crossingAt}`,
    });
    assert.equal(h.store.get(`${STATE_KEY}:ttl`), 7 * 24 * 60 * 60);
  });

  it('does not fire on one warning above a critical-tier baseline', async () => {
    // 40 + 10 = 50 is red, but only 10 live points.
    const h = harness();
    await h.tick([chokepoint({ disruptionScore: 50, activeWarnings: 2 })]);
    assert.equal(h.published.length, 0);
  });

  it('can alert on a war-zone chokepoint whose standing level is already red', async () => {
    const h = harness();
    const hormuz = (score, activeWarnings) => chokepoint({
      id: 'hormuz_strait', name: 'Strait of Hormuz', warRiskTier: 'WAR_RISK_TIER_WAR_ZONE', disruptionScore: score, activeWarnings,
    });
    await h.tick([hormuz(70, 0)]);
    assert.equal(h.published.length, 0, 'the standing level alone never alerts');
    await h.tick([hormuz(85, 3)]);
    assert.equal(h.published.length, 1);
  });

  it('fires once while the score wobbles around the threshold', async () => {
    const h = harness();
    for (const score of [55, 50, 55, 50, 55, 45, 55]) await h.tick([chokepoint({ disruptionScore: score })]);
    assert.equal(h.published.length, 1);
  });

  it('re-arms once the live signals subside, then honours the cooldown', async () => {
    const h = harness();
    await h.tick([chokepoint()]);
    await h.tick([chokepoint({ disruptionScore: 40, activeWarnings: 0 })]);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 1, 'a re-cross inside the cooldown does not alert');
    h.advanceClock(REFIRE_COOLDOWN_MS);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 2);
  });

  it('does not re-arm on a reading taken with a source missing', async () => {
    const h = harness();
    await h.tick([chokepoint()]);
    await h.tick([chokepoint({ disruptionScore: 40, activeWarnings: 0, aisSnapshotAvailable: false })]);
    await h.tick([chokepoint({ disruptionScore: 40, activeWarnings: 0, navigationalWarningsAvailable: false })]);
    h.advanceClock(REFIRE_COOLDOWN_MS);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 1);
  });

  it('does not re-arm on a reading with no score', async () => {
    const h = harness();
    await h.tick([chokepoint()]);
    await h.tick([chokepoint({ disruptionScore: null, activeWarnings: 0 })]);
    h.advanceClock(REFIRE_COOLDOWN_MS);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 1);
  });

  it('needs transit data to re-arm a crossing that carried a transit drop', async () => {
    const h = harness();
    // 40 + 10 anomaly + 5 warning: the transit drop is part of the crossing.
    await h.tick([chokepoint({ disruptionScore: 55, activeWarnings: 1 })]);
    assert.equal(h.published.length, 1);
    await h.tick([chokepoint({ disruptionScore: 40, activeWarnings: 0, transitSummary: { dataAvailable: false } })]);
    h.advanceClock(REFIRE_COOLDOWN_MS);
    await h.tick([chokepoint({ disruptionScore: 55, activeWarnings: 1 })]);
    assert.equal(h.published.length, 1);
    await h.tick([chokepoint({ disruptionScore: 40, activeWarnings: 0 })]);
    await h.tick([chokepoint({ disruptionScore: 55, activeWarnings: 1 })]);
    assert.equal(h.published.length, 2);
  });

  it('tracks each chokepoint separately', async () => {
    const h = harness();
    const suez = (score) => chokepoint({ id: 'suez', name: 'Suez Canal', warRiskTier: 'WAR_RISK_TIER_HIGH', disruptionScore: score });
    await h.tick([chokepoint(), suez(30)]);
    await h.tick([chokepoint(), suez(55)]);
    assert.deepEqual(h.published.map((e) => e.payload.chokepointId), ['bab_el_mandeb', 'suez']);
  });

  it('retries a failed publish with the same coalesceKey', async () => {
    let fail = true;
    const h = harness({ publishOk: () => !fail });
    const first = await h.tick([chokepoint()]);
    assert.deepEqual(first, { published: 0, failed: 1, stateWritten: true, skipped: null });
    fail = false;
    await h.tick([chokepoint()]);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 2);
    assert.equal(h.published[1].payload.coalesceKey, h.published[0].payload.coalesceKey);
  });

  it('keeps the coalesceKey when the post-publish state write is lost', async () => {
    const h = harness({ writeOk: (n) => n !== 2 });
    const first = await h.tick([chokepoint()]);
    assert.equal(first.stateWritten, false);
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 2, 'at-least-once: the crossing is re-published');
    assert.equal(h.published[1].payload.coalesceKey, h.published[0].payload.coalesceKey, 'and the publisher dedups it');
  });

  it('publishes nothing when the pending state cannot be written', async () => {
    const h = harness({ writeOk: () => false });
    assert.equal(await h.tick([chokepoint()]), null);
    assert.equal(h.published.length, 0);
  });

  it('publishes nothing when the state cannot be read', async () => {
    const h = harness({ readFails: 'timeout' });
    assert.equal(await h.tick([chokepoint()]), null);
    assert.equal(h.published.length, 0);
    assert.equal(h.store.has(STATE_KEY), false);
  });

  it('starts fresh from an unparseable state instead of stalling', async () => {
    const h = harness({ readFails: 'JSON result parse failed: Unexpected token' });
    await h.tick([chokepoint()]);
    assert.equal(h.published.length, 1);
    assert.ok(h.logs.some((m) => /unparseable/.test(m)));
  });

  it('treats a malformed Upstash response body as a read failure, not corrupt state', async () => {
    const h = harness({ readFails: 'JSON response parse failed: Unexpected end of JSON input' });
    assert.equal(await h.tick([chokepoint()]), null);
    assert.equal(h.published.length, 0);
    assert.equal(h.store.has(STATE_KEY), false, 'the saved state is not overwritten');
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
