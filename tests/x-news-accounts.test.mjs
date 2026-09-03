import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet } from '../scripts/verify-x-accounts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const xNews = require('../scripts/lib/x-news-accounts.cjs');
const {
  DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS,
  createXPostBudget,
  RESERVE_LUA,
  SETTLE_LUA,
  STATUS_LUA,
} = require('../scripts/lib/x-post-budget.cjs');
const registry = JSON.parse(readFileSync(join(__dirname, '../data/x-accounts.json'), 'utf8'));
const accounts = xNews.loadXAccounts(registry);
const NOW = Date.parse('2026-09-03T12:00:00.000Z');

async function withTestReturnedPostBudget(request) {
  const budget = createXPostBudget({
    evalCommand: async (script, _keys, args) => {
      if (script === RESERVE_LUA) return [1, request.requestedPosts, request.requestedPosts, 0, 0, ''];
      if (script === SETTLE_LUA) {
        const actual = Number(args[0]);
        return [1, actual, actual, request.requestedPosts, actual, 0];
      }
      if (script === STATUS_LUA) return [0, 0, 0, 0, ''];
      throw new Error('unexpected test budget script');
    },
    now: () => NOW,
    idFactory: () => `test-${request.operation}`,
  });
  return budget.withReturnedPosts(request);
}

function rawPost(account, id, overrides = {}) {
  return {
    id,
    author_id: account.accountId,
    text: `Post ${id}`,
    created_at: '2026-09-03T11:59:00.000Z',
    lang: 'en',
    public_metrics: { like_count: 4, reply_count: 1, retweet_count: 2 },
    ...overrides,
  };
}

describe('data/x-accounts.json registry', () => {
  it('contains exactly 64 unique enabled immutable account IDs', () => {
    assert.equal(accounts.length, 64);
    assert.equal(new Set(accounts.map((account) => account.accountId)).size, 64);
    for (const account of accounts) {
      assert.match(account.accountId, /^[1-9]\d{0,18}$/);
      assert.match(account.handle, /^[A-Za-z0-9_]{1,15}$/);
    }
  });

  it('reserves 96 five-Post List slots and one 25-Post deletion audit', () => {
    assert.equal(xNews.X_LIST_POST_LIMIT, 5);
    assert.equal((96 * xNews.X_LIST_POST_LIMIT) + xNews.DEFAULT_DELETION_AUDIT_MAX_POSTS, 505);
    assert.equal(DEFAULT_X_CURATED_DAILY_COVERAGE_POSTS, 505);
  });
});

describe('exact X List membership gate', () => {
  const listId = '1234567890123456789';
  const validList = {
    id: listId,
    name: xNews.X_CURATED_LIST_NAME,
    description: xNews.X_CURATED_LIST_DESCRIPTION,
    private: false,
    member_count: 64,
  };
  const matchingMembers = accounts.map((account) => ({
    id: account.accountId,
    username: account.handle,
    name: account.label,
    protected: false,
  }));

  it('accepts one public, unpaginated page with the exact 64 immutable IDs', () => {
    const result = xNews.verifyXListMembership({
      listId,
      accounts,
      listBody: { data: validList },
      membersBody: { data: matchingMembers, meta: { result_count: 64 } },
    });

    assert.equal(result.ok, true);
    assert.equal(result.expectedCount, 64);
    assert.equal(result.actualCount, 64);
    assert.deepEqual(result.findings, []);
  });

  it('rejects wrong metadata, private, paginated, duplicate, missing, extra, and renamed membership', () => {
    const missing = matchingMembers[0];
    const duplicate = matchingMembers[1];
    const renamed = matchingMembers[2];
    const extraId = '999999999999999999';
    const result = xNews.verifyXListMembership({
      listId,
      accounts,
      listBody: { data: {
        ...validList,
        name: 'Wrong name',
        description: 'Wrong description',
        private: true,
        member_count: 65,
      } },
      membersBody: {
        data: [
          ...matchingMembers.slice(1).map((member) => (
            member.id === renamed.id ? { ...member, username: 'renamed_account' } : member
          )),
          duplicate,
          { id: extraId, username: 'unexpected', name: 'Unexpected', protected: false },
        ],
        meta: { result_count: 65, next_token: 'another-page' },
      },
    });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.kind === 'list-name-mismatch'));
    assert.ok(result.findings.some((finding) => finding.kind === 'list-description-mismatch'));
    assert.ok(result.findings.some((finding) => finding.kind === 'list-private'));
    assert.ok(result.findings.some((finding) => finding.kind === 'pagination'));
    assert.ok(result.findings.some((finding) => finding.kind === 'duplicate-member'));
    assert.ok(result.findings.some((finding) => finding.kind === 'handle-mismatch'));
    assert.deepEqual(result.missingIds, [missing.id]);
    assert.deepEqual(result.extraIds, [extraId]);
  });

  it('rejects an unreadable member page instead of treating it as an empty List', () => {
    const result = xNews.verifyXListMembership({
      listId,
      accounts,
      listBody: { data: validList },
      membersBody: { errors: [{ title: 'Authorization Error', detail: 'List is not readable' }] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.kind === 'unreadable-members'));
  });

  it('keeps the operator verifier off every Post-returning endpoint', () => {
    const source = readFileSync(join(__dirname, '../scripts/verify-x-accounts.mjs'), 'utf8');
    assert.doesNotMatch(source, /--timelines|createXPostBudget|x-post-budget|\/tweets/);
    assert.match(source, /\/2\/lists\/\$\{listId\}\/members/);
    assert.match(source, /list\.fields=id,name,description,private,member_count/);
    assert.match(source, /max_results=100/);
  });

  it('stops the operator verifier after two bounded rate-limit retries', async () => {
    let fetches = 0;
    const waits = [];
    const result = await apiGet('/2/lists/123', 'test-token', async () => {
      fetches += 1;
      return Response.json({ title: 'Too Many Requests' }, { status: 429 });
    }, {
      now: () => NOW,
      sleepImpl: async (waitMs) => { waits.push(waitMs); },
      onRateLimit: () => {},
    });

    assert.equal(fetches, 3);
    assert.deepEqual(waits, [5_000, 5_000]);
    assert.equal(result.status, 429);
    assert.equal(result.ok, false);
  });

  it('makes both X List settings Railway deployment prerequisites', () => {
    const services = JSON.parse(readFileSync(join(__dirname, '../scripts/railway-services.json'), 'utf8'));
    const relay = services.find((service) => service.service === 'ais-relay');
    assert.deepEqual(relay.requiredEnv, ['X_BEARER_TOKEN', 'X_CURATED_LIST_ID']);

    const envExample = readFileSync(join(__dirname, '../.env.example'), 'utf8');
    const healthDocs = readFileSync(join(__dirname, '../docs/health-endpoints.mdx'), 'utf8');
    assert.match(envExample, /^X_BEARER_TOKEN=$/m);
    assert.match(envExample, /^X_CURATED_LIST_ID=$/m);
    assert.match(healthDocs, /fixed 15-minute UTC slot/);
    assert.match(healthDocs, /X_CURATED_LIST_ID/);
    assert.match(healthDocs, /no earlier than 30 minutes before 00:00 UTC/);
    assert.match(healthDocs, /set `X_CURATED_LIST_ID` on the running AIS relay before deploying this code/);
    assert.match(healthDocs, /unversioned coverage hold/);
    assert.match(healthDocs, /Do not reset or rewrite the live budget counters/);
  });
});

describe('X List page contract', () => {
  it('builds one bounded newest-page URL without pagination or server-side filtering', () => {
    const url = xNews.buildXListPostsUrl('1234567890123456789');
    assert.equal(url.pathname, '/2/lists/1234567890123456789/tweets');
    assert.equal(url.searchParams.get('max_results'), '5');
    assert.equal(
      url.searchParams.get('tweet.fields'),
      'author_id,created_at,lang,public_metrics,referenced_tweets,attachments',
    );
    assert.equal(url.searchParams.has('pagination_token'), false);
    assert.equal(url.searchParams.has('exclude'), false);
  });

  it('rejects a malformed List ID before it can form a Post route', () => {
    assert.throws(() => xNews.buildXListPostsUrl('not-a-list'), /List ID is invalid/);
  });

  it('attributes several publishers and filters replies and reposts after raw counting', () => {
    const [reuters, ap] = accounts;
    const body = {
      data: [
        rawPost(reuters, '7000000000000000001'),
        rawPost(ap, '7000000000000000002'),
        rawPost(reuters, '7000000000000000003', { referenced_tweets: [{ type: 'replied_to', id: '1' }] }),
        rawPost(ap, '7000000000000000004', { referenced_tweets: [{ type: 'retweeted', id: '2' }] }),
      ],
      meta: { result_count: 4, next_token: 'ignored-by-design' },
    };
    const receipt = xNews.buildXListReceipt({
      listId: '1234567890123456789',
      sourceSlot: '2026-09-03T12:00:00.000Z',
      providerSuccessAt: NOW,
      accounts,
      body,
    });
    const normalized = xNews.normalizeXListReceipt(receipt, '1234567890123456789', accounts);
    const items = xNews.listItemsFromReceipt(normalized, accounts);

    assert.equal(normalized.rawPostCount, 4);
    assert.equal(normalized.sourceSlot, '2026-09-03T12:00:00.000Z');
    assert.equal(normalized.providerSuccessAt, NOW);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.accountId), [reuters.accountId, ap.accountId]);
    assert.ok(items.every((item) => item.source === 'x' && item.storageState === 'metadata_only'));
  });

  it('accepts an explicit zero page and rejects ambiguous or unsafe pages', () => {
    const options = {
      listId: '1234567890123456789',
      sourceSlot: '2026-09-03T12:00:00.000Z',
      providerSuccessAt: NOW,
      accounts,
    };
    assert.equal(xNews.buildXListReceipt({ ...options, body: { meta: { result_count: 0 } } }).rawPostCount, 0);
    assert.equal(xNews.buildXListReceipt({ ...options, body: {} }), null);
    assert.equal(xNews.buildXListReceipt({
      ...options,
      body: { data: Array.from({ length: 6 }, (_, index) => rawPost(accounts[0], String(8_000_000_000_000_000_000n + BigInt(index)))) },
    }), null);
    assert.equal(xNews.buildXListReceipt({
      ...options,
      body: { data: [rawPost({ accountId: '999999999999999999' }, '7000000000000000005')] },
    }), null);
    assert.equal(xNews.buildXListReceipt({
      ...options,
      body: { data: [rawPost(accounts[0], '7000000000000000006', { created_at: undefined })] },
    }), null);
    assert.equal(xNews.buildXListReceipt({
      ...options,
      body: { data: [rawPost(accounts[0], '7000000000000000007')], errors: [{ title: 'partial' }] },
    }), null);
  });
});

describe('aggregate X List poll', () => {
  it('acknowledges a replay receipt that no longer matches the registry', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000030'), accounts[0]);
    const receiptAck = { key: 'receipt:list', expected: '{"version":1}' };
    let fetches = 0;
    const next = await xNews.pollXFeed({
      accounts,
      state: { items: [existing] },
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
      lookupDeletions: false,
      now: () => NOW,
      withReturnedPosts: async () => ({
        allowed: true,
        completed: true,
        reusedReceipt: true,
        returnedPosts: 0,
        receiptAck,
        receipt: {
          version: 1,
          listId: '1234567890123456789',
          sourceSlot: '2026-09-03T11:45:00.000Z',
          providerSuccessAt: NOW - 15 * 60_000,
          rawPostCount: 1,
          posts: [{ id: '7000000000000000031', accountId: '999999999999999999', item: null }],
        },
      }),
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({ meta: { result_count: 0 } });
      },
    });

    assert.equal(fetches, 0);
    assert.deepEqual(next.items, [existing]);
    assert.equal(next.listAccepted, false);
    assert.deepEqual(next.receiptAcks, [receiptAck]);
    assert.match(next.lastError, /no longer valid/);
  });

  it('uses one five-Post List request and preserves the public feed item shape', async () => {
    const [reuters, ap] = accounts;
    const budgetRequests = [];
    const fetched = [];
    const next = await xNews.pollXFeed({
      accounts,
      state: { items: [] },
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
      lookupDeletions: false,
      now: () => NOW,
      withReturnedPosts: async (request) => {
        budgetRequests.push(request);
        return withTestReturnedPostBudget(request);
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        fetched.push(url);
        return Response.json({
          data: [rawPost(reuters, '7000000000000000010'), rawPost(ap, '7000000000000000011')],
          meta: { result_count: 2, next_token: 'do-not-follow' },
        });
      },
    });

    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].pathname, '/2/lists/1234567890123456789/tweets');
    assert.equal(fetched[0].searchParams.get('pagination_token'), null);
    assert.equal(budgetRequests.length, 1);
    assert.equal(budgetRequests[0].requestedPosts, 5);
    assert.equal(budgetRequests[0].coverageUnitPosts, 5);
    assert.equal(budgetRequests[0].coverageTotal, 505);
    assert.equal(budgetRequests[0].coverageId, 'list-slot:2026-09-03T12:00:00.000Z');
    assert.equal(next.cycleComplete, true);
    assert.equal(next.providerSuccessSlot, '2026-09-03T12:00:00.000Z');
    assert.equal(next.providerSuccessAt, NOW);
    assert.equal(next.lastCycleUsage.postsRead, 2);
    assert.equal(next.items.length, 2);
    assert.deepEqual(Object.keys(next.items[0]).sort(), [
      'account', 'accountId', 'accountTitle', 'contentState', 'earlySignal', 'hasMedia',
      'id', 'isQuote', 'isReply', 'lang', 'likeCount', 'postId', 'replyCount',
      'repostCount', 'source', 'sourceName', 'storageState', 'tags', 'text', 'topic', 'ts', 'url',
    ]);
  });

  it('deduplicates repeated pages and accepts an explicit zero without dropping last-good items', async () => {
    const item = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000020'), accounts[0]);
    const run = (body, coverageId, state) => xNews.pollXFeed({
      accounts,
      state,
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId,
      lookupDeletions: false,
      now: () => NOW,
      withReturnedPosts: withTestReturnedPostBudget,
      fetchImpl: async () => Response.json(body),
    });
    const repeated = await run(
      { data: [rawPost(accounts[0], item.postId)], meta: { result_count: 1 } },
      'list-slot:2026-09-03T12:00:00.000Z',
      { items: [item] },
    );
    assert.equal(repeated.items.length, 1);
    assert.equal(repeated.cycleComplete, true);

    const empty = await run(
      { meta: { result_count: 0 } },
      'list-slot:2026-09-03T12:15:00.000Z',
      repeated,
    );
    assert.deepEqual(empty.items, repeated.items);
    assert.equal(empty.cycleComplete, true);
    assert.equal(empty.lastCycleUsage.postsRead, 0);
  });

  it('preserves last-good state when the page cannot be accepted', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000030'), accounts[0]);
    const next = await xNews.pollXFeed({
      accounts,
      state: { items: [existing] },
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
      lookupDeletions: false,
      now: () => NOW,
      withReturnedPosts: withTestReturnedPostBudget,
      fetchImpl: async () => Response.json({
        data: [rawPost({ accountId: '999999999999999999' }, '7000000000000000031')],
      }),
    });

    assert.deepEqual(next.items, [existing]);
    assert.equal(next.cycleComplete, false);
    assert.match(next.lastError, /membership drift/i);
    assert.equal(next.lastCycleUsage.postReadLimit, 5);
  });

  it('preserves last-good state and opens the shared auth backoff after a bearer rejection', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000032'), accounts[0]);
    let fetchCalls = 0;
    const run = (state, coverageId) => xNews.pollXFeed({
      accounts,
      state,
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId,
      lookupDeletions: false,
      now: () => NOW,
      withReturnedPosts: withTestReturnedPostBudget,
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ title: 'Unauthorized' }, { status: 401 });
      },
    });

    const rejected = await run(
      { items: [existing] },
      'list-slot:2026-09-03T12:00:00.000Z',
    );
    assert.deepEqual(rejected.items, [existing]);
    assert.equal(rejected.cycleComplete, false);
    assert.equal(rejected.backoffCause, xNews.X_BACKOFF_CAUSES.AUTH);
    assert.equal(rejected.rateLimitedUntil, NOW + xNews.AUTH_FAILURE_BACKOFF_MS);
    assert.match(rejected.lastError, /X_BEARER_TOKEN/);

    const deferred = await run(
      rejected,
      'list-slot:2026-09-03T12:15:00.000Z',
    );
    assert.deepEqual(deferred.items, [existing]);
    assert.equal(deferred.cycleComplete, false);
    assert.equal(deferred.backoffCause, xNews.X_BACKOFF_CAUSES.AUTH);
    assert.match(deferred.lastError, /X_BEARER_TOKEN/);
    assert.equal(fetchCalls, 1);
  });

  it('preserves last-good state without a provider call when the shared budget denies the slot', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000033'), accounts[0]);
    let fetchCalls = 0;
    const next = await xNews.pollXFeed({
      accounts,
      state: { items: [existing] },
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
      lookupDeletions: false,
      now: () => NOW,
      withReturnedPosts: async () => ({
        allowed: false,
        reason: 'daily_limit',
        status: { day: '2026-09-03', dayUsed: 95, coverageHeld: 505 },
      }),
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ meta: { result_count: 0 } });
      },
    });

    assert.deepEqual(next.items, [existing]);
    assert.equal(next.cycleComplete, false);
    assert.match(next.lastError, /daily_limit/);
    assert.equal(next.lastCycleUsage.requestsUsed, 0);
    assert.equal(fetchCalls, 0);
  });

  it('keeps provider failures typed without accepting or acknowledging a List page', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000034'), accounts[0]);
    const cases = [
      {
        label: 'rate limit',
        fetchImpl: async () => Response.json({}, {
          status: 429,
          headers: { 'x-rate-limit-reset': String(Math.floor((NOW + 60_000) / 1000)) },
        }),
        cause: xNews.X_BACKOFF_CAUSES.RATE_LIMIT,
        error: /rate limited/,
      },
      {
        label: 'forbidden bearer',
        fetchImpl: async () => Response.json({}, { status: 403 }),
        cause: xNews.X_BACKOFF_CAUSES.AUTH,
        error: /X_BEARER_TOKEN/,
      },
      {
        label: 'credits depleted',
        fetchImpl: async () => Response.json({}, { status: 402 }),
        cause: xNews.X_BACKOFF_CAUSES.CREDITS,
        error: /top up/,
      },
      {
        label: 'provider error',
        fetchImpl: async () => Response.json({}, { status: 503 }),
        cause: null,
        error: /HTTP 503/,
      },
      {
        label: 'transport error',
        fetchImpl: async () => { throw new Error('socket reset'); },
        cause: null,
        error: /socket reset/,
      },
    ];

    for (const testCase of cases) {
      const next = await xNews.pollXFeed({
        accounts,
        state: { items: [existing] },
        bearerToken: 'x-test-token',
        listId: '1234567890123456789',
        coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
        lookupDeletions: false,
        now: () => NOW,
        withReturnedPosts: withTestReturnedPostBudget,
        fetchImpl: testCase.fetchImpl,
      });
      assert.deepEqual(next.items, [existing], testCase.label);
      assert.equal(next.cycleComplete, false, testCase.label);
      assert.equal(next.listAccepted, false, testCase.label);
      assert.deepEqual(next.receiptAcks, [], testCase.label);
      assert.equal(next.backoffCause, testCase.cause, testCase.label);
      assert.match(next.lastError, testCase.error, testCase.label);
    }
  });

  it('runs at most one bounded deletion audit per UTC day', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000040'), accounts[0]);
    const budgetRequests = [];
    const run = (state, coverageId) => xNews.pollXFeed({
      accounts,
      state,
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId,
      now: () => NOW,
      withReturnedPosts: async (request) => {
        budgetRequests.push(request);
        return withTestReturnedPostBudget(request);
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/2/tweets') {
          return Response.json({ data: [{ id: existing.postId }] });
        }
        return Response.json({ meta: { result_count: 0 } });
      },
    });

    const first = await run({ items: [existing] }, 'list-slot:2026-09-03T12:00:00.000Z');
    await run(first, 'list-slot:2026-09-03T12:15:00.000Z');
    const deletionRequests = budgetRequests.filter((request) => request.operation === 'deletion-lookup');
    const listRequests = budgetRequests.filter((request) => request.operation === 'list-feed');
    assert.equal(listRequests[0].deadlineMs, Date.parse('2026-09-03T12:15:00.000Z'));
    assert.equal(deletionRequests.length, 1);
    assert.equal(deletionRequests[0].deadlineMs, Date.parse('2026-09-03T12:15:00.000Z'));
    assert.ok(deletionRequests[0].requestedPosts <= 25);
    assert.equal(deletionRequests[0].coverageUnitPosts, 25);
    assert.equal(deletionRequests[0].oncePerDay, true);
  });

  it('does not report an unknown deletion audit as successful on later slots', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000041'), accounts[0]);
    let auditAttempts = 0;
    const run = (state, coverageId) => xNews.pollXFeed({
      accounts,
      state,
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId,
      now: () => NOW,
      withReturnedPosts: async (request) => {
        if (request.operation === 'list-feed') return withTestReturnedPostBudget(request);
        auditAttempts += 1;
        return auditAttempts === 1
          ? { allowed: true, completed: false, reason: 'unsettled_response', status: { day: '2026-09-03' } }
          : { allowed: false, reason: 'already_run', status: { day: '2026-09-03' } };
      },
      fetchImpl: async () => Response.json({ meta: { result_count: 0 } }),
    });

    const first = await run({ items: [existing] }, 'list-slot:2026-09-03T12:00:00.000Z');
    const second = await run(first, 'list-slot:2026-09-03T12:15:00.000Z');

    assert.equal(auditAttempts, 2);
    assert.equal(first.lastDeletionAuditAt, 0);
    assert.equal(second.lastDeletionAuditAt, 0);
    assert.equal(second.cycleComplete, true);
    assert.equal(second.listAccepted, true);
    assert.match(second.lastError, /without a recorded successful result/);
  });

  it('keeps a valid List publication healthy when ancillary deletion maintenance fails', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000042'), accounts[0]);
    const cases = [
      { label: 'rate limit', response: new Response(null, { status: 429 }), error: /rate limited/ },
      { label: 'authentication', response: new Response(null, { status: 401 }), error: /X auth failed/ },
      { label: 'provider failure', response: new Response(null, { status: 503 }), error: /HTTP 503/ },
    ];

    for (const testCase of cases) {
      const next = await xNews.pollXFeed({
        accounts,
        state: { items: [existing] },
        bearerToken: 'x-test-token',
        listId: '1234567890123456789',
        coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
        now: () => NOW,
        withReturnedPosts: withTestReturnedPostBudget,
        fetchImpl: async (input) => {
          const url = new URL(input);
          if (url.pathname === '/2/tweets') return testCase.response;
          return Response.json({ meta: { result_count: 0 } });
        },
      });

      assert.equal(next.cycleComplete, true, testCase.label);
      assert.equal(next.listAccepted, true, testCase.label);
      assert.equal(next.lastDeletionAuditAt, 0, testCase.label);
      assert.match(next.lastError, testCase.error, testCase.label);
    }
  });

  it('does not complete a deletion audit when a 200 response leaves an ID unaccounted', async () => {
    const existing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000043'), accounts[0]);
    const next = await xNews.pollXFeed({
      accounts,
      state: { items: [existing] },
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
      now: () => NOW,
      withReturnedPosts: withTestReturnedPostBudget,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/2/tweets') {
          return Response.json({
            errors: [{
              resource_id: existing.postId,
              title: 'Authorization Error',
              type: 'https://api.x.com/2/problems/not-authorized-for-resource',
            }],
          });
        }
        return Response.json({ meta: { result_count: 0 } });
      },
    });

    assert.equal(next.cycleComplete, true);
    assert.equal(next.listAccepted, true);
    assert.equal(next.lastDeletionAuditAt, 0);
    assert.equal(next.lookupOffset, 0);
    assert.deepEqual(next.items, [existing]);
    assert.match(next.lastError, /incomplete|non-deletion/);
  });

  it('completes a deletion audit only for returned or confirmed-missing IDs', async () => {
    const missing = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000044'), accounts[0]);
    const present = xNews.normalizeXPost(rawPost(accounts[1], '7000000000000000045'), accounts[1]);
    const next = await xNews.pollXFeed({
      accounts,
      state: { items: [missing, present] },
      bearerToken: 'x-test-token',
      listId: '1234567890123456789',
      coverageId: 'list-slot:2026-09-03T12:00:00.000Z',
      now: () => NOW,
      withReturnedPosts: withTestReturnedPostBudget,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/2/tweets') {
          return Response.json({
            data: [{ id: present.postId }],
            errors: [{
              resource_id: missing.postId,
              title: 'Not Found Error',
              type: 'https://api.x.com/2/problems/resource-not-found',
            }],
          });
        }
        return Response.json({ meta: { result_count: 0 } });
      },
    });

    assert.equal(next.lastDeletionAuditAt, Date.parse('2026-09-03T00:00:00.000Z'));
    assert.equal(next.lastError, null);
    assert.equal(next.items.find((item) => item.postId === missing.postId)?.contentState, 'deleted');
    assert.equal(next.items.find((item) => item.postId === present.postId)?.contentState, 'active');
  });
});

describe('shared feed helpers', () => {
  it('deduplicates newest-first and keeps alert bodies out of derived facts', () => {
    const older = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000050', { created_at: '2026-09-03T10:00:00Z' }), accounts[0]);
    const newer = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000051', { created_at: '2026-09-03T11:00:00Z' }), accounts[0]);
    const merged = xNews.mergeAndDedup([older], [newer, newer]);
    assert.deepEqual(merged.map((item) => item.postId), [newer.postId, older.postId]);
    assert.doesNotMatch(JSON.stringify(xNews.derivedAlertFacts(newer)), /Post 7000000000000000051/);
  });

  it('tombstones deleted Posts and purges them after 24 hours', () => {
    const item = xNews.normalizeXPost(rawPost(accounts[0], '7000000000000000060'), accounts[0]);
    const tombstone = xNews.tombstonePosts([item], [item.postId], NOW)[0];
    assert.equal(tombstone.text, '');
    assert.equal(tombstone.contentState, 'deleted');
    assert.equal(xNews.purgeExpiredTombstones([tombstone], NOW + xNews.TOMBSTONE_TTL_MS - 1).length, 1);
    assert.equal(xNews.purgeExpiredTombstones([tombstone], NOW + xNews.TOMBSTONE_TTL_MS).length, 0);
  });

  it('keeps typed 429, auth, and credit backoff messages distinct', () => {
    assert.match(xNews.sharedBackoffMessage(xNews.X_BACKOFF_CAUSES.RATE_LIMIT), /rate-limit/);
    assert.match(xNews.sharedBackoffMessage(xNews.X_BACKOFF_CAUSES.AUTH), /X_BEARER_TOKEN/);
    assert.match(xNews.sharedBackoffMessage(xNews.X_BACKOFF_CAUSES.CREDITS), /top up/);
  });
});
