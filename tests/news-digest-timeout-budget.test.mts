import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { keepUnrecordedLabels, labelChangeFor, recordLabelChanges, STORY_LABEL_FIELD, storyLabel } from '../server/_shared/label-history';
import {
  __resetFetcherTimeoutForTests,
  __setFetcherTimeoutForTests,
  cachedFetchJson,
  REDIS_OP_TIMEOUT_MS,
  REDIS_PIPELINE_TIMEOUT_MS,
} from '../server/_shared/redis';

const {
  VERCEL_INITIAL_RESPONSE_LIMIT_MS,
  DIGEST_RESPONSE_TIMEOUT_MS,
  POST_FETCH_HEADROOM_MS,
  RESPONSE_GUARD_BAND_MS,
  RESPONSE_DEADLINE_MS,
  OVERALL_DEADLINE_MS,
} = __testing__;

const DIGEST_SRC = readFileSync(
  new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url),
  'utf8',
);

const callerStart = DIGEST_SRC.indexOf('    if (labelByHash && labelChanges.length > 0) {');
const callerEnd = DIGEST_SRC.indexOf('    for (const [category, sliced] of slicedByCategory)', callerStart);
assert.ok(callerStart >= 0 && callerEnd > callerStart);
const callerCode = ts.transpileModule(`
  return async function(storyTrackingDeadlineAt, labelByHash, labelChanges, allSliced, titleHashes) {
    const variant = 'full', lang = 'en';
    const memberHashesByFinal = undefined, clusterAnchorEligibleByFinalHash = undefined, corroborationByHash = undefined;
    ${DIGEST_SRC.slice(callerStart, callerEnd)}
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const runHistoryThenTracking = new Function(
  'recordLabelChanges', 'keepUnrecordedLabels', 'redisTimeoutForDeadline', 'writeStoryTracking', 'REDIS_PIPELINE_TIMEOUT_MS',
  callerCode,
)(recordLabelChanges, keepUnrecordedLabels, __testing__.redisTimeoutForDeadline, __testing__.writeStoryTracking, REDIS_PIPELINE_TIMEOUT_MS) as (
  deadline: number, labels: Map<string, string>, changes: NonNullable<ReturnType<typeof labelChangeFor>>[],
  items: unknown[], hashes: string[],
) => Promise<void>;

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    async json() {
      return payload;
    },
  } as Response;
}

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function isRedisSet(init: RequestInit | undefined): boolean {
  try {
    const body = JSON.parse(String(init?.body ?? 'null'));
    return Array.isArray(body) && body[0] === 'SET';
  } catch {
    return false;
  }
}

describe('news digest timeout budget', () => {
  it('reserves the existing request window in the actual history-to-tracking caller', async () => {
    const hash = 'a'.repeat(64);
    const start = 1_000_000;
    const item = { source: 'Reuters World', title: 'Rates held', link: 'https://example.test/story',
      publishedAt: start, importanceScore: 10, level: 'low', lang: 'en', description: '', titleHash: hash };
    const change = labelChangeFor(hash, 'single-publisher|1', storyLabel([
      { source: 'Reuters World', corroborationCount: 2 }, { source: 'BBC World' },
    ]), { at: start, title: item.title, link: item.link, credibilityScore: 70 })!;
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-only',
      VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: undefined, LOCAL_API_MODE: undefined,
    });
    const savedFetch = globalThis.fetch;
    const savedNow = Date.now;
    const savedTimeout = AbortSignal.timeout;
    try {
      for (const scenario of [
        { remaining: 100, guard: 80, append: 80, confirmed: false },
        { remaining: REDIS_PIPELINE_TIMEOUT_MS, guard: 80, append: 80, confirmed: false },
        { remaining: 7000, guard: 1500, append: 1000, confirmed: false },
        { remaining: 7000, guard: 10, append: 10, confirmed: true },
        { remaining: 7000, guard: 10, append: 10, confirmed: false, fail: true },
        { remaining: 0, guard: 0, append: 0, confirmed: false },
        { remaining: -1, guard: 0, append: 0, confirmed: false },
        { remaining: Number.POSITIVE_INFINITY, guard: 4000, append: 4000, confirmed: true },
      ]) {
        let now = start;
        let budget = 0;
        const calls: Array<{ commands: Array<Array<string | number>>; budget: number; at: number }> = [];
        Date.now = () => now;
        AbortSignal.timeout = (ms) => { budget = ms; return new AbortController().signal; };
        globalThis.fetch = async (_input, init) => {
          const commands = JSON.parse(String(init?.body)) as Array<Array<string | number>>;
          const stage = commands[0]?.[0];
          calls.push({ commands, budget, at: now });
          const elapsed = stage === 'SET' ? scenario.guard : stage === 'LPUSH' ? scenario.append : 1;
          now += Math.min(elapsed, budget);
          if (elapsed > budget) throw new Error('fixture deadline abort');
          return jsonResponse(commands.map(() => ({ result: 'OK' })), !(stage === 'LPUSH' && scenario.fail));
        };
        const labels = new Map([[hash, 'corroborated|2']]);
        await runHistoryThenTracking(start + scenario.remaining, labels, [change], [item], [hash]);
        const history = calls.filter((call) => ['SET', 'LPUSH', 'DEL'].includes(String(call.commands[0]?.[0])));
        const counters = calls.filter((call) => call.commands.some((command) => command[0] === 'HINCRBY'));
        if (scenario.remaining <= REDIS_PIPELINE_TIMEOUT_MS) assert.equal(history.length, 0);
        if (scenario.remaining <= 0) {
          assert.equal(calls.length, 0);
          continue;
        }
        assert.equal(counters.flatMap((call) => call.commands).filter((command) => command[0] === 'HINCRBY').length, 1, 'one actual tracking increment per story');
        const tracking = counters[0]!;
        assert.equal(tracking.budget, Math.min(REDIS_PIPELINE_TIMEOUT_MS, start + scenario.remaining - tracking.at), 'original absolute tracking deadline');
        if (scenario.remaining === 7000 && scenario.guard === 1500) {
          assert.deepEqual(history.map((call) => call.budget), [2000, 500]);
          assert.equal(tracking.at, start + 2000);
          assert.equal(tracking.budget, REDIS_PIPELINE_TIMEOUT_MS);
        }
        if (scenario.remaining === Number.POSITIVE_INFINITY) {
          assert.deepEqual(history.map((call) => call.budget), [REDIS_PIPELINE_TIMEOUT_MS, REDIS_PIPELINE_TIMEOUT_MS]);
          assert.equal(tracking.at, start + 8000);
        }
        const hsets = calls.flatMap((call) => call.commands).filter((command) => command[0] === 'HSET');
        assert.equal(hsets.some((command) => command.includes(STORY_LABEL_FIELD)), scenario.confirmed);
        for (const command of hsets.filter((command) => command.includes(STORY_LABEL_FIELD))) {
          assert.equal(command[command.indexOf(STORY_LABEL_FIELD) + 1], 'corroborated|2');
        }
        assert.equal(labels.has(hash), scenario.confirmed);
        if (scenario.confirmed) assert.ok(calls.findIndex((call) => call.commands[0]?.[0] === 'LPUSH') < calls.indexOf(tracking));
      }
    } finally {
      globalThis.fetch = savedFetch;
      Date.now = savedNow;
      AbortSignal.timeout = savedTimeout;
      restoreEnv();
    }
  });

  it('keeps cold cache misses below Vercel initial-response timeout', () => {
    assert.equal(VERCEL_INITIAL_RESPONSE_LIMIT_MS, 25_000);
    assert.equal(RESPONSE_DEADLINE_MS, VERCEL_INITIAL_RESPONSE_LIMIT_MS - RESPONSE_GUARD_BAND_MS);
    assert.ok(
      RESPONSE_GUARD_BAND_MS >= 3_000,
      'fallback path must reserve several seconds for edge runtime overhead and response jitter',
    );
    assert.ok(
      REDIS_OP_TIMEOUT_MS + DIGEST_RESPONSE_TIMEOUT_MS + REDIS_PIPELINE_TIMEOUT_MS + RESPONSE_GUARD_BAND_MS
        < VERCEL_INITIAL_RESPONSE_LIMIT_MS,
      'cache read + digest timeout + Redis sentinel write must leave platform response headroom',
    );
    assert.ok(
      REDIS_OP_TIMEOUT_MS + OVERALL_DEADLINE_MS + REDIS_PIPELINE_TIMEOUT_MS + RESPONSE_GUARD_BAND_MS
        < VERCEL_INITIAL_RESPONSE_LIMIT_MS,
      'RSS collection plus cache write must leave platform response headroom',
    );
    assert.ok(
      OVERALL_DEADLINE_MS + RESPONSE_GUARD_BAND_MS < DIGEST_RESPONSE_TIMEOUT_MS,
      'RSS collection deadline must leave assembly room before the cache miss response timeout',
    );
  });

  it('passes the digest-specific timeout to cachedFetchJson', () => {
    // Matches either wrapper: #7084 switched to cachedFetchJsonWithMeta so the
    // handler can tell a real build from a cache hit. Pinning the exact name
    // made this fail on the rename while the timeout argument was unchanged.
    assert.match(
      DIGEST_SRC,
      /cachedFetchJson(?:WithMeta)?<ListFeedDigestResponse>\([\s\S]*timeoutMs:\s*DIGEST_RESPONSE_TIMEOUT_MS,[\s\S]*cacheFailures:\s*false,[\s\S]*\}\s*,\s*\)/,
      'listFeedDigest must not rely on cachedFetchJson default timeout for cold builds',
    );
  });

  it('proves cachedFetchJson waits for the post-timeout sentinel write', async () => {
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let releaseSet: (() => void) | undefined;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isRedisSet(init)) {
        setCalls += 1;
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      __setFetcherTimeoutForTests(10);
      let settled = false;
      const result = cachedFetchJson(
        'news:digest:timeout-budget',
        60,
        () => new Promise<never>(() => {}),
      ).catch((err: unknown) => err).finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(setCalls, 1, 'timeout path should attempt the negative sentinel write');
      assert.equal(settled, false, 'cachedFetchJson must still be waiting on the sentinel write');

      releaseSet?.();
      const err = await result;
      assert.match(
        err instanceof Error ? err.message : String(err),
        /^cachedFetchJson timeout after 10ms for "news:digest:timeout-budget"$/,
      );
    } finally {
      releaseSet?.();
      __resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
