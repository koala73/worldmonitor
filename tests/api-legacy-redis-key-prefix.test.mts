/**
 * #7674 — the legacy api/_upstash-json.js layer must resolve the deployment
 * key prefix exactly like server/_shared/redis.ts: app-owned keys ride the
 * `preview:<sha>:` namespace by default (reads AND writes), while
 * seeder-owned keys are read raw in every environment because the Railway
 * fleet publishes them bare.
 *
 * Production is unaffected by any of this (the prefix is '' there); these
 * tests run the real consumers under VERCEL_ENV=preview with a stubbed
 * Upstash and assert the EXACT keys requested — the same recipe
 * tests/supply-chain-raw-keys.test.mts uses for the server layer.
 *
 * Covered asymmetries from the issue:
 *   - get_keyword_spikes read the accumulator/story rows bare and cached its
 *     payload into the production namespace (nlp-tools).
 *   - The health sweep classified the route-stamped temporal producer keys
 *     against production rows while reading every seeder key bare.
 *   - get-risk-scores raw-read the app-owned temporal:anomalies:v1 snapshot.
 *   - The inverse hazard: brief envelopes are Railway-composed and must stay
 *     raw, or preview briefs would 404.
 */
import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

const SHA = 'deadbeefcafe4321';
const PREFIX = `preview:${SHA.slice(0, 8)}:`;
const UPSTASH = 'https://upstash.test';

process.env.VERCEL_ENV = 'preview';
process.env.VERCEL_GIT_COMMIT_SHA = SHA;
process.env.UPSTASH_REDIS_REST_URL = UPSTASH;
process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
delete process.env.LOCAL_API_MODE;

// Imported AFTER the env above.
const upstash = await import('../api/_upstash-json.js');
const { isAppOwnedRedisKey } = await import('../api/_redis-key-ownership.js');

/** Decoded /get/<key> paths, in call order. */
const getPaths = [];
/** Decoded command arrays from every pipeline POST, in call order. */
const pipelineBodies = [];

function resetRecordings() {
  getPaths.length = 0;
  pipelineBodies.length = 0;
}

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

beforeEach(() => {
  upstash.__resetKeyPrefixCacheForTests();
  resetRecordings();
});

/** Record Upstash traffic; return null for every GET (cache miss). */
function stubUpstash() {
  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${UPSTASH}/get/`)) {
      getPaths.push(decodeURIComponent(url.slice(`${UPSTASH}/get/`.length)));
      return Response.json({ result: null });
    }
    if (url.startsWith(`${UPSTASH}/pipeline`)) {
      const commands = JSON.parse(init.body);
      pipelineBodies.push(commands);
      return Response.json(commands.map(() => ({ result: null })));
    }
    if (url.startsWith(UPSTASH)) return Response.json({ result: null });
    throw new Error(`unexpected global fetch: ${url}`);
  }) as typeof fetch;
}

describe('api/_upstash-json.js deployment key prefix mechanics (#7674)', () => {
  it('sanity: the suite really runs under a non-empty deployment prefix', () => {
    assert.equal(upstash.getKeyPrefix(), PREFIX);
    assert.equal(upstash.applyRedisKeyPrefix('k'), `${PREFIX}k`);
  });

  it('readJsonFromUpstash prefixes by default and reads raw on request', async () => {
    stubUpstash();
    await upstash.readJsonFromUpstash('app:owned:v1');
    await upstash.readJsonFromUpstash('seed:owned:v1', 3_000, true);
    assert.deepEqual(getPaths, [`${PREFIX}app:owned:v1`, 'seed:owned:v1']);
  });

  it('readRawJsonFromUpstash prefixes by default and reads raw on request', async () => {
    stubUpstash();
    await upstash.readRawJsonFromUpstash('app:owned:v1');
    await upstash.readRawJsonFromUpstash('seed:owned:v1', 3_000, true);
    assert.deepEqual(getPaths, [`${PREFIX}app:owned:v1`, 'seed:owned:v1']);
  });

  it('readJsonFromUpstashWithStatus delegates the raw flag', async () => {
    stubUpstash();
    await upstash.readJsonFromUpstashWithStatus('app:owned:v1');
    await upstash.readJsonFromUpstashWithStatus('seed:owned:v1', 3_000, true);
    assert.deepEqual(getPaths, [`${PREFIX}app:owned:v1`, 'seed:owned:v1']);
  });

  it('readJsonBatchFromUpstashWithStatus prefixes every key unless raw', async () => {
    stubUpstash();
    await upstash.readJsonBatchFromUpstashWithStatus(['app:a', 'app:b']);
    await upstash.readJsonBatchFromUpstashWithStatus(['seed:a'], 3_000, true);
    assert.deepEqual(pipelineBodies, [
      [['GET', `${PREFIX}app:a`], ['GET', `${PREFIX}app:b`]],
      [['GET', 'seed:a']],
    ]);
  });

  it('setCachedData writes prefixed by default and verbatim when raw', async () => {
    stubUpstash();
    await upstash.setCachedData('app:owned:v1', { x: 1 }, 60);
    await upstash.setCachedData('seed:owned:v1', { x: 1 }, 60, true);
    assert.deepEqual(pipelineBodies, [
      [['SET', `${PREFIX}app:owned:v1`, '{"x":1}', 'EX', '60']],
      [['SET', 'seed:owned:v1', '{"x":1}', 'EX', '60']],
    ]);
  });

  it('redisPipeline prefixes the key argument of every command unless raw', async () => {
    stubUpstash();
    await upstash.redisPipeline([
      ['GET', 'app:a'],
      ['SET', 'app:b', '1', 'EX', '60'],
      ['INCR', 'app:c'],
      ['ZRANGE', 'app:d', '0', '-1'],
    ]);
    await upstash.redisPipeline([['GET', 'seed:a']], 5_000, true);
    assert.deepEqual(pipelineBodies, [
      [
        ['GET', `${PREFIX}app:a`],
        ['SET', `${PREFIX}app:b`, '1', 'EX', '60'],
        ['INCR', `${PREFIX}app:c`],
        ['ZRANGE', `${PREFIX}app:d`, '0', '-1'],
      ],
      [['GET', 'seed:a']],
    ]);
  });

  it('redisPipeline prefixes EVAL KEYS via the key-count argument, mirroring the server layer', async () => {
    stubUpstash();
    await upstash.redisPipeline([
      ['EVAL', 'script', '2', 'app:k1', 'app:k2', 'arg1'],
      ['EVAL', 'script', '1', 'seed:k1', 'arg1'],
    ]);
    assert.deepEqual(pipelineBodies, [
      [
        ['EVAL', 'script', '2', `${PREFIX}app:k1`, `${PREFIX}app:k2`, 'arg1'],
        // raw only matters per-pipeline; this EVAL's key is a non-key slot
        // ('script') and its KEYS are still finalized.
        ['EVAL', 'script', '1', `${PREFIX}seed:k1`, 'arg1'],
      ],
    ]);
  });

  it('non-string verbs/keys pass through untouched', async () => {
    stubUpstash();
    await upstash.redisPipeline([['GET', 42]]);
    assert.deepEqual(pipelineBodies, [[['GET', 42]]]);
  });

  it('the memoized prefix recomputes after the test reset hook', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'cafe0001abcd';
    try {
      upstash.__resetKeyPrefixCacheForTests();
      assert.equal(upstash.getKeyPrefix(), 'preview:cafe0001:');
      assert.equal(upstash.applyRedisKeyPrefix('k'), 'preview:cafe0001:k');
    } finally {
      process.env.VERCEL_GIT_COMMIT_SHA = SHA;
      upstash.__resetKeyPrefixCacheForTests();
    }
  });
});

describe('isAppOwnedRedisKey (#7674)', () => {
  it('names the route-owned exceptions and leaves the seeder fleet raw', () => {
    assert.equal(isAppOwnedRedisKey('temporal:anomalies:v1'), true);
    assert.equal(isAppOwnedRedisKey('seed-meta:temporal:anomalies'), true);
    assert.equal(isAppOwnedRedisKey('seed-meta:market:crypto'), false);
    assert.equal(isAppOwnedRedisKey('temporal:anomalies:v1:lookalike'), false);
    assert.equal(isAppOwnedRedisKey(undefined), false);
  });
});

describe('mcp get_keyword_spikes reads and writes the preview namespace (#7674)', () => {
  it('accumulator, story rows, and the spike cache all carry the deployment prefix', async () => {
    const { NLP_TOOLS } = await import('../api/mcp/registry/nlp-tools.ts');
    const tool = NLP_TOOLS.find((t) => t.name === 'get_keyword_spikes');
    assert.ok(tool, 'get_keyword_spikes must stay registered');

    const now = Date.now();
    const HOUR = 3_600_000;
    const recentHashes = ['ra'.repeat(32), 'rb'.repeat(32), 'rc'.repeat(32)];
    const baselineHashes = ['ba'.repeat(32), 'bb'.repeat(32)];
    const sourcesByHash = new Map([
      [recentHashes[0], ['Reuters']],
      [recentHashes[1], ['AP News']],
      [recentHashes[2], ['BBC']],
    ]);
    globalThis.fetch = (async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${UPSTASH}/get/`)) {
        getPaths.push(decodeURIComponent(url.slice(`${UPSTASH}/get/`.length)));
        return Response.json({ result: null });
      }
      if (url.startsWith(`${UPSTASH}/pipeline`)) {
        const commands = JSON.parse(init.body);
        pipelineBodies.push(commands);
        const verb = commands[0]?.[0];
        if (verb === 'ZRANGE') {
          // Two cohorts in one pipeline: recent (3 stories) + baseline (2).
          // Scores sit well inside each cohort's bounds — the tool re-reads
          // Date.now() after the fixture captured `now`, so exact-boundary
          // scores race the tool's own clock.
          return Response.json(commands.map((command) => {
            const maxScore = Number(command[2]);
            const minScore = Number(command[3]);
            const pairs = [
              ...recentHashes.map((hash, i) => [hash, String(now - (20 + 10 * i) * 60_000)]),
              ...baselineHashes.map((hash, i) => [hash, String(now - (30 + 10 * i) * HOUR)]),
            ];
            return {
              result: pairs
                .filter(([, score]) => Number(score) >= minScore && Number(score) <= maxScore)
                .flat(),
            };
          }));
        }
        if (verb === 'HMGET') {
          return Response.json(commands.map((command) => {
            const hash = String(command[1]).replace(`${PREFIX}story:track:v1:`, '');
            if (recentHashes.includes(hash)) return { result: ['Iran closes Strait of Hormuz to tanker traffic', 'https://n/1'] };
            return { result: ['Wildfire spreads across Tasmania national park', 'https://n/2'] };
          }));
        }
        if (verb === 'SMEMBERS') {
          // Three distinct publishers across the recent stories — the spike
          // decision requires MIN_SPIKE_SOURCE_COUNT (2) unique publishers.
          return Response.json(commands.map((command) => ({
            result: sourcesByHash.get(String(command[1]).replace(`${PREFIX}story:sources:v1:`, '')) ?? [],
          })));
        }
        return Response.json(commands.map(() => ({ result: 'OK' })));
      }
      throw new Error(`unexpected global fetch: ${url}`);
    }) as typeof fetch;

    const result = await tool._execute({ window_hours: 2, min_count: 2, limit: 10 });
    assert.ok(Array.isArray(result.spikes), 'the tool must compute from the fixture rows');
    assert.ok(result.spikes.length > 0, 'two matching recent titles must produce a spike');

    // The cache read happened through the prefixed GET…
    assert.deepEqual(getPaths, [`${PREFIX}intelligence:keyword-spikes:mcp:v3:2h:2`]);
    // …every pipeline key is deployment-namespaced…
    const requestedKeys = pipelineBodies.flat().map((command) => command[1]);
    assert.ok(requestedKeys.includes(`${PREFIX}digest:accumulator:v1:full:en`), 'accumulator read must be prefixed');
    assert.ok(requestedKeys.includes(`${PREFIX}story:track:v1:${recentHashes[0]}`), 'story row HMGET must be prefixed');
    assert.ok(requestedKeys.includes(`${PREFIX}story:sources:v1:${recentHashes[0]}`), 'story sources SMEMBERS must be prefixed');
    // …and the spike cache write landed in the deployment namespace, not in
    // the production rows a preview deploy used to leak into.
    assert.ok(requestedKeys.includes(`${PREFIX}intelligence:keyword-spikes:mcp:v3:2h:2`), 'spike cache write must be prefixed');
    assert.ok(!requestedKeys.some((key) => key.startsWith('story:') || key.startsWith('digest:')),
      'no bare story/digest key may be requested under preview');
  });
});

describe('health sweep classifies the temporal producer keys into the preview namespace (#7674)', () => {
  it('temporal data + stamp are prefixed; every seeder key and marker stays raw', async () => {
    const { handleHealth } = await import('../api/health.js');
    process.env.WORLDMONITOR_VALID_KEYS = 'prefix-health-test-key';

    globalThis.fetch = (async (input, init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${UPSTASH}/get/`)) {
        getPaths.push(decodeURIComponent(url.slice(`${UPSTASH}/get/`.length)));
        return Response.json({ result: null });
      }
      if (url.startsWith(`${UPSTASH}/pipeline`)) {
        const commands = JSON.parse(init.body);
        pipelineBodies.push(commands);
        const results = commands.map(([op, key]) => {
          if (op === 'STRLEN' || op === 'LLEN') return { result: 128 };
          if (op === 'EXISTS') return { result: 0 };
          if (op === 'HEXISTS') return { result: 0 };
          if (op === 'HSETNX' || op === 'HGET' || op === 'HDEL' || op === 'PEXPIRE') return { result: 'OK' };
          if (op === 'GET' && String(key).includes('health:verdict')) return { result: null };
          if (op === 'GET' && String(key).endsWith('health:failure-log-sig')) return { result: '' };
          if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 10_000 }) };
          return { result: 'OK' };
        });
        return Response.json(results);
      }
      throw new Error(`unexpected global fetch: ${url}`);
    }) as typeof fetch;

    const response = await handleHealth(
      new Request('https://api.worldmonitor.app/api/health', {
        headers: { 'x-worldmonitor-key': 'prefix-health-test-key' },
      }),
      undefined,
      { now: Date.parse('2026-09-05T00:00:00Z') },
    );
    assert.equal(response.status, 200);

    // The verdict snapshot read happened through the deployment-prefixed key
    // (health.js pre-prefixes its own verdict keys via healthVerdictRedisKey
    // and sends those pipelines verbatim).
    assert.ok(
      pipelineBodies.some((commands) => String(commands[0]?.[1] ?? '').startsWith(`${PREFIX}health:verdict`)),
      'the verdict snapshot must be read from the deployment namespace',
    );

    // The sweep is the pipeline that starts with the data-key STRLEN/LLEN
    // commands.
    const sweep = pipelineBodies.find((commands) => commands[0]?.[0] === 'STRLEN');
    assert.ok(sweep, 'the registry sweep must have run');
    const sweepKeys = new Set(sweep.map((command) => command[1]));

    // Route-owned temporal keys: this deployment's own snapshot and stamp.
    assert.ok(sweepKeys.has(`${PREFIX}temporal:anomalies:v1`), 'temporal snapshot must be prefixed');
    assert.ok(sweepKeys.has(`${PREFIX}seed-meta:temporal:anomalies`), 'temporal stamp must be prefixed');
    // Seeder-owned fleet keys: raw, or every preview would classify nothing.
    assert.ok(sweepKeys.has('seed-meta:market:crypto'), 'seeder seed-meta must stay raw');
    assert.ok(sweepKeys.has('seed-activated:prediction:markets-country-index'), 'activation markers must stay raw');
    assert.ok(sweepKeys.has('market:stocks-bootstrap:v1'), 'bootstrap data keys must stay raw');
  });
});

describe('getRiskScores reads the app-owned temporal snapshot prefixed (#7674)', () => {
  it('temporal:anomalies:v1 is namespaced; seeder-owned sources stay raw', async () => {
    const { getRiskScores } = await import(
      '../server/worldmonitor/intelligence/v1/get-risk-scores'
    );

    globalThis.fetch = (async (input, _init = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${UPSTASH}/get/`)) {
        getPaths.push(decodeURIComponent(url.slice(`${UPSTASH}/get/`.length)));
        return Response.json({ result: null });
      }
      if (url.startsWith(UPSTASH)) return Response.json([]);
      throw new Error(`unexpected global fetch: ${url}`);
    }) as typeof fetch;

    await getRiskScores({} as never, {} as never);

    const requested = new Set(getPaths);
    assert.ok(requested.has(`${PREFIX}temporal:anomalies:v1`), 'app-owned snapshot must be prefixed');
    assert.ok(requested.has('news:insights:v1'), 'seeder count sources must stay raw');
    assert.ok(!requested.has('temporal:anomalies:v1'), 'no bare app-owned snapshot read may remain');
  });
});

describe('brief envelopes stay raw under preview (#7674)', () => {
  it('api/brief/[userId]/[issueDate] requests the Railway-composed envelope bare', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET ??= 'test-secret-prefix-7674';
    const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
    const { signBriefToken } = await import('../server/_shared/brief-url.ts');
    const userId = 'user_prefixtest';
    const issueDate = '2026-04-17-0800';
    const token = await signBriefToken(userId, issueDate, process.env.BRIEF_URL_SIGNING_SECRET);

    globalThis.fetch = (async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${UPSTASH}/get/`)) {
        getPaths.push(decodeURIComponent(url.slice(`${UPSTASH}/get/`.length)));
        return Response.json({ result: null });
      }
      // Non-Upstash fetches are fire-and-forget side channels (telemetry);
      // answer them harmlessly.
      return Response.json({});
    }) as typeof fetch;

    const res = await handler(new Request(
      `https://worldmonitor.app/api/brief/${userId}/${issueDate}?t=${token}`,
      { method: 'GET', headers: { origin: 'https://worldmonitor.app' } },
    ));
    // Miss → the route's documented 404; the assertion is about the KEY.
    assert.equal(res.status, 404);
    assert.deepEqual(getPaths, [`brief:${userId}:${issueDate}`],
      'the seeder-composed envelope must be read raw — a prefixed read would 404 every preview brief');
  });
});
