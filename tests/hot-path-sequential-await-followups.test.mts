// Follow-ups to the hot-path await sweep (#10075): independent awaits the
// first pass left serialized. The crypto and Redis paths are driven for real
// with a deferred spy, so the tests fail if the work goes back to running one
// await at a time. The client sites have no injectable seam, so their tests pin
// the order in the source instead: the second operation must start before the
// first is awaited.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { timingSafeIncludes } from '../api/_crypto.js';
import { peekIdempotency } from '../server/_shared/idempotency.ts';
import {
  buildInternalMcpHeaders,
  signInternalMcpRequest,
  verifyInternalMcpRequestDetailed,
} from '../server/_shared/mcp-internal-hmac.ts';
import {
  _resetTrackedAircraftCacheForTests,
  getTrackedAircraftIcao24s,
} from '../server/worldmonitor/military/v1/_tracked-aircraft.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

/**
 * Count digest "waves": a wave starts whenever a digest begins while no other
 * digest is in flight. Each digest resolves on a later macrotask, so digests
 * awaited one after another land in separate waves and concurrent ones share a
 * wave.
 */
async function countDigestWaves<T>(fn: () => Promise<T>): Promise<{ result: T; waves: number }> {
  const subtle = globalThis.crypto.subtle;
  const originalDigest = subtle.digest.bind(subtle);
  let inFlight = 0;
  let waves = 0;
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    value: async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
      if (inFlight === 0) waves += 1;
      inFlight += 1;
      try {
        await nextTurn();
        return await originalDigest(algorithm, data);
      } finally {
        inFlight -= 1;
      }
    },
  });
  try {
    const result = await fn();
    return { result, waves };
  } finally {
    Object.defineProperty(subtle, 'digest', { configurable: true, value: originalDigest });
  }
}

describe('constant-time comparisons hash their inputs in one wave', () => {
  it('api/_crypto.js timingSafeIncludes digests the candidate and every key together', async () => {
    const hit = await countDigestWaves(() => timingSafeIncludes('key-b', ['key-a', 'key-b', 'key-c']));
    assert.equal(hit.result, true);
    assert.equal(hit.waves, 1, 'candidate and key digests must run concurrently, not one per key');

    const miss = await countDigestWaves(() => timingSafeIncludes('nope', ['key-a', 'key-b']));
    assert.equal(miss.result, false);
    assert.equal(miss.waves, 1);
  });

  it('verifyInternalMcpRequestDetailed compares the signature in one wave', async () => {
    const url = 'https://api.worldmonitor.app/api/intelligence/v1/get-country-risk?country_code=IR';
    const signed = await signInternalMcpRequest({
      method: 'GET',
      url,
      userId: 'user_wave_test',
      secret: 'wave-test-secret',
    });
    const request = new Request(url, { method: 'GET', headers: buildInternalMcpHeaders(signed) });
    const { result, waves } = await countDigestWaves(() => verifyInternalMcpRequestDetailed(request, 'wave-test-secret'));
    assert.equal(result.ok, true);
    // One wave for the query and body hashes, one for the constant-time
    // signature compare. A serialized compare adds a third.
    assert.equal(waves, 2);
  });
});

describe('server/_shared/idempotency.ts hashes body and key together', () => {
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
  });

  it('derives the request hash and the Redis key in one digest wave', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const request = new Request('https://api.worldmonitor.app/api/scenario/v1/run-scenario', {
      method: 'POST',
      body: JSON.stringify({ scenarioId: 'wave' }),
    });
    const { waves } = await countDigestWaves(() => peekIdempotency({
      request,
      pathname: '/api/scenario/v1/run-scenario',
      scope: 'user:wave',
      idempotencyKey: 'wave-key-1',
      corsHeaders: {},
    }));
    assert.equal(waves, 1);
  });
});

describe('tracked-aircraft snapshot reads', () => {
  const savedFetch = globalThis.fetch;
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
    _resetTrackedAircraftCacheForTests();
  });

  it('issues the live and stale snapshot reads together and merges both', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    _resetTrackedAircraftCacheForTests();
    const pending: Array<{ url: string; release: () => void }> = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      const hex = url.includes('stale') ? 'BBB222' : 'AAA111';
      const body = JSON.stringify({ result: JSON.stringify({ flights: [{ hexCode: hex }] }) });
      return new Promise<Response>((resolveResponse) => {
        pending.push({ url, release: () => resolveResponse(new Response(body, { status: 200 })) });
      });
    }) as typeof fetch;

    const tracked = getTrackedAircraftIcao24s();
    await nextTurn();
    assert.equal(pending.length, 2, 'both snapshot reads must be in flight before either resolves');
    for (const entry of pending) entry.release();
    const set = await tracked;
    assert.deepEqual([...(set ?? [])].sort(), ['aaa111', 'bbb222']);
  });
});

/** Slice one function body out of a source file, by a unique marker inside it. */
function functionContaining(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  // The next top-level function or class method ends the slice.
  const nextFunctionMarker = /\n(?:export )?(?:async )?function |\n {2}(?:private |public |protected )?(?:async )?\w+\(/g;
  nextFunctionMarker.lastIndex = at + marker.length;
  const next = nextFunctionMarker.exec(source);
  return source.slice(at, next ? next.index : source.length);
}

function assertStartsBefore(body: string, started: string, awaited: string, message: string) {
  const startAt = body.indexOf(started);
  const awaitAt = body.indexOf(awaited);
  assert.ok(startAt >= 0, `missing: ${started}`);
  assert.ok(awaitAt >= 0, `missing: ${awaited}`);
  assert.ok(startAt < awaitAt, message);
}

/**
 * In the function that logs `marker`, the Convex API load must start before the
 * client is awaited, so the two chunk fetches overlap.
 */
function assertApiLoadStartsBeforeClientAwait(rel: string, marker: string) {
  const source = read(rel);
  const markerAt = source.indexOf(marker);
  assert.ok(markerAt >= 0, `${rel}: marker not found: ${marker}`);
  const clientAwait = source.lastIndexOf('await getConvexClient()', markerAt);
  const fnStart = source.lastIndexOf('function ', clientAwait);
  const apiStart = source.lastIndexOf('getConvexApi()', clientAwait);
  assert.ok(clientAwait > fnStart && fnStart >= 0, `${rel}: could not locate the client await`);
  assert.ok(apiStart > fnStart, `${rel}: start getConvexApi() before awaiting getConvexClient()`);
}

describe('signed-in boot: the Convex API chunk loads alongside the client', () => {
  it('entitlements subscription starts the API load before awaiting the client', () => {
    assertApiLoadStartsBeforeClientAwait('src/services/entitlements.ts', 'No VITE_CONVEX_URL — skipping Convex subscription');
  });

  it('billing subscription watch starts the API load before awaiting the client', () => {
    assertApiLoadStartsBeforeClientAwait('src/services/billing.ts', 'No VITE_CONVEX_URL -- skipping subscription watch');
  });

  it('no billing or followed-countries call awaits the client and then the API', () => {
    for (const rel of ['src/services/billing.ts', 'src/services/followed-countries.ts', 'src/services/entitlements.ts']) {
      assert.doesNotMatch(
        read(rel),
        /await (?:getConvexClient|_convexClientGetter)\(\);\s*\n\s*const api = await (?:getConvexApi|_convexApiGetter)\(\)/,
        `${rel}: load the Convex client and API together`,
      );
    }
  });
});

describe('country brief open', () => {
  it('getCountrySignals starts the aviation read before awaiting the aggregator chunk', () => {
    const body = functionContaining(read('src/app/country-intel.ts'), 'async getCountrySignals(');
    assertStartsBefore(
      body,
      'this.countryAviationDisruptions(code, country)',
      'await getSignalAggregator()',
      'the aviation fetch must not wait for the signal-aggregator chunk',
    );
  });

  it('country-brief-source loads its schemas alongside the network read', () => {
    const source = read('src/services/country-brief-source.ts');
    assert.doesNotMatch(source, /await import\('\.\.\/\.\.\/shared\/country-signal-observations'\)/);
    assert.doesNotMatch(source, /await import\('\.\.\/\.\.\/shared\/country-raw-signals'\)/);
  });
});

describe('app boot', () => {
  it('starts loading i18n before it waits for IndexedDB', () => {
    const body = functionContaining(read('src/App.ts'), "markLcpDebug('wm:boot:app-init-start');");
    assertStartsBefore(body, 'const i18nReady = initI18n();', 'await initDB();', 'the locale load must not wait for IndexedDB');
    assertStartsBefore(body, 'await initDB();', 'await i18nReady;', 'boot still waits for i18n after the database opens');
    assert.doesNotMatch(body, /await initI18n\(\)/);
  });
});

describe('request handlers', () => {
  it('chat-analyst resolves the routing policy alongside the context assembly', () => {
    const source = read('api/chat-analyst.ts');
    assert.doesNotMatch(source, /await assembleAnalystContext\(/, 'context assembly must not be awaited alone');
    assert.doesNotMatch(source, /await getAiRoutingDecisionForUser\(/, 'the routing lookup must not be awaited alone');
    assert.match(
      source,
      /Promise\.all\(\[\s*assembleAnalystContext\([^)]*\),\s*getAiRoutingDecisionForUser\(premiumIdentity\.userId\),?\s*\]\)/,
    );
  });

  it('classify-event hashes the title alongside the routing lookup', () => {
    const source = read('server/worldmonitor/intelligence/v1/classify-event.ts');
    assert.doesNotMatch(source, /const aiRouting = await resolveAiRouting\(ctx\.request\);\s*\n\s*const cacheKey = `\$\{await buildClassifyCacheKey/);
    assert.match(source, /Promise\.all\(\[\s*resolveAiRouting\(ctx\.request\),\s*buildClassifyCacheKey\(title\)/);
  });

  it('get-risk-scores reads its auxiliary fallbacks together', () => {
    const body = functionContaining(read('server/worldmonitor/intelligence/v1/get-risk-scores.ts'), 'async function fetchAuxiliarySources');
    assert.doesNotMatch(body, /\(await readRiskInputs\(\[\{ key: 'wildfire:fires:v1'/, 'the fires fallback must not wait for the displacement fallback');
    assert.doesNotMatch(body, /const borderSnapshots = await readRiskInputs\(/, 'the border reads must not wait for the fallbacks');
  });

  it('get-country-energy-profile reads the regional feeds with the seeds', () => {
    const source = read('server/worldmonitor/intelligence/v1/get-country-energy-profile.ts');
    assert.doesNotMatch(source, /const regionalEnergyFeeds = await readRegionalEnergyFeeds\(/);
    assert.match(source, /readRegionalEnergyFeeds\(code, getRawJson\),?\s*\]\)/);
  });
});
