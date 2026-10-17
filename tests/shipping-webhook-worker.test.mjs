import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKFILL_CURSOR_KEY,
  CHOKEPOINT_STATUS_KEY,
  CHOKEPOINT_STATUS_RPC_URL,
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
    transitSummary: { todayCountsAvailable: true, wowChangePct: -3 },
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

function plan(score, state, overrides = {}) {
  const rec = record(overrides);
  return planTick({
    chokepoints: [chokepoint('suez', score), chokepoint('hormuz_strait', 90)],
    records: [rec],
    states: new Map(state ? [[rec.subscriberId, { suez: state }]] : []),
    now: NOW,
    scoresFetchedAt: '2026-10-17T11:58:00.000Z',
  });
}

describe('planTick state machine', () => {
  it('fires once for a subscriber first seen above threshold', () => {
    const { deliveries, nextStates } = plan(75);
    assert.equal(deliveries.length, 1);
    assert.deepEqual(nextStates.get(record().subscriberId), { suez: { armed: true, lastScore: 75 } });
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
        const [, recordKey, expected, next] = args;
        if (store.get(recordKey) !== expected) return 0;
        store.set(recordKey, next);
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

function lockStub(acquired = true) {
  const calls = { acquire: 0, release: 0 };
  return {
    calls,
    lock: {
      acquire: async () => { calls.acquire += 1; return acquired; },
      release: async () => { calls.release += 1; },
    },
  };
}

const SUB = record().subscriberId;
const RECORD_KEY = `webhook:sub:${SUB}:v1`;

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
  const deliver = async (rec, payload) => {
    sent.push({ rec, payload });
    return outcomes.shift() ?? { ok: true, status: 200 };
  };
  return { sent, deliver };
}

const tick = (fake, deliver, extra = {}) => runTick({
  redis: fake.redis,
  lock: lockStub().lock,
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
      armed: false, lastScore: 75, lastDeliveredAt: '2026-10-17T12:00:00.000Z',
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
    const write = fake.log.find((command) => command[0] === 'EVAL');
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
