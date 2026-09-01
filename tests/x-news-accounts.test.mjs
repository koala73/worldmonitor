import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const xNews = require('../scripts/lib/x-news-accounts.cjs');
const registry = JSON.parse(readFileSync(join(__dirname, '../data/x-accounts.json'), 'utf8'));

describe('data/x-accounts.json registry (#6654)', () => {
  it('has the Telegram-shaped product-managed envelope', () => {
    assert.equal(registry.version, 1);
    assert.ok(registry.updatedAt);
    assert.match(String(registry.note), /Product-managed/);
    assert.ok(registry.channels.full);
    assert.ok(registry.channels.tech);
    assert.ok(Array.isArray(registry.channels.finance));
  });

  it('stays in the Telegram analogue ballpark of enabled accounts', () => {
    // Back to 64. Both accounts first disabled here as `protected` were the
    // registry naming the wrong account, not the publisher being unreachable:
    // handle `OSINTdefender` is 'Depressed Defender' (626 followers, bio:
    // "Backup Account of @sentdefender"), while the 2.5M-follower OSINT monitor
    // is @sentdefender; and DW's English newsroom is public at @DeutscheWelle
    // while @dwnews is locked. Disabling them dropped two real sources to
    // silence a symptom. Verified against the API 2026-08-21.
    const enabled = xNews.countEnabledAccounts(registry);
    assert.equal(enabled, 64, `expected 64 enabled accounts, got ${enabled}`);
    const all = xNews.loadXAccounts(registry);
    const full = xNews.loadXAccounts(registry, { set: 'full' });
    const tech = xNews.loadXAccounts(registry, { set: 'tech' });
    assert.equal(all.length, 64);
    assert.equal(new Set(all.map((account) => account.handle.toLowerCase())).size, 64);
    assert.equal(full.length, 56);
    assert.equal(tech.length, 8);
  });

  it('pins a verified numeric accountId on every enabled account', () => {
    // This assertion used to read `if (account.accountId)`, which is vacuous
    // for an account that has none — and 41 of 64 shipped without one. The
    // registry was curated with no API access, so six handles pointed at
    // accounts that do not exist and four pinned ids pointed at unrelated
    // private individuals whose posts would have published as trusted tier-2
    // wire services. An id is the identity the poll loop actually uses, so it
    // is required, not optional (#6654 follow-up).
    const accounts = [
      ...xNews.loadXAccounts(registry, { set: 'full' }),
      ...xNews.loadXAccounts(registry, { set: 'tech' }),
    ];
    for (const account of accounts) {
      assert.ok(account.handle, 'handle required');
      assert.ok(account.label, 'label required');
      assert.ok(account.sourceName, 'sourceName required');
      assert.ok(account.topic, 'topic required');
      assert.ok(Number.isFinite(account.tier) && account.tier >= 1 && account.tier <= 3, `${account.handle} tier`);
      assert.equal(account.enabled, true);
      assert.ok(account.accountId, `@${account.handle} must ship a verified accountId`);
      assert.match(account.accountId, /^[1-9]\d{0,18}$/, `@${account.handle} accountId shape`);
    }
    assert.equal(accounts.find((a) => a.handle === 'Reuters')?.accountId, '1652541');
  });

  it('never points two accounts at the same X identity', () => {
    // A copy-paste during curation is how @TheEconomist ended up on another
    // account's id. Duplicate ids would silently double-count one timeline
    // while the shadowed source went dark.
    const accounts = [
      ...xNews.loadXAccounts(registry, { set: 'full' }),
      ...xNews.loadXAccounts(registry, { set: 'tech' }),
    ];
    const ids = accounts.map((a) => a.accountId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate accountId in the registry');
    // sourceName is deliberately NOT unique: a masthead can run several
    // accounts that share one trust identity (@BBCBreaking + @BBCWorld ->
    // 'BBC World', @CNN + @cnnbrk -> 'CNN World', both Iran International
    // feeds). Trust is keyed on the publisher; only the X identity is 1:1.
    const handles = accounts.map((a) => a.handle.toLowerCase());
    assert.equal(new Set(handles).size, handles.length, 'duplicate handle in the registry');
  });

  it('records when each enabled account was last verified against the API', () => {
    for (const account of xNews.loadXAccounts(registry)) {
      const raw = [...registry.channels.full, ...registry.channels.tech]
        .find((a) => a.handle === account.handle);
      assert.match(
        String(raw?.verifiedAt || ''),
        /^\d{4}-\d{2}-\d{2}$/,
        `@${account.handle} needs a verifiedAt date (run scripts/verify-x-accounts.mjs)`,
      );
    }
  });
});

describe('normalizeXPost / dedup (#6654)', () => {
  const account = {
    handle: 'Reuters',
    accountId: '1652541',
    label: 'Reuters',
    sourceName: 'Reuters',
    topic: 'breaking',
    region: 'global',
  };

  it('normalises a user-timeline tweet onto the Telegram-like feed item', () => {
    const item = xNews.normalizeXPost({
      id: '1234567890123456789',
      text: 'Breaking: a port disruption was reported in the strait.',
      created_at: '2026-08-18T12:00:00.000Z',
      lang: 'en',
      public_metrics: { like_count: 4, reply_count: 1, retweet_count: 2 },
      attachments: { media_keys: ['3_1'] },
    }, account);
    assert.equal(item.id, 'Reuters:1234567890123456789');
    assert.equal(item.source, 'x');
    assert.equal(item.account, 'Reuters');
    assert.equal(item.url, 'https://x.com/Reuters/status/1234567890123456789');
    assert.equal(item.ts, '2026-08-18T12:00:00.000Z');
    assert.equal(item.topic, 'breaking');
    assert.equal(item.hasMedia, true);
    assert.equal(item.storageState, 'metadata_only');
    assert.equal(item.contentState, 'active');
    assert.deepEqual(item.tags, ['global']);
  });

  it('dedups by account:postId and keeps the newest first', () => {
    const older = xNews.normalizeXPost({ id: '10', text: 'a', created_at: '2026-08-18T11:00:00.000Z' }, account);
    const newer = xNews.normalizeXPost({ id: '11', text: 'b', created_at: '2026-08-18T12:00:00.000Z' }, account);
    const duplicate = xNews.normalizeXPost({ id: '11', text: 'b-dup', created_at: '2026-08-18T12:00:00.000Z' }, account);
    const merged = xNews.mergeAndDedup([older], [newer, duplicate], 50);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, 'Reuters:11');
    assert.equal(merged[1].id, 'Reuters:10');
  });

  it('alert facts omit R4 tweet bodies', () => {
    const item = xNews.normalizeXPost({
      id: '99',
      text: 'SECRET BODY that must not leak to embed partners',
      created_at: '2026-08-18T12:00:00.000Z',
    }, account);
    const facts = xNews.derivedAlertFacts(item);
    assert.equal(facts.link, item.url);
    assert.equal(facts.source, 'Reuters');
    assert.doesNotMatch(JSON.stringify(facts), /SECRET BODY/);
  });

  it('collectXAlertCandidates skips deleted posts, omits tweet bodies, and drops unlisted/tier-4 sources', () => {
    const live = xNews.normalizeXPost({
      id: '101',
      text: 'SECRET BODY must not enter the alert path',
      created_at: '2026-08-18T12:00:00.000Z',
    }, account);
    const deleted = xNews.tombstonePosts([
      xNews.normalizeXPost({
        id: '102',
        text: 'deleted body',
        created_at: '2026-08-18T12:00:00.000Z',
      }, account),
    ], ['102'], Date.parse('2026-08-18T12:01:00.000Z'))[0];
    const unlisted = xNews.normalizeXPost({
      id: '103',
      text: 'unlisted source',
      created_at: '2026-08-18T12:00:00.000Z',
    }, { ...account, sourceName: 'Unknown Outlet' });
    const candidates = xNews.collectXAlertCandidates(
      [live, deleted, unlisted],
      { Reuters: 1, 'Unknown Outlet': 4 },
      Date.parse('2026-08-18T12:05:00.000Z'),
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source, 'Reuters');
    assert.equal(candidates[0].link, live.url);
    assert.doesNotMatch(JSON.stringify(candidates), /SECRET BODY|deleted body|unlisted source/);
  });
});

describe('24h tombstone path (#6654)', () => {
  const account = { handle: 'AP', accountId: '51241574', label: 'AP News', sourceName: 'AP News', topic: 'breaking' };

  it('strips text and marks deleted posts as tombstones', () => {
    const item = xNews.normalizeXPost({
      id: '42',
      text: 'this body must disappear',
      created_at: '2026-08-18T10:00:00.000Z',
    }, account);
    const now = Date.parse('2026-08-18T12:00:00.000Z');
    const tombstoned = xNews.tombstonePosts([item], ['42'], now);
    assert.equal(tombstoned[0].text, '');
    assert.equal(tombstoned[0].storageState, 'tombstone');
    assert.equal(tombstoned[0].contentState, 'deleted');
    assert.equal(tombstoned[0].deletedAt, '2026-08-18T12:00:00.000Z');
    assert.equal(tombstoned[0].url, item.url);
  });

  it('purges tombstones older than 24h and keeps fresh ones', () => {
    const item = xNews.normalizeXPost({ id: '7', text: 'gone', created_at: '2026-08-17T00:00:00.000Z' }, account);
    const deletedAt = Date.parse('2026-08-17T00:00:00.000Z');
    const tombstoned = xNews.tombstonePosts([item], ['7'], deletedAt);
    const stillFresh = xNews.purgeExpiredTombstones(tombstoned, deletedAt + 23 * 60 * 60 * 1000);
    const expired = xNews.purgeExpiredTombstones(tombstoned, deletedAt + 25 * 60 * 60 * 1000);
    assert.equal(stillFresh.length, 1);
    assert.equal(expired.length, 0);
  });
});

describe('since_id poll loop + 429 backoff (#6654)', () => {
  it('builds user-timeline URLs with since_id and clamps cadence to 5–15 minutes', () => {
    const url = xNews.buildUserTimelineUrl({ accountId: '1652541', sinceId: '99', maxResults: 10 });
    assert.equal(url.pathname, '/2/users/1652541/tweets');
    assert.equal(url.searchParams.get('since_id'), '99');
    assert.equal(xNews.clampPollIntervalMs(60_000), xNews.MIN_POLL_INTERVAL_MS);
    assert.equal(xNews.clampPollIntervalMs(20 * 60 * 1000), xNews.MAX_POLL_INTERVAL_MS);
    assert.equal(xNews.clampPollIntervalMs(10 * 60 * 1000), 10 * 60 * 1000);
  });

  it('honors Retry-After on 429', () => {
    const headers = new Headers({ 'retry-after': '12' });
    assert.equal(xNews.compute429BackoffMs(headers, 0), 12_000);
    assert.ok(xNews.compute429BackoffMs(new Headers(), 3) >= 8000);
  });

  it('honors x-rate-limit-reset, the header X API v2 actually sends on 429', () => {
    const now = () => Date.parse('2026-08-18T12:00:00.000Z');
    // Absolute epoch SECONDS, not a delta — 90s in the future.
    const resetAt = Math.floor(now() / 1000) + 90;
    const headers = new Headers({ 'x-rate-limit-reset': String(resetAt) });
    assert.equal(xNews.compute429BackoffMs(headers, 0, now), 90_000);
    // retry-after still wins when both are present.
    const both = new Headers({ 'retry-after': '5', 'x-rate-limit-reset': String(resetAt) });
    assert.equal(xNews.compute429BackoffMs(both, 0, now), 5_000);
    // An already-elapsed reset must not produce a negative or zero-forever wait.
    const past = new Headers({ 'x-rate-limit-reset': String(Math.floor(now() / 1000) - 60) });
    assert.equal(xNews.parseRateLimitResetMs(past, now), 0);
  });

  it('escalates the blind backoff to the 15-minute ceiling it advertises', () => {
    // Regression: the exponent was clamped to 6, topping out at 64s — below
    // MIN_POLL_INTERVAL_MS, so rateLimitedUntil had always elapsed by the next
    // tick and the backoff could never defer a poll.
    assert.ok(
      xNews.compute429BackoffMs(new Headers(), 6) < xNews.MIN_POLL_INTERVAL_MS,
      'attempt 6 is the old ceiling and must still be under one poll interval',
    );
    const deep = xNews.compute429BackoffMs(new Headers(), xNews.MAX_429_BACKOFF_EXPONENT);
    assert.equal(deep, xNews.MAX_429_BACKOFF_MS);
    assert.ok(
      deep >= xNews.MIN_POLL_INTERVAL_MS,
      'a sustained 429 must be able to defer at least one full poll interval',
    );
    // Never exceeds the advertised ceiling, however many attempts accrue.
    assert.equal(xNews.compute429BackoffMs(new Headers(), 99), xNews.MAX_429_BACKOFF_MS);
  });

  it('polls tier 1 every cycle but throttles tier 2 and tier 3', async () => {
    // 64 accounts x 96 cycles/day = 6,240 X reads/day, billed ~$50 per four days.
    // Tier 1 keeps the baseline cadence; the slower tiers carry the saving.
    const accounts = [
      { handle: 'Reuters', accountId: '1', tier: 1 },
      { handle: 'Slower', accountId: '2', tier: 2 },
      { handle: 'Slowest', accountId: '3', tier: 3 },
      { handle: 'Untiered', accountId: '4' },
    ];
    const polled = [];
    const fetchImpl = async (url) => {
      const match = String(url).match(/users\/(\d+)\/tweets/);
      if (match) polled.push(match[1]);
      return new Response(JSON.stringify({ data: [], meta: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const poll = (state, nowMs) => xNews.pollXFeed({
      accounts, state, bearerToken: 'test-token', fetchImpl,
      now: () => nowMs, wait: async () => {}, lookupDeletions: false,
    });

    const T0 = 1_000_000;
    let state = await poll({ items: [], accountOffset: 0 }, T0);
    assert.deepEqual(polled.sort(), ['1', '2', '3', '4'], 'first cycle polls everything');

    // +15 min: one baseline cycle. Tier 1 and untiered are due; 2 and 3 are not.
    polled.length = 0;
    state = await poll(state, T0 + 15 * 60_000);
    assert.deepEqual(polled.sort(), ['1', '4'], 'only baseline accounts poll at +15m');

    // +60 min: tier 2 comes due, tier 3 still throttled.
    polled.length = 0;
    state = await poll(state, T0 + 60 * 60_000);
    assert.deepEqual(polled.sort(), ['1', '2', '4'], 'tier 2 rejoins at its hour');

    // +4h: everything is due again.
    polled.length = 0;
    await poll(state, T0 + 4 * 60 * 60_000);
    assert.deepEqual(polled.sort(), ['1', '2', '3', '4'], 'tier 3 rejoins at four hours');
  });

  it('a throttled cycle still completes and keeps rotation honest', async () => {
    // accountOffset advances by accountsAttempted through the FULL registry and
    // cycleComplete requires attempted === configured. Filtering the account list
    // instead of skipping in-loop corrupts both: rotation drifts, and every
    // cadence-limited cycle reports incomplete, holding the feed at partial
    // coverage forever. A skipped account must still be counted.
    const accounts = [
      { handle: 'Fast', accountId: '1', tier: 1 },
      { handle: 'Slow', accountId: '2', tier: 3 },
    ];
    const fetchImpl = async () => new Response(JSON.stringify({ data: [], meta: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const poll = (state, nowMs) => xNews.pollXFeed({
      accounts, state, bearerToken: 'test-token', fetchImpl,
      now: () => nowMs, wait: async () => {}, lookupDeletions: false,
    });
    const T0 = 2_000_000;
    let state = await poll({ items: [], accountOffset: 0 }, T0);
    assert.equal(state.cycleComplete, true);

    state = await poll(state, T0 + 15 * 60_000);
    assert.equal(state.accountsAttempted, 2, 'a skipped account is still attempted');
    assert.equal(state.cycleComplete, true, 'throttling must not read as partial coverage');
  });

  it('never throttles an account whose tier is missing or unknown', () => {
    // A missing tier is an unannotated registry row, not an editorial judgement
    // that the feed matters less; absent metadata must not downgrade freshness.
    const now = 5_000_000;
    for (const tier of [undefined, null, 1, 0, 99, 'weird']) {
      assert.equal(
        xNews.isAccountDueForPoll({ tier }, now, now),
        true,
        `tier ${String(tier)} must poll at the baseline cadence`,
      );
    }
    // A slower tier just polled is not due; the same tier an interval later is.
    assert.equal(xNews.isAccountDueForPoll({ tier: 2 }, now, now), false);
    assert.equal(xNews.isAccountDueForPoll({ tier: 2 }, now, now + 60 * 60_000), true);
    // A backwards clock must never park an account forever.
    assert.equal(xNews.isAccountDueForPoll({ tier: 3 }, now + 60_000, now), true);
    // Never polled reads as due.
    assert.equal(xNews.isAccountDueForPoll({ tier: 3 }, 0, now), true);
  });

  it('lets the attempt counter climb far enough to reach that ceiling', async () => {
    // The counter was capped at 7 (128s), which held the exponential below the
    // ceiling no matter how long the rate limiting lasted.
    const account = { handle: 'Reuters', accountId: '1652541' };
    let state = { items: [], accountOffset: 0 };
    const fetchImpl = async () => new Response('rate limited', { status: 429 });
    for (let i = 0; i < 12; i += 1) {
      state = await xNews.pollXFeed({
        accounts: [account],
        state: { ...state, rateLimitedUntil: 0 },
        bearerToken: 'test-token',
        fetchImpl,
        now: () => 1000,
        wait: async () => {},
        lookupDeletions: false,
      });
    }
    assert.equal(state.rateLimitAttempt, xNews.MAX_429_BACKOFF_EXPONENT);
    assert.equal(state.rateLimitedUntil - 1000, xNews.MAX_429_BACKOFF_MS);
  });

  it('polls with since_id, dedups, and tombstones missing IDs', async () => {
    const account = {
      handle: 'Reuters',
      accountId: '1652541',
      label: 'Reuters',
      sourceName: 'Reuters',
      topic: 'breaking',
      maxMessages: 10,
    };
    const calls = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname + parsed.search);
      if (parsed.pathname === '/2/users/1652541/tweets') {
        assert.equal(parsed.searchParams.get('since_id'), '100');
        return new Response(JSON.stringify({
          data: [
            { id: '101', text: 'new post', created_at: '2026-08-18T12:00:00.000Z' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (parsed.pathname === '/2/tweets') {
        return new Response(JSON.stringify({
          data: [{ id: '101' }],
          errors: [{
            resource_id: '50',
            value: '50',
            type: 'https://api.twitter.com/2/problems/resource-not-found',
            title: 'Not Found Error',
            detail: 'Could not find tweet with ids: [50].',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    };

    const prior = xNews.normalizeXPost({
      id: '50',
      text: 'old post that was deleted',
      created_at: '2026-08-18T09:00:00.000Z',
    }, account);
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: {
        cursorByAccountId: { '1652541': '100' },
        accountIdByHandle: {},
        items: [prior],
      },
      bearerToken: 'test-token',
      fetchImpl,
      now: () => Date.parse('2026-08-18T12:05:00.000Z'),
      wait: async () => {},
    });

    assert.equal(state.accountsPolled, 1);
    assert.equal(state.newCount, 1);
    assert.equal(state.cursorByAccountId['1652541'], '101');
    const live = state.items.find((item) => item.postId === '101');
    const gone = state.items.find((item) => item.postId === '50');
    assert.ok(live);
    assert.equal(gone.contentState, 'deleted');
    assert.equal(gone.text, '');
    assert.ok(calls.some((c) => c.includes('since_id=100')));
  });

  it('resolves a missing account ID by username and persists the mapping', async () => {
    const calls = [];
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'ExampleNews', label: 'Example News', sourceName: 'Example News', topic: 'breaking' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      lookupDeletions: false,
      wait: async () => {},
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed.pathname);
        if (parsed.pathname === '/2/users/by/username/ExampleNews') {
          return new Response(JSON.stringify({ data: { id: '987654321', username: 'ExampleNews' } }), { status: 200 });
        }
        if (parsed.pathname === '/2/users/987654321/tweets') {
          return new Response(JSON.stringify({ data: [{ id: '101', text: 'resolved account post' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${parsed.pathname}`);
      },
    });

    assert.deepEqual(calls, ['/2/users/by/username/ExampleNews', '/2/users/987654321/tweets']);
    assert.equal(state.accountIdByHandle.ExampleNews, '987654321');
    assert.equal(state.cursorByAccountId['987654321'], '101');
    assert.equal(state.items[0].accountId, '987654321');
  });

  it('stops the cycle and records backoff on HTTP 429', async () => {
    const fetchImpl = async () => new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl,
      now: () => 1_000,
      wait: async () => {},
    });
    assert.equal(state.accountsPolled, 0);
    assert.equal(state.accountOffset, 0);
    assert.ok(state.rateLimitedUntil > 1000);
    assert.match(state.lastError, /rate limited/);
  });

  it('pages one fixed since_id window before advancing its cursor', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname === '/2/tweets') {
        return new Response(JSON.stringify({ data: [{ id: '101' }, { id: '102' }] }), { status: 200 });
      }
      const token = parsed.searchParams.get('pagination_token');
      return new Response(JSON.stringify(token ? {
        data: [{ id: '101', text: 'older', created_at: '2026-08-18T11:59:00.000Z' }],
        meta: {},
      } : {
        data: [{ id: '102', text: 'newest', created_at: '2026-08-18T12:00:00.000Z' }],
        meta: { next_token: 'page-2' },
      }), { status: 200 });
    };
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      fetchImpl,
      wait: async () => {},
    });
    const timelineCalls = calls.filter((url) => url.pathname.endsWith('/tweets') && url.pathname !== '/2/tweets');
    assert.equal(timelineCalls.length, 2);
    assert.equal(timelineCalls[0].searchParams.get('since_id'), '100');
    assert.equal(timelineCalls[1].searchParams.get('since_id'), '100');
    assert.equal(timelineCalls[1].searchParams.get('pagination_token'), 'page-2');
    assert.equal(state.cursorByAccountId['1652541'], '102');
    assert.equal(state.cycleComplete, true);
  });

  it('does not advance the cursor when the timeline page limit truncates a window', async () => {
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ id: '102', text: 'newest' }],
        meta: { next_token: 'more' },
      }), { status: 200 }),
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(state.cursorByAccountId['1652541'], '100');
    assert.equal(state.accountsFailed, 1);
    assert.equal(state.cycleComplete, false);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].postId, '102');
  });

  it('resumes a capped later window on the next poll before advancing since_id', async () => {
    const timelineTokens = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/2/tweets') {
        const ids = parsed.searchParams.get('ids')?.split(',') || [];
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
      }
      const token = parsed.searchParams.get('pagination_token') || '';
      timelineTokens.push(token);
      if (!token) {
        return new Response(JSON.stringify({
          data: [{ id: '105', text: 'newest' }],
          meta: { next_token: 'page-2' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: '104', text: 'older' }], meta: {} }), { status: 200 });
    };
    const account = { handle: 'Reuters', accountId: '1652541', maxMessages: 10 };
    const first = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      fetchImpl,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(first.cursorByAccountId['1652541'], '100');
    assert.equal(first.catchupByAccountId['1652541'].paginationToken, 'page-2');
    assert.equal(first.items[0].postId, '105');

    const second = await xNews.pollXFeed({
      accounts: [account],
      state: first,
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      fetchImpl,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.deepEqual(timelineTokens, ['', 'page-2']);
    assert.equal(second.cursorByAccountId['1652541'], '105');
    assert.equal(second.catchupByAccountId['1652541'], undefined);
    assert.deepEqual(second.items.map((item) => item.postId).sort(), ['104', '105']);
    assert.equal(second.cycleComplete, true);
  });

  it('establishes since_id from newest pages when the first poll hits the page cap', async () => {
    const calls = [];
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: {}, items: [] },
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      lookupDeletions: false,
      now: () => Date.parse('2026-08-18T12:00:00.000Z'),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed);
        return new Response(JSON.stringify({
          data: [{ id: '200', text: 'newest', created_at: '2026-08-18T11:50:00.000Z' }],
          meta: { next_token: 'more' },
        }), { status: 200 });
      },
      wait: async () => {},
    });
    const timeline = calls.find((url) => url.pathname.endsWith('/tweets') && url.pathname !== '/2/tweets');
    assert.equal(timeline.searchParams.get('since_id'), null);
    assert.ok(timeline.searchParams.get('start_time'));
    assert.equal(state.cursorByAccountId['1652541'], '200');
    assert.equal(state.accountsPolled, 1);
    assert.equal(state.accountsFailed, 0);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].postId, '200');
    assert.equal(state.cycleComplete, true);
  });

  it('bounds a cold-start cycle to one page per account, but pages a resumed window fully', async () => {
    // Regression: a cold start (no cursor) walked back 24h with no since_id and
    // paged to DEFAULT_MAX_TIMELINE_PAGES. Across 64 accounts that is ~640
    // timeline requests in one cycle against a ~64/cycle spend model, and it
    // re-triggers after any outage longer than the poll-state TTL.
    const pagesPerAccount = new Map();
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const id = parsed.pathname.split('/')[3];
      pagesPerAccount.set(id, (pagesPerAccount.get(id) || 0) + 1);
      return new Response(JSON.stringify({
        data: [{ id: String(900 + pagesPerAccount.get(id)), text: 'post' }],
        meta: { next_token: 'always-more' },
      }), { status: 200 });
    };
    const accounts = [
      { handle: 'Reuters', accountId: '1652541' },
      { handle: 'AP', accountId: '51241574' },
    ];

    const cold = await xNews.pollXFeed({
      accounts,
      state: { cursorByAccountId: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl,
      wait: async () => {},
      lookupDeletions: false,
      now: () => Date.parse('2026-08-18T12:00:00.000Z'),
    });
    assert.deepEqual([...pagesPerAccount.values()], [1, 1], 'cold start must not page past the cold-start cap');
    assert.equal(cold.accountsPolled, 2);
    assert.equal(cold.accountsFailed, 0);
    // The cursor is still established, so the next cycle resumes normally.
    assert.ok(cold.cursorByAccountId['1652541']);

    // A warm account with a cursor still pages up to the full limit.
    pagesPerAccount.clear();
    await xNews.pollXFeed({
      accounts: [accounts[0]],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      fetchImpl,
      wait: async () => {},
      lookupDeletions: false,
      maxTimelinePages: 4,
    });
    assert.equal(pagesPerAccount.get('1652541'), 4, 'a resumed window still pages to the full limit');
  });

  it('never exceeds an explicitly requested page limit on a cold start', async () => {
    let pages = 0;
    await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541' }],
      state: { cursorByAccountId: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => {
        pages += 1;
        return new Response(JSON.stringify({ data: [{ id: '1' }], meta: { next_token: 'more' } }), { status: 200 });
      },
      wait: async () => {},
      lookupDeletions: false,
      maxTimelinePages: 1,
      coldStartMaxTimelinePages: 9,
    });
    assert.equal(pages, 1, 'explicit maxTimelinePages must still bound a cold start');
  });

  it('tombstones only resource-not-found lookup errors', async () => {
    const account = {
      handle: 'Reuters',
      accountId: '1652541',
      label: 'Reuters',
      sourceName: 'Reuters',
      topic: 'breaking',
    };
    const priorDeleted = xNews.normalizeXPost({
      id: '50', text: 'deleted post', created_at: '2026-08-18T09:00:00.000Z',
    }, account);
    const priorOmitted = xNews.normalizeXPost({
      id: '60', text: 'silently omitted', created_at: '2026-08-18T09:01:00.000Z',
    }, account);
    const priorProtected = xNews.normalizeXPost({
      id: '70', text: 'protected post', created_at: '2026-08-18T09:02:00.000Z',
    }, account);
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: {
        cursorByAccountId: { '1652541': '100' },
        items: [priorDeleted, priorOmitted, priorProtected],
        lookupOffset: 0,
      },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/tweets') && parsed.pathname !== '/2/tweets') {
          return new Response(JSON.stringify({
            data: [{ id: '101', text: 'new post', created_at: '2026-08-18T12:00:00.000Z' }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [{ id: '101' }],
          errors: [
            {
              resource_id: '50',
              type: 'https://api.twitter.com/2/problems/resource-not-found',
              title: 'Not Found Error',
              detail: 'Could not find tweet with ids: [50].',
            },
            {
              resource_id: '70',
              type: 'https://api.twitter.com/2/problems/not-authorized-for-resource',
              title: 'Authorization Error',
              detail: 'Not authorized to view this Tweet.',
            },
            {
              resource_id: '60',
              type: 'https://api.twitter.com/2/problems/invalid-request',
              title: 'Not Found Error',
              detail: 'This deleted-looking text must not be treated as a resource tombstone.',
            },
          ],
        }), { status: 200 });
      },
      wait: async () => {},
    });
    assert.equal(state.items.find((item) => item.postId === '50').contentState, 'deleted');
    assert.notEqual(state.items.find((item) => item.postId === '60').contentState, 'deleted');
    assert.notEqual(state.items.find((item) => item.postId === '70').contentState, 'deleted');
    assert.equal(state.items.find((item) => item.postId === '60').contentState, 'active');
  });

  it('does not advance lookupOffset when deletion lookup fails', async () => {
    const account = { handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' };
    const items = ['10', '20', '30'].map((id) => xNews.normalizeXPost({
      id, text: `post ${id}`, created_at: '2026-08-18T09:00:00.000Z',
    }, account));
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { '1652541': '100' }, items, lookupOffset: 0 },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/2/tweets') {
          return new Response('lookup failed', { status: 500 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      wait: async () => {},
    });
    assert.equal(state.lookupOffset, 0);
    assert.equal(state.items.filter((item) => item.contentState === 'deleted').length, 0);
  });

  it('does not advance lookupOffset after a non-200 success response', async () => {
    const account = { handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' };
    const items = ['10', '20'].map((id) => xNews.normalizeXPost({ id, text: `post ${id}` }, account));
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { '1652541': '100' }, items, lookupOffset: 1 },
      bearerToken: 'test-token',
      fetchImpl: async (url) => new URL(url).pathname === '/2/tweets'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 }),
      wait: async () => {},
    });
    assert.equal(state.lookupOffset, 1);
    assert.match(state.lastError, /HTTP 204/);
  });

  it('rotates the next account after a partial 429 cycle', async () => {
    const accounts = [
      { handle: 'Reuters', accountId: '1652541' },
      { handle: 'AP', accountId: '51241574' },
      { handle: 'BBCWorld', accountId: '742143' },
    ];
    const first = await xNews.pollXFeed({
      accounts,
      state: { items: [], accountOffset: 0 },
      bearerToken: 'test-token',
      fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
      now: () => 1000,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(first.accountsAttempted, 1);
    assert.equal(first.accountOffset, 1);

    let firstPath = '';
    const second = await xNews.pollXFeed({
      accounts,
      state: { ...first, rateLimitedUntil: 0 },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        firstPath ||= new URL(url).pathname;
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
      },
      now: () => 1000,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.match(firstPath, /\/2\/users\/51241574\/tweets$/);
    assert.equal(first.rateLimitAttempt, 1);
    assert.equal(second.rateLimitAttempt, 2);
  });

  it('marks partial account coverage incomplete', async () => {
    const state = await xNews.pollXFeed({
      accounts: [
        { handle: 'Reuters', accountId: '1652541' },
        { handle: 'AP', accountId: '51241574' },
      ],
      state: { items: [] },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes('/1652541/')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response('failure', { status: 503 });
      },
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(state.accountsPolled, 1);
    assert.equal(state.accountsFailed, 1);
    assert.equal(state.accountsAttempted, 2);
    assert.equal(state.cycleComplete, false);
  });
});

describe('per-cycle request budget (#6654)', () => {
  // 64 warm accounts whose windows never end — the outage-catch-up shape. The
  // poll-state key lives 90 minutes, so any outage shorter than that leaves
  // every cursor intact and every account takes the warm branch at the full
  // page limit.
  const catchupAccounts = () => Array.from({ length: 64 }, (_, i) => ({
    handle: `News${i}`,
    accountId: String(1000 + i),
    maxMessages: 10,
  }));
  const catchupState = () => ({
    cursorByAccountId: Object.fromEntries(catchupAccounts().map((a) => [a.accountId, '500'])),
    items: [],
  });
  const endlessPages = async () => new Response(JSON.stringify({
    data: [{ id: '900', text: 'post', created_at: '2026-08-20T11:00:00.000Z' }],
    meta: { next_token: 'always-more' },
  }), { status: 200 });

  it('caps a catch-up cycle at the aggregate budget instead of pages-per-account', async () => {
    // Regression: pages were capped PER ACCOUNT with no cycle-wide counter, so
    // 64 accounts x DEFAULT_MAX_TIMELINE_PAGES spent ~640 timeline requests in
    // ONE cycle against a model sized for ~64.
    const accounts = catchupAccounts();
    let requests = 0;
    const state = await xNews.pollXFeed({
      accounts,
      state: catchupState(),
      bearerToken: 'test-token',
      fetchImpl: async (url) => { requests += 1; return endlessPages(url); },
      wait: async () => {},
      lookupDeletions: false,
    });
    const budget = accounts.length * xNews.DEFAULT_CYCLE_REQUESTS_PER_ACCOUNT;
    assert.equal(requests, budget, 'the cycle must stop at the aggregate budget');
    assert.equal(state.requestsUsed, budget);
    assert.ok(requests < accounts.length * xNews.DEFAULT_MAX_TIMELINE_PAGES, 'must be far under the per-account worst case');
    // Ends cleanly and partially, never by throwing.
    assert.equal(state.cycleComplete, false);
    assert.ok(state.accountsAttempted < accounts.length, 'the remaining accounts are deferred, not attempted');
    assert.match(state.lastError, /budget/);
  });

  it('defers the truncated remainder through catchup and resumes it next cycle', async () => {
    const accounts = catchupAccounts();
    const first = await xNews.pollXFeed({
      accounts,
      state: catchupState(),
      bearerToken: 'test-token',
      fetchImpl: endlessPages,
      wait: async () => {},
      lookupDeletions: false,
    });
    // The account stopped mid-window keeps its cursor and hands the page token
    // to catchup, so nothing is re-paged and nothing is lost.
    const stopped = accounts[first.accountsAttempted - 1];
    assert.ok(first.catchupByAccountId[stopped.accountId], 'the mid-window account resumes from a catchup token');
    assert.equal(first.cursorByAccountId[stopped.accountId], '500', 'a truncated window must not advance since_id');
    assert.equal(first.accountOffset, first.accountsAttempted, 'the rotation starts beyond the last attempted account');

    const seen = [];
    const second = await xNews.pollXFeed({
      accounts,
      state: first,
      bearerToken: 'test-token',
      fetchImpl: async (url) => { seen.push(new URL(url).pathname); return endlessPages(url); },
      wait: async () => {},
      lookupDeletions: false,
    });
    // Like the 429 break, the rotation starts BEYOND the account that consumed
    // the quota — otherwise one account with a deep backlog would eat the budget
    // every cycle and starve the other 63. Its catchup token simply waits for
    // the rotation to come back around.
    assert.equal(seen[0], `/2/users/${accounts[first.accountsAttempted].accountId}/tweets`, 'the deferred accounts run next');
    assert.deepEqual(
      second.catchupByAccountId[stopped.accountId],
      first.catchupByAccountId[stopped.accountId],
      'the deferred window survives untouched until its turn',
    );
  });

  it('leaves an ordinary cold start and steady state untouched', async () => {
    // Sizing check: the worst honest cycle is the first poll — 47 of 64 accounts
    // also need a username lookup — and it must fit whole, or the feed would
    // never establish its cursors.
    const accounts = Array.from({ length: 64 }, (_, i) => ({
      handle: `News${i}`,
      accountId: i < 17 ? String(1000 + i) : '',
    }));
    let requests = 0;
    const cold = await xNews.pollXFeed({
      accounts,
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        requests += 1;
        const handle = new URL(url).pathname.match(/^\/2\/users\/by\/username\/News(\d+)$/);
        if (handle) return new Response(JSON.stringify({ data: { id: String(2000 + Number(handle[1])) } }), { status: 200 });
        return new Response(JSON.stringify({ data: [{ id: '900', text: 'p' }], meta: { next_token: 'more' } }), { status: 200 });
      },
      wait: async () => {},
      lookupDeletions: false,
      now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    });
    assert.equal(requests, 111, '47 username lookups + 64 one-page cold-start timelines');
    assert.ok(requests < accounts.length * xNews.DEFAULT_CYCLE_REQUESTS_PER_ACCOUNT, 'the cold start must fit inside the budget');
    assert.equal(cold.accountsPolled, 64);
    assert.equal(cold.cycleComplete, true);
  });

  it('never counts a budget deferral as an account failure', async () => {
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: { 1652541: '100' }, items: [] },
      bearerToken: 'test-token',
      fetchImpl: endlessPages,
      wait: async () => {},
      lookupDeletions: false,
      maxCycleRequests: 3,
    });
    assert.equal(state.requestsUsed, 3, 'an explicit budget binds literally');
    assert.equal(state.accountsFailed, 0, 'deferred work is not failed work');
    assert.equal(state.cursorByAccountId['1652541'], '100');
    assert.equal(state.catchupByAccountId['1652541'].paginationToken, 'always-more');
  });

  it('does not mark an account polled when the budget ran out before its first page', async () => {
    // The username lookup bills the same quota, so it can consume the last unit
    // and leave zero timeline pages fetched. Counting that account as polled
    // would advance coverage over an account we never actually read.
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'FreshHandle' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async (url) => (new URL(url).pathname.startsWith('/2/users/by/')
        ? new Response(JSON.stringify({ data: { id: '4242' } }), { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: '5' }] }), { status: 200 })),
      wait: async () => {},
      lookupDeletions: false,
      maxCycleRequests: 1,
    });
    assert.equal(state.accountsAttempted, 1);
    assert.equal(state.accountsPolled, 0);
    assert.equal(state.accountsFailed, 0);
    assert.equal(state.cycleComplete, false);
    // The lookup we already paid for is still cached for the next cycle.
    assert.equal(state.accountIdByHandle.FreshHandle, '4242');
  });
});

describe('402 credits-depleted circuit breaker', () => {
  const accounts = Array.from({ length: 64 }, (_, i) => ({
    handle: `News${i}`,
    accountId: i < 17 ? String(1000 + i) : '',
  }));
  const now = () => Date.parse('2026-08-25T12:00:00.000Z');
  const creditsDepleted = () => new Response(
    JSON.stringify({
      title: 'Payment Required',
      detail: 'credits depleted',
      status: 402,
      type: 'https://api.x.com/2/problems/credits-depleted',
    }),
    { status: 402, headers: { 'content-type': 'application/json' } },
  );

  it('stops the whole cycle on the first HTTP 402 and backs off', async () => {
    // Observed in production 2026-08-25: the plan ran out of credits and every
    // call answered 402. Only 429 and 401/403 broke the loop, so 402 fell to the
    // per-account failure path — all 64 accounts rejected, every cycle, with no
    // backoff, exactly the ~6.1k/day the 401/403 breaker exists to prevent.
    // Rate-limit headers were untouched (remaining 1999/2000), so nothing else
    // would have slowed it down either.
    let requests = 0;
    const state = await xNews.pollXFeed({
      accounts,
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => { requests += 1; return creditsDepleted(); },
      now,
      wait: async () => {},
    });

    assert.equal(requests, 1, 'the breaker must trip on the first 402');
    assert.equal(state.accountsAttempted, 1);
    assert.equal(state.cycleComplete, false);
    assert.equal(state.rateLimitedUntil, now() + xNews.AUTH_FAILURE_BACKOFF_MS);
    assert.equal(state.rateLimitAttempt, 0, '402 is not the 429 exponential');
    assert.equal(state.backoffCause, xNews.X_BACKOFF_CAUSES.CREDITS);
  });

  it('names billing, not the token, so the operator is not sent to rotate a working bearer', async () => {
    // The whole point of separating this from 401/403: the bearer is VALID and
    // rotating it fixes nothing. A message saying "check X_BEARER_TOKEN" would
    // cost an operator a credential rotation before they found the real cause.
    const state = await xNews.pollXFeed({
      accounts,
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => creditsDepleted(),
      now,
      wait: async () => {},
    });

    assert.match(state.lastError, /credits/i, 'the cause must be named');
    assert.doesNotMatch(state.lastError, /X_BEARER_TOKEN/,
      'a valid bearer must not be implicated');
    assert.doesNotMatch(state.lastError, /auth failed/i);
    assert.doesNotMatch(state.lastError, /rate limited/i);
  });

  it('trips during username resolution when the account id is not cached', async () => {
    let requests = 0;
    const state = await xNews.pollXFeed({
      accounts: [{ ...accounts[0], accountId: '' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => { requests += 1; return creditsDepleted(); },
      now,
      wait: async () => {},
    });

    assert.equal(requests, 1, 'the username lookup must be the only billed request');
    assert.equal(state.accountsFailed, 0, 'billing failure is a cycle fault, not an account fault');
    assert.match(state.lastError, /resolving @News0/);
    assert.match(state.lastError, /top up the X API plan/i);
    assert.doesNotMatch(state.lastError, /X_BEARER_TOKEN/);
    assert.equal(state.rateLimitedUntil, now() + xNews.AUTH_FAILURE_BACKOFF_MS);
    assert.equal(state.rateLimitAttempt, 0);
    assert.equal(state.backoffCause, xNews.X_BACKOFF_CAUSES.CREDITS);
  });

  it('trips on the timeline leg too, not only the username lookup', async () => {
    // Accounts with a pinned id skip the lookup entirely and go straight to the
    // timeline call, so a breaker on only one leg leaves the other burning.
    let requests = 0;
    const state = await xNews.pollXFeed({
      accounts: accounts.map((account, i) => ({ ...account, accountId: String(2000 + i) })),
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => { requests += 1; return creditsDepleted(); },
      now,
      wait: async () => {},
    });

    assert.equal(requests, 1, 'the timeline leg must trip on the first 402 too');
    assert.equal(state.rateLimitedUntil, now() + xNews.AUTH_FAILURE_BACKOFF_MS);
    assert.match(state.lastError, /credits/i);
  });

  it('trips during the deletion lookup after a successful timeline request', async () => {
    const account = { ...accounts[0], label: 'News 0', sourceName: 'News 0' };
    const existing = xNews.normalizeXPost({
      id: '99', text: 'existing post', created_at: '2026-08-25T11:00:00.000Z',
    }, account);
    let requests = 0;
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { [account.accountId]: '99' }, items: [existing] },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        requests += 1;
        return new URL(url).pathname === '/2/tweets'
          ? creditsDepleted()
          : new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      now,
      wait: async () => {},
    });

    assert.equal(requests, 2, 'one timeline and one deletion request must bound the cycle');
    assert.equal(state.accountsPolled, 1);
    assert.equal(state.cycleComplete, false);
    assert.equal(state.rateLimitedUntil, now() + xNews.AUTH_FAILURE_BACKOFF_MS);
    assert.equal(state.rateLimitAttempt, 0, '402 must not advance the 429 exponential');
    assert.equal(state.backoffCause, xNews.X_BACKOFF_CAUSES.CREDITS);
    assert.match(state.lastError, /during deletion lookup/);
    assert.match(state.lastError, /top up the X API plan/i);
  });
});

describe('401/403 circuit breaker (#6654)', () => {
  const accounts = Array.from({ length: 64 }, (_, i) => ({
    handle: `News${i}`,
    accountId: i < 17 ? String(1000 + i) : '',
  }));
  const now = () => Date.parse('2026-08-20T12:00:00.000Z');

  for (const status of [401, 403]) {
    it(`stops the whole cycle on the first HTTP ${status} and backs off`, async () => {
      // Regression: only 429 broke the loop. A bearer that is absent, wrong-scope
      // or revoked rejected every account, so one bad token cost 64 rejected
      // requests every 15 minutes — ~6.1k/day — indefinitely and with no backoff.
      let requests = 0;
      const state = await xNews.pollXFeed({
        accounts,
        state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
        bearerToken: 'test-token',
        fetchImpl: async () => { requests += 1; return new Response('nope', { status }); },
        now,
        wait: async () => {},
      });
      assert.equal(requests, 1, 'the breaker must trip on the first rejection');
      assert.equal(state.accountsAttempted, 1);
      assert.equal(state.cycleComplete, false);
      assert.equal(state.rateLimitedUntil, now() + xNews.AUTH_FAILURE_BACKOFF_MS);
      // An auth failure needs a different operator response than a 429, so the
      // message must not read as a rate limit.
      assert.match(state.lastError, /auth failed/i);
      assert.match(state.lastError, /X_BEARER_TOKEN/);
      assert.doesNotMatch(state.lastError, /rate limited/i);
      // Must be long enough to actually skip a cycle at the slowest cadence.
      assert.ok(
        xNews.AUTH_FAILURE_BACKOFF_MS > xNews.MAX_POLL_INTERVAL_MS,
        'a backoff at or under one poll interval defers nothing',
      );
      // The 429 exponential is a different failure mode and must not escalate.
      assert.equal(state.rateLimitAttempt, 0);
    });
  }

  it('trips on the username-lookup leg too, where 47 of 64 accounts start', async () => {
    const state = await xNews.pollXFeed({
      accounts: accounts.map((account) => ({ ...account, accountId: '' })),
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => new Response('nope', { status: 401 }),
      now,
      wait: async () => {},
    });
    assert.equal(state.accountsAttempted, 1);
    assert.equal(state.accountsFailed, 0, 'a credential fault is a cycle fault, not an account fault');
    assert.match(state.lastError, /resolving @News0/);
    assert.equal(state.rateLimitedUntil, now() + xNews.AUTH_FAILURE_BACKOFF_MS);
  });

  it('still reports a 429 as a rate limit, with its own escalating backoff', async () => {
    const state = await xNews.pollXFeed({
      accounts: [accounts[0]],
      state: { cursorByAccountId: { 1000: '5' }, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      now,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.match(state.lastError, /rate limited/);
    assert.doesNotMatch(state.lastError, /auth failed/i);
    assert.equal(state.rateLimitedUntil, now() + 30_000);
    assert.equal(state.rateLimitAttempt, 1);
  });
});

describe('cycleComplete failure tolerance (#6654)', () => {
  const roster = (size) => Array.from({ length: size }, (_, i) => ({
    handle: `News${i}`,
    accountId: String(1000 + i),
  }));
  const withDeadHandles = (deadCount) => async (url) => {
    const path = new URL(url).pathname;
    const id = path.match(/^\/2\/users\/(\d+)\/tweets/);
    // A renamed or suspended handle 404s forever.
    if (id && Number(id[1]) - 1000 < deadCount) return new Response('gone', { status: 404 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const poll = (accounts, deadCount) => xNews.pollXFeed({
    accounts,
    state: {
      cursorByAccountId: Object.fromEntries(accounts.map((a) => [a.accountId, '500'])),
      items: [],
    },
    bearerToken: 'test-token',
    fetchImpl: withDeadHandles(deadCount),
    wait: async () => {},
    lookupDeletions: false,
  });

  it('tolerates a few dead handles out of 64 instead of pinning the feed at SEED_ERROR', async () => {
    // Regression: cycleComplete demanded accountsFailed === 0. ais-relay maps
    // that to sourceState 'degraded' and api/health.js maps it to SEED_ERROR, so
    // ONE renamed handle out of 64 made every cycle degraded forever — and only
    // xFeed:EMPTY is acknowledged in seed-freshness-baseline.json, so it also
    // reds the fleet-wide ingestion-acceptance gate for every other source.
    const accounts = roster(64);
    const one = await poll(accounts, 1);
    assert.equal(one.cycleComplete, true);
    // Tolerated, never hidden: an operator still sees 63/64 with 1 failure.
    assert.equal(one.accountsPolled, 63);
    assert.equal(one.accountsFailed, 1);
    assert.equal(one.accountsAttempted, 64);
    assert.match(one.lastError, /HTTP 404/);

    const atBudget = await poll(accounts, xNews.MAX_TOLERATED_FAILED_ACCOUNTS);
    assert.equal(atBudget.cycleComplete, true, 'the tolerance boundary itself must still be complete');

    const overBudget = await poll(accounts, xNews.MAX_TOLERATED_FAILED_ACCOUNTS + 1);
    assert.equal(overBudget.cycleComplete, false, 'a systemic failure must still degrade the source');
    assert.equal(overBudget.accountsFailed, xNews.MAX_TOLERATED_FAILED_ACCOUNTS + 1);
  });

  it('keeps zero tolerance on a roster too small for the fraction', async () => {
    // 5% of 2 accounts is 0, so a half-dead operator override still degrades.
    const half = await poll(roster(2), 1);
    assert.equal(half.accountsFailed, 1);
    assert.equal(half.cycleComplete, false);
  });

  it('does not call a rate-limited or budget-truncated cycle complete', async () => {
    const accounts = roster(64);
    const limited = await xNews.pollXFeed({
      accounts,
      state: { cursorByAccountId: Object.fromEntries(accounts.map((a) => [a.accountId, '500'])), items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      now: () => 1000,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(limited.accountsFailed, 0, 'zero failures alone must not imply a complete cycle');
    assert.equal(limited.cycleComplete, false, 'accounts were never attempted — that is partial, not degraded');
  });
});

describe('under-lock poll-state merge (multi-replica)', () => {
  const redisState = {
    cursorByAccountId: { '1652541': '900' },
    accountIdByHandle: { Reuters: '1652541' },
    catchupByAccountId: {},
    lookupOffset: 7,
    accountOffset: 3,
    rateLimitedUntil: 0,
    rateLimitAttempt: 0,
  };

  it('takes cursors and offsets from Redis, not from stale in-process state', () => {
    const stale = {
      cursorByAccountId: { '1652541': '100' },
      accountIdByHandle: {},
      catchupByAccountId: {},
      lookupOffset: 0,
      accountOffset: 0,
    };
    const merged = xNews.mergeRefreshedPollState(stale, redisState);
    // The rewind this prevents: buildXPollState writes the WHOLE cursor map, so
    // polling from '100' would publish '100' back over a peer's '900'.
    assert.equal(merged.cursorByAccountId['1652541'], '900');
    assert.equal(merged.accountIdByHandle.Reuters, '1652541');
    assert.equal(merged.lookupOffset, 7);
    assert.equal(merged.accountOffset, 3);
  });

  it('adopts a peer’s active rate-limit backoff — the X bearer is shared', () => {
    const merged = xNews.mergeRefreshedPollState(
      { ...redisState, rateLimitedUntil: 0, rateLimitAttempt: 0 },
      {
        ...redisState,
        rateLimitedUntil: 5_000_000,
        rateLimitAttempt: 4,
        backoffCause: xNews.X_BACKOFF_CAUSES.CREDITS,
      },
    );
    assert.equal(merged.rateLimitedUntil, 5_000_000);
    assert.equal(merged.rateLimitAttempt, 4);
    assert.equal(merged.backoffCause, xNews.X_BACKOFF_CAUSES.CREDITS);
  });

  it('does not let an older Redis copy clear a backoff this process just recorded', () => {
    // The failure a plain assignment would cause: this replica 429s, records a
    // deadline, then reads a Redis copy written before that 429 and resumes
    // polling straight into the same rate limit.
    const merged = xNews.mergeRefreshedPollState(
      { ...redisState, rateLimitedUntil: 9_000_000, rateLimitAttempt: 6 },
      { ...redisState, rateLimitedUntil: 1_000_000, rateLimitAttempt: 2 },
    );
    assert.equal(merged.rateLimitedUntil, 9_000_000);
    assert.equal(merged.rateLimitAttempt, 6, 'backoff escalation must not reset');
  });

  it('keeps current state when the refreshed read is absent or malformed', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      const merged = xNews.mergeRefreshedPollState(
        { ...redisState, cursorByAccountId: { '1652541': '250' }, rateLimitedUntil: 4_000 },
        bad,
      );
      assert.equal(merged.cursorByAccountId['1652541'], '250');
      assert.equal(merged.rateLimitedUntil, 4_000);
    }
  });

  it('returns only poll bookkeeping, never serving state', () => {
    const merged = xNews.mergeRefreshedPollState(
      { ...redisState, items: [{ id: 'keep-me' }] },
      { ...redisState, items: [{ id: 'clobber' }] },
    );
    assert.equal(merged.items, undefined, 'items must not be merged by this path');
    assert.equal(merged.lastCoverage, undefined);
  });
});

describe('versioned X feed snapshot', () => {
  it('round-trips bounded serving state and poll cursors across a restart', () => {
    const item = xNews.normalizeXPost({ id: '101', text: 'body' }, {
      handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters',
    });
    const state = {
      generation: 7,
      cursorByAccountId: { '1652541': '101' },
      accountIdByHandle: { Reuters: '1652541' },
      items: [item],
      lookupOffset: 4,
      accountOffset: 9,
      catchupByAccountId: { '1652541': { sinceId: '100', paginationToken: 'page-3', newestPostId: '101' } },
      rateLimitedUntil: 1_755_521_260_000,
      rateLimitAttempt: 3,
      backoffCause: xNews.X_BACKOFF_CAUSES.CREDITS,
      lastPollAt: 1_755_521_200_000,
      lastHealthyAt: 1_755_521_200_000,
      lastCoverage: { expected: 64, polled: 64, failed: 0, attempted: 64, complete: true },
    };
    const snapshot = xNews.buildXFeedSnapshot(state, { enabled: true, expectedAccounts: 64 });
    const pollState = xNews.buildXPollState(state, { expectedAccounts: 64 });
    assert.equal(snapshot.pollState, undefined);
    const hydrated = xNews.hydrateXFeedSnapshot(snapshot, { pollState });
    assert.equal(snapshot.version, xNews.X_FEED_SNAPSHOT_VERSION);
    assert.equal(snapshot.count, 1);
    assert.equal(hydrated.generation, 7);
    assert.equal(hydrated.cursorByAccountId['1652541'], '101');
    assert.equal(hydrated.accountOffset, 9);
    assert.equal(hydrated.catchupByAccountId['1652541'].paginationToken, 'page-3');
    assert.equal(hydrated.rateLimitedUntil, 1_755_521_260_000);
    assert.equal(hydrated.rateLimitAttempt, 3);
    assert.equal(hydrated.backoffCause, xNews.X_BACKOFF_CAUSES.CREDITS);
    assert.equal(hydrated.items[0].text, 'body');
    assert.equal(hydrated.lastCoverage.complete, true);
    const legacy = xNews.hydrateXFeedSnapshot({ ...snapshot, pollState });
    assert.equal(legacy.cursorByAccountId['1652541'], '101');
    const servingOnly = xNews.hydrateXFeedSnapshot(snapshot);
    assert.ok(servingOnly);
    assert.equal(servingOnly.cursorByAccountId['1652541'], undefined);
    assert.equal(servingOnly.items[0].text, 'body');
    const pollStateOnly = xNews.hydrateXFeedSnapshot(null, { pollState });
    assert.equal(pollStateOnly.cursorByAccountId['1652541'], '101');
    assert.equal(pollStateOnly.items.length, 0);
  });

  it('hydrates legacy poll state without a backoff cause', () => {
    const hydrated = xNews.hydrateXFeedSnapshot(null, {
      pollState: { rateLimitedUntil: 1_755_521_260_000, rateLimitAttempt: 3 },
    });
    assert.equal(hydrated.rateLimitedUntil, 1_755_521_260_000);
    assert.equal(hydrated.backoffCause, null);
  });

  it('rejects an unversioned or malformed snapshot', () => {
    assert.equal(xNews.hydrateXFeedSnapshot({ items: [] }), null);
    assert.equal(xNews.hydrateXFeedSnapshot({ version: 2, items: [] }), null);
    const empty = xNews.hydrateXFeedSnapshot({ version: xNews.X_FEED_SNAPSHOT_VERSION, items: [] });
    assert.ok(empty);
    assert.equal(empty.items.length, 0);
  });
});

// X answers an unreadable account with HTTP 200 and an `errors` array rather
// than a 4xx — observed live against @OSINTdefender and @dwnews, both of which
// are `protected`. (Both are since replaced in the registry by the publishers'
// real public accounts, @sentdefender and @DeutscheWelle — the ids below stay
// as the verbatim live payloads that proved the bug.) The timeline loop only
// tested `!response.ok`, so a 200 fell
// through to `tweets = []`, found no `next_token`, and recorded a COMPLETE
// window: a protected, suspended, or deleted account counted as a healthy
// empty poll forever, with no error and nothing for an operator to see. Every
// account now ships a pinned accountId, which makes this the only path that
// runs for them, so it has to fail loudly.
describe('unreadable-account timeline responses (#6654 follow-up)', () => {
  const protectedAccount = {
    handle: 'OSINTdefender',
    accountId: '1496286557053071361',
    label: 'OSINTdefender',
    sourceName: 'OSINTdefender',
    topic: 'osint',
    tier: 2,
    maxMessages: 10,
  };

  const authErrorBody = JSON.stringify({
    errors: [{
      value: '1496286557053071361',
      detail: 'Sorry, you are not authorized to see the user with id: [1496286557053071361].',
      title: 'Authorization Error',
      type: 'https://api.twitter.com/2/problems/not-authorized-for-resource',
    }],
  });

  const unreadable = async () => new Response(authErrorBody, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  it('counts a 200-with-errors timeline as a failure, not a complete window', async () => {
    const state = await xNews.pollXFeed({
      accounts: [protectedAccount],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: unreadable,
      now: () => Date.parse('2026-08-21T06:00:00.000Z'),
      wait: async () => {},
    });

    assert.equal(state.accountsFailed, 1, 'an unreadable account must count as failed');
    assert.equal(state.accountsPolled, 0, 'an unreadable account must not count as polled');
  });

  it('names the handle and the upstream reason so an operator can act', async () => {
    const state = await xNews.pollXFeed({
      accounts: [protectedAccount],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: unreadable,
      now: () => Date.parse('2026-08-21T06:00:00.000Z'),
      wait: async () => {},
    });

    assert.match(state.lastError || '', /OSINTdefender/, 'lastError must name the account');
    assert.match(state.lastError || '', /Authorization Error/, 'lastError must carry the upstream title');
    assert.doesNotMatch(state.lastError || '', /HTTP 200/, 'reporting an unreadable account as "HTTP 200" misleads the operator');
  });

  it('does not advance the cursor for an unreadable account', async () => {
    const state = await xNews.pollXFeed({
      accounts: [protectedAccount],
      state: {
        cursorByAccountId: { '1496286557053071361': '900' },
        accountIdByHandle: {},
        items: [],
      },
      bearerToken: 'test-token',
      fetchImpl: unreadable,
      now: () => Date.parse('2026-08-21T06:00:00.000Z'),
      wait: async () => {},
    });

    assert.equal(state.cursorByAccountId['1496286557053071361'], '900', 'cursor must not move on a failed read');
  });

  // Positive control: without this the fix could be "call every empty page a
  // failure", which would red the whole fleet on a quiet night.
  //
  // The body is the VERBATIM live response for an account with nothing in the
  // window (verified 2026-08-21 against @thePentagon over a 24h start_time):
  // no `data` key at all and no `errors` key, only `meta.result_count`. An
  // earlier draft of this test asserted `{ data: [], meta: {...} }`, a shape X
  // never sends — it would have passed against a guard that wrongly keys on
  // `data` being absent, which is the exact false positive being ruled out.
  it('still reports a genuinely empty timeline as a successful poll', async () => {
    const state = await xNews.pollXFeed({
      accounts: [{ ...protectedAccount, handle: 'Reuters', accountId: '1652541', sourceName: 'Reuters' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl: async () => new Response(JSON.stringify({ meta: { result_count: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      now: () => Date.parse('2026-08-21T06:00:00.000Z'),
      wait: async () => {},
    });

    assert.equal(state.accountsFailed, 0, 'a quiet account is not a broken one');
    assert.equal(state.accountsPolled, 1);
  });

  // The deleted-post tombstone path depends on `data` and `errors` arriving
  // TOGETHER from /2/tweets. Treating any payload carrying `errors` as a fault
  // would misread that as a broken account, so prove the two stay
  // distinguishable. Tombstone semantics themselves are asserted by the
  // dedicated deletion test above; this one guards the failure accounting.
  it('does not count a data-plus-errors tombstone response as an account failure', async () => {
    const account = { ...protectedAccount, handle: 'Reuters', accountId: '1652541', sourceName: 'Reuters' };
    const prior = xNews.normalizeXPost(
      { id: '50', text: 'old post', created_at: '2026-08-20T09:00:00.000Z' },
      account,
    );
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { 1652541: '100' }, accountIdByHandle: {}, items: [prior] },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/2/users/1652541/tweets') {
          return new Response(JSON.stringify({
            data: [{ id: '101', text: 'live post', created_at: '2026-08-21T05:00:00.000Z' }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          data: [{ id: '101' }],
          errors: [{
            resource_id: '50',
            value: '50',
            title: 'Not Found Error',
            detail: 'Could not find tweet with ids: [50].',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      now: () => Date.parse('2026-08-21T06:00:00.000Z'),
      wait: async () => {},
    });

    assert.equal(state.accountsFailed, 0, 'a tombstone response is not an account failure');
    assert.equal(state.accountsPolled, 1);
    assert.equal(state.cursorByAccountId['1652541'], '101', 'the live page still advances the cursor');
  });
});
