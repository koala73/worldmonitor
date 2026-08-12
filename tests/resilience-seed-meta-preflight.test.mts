// Seed-meta preflight read semantics for FAIL-CLOSED dimensions.
//
// The incident this pins (#6484, 2026-08-12): within 25 minutes of the
// education activation deploying, `education` came back `source-failure` with
// coverage 0 for 196/196 countries in production. The seeder was healthy and
// the payload was present — `seed-meta:resilience:education-attainment` was
// 26h old against an 8-day budget, and scoring the same production data
// serially resolved 181 observed countries.
//
// The chain:
//   1. The ranking warm scores ~196 countries CONCURRENTLY.
//   2. Under that burst `getCachedJson` hits its 1500 ms op timeout.
//   3. `getCachedJson` collapses MISS and ERROR to the same `null`.
//   4. `createMemoizedSeedReader` shares that in-flight read, so ONE exhausted
//      result reaches every country that joined it.
//   5. The preflight reads `null` as "the producer never published" and
//      fail-closes, publishing a 6-hour-cached source-failure for the world.
//
// A fail-closed preflight is correct for a genuinely absent producer and wrong
// for a 1.5-second network blip. These tests hold both halves of that line, so
// a future change cannot fix the blip by making real outages silent.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { scoreEducation, createMemoizedSeedReader } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { warmMissingResilienceScores } from '../server/worldmonitor/resilience/v1/_shared.ts';

const META_KEY = 'seed-meta:resilience:education-attainment';
const DATA_KEY = 'resilience:education-attainment:v1';

// A payload that clears the #6472 activation floors. Both the seed-meta proof
// (`rankableRecordCount`) and the payload's own usable-record count must exceed
// 180, so a one-country fixture would fail for reasons unrelated to the read
// path this suite tests. Built from the real rankable universe so the codes are
// genuine rather than synthetic strings the universe check would reject.
const RANKABLE_CODES: string[] = Object.values(
  JSON.parse(readFileSync(new URL('../scripts/shared/sovereign-status.json', import.meta.url), 'utf8')).entries,
).map((entry: any) => entry.iso2).slice(0, 185);

const EDUCATION_PAYLOAD = {
  countries: Object.fromEntries(RANKABLE_CODES.map((code, i) => [code, { value: 40 + (i % 50), year: 2024 }])),
};

const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalFlag = process.env.RESILIENCE_EDUCATION_ENABLED;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  if (originalFlag == null) delete process.env.RESILIENCE_EDUCATION_ENABLED;
  else process.env.RESILIENCE_EDUCATION_ENABLED = originalFlag;
});

interface StubOptions {
  /** Number of leading reads of the meta key that fail like a timeout. */
  metaFailures?: number;
  /** When true the meta key is genuinely absent (Upstash returns result:null). */
  metaMissing?: boolean;
}

function installRedisStub(options: StubOptions = {}) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.RESILIENCE_EDUCATION_ENABLED = 'true';

  const counts = { meta: 0, data: 0 };
  let remainingMetaFailures = options.metaFailures ?? 0;

  const values: Record<string, unknown> = {
    // `rankableRecordCount` satisfies the #6472 activation-proof gate. It is
    // deliberately present here: this suite is about the READ path, so the
    // fixture must clear every other preflight or a green result would prove
    // nothing about the thing under test.
    [META_KEY]: { fetchedAt: Date.now(), recordCount: 189, rankableRecordCount: 181 },
    [DATA_KEY]: EDUCATION_PAYLOAD,
  };

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : (input as Request).url;
    const url = new URL(href);
    if (url.pathname.endsWith('/pipeline')) {
      const commands = JSON.parse(String(init?.body ?? '[]')) as unknown[];
      return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), { status: 200 });
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
    if (key === META_KEY) {
      counts.meta++;
      if (remainingMetaFailures > 0) {
        remainingMetaFailures--;
        // Exactly what AbortSignal.timeout produces at 1500 ms: a thrown
        // fetch, which readCachedJson reports as status 'error'.
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      if (options.metaMissing) return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (key === DATA_KEY) counts.data++;
    const value = values[key];
    return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), { status: 200 });
  }) as typeof fetch;

  return counts;
}

describe('seed-meta preflight — transient read error vs genuine absence', () => {
  it('does not fail closed when the seed-meta read times out but the producer is healthy', async () => {
    // The production shape: one timed-out read of a key that is present and
    // fresh. Before #6484 this published source-failure for every country.
    installRedisStub({ metaFailures: 1 });

    const score = await scoreEducation('US');

    assert.equal(
      score.imputationClass,
      null,
      'a transient seed-meta read timeout must not be reported as a dead producer',
    );
    assert.ok(score.coverage > 0, `expected real coverage, got ${score.coverage}`);
    assert.ok(score.score > 0, `expected a real score, got ${score.score}`);
  });

  it('still fails closed when the producer genuinely never published', async () => {
    // The over-correction guard. Retrying a transient error must not make a
    // real outage silent — an absent seed-meta is the signal that the Railway
    // bundle is not publishing, and it must stay loud.
    //
    // Asserted as a THROW rather than a source-failure shape: scoreEducation
    // raises ResilienceConfigurationError and `scoreAllDimensions` is what
    // converts that into the coverage-0 source-failure row. Asserting the
    // shape here would test the wrong layer.
    installRedisStub({ metaMissing: true });

    await assert.rejects(
      () => scoreEducation('US'),
      (err: Error) => err.name === 'ResilienceConfigurationError'
        && /required seed-meta absent or unhealthy/.test(err.message),
      'an absent seed-meta must still fail closed — that is the operator alarm',
    );
  });

  it('retries the failing read rather than trusting the first answer', async () => {
    const counts = installRedisStub({ metaFailures: 2 });
    const score = await scoreEducation('US');
    assert.ok(counts.meta > 1, `expected a retry, saw ${counts.meta} meta read(s)`);
    assert.equal(score.imputationClass, null);
  });
});

describe('memoized seed reader — one failed read must not poison the batch', () => {
  it('contains an exhausted seed-meta read without creating a batch-wide retry herd', async () => {
    // #6510: the first fix evicted a resolved null from the memo, but all
    // concurrent countries had already joined the same in-flight promise.
    // If that promise exhausted its retries, every joined scorer still saw
    // null and the whole batch failed closed. The first country may retain the
    // fail-closed result; joined countries must share one recovery read.
    const counts = installRedisStub({ metaFailures: 3 });
    const countryCodes = RANKABLE_CODES.slice(0, 20);
    const warmed = await warmMissingResilienceScores(
      countryCodes,
      async (countryCode, reader) => {
        const education = await scoreEducation(countryCode, reader);
        return {
          countryCode,
          domains: [{ id: 'human', score: education.score, weight: 1, dimensions: [{ id: 'education', ...education }] }],
        } as never;
      },
    );

    assert.equal(warmed.failures.filter((failure) => failure.stage === 'compute').length, 1);
    assert.equal(warmed.size, countryCodes.length - 1, 'only the creator of the exhausted read may fail closed');
    assert.equal(counts.meta, 4, 'joined countries must share one recovery read instead of stampeding Redis');
    for (const score of warmed.values()) {
      const education = score.domains.flatMap((domain) => domain.dimensions).find((dimension) => dimension.id === 'education');
      assert.ok(education && education.coverage > 0, `${score.countryCode} must observe the healthy education seed`);
      assert.notEqual(education.imputationClass, 'source-failure');
    }
  });

  it('evicts a null seed-meta result before a later sequential read', async () => {
    const recoveredMeta = { fetchedAt: Date.now(), recordCount: 189, rankableRecordCount: 181 };
    let reads = 0;
    const reader = createMemoizedSeedReader(async () => {
      reads++;
      return reads === 1 ? null : recoveredMeta;
    });

    assert.equal(await reader(META_KEY), null, 'the creator still observes its fail-closed null');
    assert.deepEqual(
      await reader(META_KEY),
      recoveredMeta,
      'a later caller must retry instead of reusing the resolved null',
    );
    assert.equal(reads, 2, 'the sequential retry contract must not depend on the internal retry budget');
  });

  it('still memoizes a successful read', async () => {
    const counts = installRedisStub();
    const reader = createMemoizedSeedReader();
    await reader(META_KEY);
    await reader(META_KEY);
    assert.equal(counts.meta, 1, 'a hit must be cached — memoization is the point of this reader');
  });
});
