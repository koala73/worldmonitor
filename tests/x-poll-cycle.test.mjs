import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createXPollCycle } = require('../scripts/lib/x-poll-cycle.cjs');
const xNewsAccounts = require('../scripts/lib/x-news-accounts.cjs');

// These three functions used to live inside scripts/ais-relay.cjs, which has no
// module.exports and no require.main guard — importing it boots the relay — so
// the only "coverage" they had was tests/x-relay-state-contract.test.mjs
// asserting that regexes matched the file's SOURCE TEXT. A regex proves a string
// exists, not that a branch works: a generation-field collision, a lease handoff
// that permanently dropped a peer replica's posts, and a stuck-abort threshold
// that outlived the Redis lease all passed those assertions. Everything below
// executes the real code with stubbed Redis instead.

const CACHE_KEY = 'intelligence:x-feed:v1';
const POLL_STATE_KEY = 'intelligence:x-feed:poll-state:v1';
const LOCK_KEY = 'intelligence:x-feed:poll-lock:v1';
const META_KEY = 'seed-meta:intelligence:x-feed:v1';
const NOW = 1_700_000_000_000;

const ACCOUNT = {
  handle: 'Reuters',
  accountId: '1652541',
  label: 'Reuters',
  sourceName: 'Reuters',
  topic: 'world',
  tier: 1,
  enabled: true,
};

function post(id, ts) {
  return { id, postId: id, ts, text: `post ${id}`, sourceName: 'Reuters', handle: 'Reuters' };
}

// Mirrors the xState literal in scripts/ais-relay.cjs.
function makeState(overrides = {}) {
  return {
    accounts: [ACCOUNT],
    cursorByAccountId: Object.create(null),
    accountIdByHandle: Object.create(null),
    catchupByAccountId: Object.create(null),
    items: [],
    lookupOffset: 0,
    accountOffset: 0,
    generation: 0,
    lastPollAt: 0,
    lastHealthyAt: 0,
    lastCoverage: null,
    lastError: null,
    rateLimitedUntil: 0,
    rateLimitAttempt: 0,
    hydrationFailed: false,
    startedAt: NOW,
    ...overrides,
  };
}

// A poll result shaped like xNewsAccounts.pollXFeed's return value.
function pollResult(overrides = {}) {
  return {
    cursorByAccountId: { 1652541: '900' },
    accountIdByHandle: { reuters: '1652541' },
    catchupByAccountId: {},
    items: [],
    lookupOffset: 0,
    accountOffset: 0,
    accountsPolled: 1,
    accountsFailed: 0,
    accountsAttempted: 1,
    cycleComplete: true,
    newCount: 1,
    rateLimitedUntil: 0,
    rateLimitAttempt: 0,
    lastError: null,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const {
    state = makeState(),
    redis = new Map(),
    failGet = () => false,
    setNxResult = 'new',
    publishResult = true,
    pollXFeed = async () => pollResult(),
    autoFireTimer = true,
    xEnabled = true,
    now = () => NOW,
  } = options;

  const calls = {
    get: [], setNx: [], publish: [], release: [], poll: [], retry: [], timer: [],
    timerFns: [], loadAccounts: 0, log: [], warn: [],
  };
  let getIndex = 0;
  let generation = 1;

  const cycle = createXPollCycle({
    xState: state,
    xNewsAccounts: {
      ...xNewsAccounts,
      pollXFeed: async (args) => {
        // `args.state` is the live xState the cycle keeps mutating, so snapshot
        // the fields a test wants to inspect AT CALL TIME.
        calls.poll.push({
          ...args,
          cursorsAtCall: { ...args.state.cursorByAccountId },
          itemsAtCall: [...(args.state.items || [])],
        });
        return pollXFeed(args);
      },
    },
    loadXAccounts: () => { calls.loadAccounts += 1; return state.accounts; },
    upstashGet: async (key, onFailure) => {
      const index = getIndex++;
      calls.get.push(key);
      if (failGet(key, index)) {
        onFailure?.(`stubbed read failure (call ${index}, ${key})`);
        return null;
      }
      return redis.has(key) ? redis.get(key) : null;
    },
    upstashSetNx: async (key, owner, ttlSeconds) => {
      calls.setNx.push({ key, owner, ttlSeconds });
      return typeof setNxResult === 'function' ? setNxResult() : setNxResult;
    },
    upstashPublishXIfLockOwner: async (args) => {
      calls.publish.push(args);
      return typeof publishResult === 'function' ? publishResult(args) : publishResult;
    },
    upstashReleaseLockIfOwner: async (key, owner) => { calls.release.push({ key, owner }); return true; },
    getPollGeneration: () => generation,
    scheduleRetry: (retryAfterLeaseConflict) => { calls.retry.push(retryAfterLeaseConflict); },
    randomId: () => 'deadbeef',
    X_ENABLED: xEnabled,
    X_BEARER_TOKEN: 'test-bearer',
    X_FEED_CACHE_KEY: CACHE_KEY,
    X_FEED_META_KEY: META_KEY,
    X_FEED_POLL_STATE_KEY: POLL_STATE_KEY,
    X_FEED_POLL_LOCK_KEY: LOCK_KEY,
    X_FEED_TTL_SECONDS: 5400,
    X_FEED_META_TTL_SECONDS: 3600,
    X_FEED_POLL_LOCK_TTL_SECONDS: 720,
    X_MAX_FEED_ITEMS: 200,
    X_MAX_TEXT_CHARS: 800,
    log: (message) => calls.log.push(message),
    warn: (message) => calls.warn.push(message),
    now,
    pid: 4242,
    fetchImpl: () => { throw new Error('the cycle must not fetch directly'); },
    setTimer: (fn, ms) => {
      calls.timer.push(ms);
      calls.timerFns.push(fn);
      if (autoFireTimer) fn();
      return { unref() {} };
    },
  });

  return {
    cycle,
    calls,
    state,
    redis,
    getGeneration: () => generation,
    setGeneration: (value) => { generation = value; },
  };
}

describe('createXPollCycle — baseline cycle (positive control)', () => {
  it('publishes and commits when Redis reads, the lease and the publish all succeed', async () => {
    const harness = createHarness({
      pollXFeed: async () => pollResult({ items: [post('fresh-1', '2026-08-20T10:00:00Z')] }),
    });

    assert.equal(await harness.cycle.hydrate(), false, 'empty Redis hydrates to nothing, but not to a failure');
    assert.equal(harness.state.hydrationFailed, false);

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.setNx.length, 1);
    assert.equal(harness.calls.setNx[0].key, LOCK_KEY);
    assert.equal(harness.calls.setNx[0].ttlSeconds, 720);
    assert.match(harness.calls.setNx[0].owner, /^ais-relay:4242:1:\d+:deadbeef$/);
    assert.equal(harness.calls.publish.length, 1, 'a healthy cycle must publish exactly once');
    assert.equal(harness.calls.publish[0].snapshotKey, CACHE_KEY);
    assert.equal(harness.calls.publish[0].pollStateKey, POLL_STATE_KEY);
    assert.equal(harness.calls.publish[0].metaKey, META_KEY);
    assert.equal(harness.calls.publish[0].meta.sourceState, 'ok');
    assert.equal(harness.calls.publish[0].meta.fetchedAt, NOW);
    // Commit happens only after a successful publish.
    assert.deepEqual(harness.state.items.map((item) => item.id), ['fresh-1']);
    assert.equal(harness.state.generation, 1);
    assert.equal(harness.state.lastPollAt, NOW);
    assert.deepEqual({ ...harness.state.cursorByAccountId }, { 1652541: '900' });
    // The lease is always released, owner-fenced.
    assert.equal(harness.calls.release.length, 1);
    assert.equal(harness.calls.release[0].key, LOCK_KEY);
    assert.equal(harness.calls.release[0].owner, harness.calls.setNx[0].owner);
  });

  it('does not poll at all when X is disabled', async () => {
    const harness = createHarness({ xEnabled: false });
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(harness.calls.setNx.length, 0);
    assert.equal(harness.calls.publish.length, 0);
  });
});

describe('createXPollCycle — fail-closed hydration', () => {
  for (const failingKey of [CACHE_KEY, POLL_STATE_KEY]) {
    it(`latches hydrationFailed when the ${failingKey} read fails, and the next poll skips without publishing`, async () => {
      const harness = createHarness({ failGet: (key) => key === failingKey });

      assert.equal(await harness.cycle.hydrate(), false);
      assert.equal(harness.state.hydrationFailed, true, 'a failed GET is not an empty feed');
      assert.ok(harness.calls.warn.some((line) => /refusing to poll or publish/.test(line)));

      await harness.cycle.pollOnce({ generation: 1 });

      assert.equal(harness.calls.publish.length, 0, 'must never publish over last-good state it could not read');
      assert.equal(harness.calls.poll.length, 0, 'must not burn shared X quota either');
      assert.equal(
        harness.state.lastError,
        'X hydration still failing; skipped poll to protect last-good Redis state',
      );
      assert.equal(harness.state.hydrationFailed, true, 'the latch stays set for the next cycle');
    });
  }

  it('clears the latch and resumes once the read succeeds', async () => {
    let broken = true;
    const harness = createHarness({ failGet: () => broken });

    await harness.cycle.hydrate();
    assert.equal(harness.state.hydrationFailed, true);

    broken = false;
    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.state.hydrationFailed, false);
    assert.equal(harness.calls.publish.length, 1, 'the retry inside pollOnce must be able to clear the latch');
  });
});

describe('createXPollCycle — lease conflict', () => {
  function seedPeerRedis(redis) {
    redis.set(CACHE_KEY, xNewsAccounts.buildXFeedSnapshot(
      { items: [post('peer-1', '2026-08-20T09:00:00Z')], generation: 7, lastPollAt: NOW - 60_000 },
      { enabled: true, expectedAccounts: 1 },
    ));
    redis.set(POLL_STATE_KEY, xNewsAccounts.buildXPollState(
      { generation: 7, cursorByAccountId: { 1652541: '800' }, lastPollAt: NOW - 60_000 },
      { expectedAccounts: 1 },
    ));
  }

  it('re-hydrates, refuses to poll, and re-arms the guard exactly once', async () => {
    const harness = createHarness({ setNxResult: 'existing' });
    seedPeerRedis(harness.redis);

    await harness.cycle.pollOnce({ generation: 1, retryAfterLeaseConflict: true });

    assert.equal(harness.calls.poll.length, 0, 'a lock-loser must not poll X');
    assert.equal(harness.calls.publish.length, 0, 'a lock-loser must not publish');
    // Re-hydrated instead of serving frozen process-local items forever.
    assert.deepEqual(harness.calls.get, [CACHE_KEY, POLL_STATE_KEY]);
    assert.deepEqual(harness.state.items.map((item) => item.id), ['peer-1']);
    assert.equal(harness.state.generation, 7);
    // Exactly one re-arm, and it passes `false` — passing `true` self-perpetuated
    // a ~1Hz SETNX + log storm for the whole lease TTL.
    assert.deepEqual(harness.calls.retry, [false]);
    assert.deepEqual(harness.calls.timer, [1000]);
    assert.equal(harness.calls.release.length, 0, 'a lease we never took must not be released');
  });

  it('does not re-arm when the guard did not ask for a retry', async () => {
    const harness = createHarness({ setNxResult: 'existing' });
    seedPeerRedis(harness.redis);

    await harness.cycle.pollOnce({ generation: 1, retryAfterLeaseConflict: false });

    assert.deepEqual(harness.calls.retry, []);
    assert.deepEqual(harness.calls.timer, []);
    // The re-hydrate still happens — that is what bounds a non-owner's staleness.
    assert.deepEqual(harness.state.items.map((item) => item.id), ['peer-1']);
  });

  it('drops the re-arm when the guard generation moved on while the retry was pending', async () => {
    const harness = createHarness({ setNxResult: 'existing', autoFireTimer: false });
    seedPeerRedis(harness.redis);

    await harness.cycle.pollOnce({ generation: 1, retryAfterLeaseConflict: true });
    assert.equal(harness.calls.timerFns.length, 1);

    harness.setGeneration(2);
    harness.calls.timerFns[0]();

    assert.deepEqual(harness.calls.retry, [], 'a superseded run must not schedule a poll');
  });
});

describe('createXPollCycle — cursor-rewind and item-loss prevention', () => {
  // hydrate() reads CACHE then POLL_STATE (indexes 0,1); the re-read under the
  // lock reads POLL_STATE then CACHE (indexes 2,3).
  for (const [label, failingIndex] of [['poll-state', 2], ['snapshot', 3]]) {
    it(`skips the cycle when the ${label} re-read under the lock fails`, async () => {
      const harness = createHarness({ failGet: (key, index) => index === failingIndex });

      await harness.cycle.hydrate();
      assert.equal(harness.state.hydrationFailed, false);

      await harness.cycle.pollOnce({ generation: 1 });

      assert.equal(harness.calls.poll.length, 0);
      assert.equal(harness.calls.publish.length, 0, 'publishing here rewinds since_id or drops a peer\'s items');
      assert.equal(
        harness.state.lastError,
        'Redis re-read failed under the lock; skipped cycle rather than risk a cursor rewind or item loss',
      );
      assert.equal(harness.calls.release.length, 1, 'the lease we took is still released');
    });
  }

  it('adopts the peer cursor map read under the lock instead of republishing stale cursors', async () => {
    const harness = createHarness({
      state: makeState({ cursorByAccountId: { 1652541: '100' } }),
      pollXFeed: async () => pollResult({ cursorByAccountId: { 1652541: '900' } }),
    });
    harness.redis.set(POLL_STATE_KEY, xNewsAccounts.buildXPollState(
      { generation: 7, cursorByAccountId: { 1652541: '800' }, lastPollAt: NOW - 60_000 },
      { expectedAccounts: 1 },
    ));

    await harness.cycle.pollOnce({ generation: 1 });

    // pollXFeed must have been handed Redis truth (800), not the stale local 100.
    assert.deepEqual(harness.calls.poll[0].cursorsAtCall, { 1652541: '800' });
    // And the snapshot version never goes backwards behind a peer's.
    assert.equal(harness.calls.publish[0].snapshot.generation, 8);
  });
});

describe('createXPollCycle — peer item preservation', () => {
  it('folds a peer post that only exists in Redis back into the published snapshot', async () => {
    const local = post('local-1', '2026-08-20T08:00:00Z');
    const peer = post('peer-1', '2026-08-20T09:00:00Z');
    const fresh = post('fresh-1', '2026-08-20T10:00:00Z');

    const harness = createHarness({
      state: makeState({ items: [local] }),
      // pollXFeed merges new posts into whatever state.items holds at call time,
      // exactly as the real implementation does.
      pollXFeed: async ({ state }) => pollResult({
        items: xNewsAccounts.mergeAndDedup(state.items, [fresh], 200),
      }),
    });
    // Redis holds the peer's post AND its own copy of ours; our in-memory state
    // never saw peer-1 because our last hydrate ran before the peer published.
    harness.redis.set(CACHE_KEY, xNewsAccounts.buildXFeedSnapshot(
      { items: [peer, local], generation: 7, lastPollAt: NOW - 60_000 },
      { enabled: true, expectedAccounts: 1 },
    ));
    harness.redis.set(POLL_STATE_KEY, xNewsAccounts.buildXPollState(
      { generation: 7, cursorByAccountId: { 1652541: '800' }, lastPollAt: NOW - 60_000 },
      { expectedAccounts: 1 },
    ));

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.publish.length, 1);
    const publishedIds = harness.calls.publish[0].snapshot.items.map((item) => item.id).sort();
    // The peer's post is the one that used to be lost for good: the cursor map we
    // just read has already advanced past its id, so it is never re-fetched.
    assert.deepEqual(publishedIds, ['fresh-1', 'local-1', 'peer-1']);
    assert.deepEqual(harness.state.items.map((item) => item.id).sort(), ['fresh-1', 'local-1', 'peer-1']);
  });
});

describe('createXPollCycle — generation fencing', () => {
  it('discards a result that lands after the guard generation moved on', async () => {
    let harness;
    harness = createHarness({
      pollXFeed: async () => {
        harness.setGeneration(9);
        return pollResult({ items: [post('fresh-1', '2026-08-20T10:00:00Z')] });
      },
    });

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.publish.length, 0, 'a superseded run must not publish');
    assert.ok(harness.calls.warn.some((line) => /generation 1 finished stale; discarding result/.test(line)));
    assert.deepEqual(harness.state.items, [], 'and must not commit its cursors or items');
    assert.deepEqual({ ...harness.state.cursorByAccountId }, {});
    assert.equal(harness.state.lastPollAt, 0);
  });

  it('discards a result whose abort signal fired', async () => {
    const harness = createHarness({
      pollXFeed: async () => pollResult({ items: [post('fresh-1', '2026-08-20T10:00:00Z')] }),
    });

    await harness.cycle.pollOnce({ generation: 1, signal: { aborted: true } });

    assert.equal(harness.calls.publish.length, 0);
    assert.deepEqual(harness.state.items, []);
  });
});

describe('createXPollCycle — publish before commit', () => {
  it('leaves xState uncommitted when the lease-guarded publish fails', async () => {
    const existing = post('local-1', '2026-08-20T08:00:00Z');
    const harness = createHarness({
      state: makeState({ items: [existing], cursorByAccountId: { 1652541: '100' } }),
      publishResult: false,
      pollXFeed: async () => pollResult({
        items: [post('fresh-1', '2026-08-20T10:00:00Z'), existing],
        rateLimitedUntil: NOW + 30_000,
        rateLimitAttempt: 2,
      }),
    });

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.publish.length, 1, 'publish is attempted first');
    assert.deepEqual(harness.state.items.map((item) => item.id), ['local-1'], 'items must not advance past Redis');
    assert.deepEqual({ ...harness.state.cursorByAccountId }, { 1652541: '100' }, 'cursors must not advance past Redis');
    assert.equal(harness.state.generation, 0);
    assert.equal(harness.state.lastPollAt, 0);
    assert.equal(harness.state.lastError, 'lost X poll lease before publication');
    assert.ok(harness.calls.warn.some((line) => /keeping previous state so Redis stays the source of truth/.test(line)));
    // Rate-limit state is protective and is deliberately kept even on failure —
    // dropping it would let the next tick hammer a 429ing upstream.
    assert.equal(harness.state.rateLimitedUntil, NOW + 30_000);
    assert.equal(harness.state.rateLimitAttempt, 2);
  });

  it('reports the publish result through publish() itself', async () => {
    const harness = createHarness({ publishResult: false });
    assert.equal(await harness.cycle.publish(1, { accountsPolled: 1, cycleComplete: true, lockOwner: 'owner-1' }), false);
    assert.equal(harness.state.lastError, 'lost X poll lease before publication');
    assert.equal(harness.calls.publish[0].owner, 'owner-1');
    assert.equal(harness.calls.publish[0].ttlSeconds, 5400);
    assert.equal(harness.calls.publish[0].metaTtlSeconds, 3600);
  });

  it('omits seed metadata when no account was actually polled', async () => {
    const harness = createHarness();
    assert.equal(await harness.cycle.publish(1, { accountsPolled: 0, cycleComplete: false, lockOwner: 'owner-1' }), true);
    assert.equal(harness.calls.publish[0].meta, null, 'a zero-account cycle must not refresh seed-meta freshness');
  });
});

describe('createXPollCycle — 429 backoff preservation', () => {
  it('keeps the LATER deadline and the HIGHER attempt count when Redis is older', async () => {
    const harness = createHarness({
      state: makeState({ rateLimitedUntil: NOW + 300_000, rateLimitAttempt: 3 }),
    });
    harness.redis.set(POLL_STATE_KEY, xNewsAccounts.buildXPollState(
      { generation: 7, rateLimitedUntil: NOW + 1_000, rateLimitAttempt: 1 },
      { expectedAccounts: 1 },
    ));

    assert.equal(await harness.cycle.hydrate(), true);

    assert.equal(harness.state.rateLimitedUntil, NOW + 300_000, 'an older Redis copy must not clear our fresh backoff');
    assert.equal(harness.state.rateLimitAttempt, 3, 'escalation must not reset behind a peer with a lower count');
  });

  it('adopts a peer backoff that is later than ours', async () => {
    const harness = createHarness({
      state: makeState({ rateLimitedUntil: NOW + 1_000, rateLimitAttempt: 1 }),
    });
    harness.redis.set(POLL_STATE_KEY, xNewsAccounts.buildXPollState(
      { generation: 7, rateLimitedUntil: NOW + 300_000, rateLimitAttempt: 4 },
      { expectedAccounts: 1 },
    ));

    assert.equal(await harness.cycle.hydrate(), true);

    assert.equal(harness.state.rateLimitedUntil, NOW + 300_000, 'the shared bearer means a peer 429 applies here too');
    assert.equal(harness.state.rateLimitAttempt, 4);
  });

  it('defers the poll while a shared backoff window read under the lock is still open', async () => {
    const harness = createHarness();
    harness.redis.set(POLL_STATE_KEY, xNewsAccounts.buildXPollState(
      { generation: 7, rateLimitedUntil: NOW + 300_000, rateLimitAttempt: 4 },
      { expectedAccounts: 1 },
    ));

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.poll.length, 0, 'the pre-lock check only saw our own state');
    assert.equal(harness.calls.publish.length, 0);
    assert.equal(harness.state.lastError, 'shared X rate-limit window still open; deferring poll');
  });

  it('returns before taking the lease while our own backoff is open', async () => {
    const harness = createHarness({ state: makeState({ rateLimitedUntil: NOW + 300_000 }) });
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(harness.calls.setNx.length, 0);
  });
});

describe('createXPollCycle — dependency wiring', () => {
  it('refuses to build without the collaborators it cannot fake', () => {
    assert.throws(() => createXPollCycle({}), /xState is required/);
    assert.throws(() => createXPollCycle({ xState: makeState() }), /xNewsAccounts is required/);
  });
});
