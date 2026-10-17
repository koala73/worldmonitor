import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { aisComponent, warningComponent } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

import {
  BACKFILL_CURSOR_KEY,
  CHOKEPOINT_STATUS_KEY,
  CHOKEPOINT_STATUS_RPC_URL,
  LOCK_KEY,
  LOCK_RENEW_SCRIPT,
  PRUNE_SCRIPT,
  RECORD_CAS_SCRIPT,
  SCORE_SOURCE_MAX_POINTS,
  STATE_WRITE_SCRIPT,
  STATUS_WRITE_SCRIPT,
  WORKER_ACTIVATION_KEY,
  WORKER_META_KEY,
  WORKER_STATUS_KEY,
  planTick,
  reasonFor,
  runTick,
  stateKey,
} from '../scripts/shipping-webhook-worker.mjs';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function chokepoint(id, disruptionScore, extra = {}) {
  return {
    id,
    name: `${id} name`,
    disruptionScore,
    status: 'yellow',
    activeWarnings: 0,
    aisDisruptions: 0,
    congestionLevel: 'normal',
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    transitSummary: { todayCountsAvailable: true, wowChangePct: -3, dataAvailable: true },
    ...extra,
  };
}

function record(overrides = {}) {
  return {
    subscriberId: 'wh_aaaaaaaaaaaaaaaaaaaaaaaa',
    ownerTag: 'owner',
    callbackUrl: 'https://hooks.example.com/wm',
    chokepointIds: ['suez'],
    alertThreshold: 60,
    createdAt: '2026-10-01T00:00:00.000Z',
    active: true,
    secret: 'a'.repeat(64),
    ...overrides,
  };
}

const SUB_ID = record().subscriberId;

function plan(score, state, overrides = {}) {
  const rec = record(overrides);
  return planTick({
    chokepoints: [chokepoint('suez', score), chokepoint('hormuz_strait', 90)],
    records: [rec],
    states: new Map(state ? [[rec.subscriberId, { suez: state }]] : []),
    now: NOW,
    scoresFetchedAt: '2026-10-17T11:58:00.000Z',
    makeId: () => 'whd_fixed',
  });
}

describe('planTick state machine', () => {
  it('fires once for a subscriber first seen above threshold', () => {
    const { deliveries, nextStates } = plan(75);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].deliveryId, 'whd_fixed');
    assert.deepEqual(nextStates.get(record().subscriberId), {
      suez: { armed: true, lastScore: 75, pending: { deliveryId: 'whd_fixed', triggeredAt: '2026-10-17T12:00:00.000Z' } },
    });
  });

  it('does not fire again while the score stays above threshold after a delivery', () => {
    const { deliveries, nextStates } = plan(80, { armed: false, lastScore: 75, lastDeliveredAt: '2026-10-17T11:55:00.000Z' });
    assert.equal(deliveries.length, 0);
    assert.deepEqual(nextStates.get(record().subscriberId).suez, {
      armed: false, lastScore: 80, lastDeliveredAt: '2026-10-17T11:55:00.000Z',
    });
  });

  it('re-arms when the score drops below threshold, then fires on the next rise', () => {
    const dropped = plan(40, { armed: false, lastScore: 80 });
    assert.equal(dropped.deliveries.length, 0);
    assert.equal(dropped.nextStates.get(record().subscriberId).suez.armed, true);
    const risen = plan(70, dropped.nextStates.get(record().subscriberId).suez);
    assert.equal(risen.deliveries.length, 1);
    assert.equal(risen.deliveries[0].payload.details.previousScore, 40);
  });

  it('stays quiet below threshold on first sight and records the armed state', () => {
    const { deliveries, nextStates } = plan(59);
    assert.equal(deliveries.length, 0);
    assert.deepEqual(nextStates.get(record().subscriberId).suez, { armed: true, lastScore: 59 });
  });

  it('fires when the score equals the threshold', () => {
    assert.equal(plan(60).deliveries.length, 1);
  });

  it('retries a still-armed crossing whose last delivery failed', () => {
    assert.equal(plan(75, { armed: true, lastScore: 75 }).deliveries.length, 1);
  });

  it('sends one delivery for a chokepoint listed twice', () => {
    assert.equal(plan(75, null, { chokepointIds: ['suez', 'suez'] }).deliveries.length, 1);
  });

  it('does not re-arm when the missing source could account for the drop', () => {
    const delivered = { armed: false, lastScore: 75, sources: { navigationalWarnings: true, ais: true, transit: true } };
    const dark = planTick({
      chokepoints: [chokepoint('suez', 50, { navigationalWarningsAvailable: false })],
      records: [record()],
      states: new Map([[SUB_ID, { suez: delivered }]]),
      now: NOW,
    });
    assert.deepEqual(dark.nextStates.get(SUB_ID).suez, { ...delivered, lastScore: 50 });
    const recovered = plan(75, dark.nextStates.get(SUB_ID).suez);
    assert.equal(recovered.deliveries.length, 0, 'the same disruption does not fire again');
    const ended = plan(40, recovered.nextStates.get(SUB_ID).suez);
    assert.equal(ended.nextStates.get(SUB_ID).suez.armed, true, 'a real drop with every source present re-arms');
  });

  it('re-arms when the score is below threshold even with every missing source at its maximum', () => {
    const delivered = { armed: false, lastScore: 60, sources: { navigationalWarnings: true, ais: true, transit: true } };
    const ended = planTick({
      chokepoints: [chokepoint('suez', 30, { transitSummary: { dataAvailable: false } })],
      records: [record({ alertThreshold: 50 })],
      states: new Map([[SUB_ID, { suez: delivered }]]),
      now: NOW,
    });
    assert.equal(ended.nextStates.get(SUB_ID).suez.armed, true, '30 + at most 10 from transit cannot reach 50');
    const again = planTick({
      chokepoints: [chokepoint('suez', 60, { transitSummary: { dataAvailable: false } })],
      records: [record({ alertThreshold: 50 })],
      states: new Map([[SUB_ID, { suez: ended.nextStates.get(SUB_ID).suez }]]),
      now: NOW,
    });
    assert.equal(again.deliveries.length, 1);
  });

  it('caps each score source at the points the scoring code gives it', () => {
    assert.equal(SCORE_SOURCE_MAX_POINTS.navigationalWarnings, warningComponent(1000));
    assert.equal(SCORE_SOURCE_MAX_POINTS.ais, aisComponent(3));
    const status = readFileSync(new URL('../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts', import.meta.url), 'utf8');
    assert.match(status, new RegExp(`anomaly\\.signal \\? ${SCORE_SOURCE_MAX_POINTS.transit} : 0`));
  });

  it('re-arms despite a source that was already missing at delivery', () => {
    const delivered = { armed: false, lastScore: 75, sources: { navigationalWarnings: true, ais: true, transit: false } };
    const { nextStates } = planTick({
      chokepoints: [chokepoint('suez', 40, { transitSummary: { dataAvailable: false } })],
      records: [record()],
      states: new Map([[SUB_ID, { suez: delivered }]]),
      now: NOW,
    });
    assert.equal(nextStates.get(SUB_ID).suez.armed, true);
  });

  it('evaluates only the chokepoints the subscriber chose', () => {
    const { deliveries } = plan(10);
    assert.equal(deliveries.length, 0, 'hormuz_strait at 90 is not subscribed');
    assert.equal(plan(10, null, { chokepointIds: ['suez', 'hormuz_strait'] }).deliveries[0].payload.chokepointId, 'hormuz_strait');
  });

  it('builds the documented payload and details', () => {
    const [delivery] = plan(75, { armed: true, lastScore: 55 }).deliveries;
    assert.deepEqual(delivery.payload, {
      subscriberId: record().subscriberId,
      chokepointId: 'suez',
      score: 75,
      alertThreshold: 60,
      triggeredAt: '2026-10-17T12:00:00.000Z',
      reason: 'score_threshold',
      details: {
        name: 'suez name',
        status: 'yellow',
        activeWarnings: 0,
        aisDisruptions: 0,
        congestionLevel: 'normal',
        warRiskTier: 'WAR_RISK_TIER_NORMAL',
        wowChangePct: -3,
        previousScore: 55,
        scoresFetchedAt: '2026-10-17T11:58:00.000Z',
      },
    });
  });
});

describe('reason precedence', () => {
  const cases = [
    [{ aisDisruptions: 2, activeWarnings: 3, transitSummary: { todayCountsAvailable: true, wowChangePct: -40 } }, 'ais_congestion_spike'],
    [{ activeWarnings: 3, transitSummary: { todayCountsAvailable: true, wowChangePct: -40 } }, 'navigational_warning'],
    [{ transitSummary: { todayCountsAvailable: true, wowChangePct: -25 } }, 'transit_drop'],
    [{ transitSummary: { todayCountsAvailable: false, wowChangePct: -60 } }, 'score_threshold'],
    [{ transitSummary: { todayCountsAvailable: true, wowChangePct: -24.9 } }, 'score_threshold'],
  ];
  for (const [extra, reason] of cases) {
    it(`${JSON.stringify(extra)} -> ${reason}`, () => {
      assert.equal(reasonFor(chokepoint('suez', 70, extra)), reason);
    });
  }
});

function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttl = new Map();
  const log = [];
  const run = (command) => {
    const [verb, key, ...args] = command;
    switch (verb) {
      case 'GET': return store.get(key) ?? null;
      case 'SET': {
        if (args.includes('NX') && store.has(key)) return null;
        store.set(key, args[0]);
        if (args[1] === 'EX') ttl.set(key, Number(args[2]));
        else if (!args.includes('KEEPTTL')) ttl.delete(key);
        return 'OK';
      }
      case 'SMEMBERS': return [...(store.get(key) ?? new Set())];
      case 'SADD': {
        const set = store.get(key) ?? new Set();
        let added = 0;
        for (const member of args) if (!set.has(member)) { set.add(member); added += 1; }
        store.set(key, set);
        return added;
      }
      case 'SREM': {
        const set = store.get(key);
        if (!set?.delete(args[0])) return 0;
        if (set.size === 0) store.delete(key);
        return 1;
      }
      case 'DEL': return store.delete(key) ? 1 : 0;
      case 'HGETALL': return Object.entries(store.get(key) ?? {}).flat();
      case 'HSET': {
        const hash = store.get(key) ?? {};
        for (let i = 0; i < args.length; i += 2) hash[args[i]] = args[i + 1];
        store.set(key, hash);
        return args.length / 2;
      }
      case 'EXPIRE': ttl.set(key, Number(args[0])); return store.has(key) ? 1 : 0;
      case 'SCAN': {
        const keys = [...store.keys()].filter((name) => /^webhook:sub:.+:v1$/.test(name));
        return ['0', keys];
      }
      case 'EVAL': {
        const script = key;
        const keys = args.slice(1, 1 + Number(args[0]));
        const argv = args.slice(1 + Number(args[0]));
        if (script === LOCK_RENEW_SCRIPT) return store.get(keys[0]) === argv[0] ? 1 : 0;
        if (store.get(keys[0]) !== argv[0]) return -1;
        if (script === PRUNE_SCRIPT) {
          if (store.has(keys[1])) return 0;
          store.get(keys[2])?.delete(argv[1]);
          store.delete(keys[3]);
          return 1;
        }
        if (script === STATE_WRITE_SCRIPT) {
          if (!store.has(keys[1])) return 0;
          const hash = store.get(keys[2]) ?? {};
          for (let i = 2; i < argv.length; i += 2) hash[argv[i]] = argv[i + 1];
          store.set(keys[2], hash);
          ttl.set(keys[2], Number(argv[1]));
          return 1;
        }
        if (script === STATUS_WRITE_SCRIPT) {
          store.set(keys[1], argv[1]);
          ttl.set(keys[1], Number(argv[2]));
          store.set(keys[2], argv[3]);
          ttl.set(keys[2], Number(argv[4]));
          if (argv[5] === '1' && !store.has(keys[3])) store.set(keys[3], '1');
          return 1;
        }
        assert.equal(script, RECORD_CAS_SCRIPT);
        if (store.get(keys[1]) !== argv[1]) return 0;
        store.set(keys[1], argv[2]);
        return 1;
      }
      default: throw new Error(`unexpected command ${verb}`);
    }
  };
  const redis = async (commands) => {
    log.push(...commands);
    return commands.map((command) => ({ result: run(command) }));
  };
  return { redis, store, ttl, log };
}

const TOKEN = 'run-1';

function lockStub(acquired = true, store = null) {
  const calls = { acquire: 0, release: 0 };
  return {
    calls,
    lock: {
      acquire: async () => {
        calls.acquire += 1;
        if (acquired) store?.set(LOCK_KEY, TOKEN);
        return acquired;
      },
      fence: () => ({ key: LOCK_KEY, token: TOKEN }),
      release: async () => { calls.release += 1; },
    },
  };
}

const SUB = record().subscriberId;
const RECORD_KEY = `webhook:sub:${SUB}:v1`;

function twoCrossings() {
  const fake = seeded({ rec: record({ chokepointIds: ['suez', 'hormuz_strait'] }) });
  fake.store.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({
    chokepoints: [chokepoint('suez', 75), chokepoint('hormuz_strait', 90)],
    fetchedAt: 'x',
  }));
  return fake;
}

function seeded({ score = 75, rec = record(), backfilled = true, state } = {}) {
  const initial = {
    [CHOKEPOINT_STATUS_KEY]: JSON.stringify({
      chokepoints: [chokepoint('suez', score)],
      fetchedAt: '2026-10-17T11:58:00.000Z',
      upstreamUnavailable: false,
    }),
    [RECORD_KEY]: JSON.stringify(rec),
    'webhook:all:v1': new Set([SUB]),
  };
  if (backfilled) initial[BACKFILL_CURSOR_KEY] = 'done';
  if (state) initial[stateKey(SUB)] = { suez: JSON.stringify(state) };
  return fakeRedis(initial);
}

function deliverStub(outcomes) {
  const sent = [];
  const deliver = async (rec, payload, deliveryId) => {
    sent.push({ rec, payload, deliveryId });
    return outcomes.shift() ?? { ok: true, status: 200 };
  };
  return { sent, deliver };
}

const tick = (fake, deliver, extra = {}) => runTick({
  redis: fake.redis,
  lock: lockStub(true, fake.store).lock,
  deliver,
  env: {},
  fetchImpl: async () => { throw new Error('unexpected fetch'); },
  now: () => NOW,
  ...extra,
});

describe('runTick', () => {
  it('delivers, disarms the chokepoint, and records the outcome on the subscriber', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub([{ ok: true, status: 202 }]);
    const summary = await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(summary.deliveries, 1);
    assert.deepEqual(JSON.parse(fake.store.get(stateKey(SUB)).suez), {
      armed: false,
      lastScore: 75,
      lastDeliveredAt: '2026-10-17T12:00:00.000Z',
      sources: { navigationalWarnings: true, ais: true, transit: true },
    });
    assert.equal(fake.ttl.get(stateKey(SUB)), 30 * 86400);
    assert.deepEqual(JSON.parse(fake.store.get(RECORD_KEY)), {
      ...record(), failureCount: 0, lastDeliveryAt: '2026-10-17T12:00:00.000Z', lastDeliveryStatus: 202,
    });

    const again = await tick(fake, deliver);
    assert.equal(again.deliveries, 0, 'one delivery per upward crossing');
  });

  it('keeps the crossing armed on failure and deactivates at the 5th consecutive failure without refreshing the TTL', async () => {
    const fake = seeded({ rec: record({ failureCount: 4 }) });
    const { deliver } = deliverStub([{ ok: false, status: 500, error: 'http_500' }]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.failures, 1);
    assert.equal(summary.deactivated, 1);
    const stored = JSON.parse(fake.store.get(RECORD_KEY));
    assert.equal(stored.active, false);
    assert.equal(stored.failureCount, 5);
    assert.equal(stored.lastDeliveryStatus, 500);
    assert.equal(stored.lastDeliveryError, 'http_500');
    assert.equal(stored.deactivatedAt, '2026-10-17T12:00:00.000Z');
    assert.equal(JSON.parse(fake.store.get(stateKey(SUB)).suez).armed, true);
    const write = fake.log.find((command) => command[0] === 'EVAL' && command[1] === RECORD_CAS_SCRIPT);
    assert.match(write[1], /'KEEPTTL'/);
    assert.equal(fake.log.some((command) => command[0] === 'SET' && command[1] === RECORD_KEY), false);

    const { sent, deliver: next } = deliverStub([]);
    await tick(fake, next);
    assert.equal(sent.length, 0, 'an inactive subscriber receives nothing');
  });

  it('counts a refused callback as a failure with no HTTP status', async () => {
    const fake = seeded({ rec: record({ failureCount: 1 }) });
    const { deliver } = deliverStub([{ ok: false, status: 0, error: 'ssrf' }]);
    await tick(fake, deliver);
    const stored = JSON.parse(fake.store.get(RECORD_KEY));
    assert.equal(stored.failureCount, 2);
    assert.equal(stored.lastDeliveryStatus, null);
    assert.equal(stored.active, true);
  });

  it('resets failureCount after a success', async () => {
    const fake = seeded({ rec: record({ failureCount: 3, lastDeliveryError: 'timeout' }) });
    const { deliver } = deliverStub([{ ok: true, status: 200 }]);
    await tick(fake, deliver);
    const stored = JSON.parse(fake.store.get(RECORD_KEY));
    assert.equal(stored.failureCount, 0);
    assert.equal('lastDeliveryError' in stored, false);
  });

  it('leaves a record that changed mid-tick alone', async () => {
    const fake = seeded();
    const rotated = JSON.stringify({ ...record(), secret: 'b'.repeat(64) });
    const deliver = async () => {
      fake.store.set(RECORD_KEY, rotated);
      return { ok: true, status: 200 };
    };
    await tick(fake, deliver);
    assert.equal(fake.store.get(RECORD_KEY), rotated, 'a rotated secret must survive the counter write');
  });

  it('backfills the index from records written before it existed, once', async () => {
    const fake = seeded({ backfilled: false });
    fake.store.delete('webhook:all:v1');
    const { sent, deliver } = deliverStub([]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.backfilled, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual([...fake.store.get('webhook:all:v1')], [SUB]);
    assert.equal(fake.store.get(BACKFILL_CURSOR_KEY), 'done');

    fake.log.length = 0;
    await tick(fake, deliver);
    assert.equal(fake.log.some((command) => command[0] === 'SCAN'), false);
  });

  it('backfills even when the API already created the index', async () => {
    const fake = seeded({ backfilled: false });
    fake.store.set('webhook:all:v1', new Set(['wh_new']));
    fake.store.set('webhook:sub:wh_new:v1', JSON.stringify(record({ subscriberId: 'wh_new' })));
    const { sent, deliver } = deliverStub([]);
    await tick(fake, deliver);
    assert.deepEqual(sent.map(({ rec }) => rec.subscriberId).sort(), [SUB, 'wh_new'].sort());
  });

  it('prunes ids whose record expired', async () => {
    const fake = seeded();
    fake.store.get('webhook:all:v1').add('wh_gone');
    fake.store.set(stateKey('wh_gone'), { suez: JSON.stringify({ armed: false, lastScore: 70 }) });
    const { deliver } = deliverStub([]);
    const summary = await tick(fake, deliver);
    assert.equal(summary.pruned, 1);
    assert.equal(fake.store.get('webhook:all:v1').has('wh_gone'), false);
    assert.equal(fake.store.has(stateKey('wh_gone')), false);
  });

  it('retries a failed crossing with the same delivery id and triggeredAt', async () => {
    const fake = seeded();
    const { sent, deliver } = deliverStub([{ ok: false, status: 0, error: 'timeout' }, { ok: true, status: 200 }]);
    await tick(fake, deliver);
    await tick(fake, deliver, { now: () => NOW + 5 * 60_000 });
    assert.equal(sent.length, 2);
    assert.match(sent[0].deliveryId, /^whd_[0-9a-f]{32}$/);
    assert.equal(sent[1].deliveryId, sent[0].deliveryId);
    assert.equal(sent[1].payload.triggeredAt, sent[0].payload.triggeredAt);
    const state = JSON.parse(fake.store.get(stateKey(SUB)).suez);
    assert.equal(state.armed, false);
    assert.equal(state.pending, undefined);
  });

  it('gives a new crossing a new delivery id after re-arming', async () => {
    const fake = seeded({ state: { armed: true, lastScore: 70, pending: { deliveryId: 'whd_old', triggeredAt: '2026-10-17T11:00:00.000Z' } } });
    fake.store.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({ chokepoints: [chokepoint('suez', 40)], fetchedAt: 'x' }));
    const { sent, deliver } = deliverStub([]);
    await tick(fake, deliver);
    assert.equal(sent.length, 0);
    assert.equal(JSON.parse(fake.store.get(stateKey(SUB)).suez).pending, undefined);
    fake.store.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({ chokepoints: [chokepoint('suez', 80)], fetchedAt: 'y' }));
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.notEqual(sent[0].deliveryId, 'whd_old');
  });

  it('keeps an index entry whose record was renewed after the read', async () => {
    const fake = seeded();
    fake.store.get('webhook:all:v1').add('wh_renewed');
    const renewed = JSON.stringify(record({ subscriberId: 'wh_renewed', chokepointIds: ['hormuz_strait'] }));
    const redis = async (commands) => {
      const rows = await fake.redis(commands);
      if (commands.some(([verb, key]) => verb === 'GET' && key === 'webhook:sub:wh_renewed:v1')) {
        fake.store.set('webhook:sub:wh_renewed:v1', renewed);
      }
      return rows;
    };
    const { deliver } = deliverStub([]);
    const summary = await tick({ ...fake, redis }, deliver);
    assert.equal(summary.pruned, 0);
    assert.equal(fake.store.get('webhook:all:v1').has('wh_renewed'), true);
  });

  it('stops sending and leaves only pending ids once the lock is lost', async () => {
    const fake = twoCrossings();
    const before = fake.store.get(RECORD_KEY);
    const { calls, lock } = lockStub(true, fake.store);
    const { sent, deliver: send } = deliverStub([]);
    const deliver = async (...args) => {
      fake.store.set(LOCK_KEY, 'run-2');
      return send(...args);
    };
    await assert.rejects(tick(fake, deliver, { lock }), /lock lost/);
    assert.equal(sent.length, 1);
    assert.equal(fake.store.get(RECORD_KEY), before);
    const state = fake.store.get(stateKey(SUB));
    assert.equal(JSON.parse(state.suez).pending.deliveryId, sent[0].deliveryId);
    assert.equal(JSON.parse(state.hormuz_strait).armed, true);
    assert.equal(fake.store.has(WORKER_META_KEY), false);
    assert.equal(calls.release, 1);
  });

  it('a worker whose lock was taken mid-delivery overwrites neither state nor record', async () => {
    const fake = seeded();
    const before = fake.store.get(RECORD_KEY);
    const { sent, deliver: send } = deliverStub([{ ok: true, status: 200 }]);
    const deliver = async (...args) => {
      fake.store.set(LOCK_KEY, 'run-2');
      return send(...args);
    };
    await assert.rejects(tick(fake, deliver), /lock lost/);
    assert.equal(sent.length, 1);
    const suez = JSON.parse(fake.store.get(stateKey(SUB)).suez);
    assert.equal(suez.armed, true, 'the new owner, not this worker, decides the disarm');
    assert.equal(suez.pending.deliveryId, sent[0].deliveryId);
    assert.equal(fake.store.get(RECORD_KEY), before);
  });

  it('does not recreate state for a subscriber pruned during the tick', async () => {
    const fake = seeded();
    const { deliver: send } = deliverStub([{ ok: true, status: 200 }]);
    const deliver = async (...args) => {
      fake.store.delete(RECORD_KEY);
      fake.store.delete(stateKey(SUB));
      return send(...args);
    };
    await tick(fake, deliver);
    assert.equal(fake.store.has(stateKey(SUB)), false);
  });

  it('stops a subscriber at its first failure in a tick so one outage counts once', async () => {
    const fake = twoCrossings();
    const { sent, deliver } = deliverStub([{ ok: false, status: 0, error: 'timeout' }]);
    const summary = await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(summary.failures, 1);
    assert.equal(JSON.parse(fake.store.get(RECORD_KEY)).failureCount, 1);
    const state = fake.store.get(stateKey(SUB));
    assert.ok(JSON.parse(state.hormuz_strait).pending, 'the unsent crossing waits for the next tick');
  });

  it('stops sending once the record changes mid-tick, so no send uses a rotated secret', async () => {
    const fake = twoCrossings();
    const rotated = JSON.stringify({ ...record({ chokepointIds: ['suez', 'hormuz_strait'] }), secret: 'b'.repeat(64) });
    const { sent, deliver: send } = deliverStub([]);
    const deliver = async (...args) => {
      fake.store.set(RECORD_KEY, rotated);
      return send(...args);
    };
    await tick(fake, deliver);
    assert.equal(sent.length, 1);
    assert.equal(fake.store.get(RECORD_KEY), rotated);
  });

  it('a worker whose lock was taken does not overwrite the health result', async () => {
    const fake = seeded({ rec: record({ active: false }) });
    fake.store.set(WORKER_META_KEY, 'successor');
    let stolen = false;
    const redis = async (commands) => {
      if (!stolen) { stolen = true; fake.store.set(LOCK_KEY, 'run-2'); }
      return fake.redis(commands);
    };
    await assert.rejects(tick({ ...fake, redis }, deliverStub([]).deliver), /lock lost/);
    assert.equal(fake.store.get(WORKER_META_KEY), 'successor');
  });

  it('retries a lock renewal that failed in transport', async () => {
    const fake = seeded();
    let failed = false;
    const redis = async (commands) => {
      if (!failed && commands.some((command) => command[1] === LOCK_RENEW_SCRIPT)) {
        failed = true;
        throw new Error('fetch failed');
      }
      return fake.redis(commands);
    };
    const { sent, deliver } = deliverStub([]);
    const summary = await tick({ ...fake, redis }, deliver);
    assert.equal(sent.length, 1);
    assert.equal(summary.deliveries, 1);
  });

  it('writes health status, meta, and the activation marker', async () => {
    const fake = seeded();
    const { deliver } = deliverStub([]);
    await tick(fake, deliver);
    assert.deepEqual(JSON.parse(fake.store.get(WORKER_META_KEY)), {
      fetchedAt: NOW,
      recordCount: 1,
      sourceState: 'ok',
      deliveries: 1,
      failures: 0,
      deactivated: 0,
      pruned: 0,
      scoresFetchedAt: '2026-10-17T11:58:00.000Z',
    });
    assert.equal(fake.ttl.get(WORKER_META_KEY), 7 * 86400);
    assert.equal(JSON.parse(fake.store.get(WORKER_STATUS_KEY)).subscribers, 1);
    assert.equal(fake.ttl.get(WORKER_STATUS_KEY), 3600);
    assert.equal(fake.store.get(WORKER_ACTIVATION_KEY), '1');
    assert.equal(fake.ttl.has(WORKER_ACTIVATION_KEY), false);
  });

  it('reports an unreadable score feed and delivers nothing', async () => {
    for (const blob of [undefined, '__WM_NEG__', JSON.stringify({ chokepoints: [], upstreamUnavailable: true })]) {
      const fake = seeded();
      if (blob === undefined) fake.store.delete(CHOKEPOINT_STATUS_KEY);
      else fake.store.set(CHOKEPOINT_STATUS_KEY, blob);
      const { sent, deliver } = deliverStub([]);
      const summary = await tick(fake, deliver);
      assert.equal(sent.length, 0);
      assert.equal(summary.sourceState, 'error');
      assert.equal(JSON.parse(fake.store.get(WORKER_META_KEY)).sourceState, 'error');
      assert.equal(fake.store.has(WORKER_ACTIVATION_KEY), false);
    }
  });

  it('falls back to the status RPC when the 5-minute cache has expired', async () => {
    const fake = seeded();
    fake.store.delete(CHOKEPOINT_STATUS_KEY);
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        chokepoints: [chokepoint('suez', 75)], fetchedAt: '2026-10-17T11:59:00.000Z', upstreamUnavailable: false,
      }));
    };
    const { sent, deliver } = deliverStub([]);
    const summary = await tick(fake, deliver, { env: { WORLDMONITOR_RELAY_KEY: 'relay-key' }, fetchImpl });
    assert.equal(summary.source, 'rpc');
    assert.equal(sent.length, 1);
    assert.equal(requests[0].url, CHOKEPOINT_STATUS_RPC_URL);
    assert.equal(requests[0].init.headers['X-WorldMonitor-Key'], 'relay-key');
  });

  it('does no Redis I/O when another instance holds the lock', async () => {
    const fake = seeded();
    const { calls, lock } = lockStub(false);
    const { sent, deliver } = deliverStub([]);
    const result = await runTick({ redis: fake.redis, lock, deliver, env: {}, now: () => NOW });
    assert.deepEqual(result, { skipped: true });
    assert.equal(fake.log.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(calls.release, 0);
  });

  it('releases the lock when the tick throws', async () => {
    const { calls, lock } = lockStub(true);
    const redis = async () => { throw new Error('redis down'); };
    await assert.rejects(runTick({ redis, lock, env: {}, now: () => NOW }), /redis down/);
    assert.equal(calls.release, 1);
  });
});
