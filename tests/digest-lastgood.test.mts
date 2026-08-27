import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import nodePath, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import {
  ATTEMPT_META_TTL_S,
  LASTGOOD_MAX_AGE_MS,
  LASTGOOD_TTL_S,
  REVOKED_URLS_KEY,
  attemptMetaKey,
  classifyStaleSnapshot,
  filterRevokedUrls,
  isAcceptableDigest,
  isEligibleScope,
  lastGoodKey,
  parseAcceptedMeta,
  shouldReplaceAccepted,
} from '../server/worldmonitor/news/v1/_lastgood';

const here = dirname(fileURLToPath(import.meta.url));

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const ONE_ITEM = { categories: { politics: { items: [{ link: 'https://a.test/1' }] } } };
const RICHER = { categories: { politics: { items: [{ link: 'https://a.test/1' }] }, tech: { items: [{ link: 'https://b.test/1' }] } } };

describe('durable last-good policy (#7084)', () => {
  it('keys the accepted snapshot and attempt metadata by scope', () => {
    assert.equal(lastGoodKey('full', 'en'), 'news:digest:lastgood:v1:full:en');
    assert.equal(attemptMetaKey('tech', 'fr'), 'news:digest:attempt:v1:tech:fr');
    assert.notEqual(lastGoodKey('full', 'en'), lastGoodKey('full', 'fr'));
    assert.notEqual(lastGoodKey('full', 'en'), lastGoodKey('tech', 'en'));
  });

  it('clamps scope keys to known-shape variants and 2-letter languages', () => {
    assert.ok(isEligibleScope('full', 'en'));
    assert.ok(!isEligibleScope('full', 'english'));
    assert.ok(!isEligibleScope('../etc', 'en'));
    assert.ok(!isEligibleScope('full', 'E1'));
  });

  it('expires the accepted snapshot after six hours', () => {
    assert.equal(LASTGOOD_TTL_S, 6 * 60 * 60);
    assert.equal(LASTGOOD_MAX_AGE_MS, 6 * 60 * 60 * 1000);
    assert.ok(ATTEMPT_META_TTL_S > LASTGOOD_TTL_S, 'attempt metadata outlives the snapshot');
  });

  it('accepts only structurally valid digests with real content', () => {
    assert.ok(isAcceptableDigest(ONE_ITEM));
    assert.ok(isAcceptableDigest(RICHER));
    assert.ok(!isAcceptableDigest({ categories: {} }));
    assert.ok(!isAcceptableDigest({ categories: { politics: { items: [] } } }));
    assert.ok(!isAcceptableDigest(null));
    assert.ok(!isAcceptableDigest(undefined));
    assert.ok(!isAcceptableDigest({}));
  });

  it('replaces when there is no accepted snapshot or it has expired', () => {
    assert.deepEqual(shouldReplaceAccepted(null, { categoryCount: 1, itemCount: 1 }, NOW), {
      replace: true,
      reason: 'no-accepted-snapshot',
    });
    const expired = { acceptedAt: NOW - LASTGOOD_MAX_AGE_MS - 1, categoryCount: 5, itemCount: 50 };
    assert.deepEqual(shouldReplaceAccepted(expired, { categoryCount: 1, itemCount: 1 }, NOW), {
      replace: true,
      reason: 'current-expired',
    });
  });

  it('does not expire at exactly the six-hour boundary -- only past it', () => {
    const atBoundary = { acceptedAt: NOW - LASTGOOD_MAX_AGE_MS, categoryCount: 4, itemCount: 40 };
    // Exactly at the bound is still live, so a narrower candidate must not win.
    assert.equal(shouldReplaceAccepted(atBoundary, { categoryCount: 1, itemCount: 1 }, NOW).replace, false);
    const justPast = { acceptedAt: NOW - LASTGOOD_MAX_AGE_MS - 1, categoryCount: 4, itemCount: 40 };
    assert.equal(shouldReplaceAccepted(justPast, { categoryCount: 1, itemCount: 1 }, NOW).replace, true);
  });

  it('a FUTURE acceptedAt is corrupt and cannot veto -- same rule as the serve path', () => {
    // classifyStaleSnapshot refuses to SERVE a future-dated row; letting the
    // same row VETO replacement would wedge an unservable snapshot in place
    // until its TTL expired.
    const corrupt = { acceptedAt: NOW + 60_000, categoryCount: 9, itemCount: 900 };
    assert.deepEqual(shouldReplaceAccepted(corrupt, { categoryCount: 1, itemCount: 1 }, NOW), {
      replace: true,
      reason: 'current-corrupt-future',
    });
  });

  it('a materially narrower candidate serves but does not displace a richer live snapshot', () => {
    const live = { acceptedAt: NOW - 60_000, categoryCount: 4, itemCount: 40 };
    assert.deepEqual(shouldReplaceAccepted(live, { categoryCount: 2, itemCount: 40 }, NOW), {
      replace: false,
      reason: 'narrower-categories:2<4',
    });
    // Equal or richer on BOTH dimensions replaces.
    assert.equal(shouldReplaceAccepted(live, { categoryCount: 4, itemCount: 40 }, NOW).replace, true);
    assert.equal(shouldReplaceAccepted(live, { categoryCount: 6, itemCount: 60 }, NOW).replace, true);
  });

  it('richness is depth as well as breadth -- same categories, far fewer items does not displace', () => {
    const live = { acceptedAt: NOW - 60_000, categoryCount: 4, itemCount: 400 };
    // Comparing categories alone let this through, so a build that produced
    // one item per category could evict a live snapshot holding hundreds.
    assert.deepEqual(shouldReplaceAccepted(live, { categoryCount: 4, itemCount: 4 }, NOW), {
      replace: false,
      reason: 'narrower-items:4<400',
    });
  });

  it('a malformed stored snapshot reads as "no snapshot", never as an unreplaceable one', () => {
    // Missing fields used to produce NaN comparisons that were false in both
    // directions, wedging the key until its TTL expired.
    assert.equal(parseAcceptedMeta({ categoryCount: 3 }), null);
    assert.equal(parseAcceptedMeta({ acceptedAt: 'nope', categoryCount: 3 }), null);
    assert.equal(parseAcceptedMeta(null), null);
    assert.deepEqual(parseAcceptedMeta({ acceptedAt: NOW, categoryCount: 3 }), {
      acceptedAt: NOW, categoryCount: 3, itemCount: 0,
    });
  });

  it('serves a valid snapshot inside the window and reports its age', () => {
    const ageMs = 45 * 60 * 1000;
    const verdict = classifyStaleSnapshot({ acceptedAt: NOW - ageMs, data: ONE_ITEM }, NOW);
    assert.equal(verdict.serve, true);
    assert.equal(verdict.outcome, 'stale');
    assert.equal(verdict.ageSeconds, 45 * 60);
  });

  it('does not serve a missing, expired, future-dated, or empty snapshot', () => {
    assert.equal(classifyStaleSnapshot(null, NOW).outcome, 'unavailable');
    assert.equal(
      classifyStaleSnapshot({ acceptedAt: NOW - LASTGOOD_MAX_AGE_MS - 5_000, data: ONE_ITEM }, NOW).outcome,
      'expired',
    );
    // A future acceptedAt is corrupt, not zero-age.
    assert.equal(classifyStaleSnapshot({ acceptedAt: NOW + 60_000, data: ONE_ITEM }, NOW).outcome, 'expired');
    assert.equal(
      classifyStaleSnapshot({ acceptedAt: NOW - 60_000, data: { categories: {} } }, NOW).outcome,
      'unavailable',
    );
  });

  it('applies the same revocation filter to item lists both paths share', () => {
    const items = [
      { link: 'https://a.test/1' },
      { link: 'https://b.test/2' },
      { link: undefined },
    ];
    assert.deepEqual(filterRevokedUrls(items, new Set()), { kept: items, dropped: 0 });
    const filtered = filterRevokedUrls(items, new Set(['https://a.test/1']));
    assert.deepEqual(
      filtered.kept.map((i) => i.link),
      ['https://b.test/2', undefined],
    );
    assert.equal(filtered.dropped, 1);
  });

  it('names the revocation key as a single narrow versioned set', () => {
    assert.equal(REVOKED_URLS_KEY, 'news:digest:revoked-urls:v1');
  });
});

/**
 * Executable wiring tests (#7084).
 *
 * These replace a block that asserted `assert.match(digestSource, ...)` against
 * list-feed-digest.ts read as TEXT. Those passed whether or not the code
 * worked -- deleting a `return null` while leaving its console.warn in place
 * kept them green -- so every defect in the serving path shipped past them.
 * Here the module is bundled with its Redis boundary stubbed and the functions
 * are actually invoked.
 */
describe('durable last-good wiring (#7084)', () => {
  const root = resolve(here, '..');
  type Read = { status: 'hit'; value: unknown } | { status: 'miss' } | { status: 'error'; error: unknown };

  const stub = {
    reads: new Map<string, Read>(),
    readCalls: [] as string[],
    writes: [] as Array<{ key: string; value: unknown; ttl: number }>,
    pipeline: (async () => [{ result: [] }]) as (c: unknown[][]) => Promise<Array<{ result?: unknown; error?: string }>>,
    transaction: (async (commands: unknown[][]) => commands.map(() => ({ result: 'OK' }))) as
      (c: unknown[][]) => Promise<Array<{ result?: unknown; error?: string }>>,
    // Every runRedisPipeline invocation, recorded so tests can assert on the
    // EVAL guarded publish and on how many revocation reads a request paid.
    pipelineCalls: [] as unknown[][][],
    transactionCalls: [] as unknown[][][],
    // Lets a test drive listFeedDigest's cache-hit vs fresh-build branch.
    fetchMeta: null as null | { data: unknown; source: string; leader: boolean },
    // Requests markNoCacheResponse was called for. The bundle carries its own
    // copy of _shared/response-headers, so its WeakMap is a different instance
    // from anything this file could import directly -- stub it instead.
    noCache: [] as unknown[],
    // #7084: false models a deployment with no Redis configured at all, which
    // must read as "no revocation store exists" (readable), NOT as a failed
    // read — the two were conflated and blanked the endpoint on preview
    // deploys and local dev runs.
    redisConfigured: true,
  };
  let mod: any;

  const evalCalls = () =>
    stub.pipelineCalls.flat().filter((cmd: any) => Array.isArray(cmd) && cmd[0] === 'EVAL');
  const smembersCalls = () =>
    stub.pipelineCalls.flat().filter((cmd: any) => Array.isArray(cmd) && cmd[0] === 'SMEMBERS');

  before(async () => {
    (globalThis as any).__digestRedisStub = stub;
    const shim = [
      'const s = globalThis.__digestRedisStub;',
      'export async function readCachedJson(k) { s.readCalls.push(k); return s.reads.get(k) ?? { status: "miss" }; }',
      'export async function setCachedJson(k, v, t) { s.writes.push({ key: k, value: v, ttl: t }); return true; }',
      'export async function cachedFetchJson() { return null; }',
      'export async function cachedFetchJsonWithMeta() { return s.fetchMeta ?? { data: null, source: "skipped", leader: false }; }',
      'export async function getCachedJson() { return null; }',
      'export async function getCachedJsonBatch() { return new Map(); }',
      'export function isRedisConfigured() { return s.redisConfigured !== false; }',
      'export async function runRedisPipeline(c) { s.pipelineCalls.push(c); return s.pipeline(c); }',
      'export async function runRedisTransaction(c) { s.transactionCalls.push(c); return s.transaction(c); }',
      'export const REDIS_PIPELINE_TIMEOUT_MS = 5000;',
    ].join('\n');
    const result = await build({
      stdin: {
        contents: "export * from './server/worldmonitor/news/v1/list-feed-digest.ts';",
        loader: 'ts',
        resolveDir: root,
        sourcefile: 'digest-lastgood-test-entry.ts',
      },
      bundle: true,
      format: 'esm',
      logLevel: 'silent',
      platform: 'node',
      target: 'node20',
      write: false,
      plugins: [{
        name: 'stub-redis',
        setup(b: any) {
          // Resolve to an absolute path before deciding. Matching the import
          // SPELLING missed `./redis` from inside server/_shared (which is how
          // digest-revocations.ts reaches it), so that module silently bundled
          // the REAL redis client and read process.env instead of the stub.
          b.onResolve({ filter: /redis(\.ts)?$/ }, (args: any) => {
            const resolved = nodePath.resolve(args.resolveDir ?? root, args.path);
            return resolved.endsWith(nodePath.join('server', '_shared', 'redis'))
              || resolved.endsWith(nodePath.join('server', '_shared', 'redis.ts'))
              ? { path: 'redis-stub', namespace: 'redisstub' }
              : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'redisstub' }, () => ({ contents: shim, loader: 'js' }));
          b.onResolve({ filter: /response-headers$/ }, () => ({ path: 'headers-stub', namespace: 'headerstub' }));
          b.onLoad({ filter: /.*/, namespace: 'headerstub' }, () => ({
            contents: [
              'const s = globalThis.__digestRedisStub;',
              'export function markNoCacheResponse(req) { s.noCache.push(req); }',
              'export function drainResponseHeaders() { return undefined; }',
            ].join('\n'),
            loader: 'js',
          }));
        },
      }],
    });
    const source = result.outputFiles[0]?.text;
    assert.ok(source, 'esbuild must emit the digest harness');
    mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  });

  const reset = () => {
    stub.reads.clear();
    stub.readCalls.length = 0;
    stub.writes.length = 0;
    stub.pipeline = async () => [{ result: [] }];
    stub.pipelineCalls.length = 0;
    stub.transaction = async (commands) => commands.map(() => ({ result: 'OK' }));
    stub.transactionCalls.length = 0;
    stub.fetchMeta = null;
    stub.redisConfigured = true;
    stub.noCache.length = 0;
    mod.__testing__.fallbackDigestCache.clear();
    mod.__testing__.lastGoodStoreTesting.activeAttempts.clear();
    mod.__testing__.lastGoodStoreTesting.recentFailedAttempts.clear();
    mod.__testing__.lastGoodStoreTesting.failureCooldowns.clear();
  };

  /** Minimal ServerContext — listFeedDigest only touches ctx.request headers. */
  const ctx = () => ({ request: new Request('https://x.test/api/news/v1/list-feed-digest') }) as any;

  const COVERAGE = {
    state: 'complete', attemptedAt: new Date(NOW).toISOString(), itemsServed: 1, publisherCount: 1,
    feedTotal: 1, feedCompleted: 1, categoryTotal: 1, categoryCompleted: 1, categoryStates: { politics: 'ok' },
    droppedFeedCap: 0, droppedUndated: 0, droppedFreshness: 0, droppedCategoryCap: 0,
    servedStale: false, staleAgeSeconds: 0, staleReason: '',
  };

  const body = (links: string[], coverage?: unknown, generatedAt = new Date(NOW).toISOString()) => ({
    categories: { politics: { items: links.map((l) => ({ link: l, source: 'S' })) } },
    feedStatuses: {},
    generatedAt,
    ...(coverage === undefined ? {} : { coverage }),
  });

  it('a genuine MISS publishes through one atomic guarded write', async () => {
    reset();
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', body(['https://a/1'], COVERAGE));
    const calls = evalCalls();
    assert.equal(calls.length, 1, 'the publish must be a single EVAL, not a read-decide-write pair');
    const cmd = calls[0] as string[];
    // ['EVAL', script, '2', bodyKey, revocationKey, ...argv] — every policy
    // input and the write are inside one atomic operation, which is what
    // closes the two-isolate lost-update race.
    assert.equal(cmd[2], '2');
    assert.equal(cmd[3], lastGoodKey('full', 'en'));
    assert.match(String(cmd[1]), /return 0/, 'the script must be able to refuse a narrower candidate');
    assert.equal(
      stub.writes.filter((w) => w.key === lastGoodKey('full', 'en')).length, 0,
      'no plain SET may bypass the guard outside sidecar mode',
    );
  });

  it('anchors acceptedAt to the CONTENT clock, not the write clock', async () => {
    reset();
    const generatedAt = new Date(NOW - 60 * 60 * 1000).toISOString();
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', body(['https://a/1'], COVERAGE, generatedAt));
    const cmd = evalCalls()[0] as string[];
    // ['EVAL', script, '2', bodyKey, revokedKey, now, maxAge, acceptedAt, ttl, dataJson]
    assert.equal(Number(cmd[7]), Date.parse(generatedAt), 'acceptedAt rides the content clock');
  });

  it('a lost guarded write (script returns 0) is a kept snapshot, not an error', async () => {
    reset();
    stub.pipeline = async (cmds) => cmds.some((c: any) => c[0] === 'EVAL')
      ? [{ result: 0 }]
      : [{ result: [] }];
    // Must not throw and must not fall back to plain writes.
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', body(['https://a/1'], COVERAGE));
    assert.equal(stub.writes.filter((w) => w.key === lastGoodKey('full', 'en')).length, 0);
  });

  it('serveLastGood returns null -- never a durable claim -- when Redis is unreadable', async () => {
    reset();
    stub.reads.set(lastGoodKey('full', 'en'), { status: 'error', error: new Error('down') });
    assert.equal(await mod.__testing__.serveLastGood('full', 'en', 'build-error', new Date(NOW).toISOString()), null);
  });

  it('a replayed snapshot is marked stale and its content is not re-dated', async () => {
    reset();
    const generatedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 30 * 60 * 1000, categoryCount: 1, itemCount: 1,
        data: body(['https://a/1'], COVERAGE, generatedAt),
      },
    });
    const out = await mod.__testing__.serveLastGood('full', 'en', 'empty-rebuild', new Date(NOW).toISOString());
    assert.ok(out, 'a snapshot inside the window must serve');
    assert.equal(out.generatedAt, generatedAt, 'content must not be re-dated');
    assert.equal(out.coverage.state, 'stale');
    assert.equal(out.coverage.servedStale, true);
    assert.equal(out.coverage.staleReason, 'empty-rebuild');
  });

  it('a snapshot with NO coverage block still comes back marked stale', async () => {
    reset();
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 60_000, categoryCount: 1, itemCount: 1,
        data: body(['https://a/1']), // pre-#7085 shape: no coverage at all
      },
    });
    const out = await mod.__testing__.serveLastGood('full', 'en', 'build-error', new Date(NOW).toISOString());
    assert.ok(out, 'must still serve');
    assert.equal(out.coverage.servedStale, true, 'an unmarked replay is indistinguishable from fresh');
    assert.equal(out.coverage.state, 'stale');
  });

  it('revocation applies to the stale path and the counts follow the served body', async () => {
    reset();
    stub.pipeline = async () => [{ result: ['https://a/1'] }];
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 60_000, categoryCount: 1, itemCount: 2,
        data: body(['https://a/1', 'https://a/2'], { ...COVERAGE, itemsServed: 2 }),
      },
    });
    const out = await mod.__testing__.serveLastGood('full', 'en', 'build-error', new Date(NOW).toISOString());
    assert.deepEqual(
      out.categories.politics.items.map((i: any) => i.link), ['https://a/2'],
      'the revoked URL must be gone',
    );
    assert.equal(out.coverage.itemsServed, 1, 'counts must describe what was actually served');
  });

  it('every replay tier is stamped by the same marker, and it declares itself stale', async () => {
    // Both the durable snapshot and the warm-isolate cache go through this one
    // function, so neither tier can go out wearing its original build's state.
    const out = mod.__testing__.markFallbackCoverageStale(
      body(['https://a/1'], COVERAGE),
      new Date(NOW).toISOString(),
      { ageSeconds: 1800, reason: 'build-error' },
    );
    assert.equal(out.coverage.state, 'stale');
    assert.equal(out.coverage.servedStale, true, 'a replay is not a fresh response');
    assert.equal(out.coverage.staleAgeSeconds, 1800);
    assert.equal(out.coverage.staleReason, 'build-error');
  });

  it('a coverage-less body still comes back marked stale, with reconstructed counts', () => {
    const out = mod.__testing__.markFallbackCoverageStale(
      body(['https://a/1', 'https://a/2']), // pre-coverage shape
      new Date(NOW).toISOString(),
      { ageSeconds: 60, reason: 'empty-rebuild' },
    );
    assert.equal(out.coverage.servedStale, true, 'an unmarked replay is indistinguishable from fresh');
    assert.equal(out.coverage.state, 'stale');
    assert.equal(out.coverage.itemsServed, 2);
  });

  it('the six-hour window is one policy, shared by both replay tiers', () => {
    // The isolate tier classifies its entry through the same predicate the
    // durable tier uses, so the two cannot drift on what "six hours" means.
    const inWindow = classifyStaleSnapshot({ acceptedAt: NOW - 60_000, data: ONE_ITEM }, NOW);
    assert.equal(inWindow.serve, true);
    const past = classifyStaleSnapshot(
      { acceptedAt: NOW - (LASTGOOD_MAX_AGE_MS + 5_000), data: ONE_ITEM },
      NOW,
    );
    assert.equal(past.serve, false, 'content past the window must not be replayed');
    assert.equal(past.outcome, 'expired');
  });

  it('a CACHE HIT does not republish the snapshot', async () => {
    // The publish is a full read+write of the ~126KB snapshot, awaited before
    // the response. Running it on every request (not just on a real rebuild)
    // put that on the hot path and re-stamped acceptance for content that had
    // not changed. Without this test, deleting the source === 'fresh' gate is
    // a surviving mutant.
    reset();
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE), source: 'cache', leader: false };
    await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(evalCalls().length, 0, 'a cache hit has nothing new to publish');
    assert.equal(
      stub.readCalls.includes(lastGoodKey('full', 'en')),
      false,
      'healthy/cache-hit requests must not read the large last-good body',
    );
  });

  it('a real BUILD does publish the snapshot', async () => {
    reset();
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE), source: 'fresh', leader: true };
    await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(evalCalls().length, 1, 'a fresh build is exactly when the snapshot should be refreshed');
  });

  it('a coalesced FOLLOWER of a build does not repeat the publication', async () => {
    // Followers awaiting the leader's in-flight build also resolve with
    // source 'fresh' — only `leader` distinguishes the one caller whose build
    // it actually was. Without the leader gate, N concurrent requests during
    // a rebuild each repeat the full ~126KB guarded write for an identical
    // body.
    reset();
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE), source: 'fresh', leader: false };
    await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(evalCalls().length, 0, 'only the leader has something new to publish');
  });

  it('a sentinel CACHE HIT does not record a new failed attempt', async () => {
    // A negative-sentinel hit replays a previous failure for up to 120s.
    // Recording it as a new attempt wrote a fresh attempt row on every
    // request in that window, telling operators failures were ongoing when
    // exactly one had occurred.
    reset();
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(stub.transactionCalls.length, 0, 'a replayed sentinel is not a new attempt');
  });

  it('the leader publishes one immutable attempt identity atomically before its sentinel', async () => {
    reset();
    const startedAt = new Date(NOW - 1234).toISOString();
    const slot = mod.__testing__.beginDigestAttempt('full', 'en', startedAt);
    const follower = mod.__testing__.recoverFailedAttempt(
      'full', 'en', { at: new Date(NOW).toISOString(), reason: 'empty-rebuild' },
    );
    const leader = mod.__testing__.publishFailedAttempt(
      'full', 'en', 'news:digest:v1:full:en', slot, 'build-error', 30,
    );
    mod.__testing__.completeDigestAttempt('full', 'en', slot);
    assert.equal(Object.isFrozen(leader), true);
    assert.deepEqual(leader, { at: startedAt, reason: 'build-error' });
    assert.strictEqual(await follower, leader, 'the coalesced follower must receive the leader-owned object');
    assert.equal(stub.transactionCalls.length, 1);
    const [attemptSet, sentinelSet] = stub.transactionCalls[0] as string[][];
    assert.equal(attemptSet[0], 'SET');
    assert.equal(attemptSet[1], attemptMetaKey('full', 'en'));
    assert.deepEqual(JSON.parse(attemptSet[2]), { ts: Date.parse(startedAt), outcome: 'build-error' });
    assert.equal(sentinelSet[1], 'news:digest:v1:full:en');
    assert.equal(JSON.parse(sentinelSet[2]), '__WM_NEG__');
  });

  it('a failed leader arms the same-isolate retry gate for the sentinel TTL', () => {
    reset();
    const cacheKey = 'news:digest:v1:full:en';
    const slot = mod.__testing__.beginDigestAttempt('full', 'en', new Date(NOW).toISOString());
    mod.__testing__.publishFailedAttempt('full', 'en', cacheKey, slot, 'empty-rebuild', 120);
    const expiresAt = mod.__testing__.lastGoodStoreTesting.failureCooldowns.get(cacheKey);
    assert.equal(mod.__testing__.shouldStartDigestAttempt(cacheKey, expiresAt - 1), false);
    assert.equal(mod.__testing__.shouldStartDigestAttempt(cacheKey, expiresAt), true);
  });

  it('a degraded request pays for exactly ONE revocation read across both replay tiers', async () => {
    // Two serial pipeline reads (durable tier, then isolate tier) were part
    // of the worst case that pushed an already-degraded request past the 25s
    // Edge response ceiling.
    reset();
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    stub.reads.set(lastGoodKey('full', 'en'), { status: 'miss' });
    mod.__testing__.fallbackDigestCache.set('full:en', {
      data: body(['https://a/1'], COVERAGE),
      ts: Date.now() - 60_000,
    });
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'stale', 'the isolate tier must still serve');
    assert.equal(smembersCalls().length, 1, 'one revocation read, shared by both tiers');
    assert.equal(
      stub.readCalls.filter((key) => key === lastGoodKey('full', 'en')).length,
      1,
      'degradation lazily starts one durable body read',
    );
  });

  it('replay tiers fail CLOSED when the revocation set cannot be read', async () => {
    // Replayed content is old — old enough that a revocation may postdate
    // it. Serving it unfiltered because the suppression set was unreadable
    // would honor availability over an operator's explicit pull.
    reset();
    stub.pipeline = async () => [{ error: 'ERR' }];
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 60_000, categoryCount: 1, itemCount: 1,
        data: body(['https://a/1'], COVERAGE),
      },
    });
    mod.__testing__.fallbackDigestCache.set('full:en', {
      data: body(['https://a/2'], COVERAGE),
      ts: Date.now() - 60_000,
    });
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'unavailable', 'neither replay tier may serve unfiltered old content');
    assert.deepEqual(out.categories, {});
  });

  it('fully revoked isolate content is unavailable, not a valid stale response', async () => {
    // Suppression must run BEFORE the servability gate on the isolate tier
    // too: classifying the unfiltered body let a fully-revoked entry through
    // as a "valid" stale response whose every item had been pulled.
    reset();
    stub.pipeline = async (cmds) => cmds.some((c: any) => c[0] === 'SMEMBERS')
      ? [{ result: ['https://a/1'] }]
      : [{ result: [] }];
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    stub.reads.set(lastGoodKey('full', 'en'), { status: 'miss' });
    mod.__testing__.fallbackDigestCache.set('full:en', {
      data: body(['https://a/1'], COVERAGE),
      ts: Date.now() - 60_000,
    });
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'unavailable');
  });

  it('a cache hit does not re-age the isolate entry -- its clock is the content clock', async () => {
    // Stamping Date.now() on every response meant a steadily-hit digest
    // never aged out of the isolate tier, and a later replay reported its
    // age from the last request rather than from the build.
    reset();
    const generatedAt = new Date(NOW - 45 * 60 * 1000).toISOString();
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE, generatedAt), source: 'cache', leader: false };
    await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(
      mod.__testing__.fallbackDigestCache.get('full:en').ts,
      Date.parse(generatedAt),
      'the isolate entry must be dated by its content, not by the request that touched it',
    );
  });

  it('a malformed stored snapshot degrades the tier, never the request', async () => {
    // A null category bucket used to throw inside the servability gate; the
    // handler catch then re-ran the same degraded path against the same body
    // and the second throw escaped as a 500 with every fallback unserved.
    reset();
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 60_000, categoryCount: 1, itemCount: 1,
        data: { categories: { politics: null }, feedStatuses: {}, generatedAt: new Date(NOW).toISOString() },
      },
    });
    mod.__testing__.fallbackDigestCache.set('full:en', {
      data: body(['https://a/2'], COVERAGE),
      ts: Date.now() - 60_000,
    });
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'stale', 'the isolate tier must take over from the malformed durable one');
    assert.deepEqual(
      out.categories.politics.items.map((i: any) => i.link), ['https://a/2'],
    );
  });

  it('a failed revocation read is reported unreadable, not as an empty set', async () => {
    reset();
    stub.pipeline = async () => [{ error: 'ERR' }];
    const read = await mod.__testing__.readRevokedUrlSet();
    assert.equal(read.readable, false);
    assert.equal(read.urls.size, 0);
  });

  it('a genuinely empty revocation set is readable', async () => {
    reset();
    stub.pipeline = async () => [{ result: [] }];
    assert.equal((await mod.__testing__.readRevokedUrlSet()).readable, true);
  });

  it('serves the DURABLE snapshot, not the isolate cache, when BOTH hold valid content', async () => {
    // The ordering claim ("durable snapshot first, warm isolate second") was
    // untestable before: every degraded case set the durable tier to a miss,
    // a read error, or a malformed body, so the isolate content won on its own
    // merits and swapping the two calls in serveDegraded kept the suite green.
    // This is the case that can actually tell the two tiers apart.
    reset();
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 60_000, categoryCount: 1, itemCount: 1,
        data: body(['https://durable/1'], COVERAGE),
      },
    });
    mod.__testing__.fallbackDigestCache.set('full:en', {
      data: body(['https://isolate/1'], COVERAGE),
      ts: Date.now() - 60_000,
    });
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'stale');
    assert.deepEqual(
      out.categories.politics.items.map((i: any) => i.link), ['https://durable/1'],
      'the cross-isolate durable snapshot outranks this isolate own warm cache',
    );
  });

  it('degraded responses are marked no-store', async () => {
    // markNoCacheResponse is the only thing keeping a degraded body out of the
    // shared cache, and nothing asserted it -- hoisting a return above it, or
    // dropping it in a merge, shipped green.
    reset();
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    stub.reads.set(lastGoodKey('full', 'en'), { status: 'miss' });
    const c = ctx();
    await mod.listFeedDigest(c, { variant: 'full', lang: 'en' });
    assert.ok(
      stub.noCache.includes(c.request),
      'a degraded digest response must never be stored by a shared cache',
    );
  });

  it('a fresh response is marked no-store once ANY revocation is live', async () => {
    // The endpoint is the gateway `slow` tier (s-maxage=1800, CDN 3600), so
    // without this an operator SADD left the revoked item served from shared
    // caches for up to an hour after suppression went in.
    reset();
    stub.pipeline = async () => [{ result: ['https://a/2'] }];
    stub.fetchMeta = { data: body(['https://a/1', 'https://a/2'], COVERAGE), source: 'fresh', leader: true };
    const c = ctx();
    const out = await mod.listFeedDigest(c, { variant: 'full', lang: 'en' });
    assert.deepEqual(out.categories.politics.items.map((i: any) => i.link), ['https://a/1']);
    assert.ok(stub.noCache.includes(c.request), 'a live revocation must stop shared caching');
  });

  it('a fresh response with NO revocations stays cacheable', async () => {
    // Positive control for the assertion above: without this, marking every
    // response no-store would satisfy it and silently destroy the CDN hit rate.
    reset();
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE), source: 'fresh', leader: true };
    const c = ctx();
    await mod.listFeedDigest(c, { variant: 'full', lang: 'en' });
    assert.equal(stub.noCache.includes(c.request), false, 'a clean fresh response stays cacheable');
  });

  it('an UNCONFIGURED Redis reads as "no revocation store", not as a failed read', async () => {
    // runRedisPipeline returns [] for missing credentials exactly as it does
    // for a transport error. Conflating the two made every serving tier fail
    // closed, so a preview deploy or a local dev run answered every request
    // with `unavailable` even though the build had succeeded.
    reset();
    stub.redisConfigured = false;
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE), source: 'fresh', leader: true };
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.deepEqual(
      out.categories.politics.items.map((i: any) => i.link), ['https://a/1'],
      'a successful build must still be served when there is no Redis at all',
    );
    assert.notEqual(out.coverage.state, 'unavailable');
  });

  it('the guarded write is the SHARED pinned script, and the Docker proxy pins the same bytes', async () => {
    // The Docker redis-rest proxy blocklists EVAL as a class and allows
    // exactly one pinned script -- the publish gate. Its image bundles only
    // its own file, so it holds a copy; this parity check is what keeps the
    // copy honest. (Text comparison is the point here: the pinned TEXT is
    // the contract the proxy enforces.)
    const { DIGEST_LASTGOOD_PUBLISH_SCRIPT } = await import('../shared/digest-lastgood-publish-script.mjs');
    reset();
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', body(['https://a/1'], COVERAGE));
    const cmd = evalCalls()[0] as string[];
    assert.equal(cmd[1], DIGEST_LASTGOOD_PUBLISH_SCRIPT, 'the server must send the shared script verbatim');
    // Structural pins only. The script's BEHAVIOUR is covered by
    // tests/digest-lastgood-script.test.mjs, which executes this exact text in
    // a Lua VM — a regex over source text cannot tell a correct gate from a
    // broken one, which is how the cjson round-trip shipped.
    assert.match(DIGEST_LASTGOOD_PUBLISH_SCRIPT, /SMEMBERS', KEYS\[2\]/);
    assert.match(DIGEST_LASTGOOD_PUBLISH_SCRIPT, /delta >= 0/);
    assert.doesNotMatch(
      DIGEST_LASTGOOD_PUBLISH_SCRIPT,
      /cjson\.encode/,
      'the body must be spliced verbatim; a cjson round trip rewrites every [] as {}',
    );

    const proxySrc = await import('node:fs').then((fs) =>
      fs.readFileSync(resolve(here, '..', 'docker', 'redis-rest-proxy.mjs'), 'utf8'));
    const block = proxySrc.match(/const DIGEST_LASTGOOD_PUBLISH_SCRIPT = (\[[\s\S]*?\])\.join\('\\n'\);/);
    assert.ok(block, 'the proxy must carry its pinned copy of the publish script');
    const proxyScript = (new Function(`return ${block![1]};`)() as string[]).join('\n');
    assert.equal(proxyScript, DIGEST_LASTGOOD_PUBLISH_SCRIPT, 'proxy copy must be byte-identical to shared/');
    assert.match(proxySrc, /isAllowedEval/, 'the proxy must gate EVAL through the pinned allowlist');
  });

  it('an EVAL-rejecting backend never falls back to racy plain writes', async () => {
    reset();
    stub.pipeline = async (cmds) => cmds.some((c: any) => c[0] === 'EVAL')
      ? [{ error: 'Command not allowed: EVAL' }]
      : [{ result: [] }];
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', body(['https://a/1'], COVERAGE));
    assert.equal(
      stub.writes.filter((w) => w.key === lastGoodKey('full', 'en')).length, 0,
      'a plain body SET would restore the cross-isolate lost-update race',
    );
  });

  it('richness is measured on the SERVABLE view; the stored body stays unfiltered', async () => {
    // A candidate full of revoked items must not look richer than what it
    // can actually deliver -- but the stored body keeps every item, because
    // revocations can be lifted and serve-time filtering governs delivery.
    reset();
    const candidate = body(['https://a/1', 'https://a/2'], COVERAGE);
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', candidate);
    const cmd = evalCalls()[0] as string[];
    assert.equal(cmd[4], REVOKED_URLS_KEY, 'the authoritative gate must read current revocations');
    const sent = JSON.parse(String(cmd[9]));
    assert.equal(
      sent.categories.politics.items.length, 2,
      'the stored body must keep revoked items so a lifted revocation restores them',
    );
    assert.equal(
      String(cmd[9]), JSON.stringify(candidate),
      'the body is sent as-is so the script can splice it without re-encoding',
    );
  });

  it('revocation drift remeasures incumbent and candidate under the same current view', () => {
    reset();
    const measure = mod.__testing__.lastGoodStoreTesting.measureServableRichness;
    const incumbent = body(['https://a/old-1', 'https://a/old-2', 'https://a/live'], COVERAGE);
    const candidate = body(['https://a/new-1', 'https://a/new-2'], COVERAGE);
    const currentRevocations = new Set(['https://a/old-1', 'https://a/old-2']);
    const current = measure(incumbent, currentRevocations);
    const next = measure(candidate, currentRevocations);
    assert.deepEqual(current, { categoryCount: 1, itemCount: 1 });
    assert.deepEqual(next, { categoryCount: 1, itemCount: 2 });
    assert.equal(
      shouldReplaceAccepted({ acceptedAt: Date.now(), ...current }, next, Date.now()).replace,
      true,
      'publication-time incumbent counts must not veto a richer currently servable candidate',
    );
  });

  it('an atomically fully-revoked candidate is rejected by the gate', async () => {
    reset();
    stub.pipeline = async (commands) => commands.some((command: any) => command[0] === 'EVAL')
      ? [{ result: -1 }]
      : [{ result: [] }];
    await mod.__testing__.publishAcceptedSnapshot('full', 'en', body(['https://a/1'], COVERAGE));
    assert.equal(evalCalls().length, 1, 'the atomic revocation view is authoritative');
    assert.equal(stub.writes.length, 0);
  });

  it('a sentinel replay recovers the REAL attempt identity the failing leader recorded', async () => {
    // Stamping the replaying request's own clock and a hardcoded
    // empty-rebuild fabricated both the attempt time and the reason -- a
    // build-error sentinel replayed as a brand-new empty rebuild dated now.
    reset();
    const failedAtMs = NOW - 90_000;
    stub.reads.set(attemptMetaKey('full', 'en'), {
      status: 'hit',
      value: { ts: failedAtMs, outcome: 'build-error' },
    });
    stub.reads.set(lastGoodKey('full', 'en'), {
      status: 'hit',
      value: {
        acceptedAt: Date.now() - 60_000, categoryCount: 1, itemCount: 1,
        data: body(['https://a/1'], COVERAGE),
      },
    });
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'stale');
    assert.equal(out.coverage.staleReason, 'build-error', 'the sentinel must not relabel the failure');
    assert.equal(
      out.coverage.attemptedAt, new Date(failedAtMs).toISOString(),
      'attemptedAt must name the leader attempt, not this replay',
    );
  });

  it('unavailable output preserves the recovered failed-attempt time and reason', async () => {
    reset();
    const failedAtMs = NOW - 45_000;
    stub.reads.set(attemptMetaKey('full', 'en'), {
      status: 'hit',
      value: { ts: failedAtMs, outcome: 'build-error' },
    });
    stub.reads.set(lastGoodKey('full', 'en'), { status: 'miss' });
    stub.fetchMeta = { data: null, source: 'cache', leader: false };
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.equal(out.coverage.state, 'unavailable');
    assert.equal(out.coverage.attemptedAt, new Date(failedAtMs).toISOString());
    assert.equal(out.coverage.staleReason, 'build-error');
  });

  it('a hanging telemetry write cannot delay the absolute response fallback', async () => {
    reset();
    stub.transaction = async () => new Promise(() => {});
    const slot = mod.__testing__.beginDigestAttempt('full', 'en', new Date(NOW).toISOString());
    mod.__testing__.publishFailedAttempt(
      'full', 'en', 'news:digest:v1:full:en', slot, 'build-error', 30,
    );
    const started = Date.now();
    const result = await mod.__testing__.settleBeforeDeadline(
      new Promise(() => {}),
      started + 20,
      'unavailable',
    );
    assert.equal(result, 'unavailable');
    assert.ok(Date.now() - started < 150, 'the absolute deadline must bound every unresolved tail');
  });

  it('fresh and cached serving fail CLOSED when revocations are unreadable', async () => {
    reset();
    stub.pipeline = async () => [{ error: 'ERR' }];
    stub.fetchMeta = { data: body(['https://a/1'], COVERAGE), source: 'cache', leader: false };
    const out = await mod.listFeedDigest(ctx(), { variant: 'full', lang: 'en' });
    assert.deepEqual(out.categories, {}, 'no unfiltered URL may escape');
    assert.equal(out.coverage.state, 'unavailable');
    assert.equal(out.coverage.attemptedAt, COVERAGE.attemptedAt);
    assert.equal(out.coverage.staleReason, '', 'a revocation outage is not a failed-build reason');
  });
});
