import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createXPollCycle, xPollSlot } = require('../scripts/lib/x-poll-cycle.cjs');
const xNewsAccounts = require('../scripts/lib/x-news-accounts.cjs');
const {
  createXPostBudget,
  RESERVE_LUA,
  SETTLE_LUA,
  ACK_RECEIPTS_LUA,
} = require('../scripts/lib/x-post-budget.cjs');

const CACHE_KEY = 'intelligence:x-feed:v1';
const POLL_STATE_KEY = 'intelligence:x-feed:poll-state:v1';
const LOCK_KEY = 'intelligence:x-feed:poll-lock:v1';
const META_KEY = 'seed-meta:intelligence:x-feed:v1';
const LIST_ID = '1234567890123456789';
const NOW = Date.parse('2026-09-03T12:07:30.000Z');
const SLOT_ID = '2026-09-03T12:00:00.000Z';
const ACCOUNT = {
  handle: 'Reuters',
  accountId: '1652541',
  label: 'Reuters',
  sourceName: 'Reuters',
  topic: 'world',
  enabled: true,
};

function post(id, ts = '2026-09-03T12:06:00.000Z') {
  return {
    id: `Reuters:${id}`,
    postId: id,
    source: 'x',
    account: 'Reuters',
    accountId: ACCOUNT.accountId,
    accountTitle: 'Reuters',
    sourceName: 'Reuters',
    url: `https://x.com/Reuters/status/${id}`,
    ts,
    text: `post ${id}`,
    topic: 'world',
    tags: [],
    lang: 'en',
    hasMedia: false,
    isReply: false,
    isQuote: false,
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    earlySignal: true,
    storageState: 'metadata_only',
    contentState: 'active',
  };
}

function makeState(overrides = {}) {
  return {
    accounts: [ACCOUNT],
    items: [],
    lookupOffset: 0,
    generation: 0,
    lastPollAt: 0,
    lastHealthyAt: 0,
    lastAttemptAt: 0,
    lastProviderSuccessAt: 0,
    lastAcceptedPublicationAt: 0,
    lastAttemptSlot: null,
    lastProviderSuccessSlot: null,
    lastPublishedSlot: null,
    lastCoverage: null,
    lastError: null,
    rateLimitedUntil: 0,
    rateLimitAttempt: 0,
    backoffCause: null,
    lastDeletionAuditAt: 0,
    lastCycleUsage: null,
    postBudget: null,
    hydrationFailed: false,
    startedAt: NOW,
    ...overrides,
  };
}

function pollResult(overrides = {}) {
  return {
    items: [],
    lookupOffset: 0,
    lastDeletionAuditAt: 0,
    lastCycleUsage: { requestsUsed: 1, requestLimit: 2, postsRead: 0, postReadLimit: 5 },
    postBudget: { available: true, dailyLimit: 600, dailyUsed: 5, monthlyLimit: 20_000, monthlyUsed: 5 },
    accountsPolled: 1,
    accountsFailed: 0,
    accountsAttempted: 1,
    cycleComplete: true,
    listAccepted: true,
    providerSuccess: true,
    newCount: 0,
    receiptAcks: [],
    rateLimitedUntil: 0,
    rateLimitAttempt: 0,
    backoffCause: null,
    lastError: null,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const state = options.state ?? makeState();
  const redis = options.redis ?? new Map();
  const calls = {
    get: [], setNx: [], publish: [], release: [], poll: [], retry: [], ack: [], warn: [], timer: [],
  };
  let generation = 1;
  const pollXFeed = options.pollXFeed ?? (async () => pollResult());
  const providedBudget = options.xPostBudget || {};
  const publishResult = options.publishResult ?? ((args) => {
    redis.set(CACHE_KEY, args.snapshot);
    redis.set(POLL_STATE_KEY, args.pollState);
    return true;
  });
  const cycle = createXPollCycle({
    xState: state,
    xNewsAccounts: {
      ...xNewsAccounts,
      pollXFeed: async (args) => {
        calls.poll.push(args);
        return pollXFeed(args);
      },
    },
    xPostBudget: {
      withReturnedPosts: providedBudget.withReturnedPosts
        ? (request) => providedBudget.withReturnedPosts(request)
        : async (request) => request.execute({}, {}),
      ackReceipts: async (receipts) => {
        calls.ack.push(receipts);
        return providedBudget.ackReceipts ? providedBudget.ackReceipts(receipts) : true;
      },
    },
    loadXAccounts: () => state.accounts,
    upstashGet: async (key, onFailure) => {
      calls.get.push(key);
      options.onGet?.(key);
      if (options.failGet?.(key)) {
        onFailure?.('stubbed failure');
        return null;
      }
      return redis.get(key) ?? null;
    },
    upstashSetNx: async (key, owner, ttlSeconds) => {
      calls.setNx.push({ key, owner, ttlSeconds });
      return typeof options.setNxResult === 'function'
        ? options.setNxResult({ key, owner, ttlSeconds })
        : (options.setNxResult ?? 'new');
    },
    upstashPublishXIfLockOwner: async (args) => {
      calls.publish.push(args);
      return typeof publishResult === 'function' ? publishResult(args) : publishResult;
    },
    upstashReleaseLockIfOwner: async (key, owner) => { calls.release.push({ key, owner }); return true; },
    getPollGeneration: () => generation,
    scheduleRetry: (retry) => calls.retry.push(retry),
    randomId: () => 'deadbeef',
    X_ENABLED: options.xEnabled ?? true,
    X_BEARER_TOKEN: 'test-bearer',
    X_CURATED_LIST_ID: LIST_ID,
    X_POLL_INTERVAL_MS: 15 * 60 * 1000,
    X_FEED_CACHE_KEY: CACHE_KEY,
    X_FEED_META_KEY: META_KEY,
    X_FEED_POLL_STATE_KEY: POLL_STATE_KEY,
    X_FEED_POLL_LOCK_KEY: LOCK_KEY,
    X_FEED_TTL_SECONDS: 5400,
    X_FEED_META_TTL_SECONDS: 3600,
    X_FEED_POLL_LOCK_TTL_SECONDS: options.xFeedPollLockTtlSeconds ?? 120,
    X_MAX_FEED_ITEMS: 200,
    X_MAX_TEXT_CHARS: 800,
    now: options.now ?? (() => NOW),
    pid: 4242,
    fetchImpl: options.fetchImpl ?? (() => { throw new Error('cycle must not fetch directly'); }),
    warn: (line) => calls.warn.push(line),
    setTimer: (fn, ms) => {
      calls.timer.push({ fn, ms });
      return { fn, unref() {} };
    },
  });
  return { cycle, state, redis, calls, setGeneration: (value) => { generation = value; } };
}

describe('fixed X poll slots', () => {
  it('aligns every time to a fixed 15-minute UTC slot', () => {
    assert.deepEqual(xPollSlot(NOW), {
      id: SLOT_ID,
      startsAt: Date.parse(SLOT_ID),
      endsAt: Date.parse('2026-09-03T12:15:00.000Z'),
    });
  });

  it('does not admit work twice in a slot, including after hydration', async () => {
    const first = createHarness();
    await first.cycle.pollOnce({ generation: 1 });

    const restarted = createHarness({ redis: first.redis });
    assert.equal(await restarted.cycle.hydrate(), true);
    await restarted.cycle.pollOnce({ generation: 1 });

    assert.equal(restarted.calls.setNx.length, 0);
    assert.equal(restarted.calls.poll.length, 0);
    assert.equal(restarted.state.lastAttemptSlot, SLOT_ID);
  });

  it('uses the active slot when Redis reads cross a slot boundary', async () => {
    let clock = Date.parse('2026-09-03T12:14:59.999Z');
    let crossed = false;
    const harness = createHarness({
      now: () => clock,
      onGet: () => {
        if (crossed) return;
        crossed = true;
        clock = Date.parse('2026-09-03T12:15:00.001Z');
      },
    });

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.poll.length, 1);
    assert.equal(harness.calls.poll[0].coverageId, 'list-slot:2026-09-03T12:15:00.000Z');
    assert.equal(harness.state.lastAttemptSlot, '2026-09-03T12:15:00.000Z');
  });

  it('retries the current slot when the prior slot ends during budget admission', async () => {
    let clock = Date.parse('2026-09-03T12:14:59.999Z');
    const harness = createHarness({
      now: () => clock,
      pollXFeed: async () => {
        clock = Date.parse('2026-09-03T12:15:00.001Z');
        return pollResult({
          cycleComplete: false,
          listAccepted: false,
          providerSuccess: false,
          lastError: 'X Post budget source_window_expired; List page deferred',
        });
      },
    });

    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.state.lastAttemptSlot, '2026-09-03T12:00:00.000Z');
    assert.equal(harness.calls.timer.length, 1);
    assert.equal(harness.calls.timer[0].ms, 1000);
    harness.calls.timer[0].fn();
    assert.deepEqual(harness.calls.retry, [false]);
  });

  it('a lock loser rehydrates peer state and makes no provider request', async () => {
    const peer = createHarness();
    await peer.cycle.pollOnce({ generation: 1 });
    const loser = createHarness({ redis: peer.redis, setNxResult: 'existing' });
    await loser.cycle.pollOnce({ generation: 1, retryAfterLeaseConflict: true });
    assert.equal(loser.calls.poll.length, 0);
    assert.equal(loser.calls.publish.length, 0);
    assert.equal(loser.state.lastPublishedSlot, SLOT_ID);
    assert.deepEqual(loser.calls.retry, []);
  });

  it('recovers at the next slot after a crashed owner lease expires', async () => {
    let clock = NOW;
    const crashedLeaseExpiresAt = NOW + 120_000;
    const harness = createHarness({
      now: () => clock,
      setNxResult: ({ ttlSeconds }) => {
        assert.equal(ttlSeconds, 120);
        return clock < crashedLeaseExpiresAt ? 'existing' : 'new';
      },
    });

    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(harness.calls.poll.length, 0);

    clock += 15 * 60 * 1000;
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(harness.calls.poll.length, 1);
    assert.equal(harness.state.lastAttemptSlot, '2026-09-03T12:15:00.000Z');
  });
});

describe('X provider and publication clocks', () => {
  it('publishes a valid empty page and moves all accepted-publication clocks', async () => {
    const harness = createHarness();
    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.poll[0].listId, LIST_ID);
    assert.equal(harness.calls.poll[0].coverageId, `list-slot:${SLOT_ID}`);
    assert.equal(harness.calls.publish[0].meta.sourceState, 'ok');
    assert.equal(harness.calls.publish[0].meta.fetchedAt, NOW);
    assert.equal(harness.state.lastAttemptAt, NOW);
    assert.equal(harness.state.lastProviderSuccessAt, NOW);
    assert.equal(harness.state.lastAcceptedPublicationAt, NOW);
    assert.equal(harness.state.lastPollAt, NOW);
    assert.equal(harness.state.lastHealthyAt, NOW);
    assert.equal(harness.state.lastPublishedSlot, SLOT_ID);
  });

  it('keeps accepted List seed metadata healthy when deletion maintenance fails', async () => {
    const harness = createHarness({
      pollXFeed: async () => pollResult({ lastError: 'rate limited during deletion lookup' }),
    });
    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.publish[0].meta.sourceState, 'ok');
    assert.equal(harness.calls.publish[0].meta.fetchedAt, NOW);
    assert.equal(harness.state.lastHealthyAt, NOW);
    assert.equal(harness.state.lastError, 'rate limited during deletion lookup');
  });

  it('persists private attempt diagnostics without refreshing public freshness or seed meta', async () => {
    const harness = createHarness({
      pollXFeed: async () => pollResult({
        cycleComplete: false,
        listAccepted: false,
        providerSuccess: true,
        accountsPolled: 0,
        accountsAttempted: 1,
        lastError: 'invalid page',
      }),
    });
    await harness.cycle.pollOnce({ generation: 1 });

    assert.equal(harness.calls.publish[0].meta, null);
    assert.equal(harness.state.lastAttemptAt, NOW);
    assert.equal(harness.state.lastProviderSuccessAt, NOW);
    assert.equal(harness.state.lastAcceptedPublicationAt, 0);
    assert.equal(harness.state.lastPollAt, 0);
    assert.equal(harness.state.lastHealthyAt, 0);
    assert.equal(harness.state.lastAttemptSlot, SLOT_ID);
    assert.equal(harness.state.lastPublishedSlot, null);
  });

  it('keeps every clock and last-good item uncommitted when publication loses the lease', async () => {
    const existing = post('7000000000000000001');
    const harness = createHarness({
      state: makeState({ items: [existing] }),
      publishResult: false,
      pollXFeed: async () => pollResult({
        items: [post('7000000000000000002'), existing],
        receiptAcks: [{ key: 'receipt', expected: '{}' }],
      }),
    });
    await harness.cycle.pollOnce({ generation: 1 });

    assert.deepEqual(harness.state.items, [existing]);
    assert.equal(harness.state.lastAttemptAt, 0);
    assert.equal(harness.state.lastProviderSuccessAt, 0);
    assert.equal(harness.state.lastAcceptedPublicationAt, 0);
    assert.equal(harness.state.lastPollAt, 0);
    assert.equal(harness.calls.ack.length, 0);
  });

  it('does not poll or publish when X List configuration is disabled', async () => {
    const harness = createHarness({ xEnabled: false });
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(harness.calls.setNx.length, 0);
    assert.equal(harness.calls.publish.length, 0);
  });
});

describe('receipt recovery and Redis safety', () => {
  it('publishes last-good state before acknowledging an invalid replay receipt', async () => {
    const existing = post('7000000000000000009');
    let receipt = JSON.stringify({
      version: 1,
      listId: LIST_ID,
      sourceSlot: SLOT_ID,
      providerSuccessAt: NOW,
      rawPostCount: 1,
      posts: [{ id: '7000000000000000010', accountId: '999999999999999999', item: null }],
    });
    const budget = createXPostBudget({
      now: () => NOW,
      dailyCoveragePosts: 505,
      evalCommand: async (script) => {
        if (script === RESERVE_LUA) return [0, 5, 5, 4, 500, receipt];
        if (script === ACK_RECEIPTS_LUA) {
          receipt = null;
          return 1;
        }
        throw new Error('invalid replay must not reserve or settle new work');
      },
    });
    let publishes = 0;
    let fetches = 0;
    const harness = createHarness({
      state: makeState({
        items: [existing],
        lastPollAt: NOW - 15 * 60_000,
        lastHealthyAt: NOW - 15 * 60_000,
      }),
      xPostBudget: budget,
      publishResult: () => {
        publishes += 1;
        return publishes > 1;
      },
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ meta: { result_count: 0 } });
      },
      pollXFeed: (args) => xNewsAccounts.pollXFeed({ ...args, lookupDeletions: false, verifyMembership: false }),
    });

    await harness.cycle.pollOnce({ generation: 1 });
    assert.notEqual(receipt, null);
    assert.equal(harness.calls.ack.length, 0);
    assert.equal(harness.state.lastPollAt, NOW - 15 * 60_000);

    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(fetches, 0);
    assert.equal(receipt, null);
    assert.equal(harness.calls.ack.length, 1);
    assert.deepEqual(harness.state.items, [existing]);
    assert.equal(harness.state.lastPollAt, NOW - 15 * 60_000);
    assert.equal(harness.state.lastHealthyAt, NOW - 15 * 60_000);
    assert.match(harness.state.lastError, /no longer valid/);
  });

  it('replays a paid List page before another provider request and acknowledges only after publish', async () => {
    let receipt = null;
    let reservation = 0;
    let clock = NOW;
    const budget = createXPostBudget({
      now: () => NOW,
      idFactory: () => 'receipt-test',
      dailyCoveragePosts: 505,
      evalCommand: async (script, _keys, args) => {
        if (script === RESERVE_LUA) {
          if (receipt) return [0, reservation, reservation, 4, 500, receipt];
          reservation = Number(args[0]);
          return [1, reservation, reservation, 0, 500, ''];
        }
        if (script === SETTLE_LUA) {
          receipt = args[3];
          return [1, 1, 1, reservation, 1, 500];
        }
        if (script === ACK_RECEIPTS_LUA) {
          receipt = null;
          return 1;
        }
        throw new Error('unexpected budget command');
      },
    });
    let fetches = 0;
    let publishes = 0;
    const harness = createHarness({
      now: () => clock,
      xPostBudget: budget,
      publishResult: (args) => {
        publishes += 1;
        if (publishes === 1) return false;
        harness.redis.set(CACHE_KEY, args.snapshot);
        harness.redis.set(POLL_STATE_KEY, args.pollState);
        return true;
      },
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({
          data: [{
            id: '7000000000000000010',
            author_id: ACCOUNT.accountId,
            text: 'paid once',
            created_at: '2026-09-03T12:06:00.000Z',
          }],
          meta: { result_count: 1 },
        });
      },
      pollXFeed: (args) => xNewsAccounts.pollXFeed({ ...args, lookupDeletions: false, verifyMembership: false }),
    });

    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(fetches, 1);
    assert.equal(harness.calls.ack.length, 0);
    clock += 15 * 60 * 1000;
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(fetches, 1);
    assert.equal(harness.state.items[0].postId, '7000000000000000010');
    assert.equal(harness.state.lastAttemptSlot, '2026-09-03T12:15:00.000Z');
    assert.equal(harness.state.lastProviderSuccessSlot, SLOT_ID);
    assert.equal(harness.state.lastProviderSuccessAt, NOW);
    assert.equal(harness.state.lastPublishedSlot, '2026-09-03T12:15:00.000Z');
    assert.equal(harness.state.lastAcceptedPublicationAt, clock);
    assert.equal(harness.state.lastPollAt, NOW,
      'public freshness stays bound to the original provider success');
    assert.equal(harness.calls.ack.length, 1);
    assert.equal(receipt, null);
  });

  it('acknowledges an already-published receipt without renewing public freshness', async () => {
    let receipt = null;
    let reservation = 0;
    let ackAttempts = 0;
    let clock = NOW;
    const budget = createXPostBudget({
      now: () => clock,
      idFactory: () => 'ack-retry',
      dailyCoveragePosts: 505,
      evalCommand: async (script, _keys, args) => {
        if (script === RESERVE_LUA) {
          if (receipt) return [0, reservation, reservation, 4, 500, receipt];
          reservation = Number(args[0]);
          return [1, reservation, reservation, 0, 500, ''];
        }
        if (script === SETTLE_LUA) {
          receipt = args[3];
          return [1, 1, 1, reservation, 1, 500];
        }
        if (script === ACK_RECEIPTS_LUA) {
          ackAttempts += 1;
          if (ackAttempts === 1) return 0;
          receipt = null;
          return 1;
        }
        throw new Error('unexpected budget command');
      },
    });
    let fetches = 0;
    const harness = createHarness({
      now: () => clock,
      xPostBudget: budget,
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ meta: { result_count: 0 } });
      },
      pollXFeed: (args) => xNewsAccounts.pollXFeed({ ...args, lookupDeletions: false, verifyMembership: false }),
    });

    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(fetches, 1);
    assert.equal(harness.state.lastPollAt, NOW);
    assert.equal(harness.state.lastAcceptedPublicationAt, NOW);
    assert.equal(receipt == null, false);

    clock += 15 * 60 * 1000;
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(fetches, 1);
    assert.equal(harness.state.lastPollAt, NOW);
    assert.equal(harness.state.lastAcceptedPublicationAt, NOW);
    assert.equal(harness.state.lastProviderSuccessAt, NOW);
    assert.equal(harness.state.lastAttemptSlot, '2026-09-03T12:15:00.000Z');
    assert.equal(harness.state.lastPublishedSlot, SLOT_ID);
    assert.equal(harness.calls.publish[1].meta, null);
    assert.equal(ackAttempts, 2);
    assert.equal(receipt, null);
  });

  it('fails closed when hydration cannot read either Redis document', async () => {
    const harness = createHarness({ failGet: () => true });
    assert.equal(await harness.cycle.hydrate(), false);
    assert.equal(harness.state.hydrationFailed, true);
    await harness.cycle.pollOnce({ generation: 1 });
    assert.equal(harness.calls.poll.length, 0);
    assert.equal(harness.calls.publish.length, 0);
  });
});

describe('X poll cycle dependencies', () => {
  it('refuses to build without required collaborators', () => {
    assert.throws(() => createXPollCycle({}), /xState is required/);
    assert.throws(() => createXPollCycle({ xState: makeState() }), /xNewsAccounts is required/);
  });
});
