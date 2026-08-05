// Tests for the three Pro-gated historical-intelligence RPCs (#5694):
//   POST /api/intelligence/v1/search-intel-history
//   GET /api/intelligence/v1/get-intel-timeline
//   POST /api/intelligence/v1/get-similar-events
//
// Two layers, mirroring the sibling suites:
//   - behavioural handler tests (fetch stubbed) modelled on
//     tests/china-decision-signals-handler.test.mts
//   - structural wiring assertions (proto → handler → registries) modelled on
//     tests/regional-snapshot-weekly-brief.test.mjs
//
// No network: every test stubs globalThis.fetch. Run via `npm run test:data`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

// The client resolves every environment variable at call time, so setting them
// here (module body runs after the import graph is evaluated, before any test
// callback) is sufficient.
process.env.CONVEX_SITE_URL = 'https://fake-convex.convex.site';
process.env.CONVEX_SERVER_SHARED_SECRET = 'test-shared-secret';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-upstash-token';

import { normalizeForEmbedding } from '../scripts/lib/brief-embedding.mjs';
import {
  EMBED_DIMS,
  OPENROUTER_EMBEDDINGS_URL,
} from '../scripts/lib/brief-dedup-consts.mjs';
import { normalizeQueryText } from '../server/_shared/intel-history-embed';
import { getIntelTimeline } from '../server/worldmonitor/intelligence/v1/get-intel-timeline';
import { getSimilarEvents } from '../server/worldmonitor/intelligence/v1/get-similar-events';
import { searchIntelHistory } from '../server/worldmonitor/intelligence/v1/search-intel-history';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const ctx = {} as never;

const CONVEX_SEARCH_URL = 'https://fake-convex.convex.site/api/internal-intel-search';
const CONVEX_TIMELINE_URL = 'https://fake-convex.convex.site/api/internal-intel-timeline';

// ── fetch harness ───────────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function vector(fill = 0.5): number[] {
  return new Array(EMBED_DIMS).fill(fill);
}

/**
 * Install a fetch stub that routes by URL. Each route is a function so a test
 * can throw (network failure) or return a non-ok Response.
 */
function stubFetch(routes: Record<string, (call: RecordedCall) => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const route = routes[url];
    if (!route && url.startsWith('https://fake-upstash.upstash.io/get/')) return jsonResponse({ result: null });
    if (!route && url === 'https://fake-upstash.upstash.io/') return jsonResponse({ result: 'OK' });
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return route(call);
  }) as typeof globalThis.fetch;
}

function embeddingsOk(): Response {
  return jsonResponse({ data: [{ index: 0, embedding: vector() }] });
}

const convexRecord = {
  id: 'doc-1',
  domain: 'conflict',
  resource: 'acled-events',
  country: 'UA',
  category: 'battle',
  title: 'Shelling near Kharkiv',
  summary: 'Sustained artillery fire reported overnight.',
  sourceUrl: 'https://example.test/a',
  occurredAt: 1_750_000_000_000,
  ingestedAt: 1_750_000_060_000,
  _score: 0.83,
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── normalization parity ────────────────────────────────────────────────────

describe('query-time normalization parity', () => {
  // The seed writer embeds normalizeForEmbedding(title + summary); the query
  // side must apply the identical transform or recall silently degrades.
  // normalizeForEmbedding itself lives in a node:crypto-importing module that
  // cannot load on the Vercel Edge runtime, so the edge copy is re-derived —
  // this test is the drift guard for that duplication.
  const fixtures = [
    'Shelling near Kharkiv',
    '  MULTIPLE   spaces\tand\ntabs  ',
    'Oil tanker seized in the Strait of Hormuz - Reuters',
    'Cyber incident at a utility — bbc.com',
    'Port strike in Rotterdam',
    '',
  ];

  for (const fixture of fixtures) {
    it(`matches normalizeForEmbedding for ${JSON.stringify(fixture)}`, () => {
      assert.equal(normalizeQueryText(fixture), normalizeForEmbedding(fixture));
    });
  }
});

// ── SearchIntelHistory ──────────────────────────────────────────────────────

// ── scope normalization ─────────────────────────────────────────────────────

describe('scope normalization', () => {
  // Convex compares scope values with eq against what the seeders wrote, so a
  // lower-case or padded country silently matches nothing — indistinguishable,
  // to the caller, from "we have no history for that country".
  it('upper-cases and trims country before querying', async () => {
    stubFetch({
      [CONVEX_TIMELINE_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    await getIntelTimeline(ctx, { domain: '', country: ' ua ', from: 0, to: 0, limit: 0 });

    const call = calls.find((c) => c.url === CONVEX_TIMELINE_URL);
    assert.equal(call?.body?.country, 'UA');
  });

  it('lower-cases and trims domain before querying', async () => {
    stubFetch({
      [CONVEX_TIMELINE_URL]: () => jsonResponse({ records: [] }),
    });

    await getIntelTimeline(ctx, { domain: ' Conflict ', country: '', from: 0, to: 0, limit: 0 });

    const call = calls.find((c) => c.url === CONVEX_TIMELINE_URL);
    assert.equal(call?.body?.domain, 'conflict');
  });

  it('rejects negative bounds before contacting Convex', async () => {
    stubFetch({ [CONVEX_TIMELINE_URL]: () => jsonResponse({ records: [] }) });
    await assert.rejects(getIntelTimeline(ctx, {
      domain: 'conflict',
      country: '',
      from: -86_400_000,
      to: 0,
      limit: 0,
    }), /from must be an integer/i);
    assert.equal(calls.length, 0);
  });

  // Whitespace must not satisfy the "at least one scope" requirement and then
  // match nothing downstream.
  it('rejects a whitespace-only scope as unscoped', async () => {
    stubFetch({});
    await assert.rejects(
      getIntelTimeline(ctx, { domain: '   ', country: '  ', from: 0, to: 0, limit: 0 }),
      /at least one of domain or country/i,
    );
    assert.equal(calls.length, 0, 'no upstream call for an unscoped read');
  });

  it('rejects invalid domains, countries, inverted bounds, and excessive limits', async () => {
    stubFetch({});
    const invalidRequests = [
      { domain: 'cyber', country: '', from: 0, to: 0, limit: 0 },
      { domain: 'conflict', country: 'U1', from: 0, to: 0, limit: 0 },
      { domain: 'conflict', country: '', from: 2, to: 1, limit: 0 },
      { domain: 'conflict', country: '', from: 0, to: 0, limit: 201 },
    ];
    for (const request of invalidRequests) {
      await assert.rejects(getIntelTimeline(ctx, request), (err: unknown) =>
        (err as { statusCode?: number }).statusCode === 400);
    }
    assert.equal(calls.length, 0);
  });
});

// ── embedding dimension parity ──────────────────────────────────────────────

describe('embedding dimension contract', () => {
  // Three independent literals must agree or the store silently breaks: the
  // seeder embeds at EMBED_DIMS, Convex validates against
  // INTEL_HISTORY_EMBED_DIMS, and the vector index is declared with a hardcoded
  // `dimensions:`. A mismatch is not a type error — it surfaces as every insert
  // being rejected at runtime, after deploy.
  it('pins EMBED_DIMS, INTEL_HISTORY_EMBED_DIMS, and the vector index together', () => {
    const convexSrc = readFileSync(resolve(root, 'convex/intelHistory.ts'), 'utf8');
    const convexDims = convexSrc.match(/INTEL_HISTORY_EMBED_DIMS\s*=\s*(\d+)/);
    assert.ok(convexDims, 'INTEL_HISTORY_EMBED_DIMS must be a numeric literal');
    assert.equal(Number(convexDims[1]), EMBED_DIMS);

    const schemaSrc = readFileSync(resolve(root, 'convex/schema.ts'), 'utf8');
    const indexBlock = schemaSrc.match(
      /vectorIndex\("by_embedding",\s*\{[\s\S]*?dimensions:\s*(\d+)/,
    );
    assert.ok(indexBlock, 'the by_embedding vector index must declare dimensions');
    assert.equal(Number(indexBlock[1]), EMBED_DIMS);
  });
});

// ── query-vector cache ──────────────────────────────────────────────────────

describe('query-vector cache', () => {
  // Every miss spends a paid OpenRouter call on an interactive request, so the
  // hit path has to actually skip the provider — and a cache entry that no
  // longer matches the index contract has to be ignored rather than forwarded
  // to Convex, which would reject it and surface as a false outage.
  const upstashGet = (key: string) =>
    `https://fake-upstash.upstash.io/get/${encodeURIComponent(key)}`;
  // The query text is hashed into the key, never stored verbatim — what an
  // analyst searches for must not be readable from a Redis key listing.
  const sha256Hex = async (text: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };
  const cacheKeyFor = async (text: string) =>
    `intel-history:embed:v1:openai/text-embedding-3-small:${EMBED_DIMS}:${await sha256Hex(normalizeQueryText(text))}`;

  it('serves a cached vector without calling the embeddings provider', async () => {
    const query = 'artillery strikes near Kharkiv';
    stubFetch({
      [upstashGet(await cacheKeyFor(query))]: () =>
        jsonResponse({ result: JSON.stringify(vector(0.25)) }),
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    const res = await searchIntelHistory(ctx, {
      query,
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(
      calls.filter((c) => c.url === OPENROUTER_EMBEDDINGS_URL).length,
      0,
      'a cache hit must not reach the embeddings provider',
    );
    const search = calls.find((c) => c.url === CONVEX_SEARCH_URL);
    assert.deepEqual(search?.body?.embedding, vector(0.25));
  });

  it('writes the provider vector back to the cache on a miss', async () => {
    const query = 'port strike in Rotterdam';
    // setCachedJson issues an atomic `SET key value EX ttl` as a command array
    // POSTed to the Upstash base URL (not a /set/ path), so match on that.
    const writes: unknown[][] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://fake-upstash.upstash.io/get/')) {
        return jsonResponse({ result: null });
      }
      if (url === 'https://fake-upstash.upstash.io/' && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)) as unknown[]);
        return jsonResponse({ result: 'OK' });
      }
      if (url === OPENROUTER_EMBEDDINGS_URL) return embeddingsOk();
      if (url === CONVEX_SEARCH_URL) return jsonResponse({ records: [] });
      throw new Error(`unstubbed fetch: ${url}`);
    }) as typeof globalThis.fetch;

    const res = await searchIntelHistory(ctx, {
      query,
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    const embedWrites = writes.filter((write) => String(write[1]).startsWith('intel-history:embed:'));
    assert.equal(embedWrites.length, 1, 'a miss must populate the embedding cache');
    const [verb, key, value, ex, ttl] = embedWrites[0] as string[];
    assert.equal(verb, 'SET');
    assert.equal(key, await cacheKeyFor(query), 'key carries hashed query, model, dimension');
    assert.ok(!key.includes('rotterdam'), 'raw query text must never appear in the cache key');
    assert.deepEqual(JSON.parse(value), vector());
    assert.equal(ex, 'EX');
    assert.equal(Number(ttl), 6 * 60 * 60);
  });

  it('re-embeds when the cached entry has the wrong dimension', async () => {
    const query = 'cyber incident at a utility';
    stubFetch({
      [upstashGet(await cacheKeyFor(query))]: () =>
        jsonResponse({ result: JSON.stringify([0.1, 0.2, 0.3]) }),
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [] }),
    });

    const res = await searchIntelHistory(ctx, {
      query,
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(
      calls.filter((c) => c.url === OPENROUTER_EMBEDDINGS_URL).length,
      1,
      'an unusable cache entry must fall through to the provider',
    );
    const search = calls.find((c) => c.url === CONVEX_SEARCH_URL);
    assert.equal((search?.body?.embedding as number[])?.length, EMBED_DIMS);
  });
});

describe('searchIntelHistory handler', () => {
  it('rejects missing or oversized query text before invoking paid upstreams', async () => {
    stubFetch({});
    await assert.rejects(searchIntelHistory(ctx, {
      query: '', domain: '', country: '', from: 0, to: 0, limit: 0,
    }), /query must be between/i);
    await assert.rejects(searchIntelHistory(ctx, {
      query: 'x'.repeat(501), domain: '', country: '', from: 0, to: 0, limit: 0,
    }), /query must be between/i);
    assert.equal(calls.length, 0);
  });
  it('embeds the query and maps Convex records onto the proto shape', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes near Kharkiv',
      domain: 'conflict',
      country: 'UA',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.query, 'artillery strikes near Kharkiv');
    assert.equal(res.records.length, 1);
    assert.deepEqual(res.records[0], {
      id: 'doc-1',
      domain: 'conflict',
      resource: 'acled-events',
      country: 'UA',
      category: 'battle',
      title: 'Shelling near Kharkiv',
      summary: 'Sustained artillery fire reported overnight.',
      sourceUrl: 'https://example.test/a',
      occurredAt: 1_750_000_000_000,
      ingestedAt: 1_750_000_060_000,
      score: 0.83,
    });
  });

  it('sends the shared secret and the resolved scope to the Convex search route', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [] }),
    });

    await searchIntelHistory(ctx, {
      query: 'grain corridor disruption',
      domain: 'conflict',
      country: 'UA',
      from: 1_700_000_000_000,
      to: 1_760_000_000_000,
      limit: 5,
    });

    const convexCall = calls.find((c) => c.url === CONVEX_SEARCH_URL);
    assert.ok(convexCall, 'expected a Convex search call');
    assert.equal(convexCall.method, 'POST');
    assert.equal(convexCall.headers['x-convex-shared-secret'], 'test-shared-secret');
    assert.deepEqual(convexCall.body, {
      embedding: vector(),
      domain: 'conflict',
      country: 'UA',
      from: 1_700_000_000_000,
      to: 1_760_000_000_000,
      limit: 5,
    });
  });

  it('defaults limit to 20 and rejects values above 64', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [] }),
    });

    await searchIntelHistory(ctx, { query: 'ab', domain: '', country: '', from: 0, to: 0, limit: 0 });
    assert.equal(calls.find((c) => c.url === CONVEX_SEARCH_URL)?.body?.limit, 20);

    calls = [];
    await assert.rejects(
      searchIntelHistory(ctx, { query: 'ab', domain: '', country: '', from: 0, to: 0, limit: 999 }),
      /limit must be an integer/i,
    );
  });

  it('omits empty optional scope fields from the Convex body', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [] }),
    });

    await searchIntelHistory(ctx, { query: 'anything', domain: '', country: '', from: 0, to: 0, limit: 3 });

    assert.deepEqual(Object.keys(calls.find((c) => c.url === CONVEX_SEARCH_URL)?.body ?? {}).sort(), [
      'embedding',
      'limit',
    ]);
  });

  it('reports upstreamUnavailable when the embeddings provider fails', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: () => jsonResponse({ error: 'nope' }, 502),
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
    // The Convex read must never run on an embedding failure — a zero vector
    // would return arbitrary "most similar" rows presented as real matches.
    assert.equal(calls.some((c) => c.url === CONVEX_SEARCH_URL), false);
  });

  it('reports upstreamUnavailable when the Convex read is non-ok', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ error: 'UNAUTHORIZED' }, 401),
    });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });

  it('reports upstreamUnavailable when the Convex read throws (timeout/network)', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });

  it('rejects a wrong-dimension embedding rather than sending it to Convex', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.equal(calls.some((c) => c.url === CONVEX_SEARCH_URL), false);
  });
});

// ── GetIntelTimeline ────────────────────────────────────────────────────────

describe('getIntelTimeline handler', () => {
  it('reads Convex chronologically without paying for an embedding', async () => {
    const { _score, ...timelineRecord } = convexRecord;
    stubFetch({
      [CONVEX_TIMELINE_URL]: () => jsonResponse({ records: [timelineRecord] }),
    });

    const res = await getIntelTimeline(ctx, {
      domain: 'conflict',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.records.length, 1);
    // No similarity applies to a chronological read.
    assert.equal(res.records[0]?.score, 0);
    const convexCall = calls.find((call) => call.url === CONVEX_TIMELINE_URL);
    assert.equal(convexCall?.headers['x-convex-shared-secret'], 'test-shared-secret');
    assert.deepEqual(convexCall?.body, { domain: 'conflict', limit: 50 });
  });

  it('rejects an unscoped read with a 400-class ApiError before any upstream call', async () => {
    stubFetch({});

    await assert.rejects(
      () => getIntelTimeline(ctx, { domain: '', country: '', from: 0, to: 0, limit: 0 }),
      (err: unknown) => {
        assert.equal((err as { statusCode?: number }).statusCode, 400);
        assert.match((err as Error).message, /domain|country/i);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it('accepts a country-only scope', async () => {
    stubFetch({ [CONVEX_TIMELINE_URL]: () => jsonResponse({ records: [] }) });

    await getIntelTimeline(ctx, { domain: '', country: 'UA', from: 0, to: 0, limit: 0 });
    assert.deepEqual(calls.find((call) => call.url === CONVEX_TIMELINE_URL)?.body, { country: 'UA', limit: 50 });
  });

  it('defaults limit to 50 and rejects values above 200', async () => {
    stubFetch({ [CONVEX_TIMELINE_URL]: () => jsonResponse({ records: [] }) });

    await getIntelTimeline(ctx, { domain: 'energy', country: '', from: 0, to: 0, limit: 0 });
    assert.equal(calls.find((call) => call.url === CONVEX_TIMELINE_URL)?.body?.limit, 50);

    calls = [];
    await assert.rejects(
      getIntelTimeline(ctx, { domain: 'energy', country: '', from: 0, to: 0, limit: 5_000 }),
      /limit must be an integer/i,
    );
  });

  it('reports upstreamUnavailable when the Convex read is non-ok', async () => {
    stubFetch({ [CONVEX_TIMELINE_URL]: () => jsonResponse({ error: 'MISSING_SCOPE' }, 400) });

    const res = await getIntelTimeline(ctx, {
      domain: 'energy',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });
    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });
});

// ── GetSimilarEvents ────────────────────────────────────────────────────────

describe('getSimilarEvents handler', () => {
  it('rejects missing or oversized situation text before invoking paid upstreams', async () => {
    stubFetch({});
    await assert.rejects(getSimilarEvents(ctx, {
      situation: 'short', domain: '', country: '', limit: 0,
    }), /situation must be between/i);
    await assert.rejects(getSimilarEvents(ctx, {
      situation: 'x'.repeat(1001), domain: '', country: '', limit: 0,
    }), /situation must be between/i);
    assert.equal(calls.length, 0);
  });
  it('embeds the situation text and echoes it back with the matches', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    const situation = 'A naval blockade closes a major grain export corridor for several weeks.';
    const res = await getSimilarEvents(ctx, { situation, domain: '', country: '', limit: 0 });

    assert.equal(res.situation, situation);
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.records.length, 1);
    assert.equal(res.records[0]?.score, 0.83);
    // Default limit is 10 — half of search's default, since precedent lookups
    // are read by a human or an LLM rather than scrolled.
    assert.equal(calls.find((c) => c.url === CONVEX_SEARCH_URL)?.body?.limit, 10);
    assert.equal(calls.find((c) => c.url === CONVEX_SEARCH_URL)?.body?.minScore, 0.55);
  });

  it('rejects limits above 32', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [] }),
    });

    await assert.rejects(getSimilarEvents(ctx, {
      situation: 'A naval blockade closes a grain export corridor.',
      domain: '',
      country: '',
      limit: 512,
    }), /limit must be an integer/i);
  });

  it('reports upstreamUnavailable when the embeddings provider fails', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: () => {
        throw new TypeError('fetch failed');
      },
      [CONVEX_SEARCH_URL]: () => jsonResponse({ records: [convexRecord] }),
    });

    const res = await getSimilarEvents(ctx, {
      situation: 'A naval blockade closes a grain export corridor.',
      domain: '',
      country: '',
      limit: 0,
    });
    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });
});

// ── Structural wiring ───────────────────────────────────────────────────────

const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf-8');

const serviceProtoSrc = read('proto/worldmonitor/intelligence/v1/service.proto');
const recordProtoSrc = read('proto/worldmonitor/intelligence/v1/intel_history_record.proto');
const searchProtoSrc = read('proto/worldmonitor/intelligence/v1/search_intel_history.proto');
const timelineProtoSrc = read('proto/worldmonitor/intelligence/v1/get_intel_timeline.proto');
const similarProtoSrc = read('proto/worldmonitor/intelligence/v1/get_similar_events.proto');
const handlerIndexSrc = read('server/worldmonitor/intelligence/v1/handler.ts');
const premiumPathsSrc = read('src/shared/premium-paths.ts');
const entitlementSrc = read('server/_shared/entitlement-check.ts');
const gatewaySrc = read('server/gateway.ts');
const rateLimitSrc = read('server/_shared/rate-limit.ts');
const openApiJson = JSON.parse(read('docs/api/IntelligenceService.openapi.json')) as {
  paths: Record<string, Record<string, unknown>>;
};

const RPCS = [
  {
    rpc: 'SearchIntelHistory',
    file: 'search_intel_history',
    path: '/api/intelligence/v1/search-intel-history',
  },
  {
    rpc: 'GetIntelTimeline',
    file: 'get_intel_timeline',
    path: '/api/intelligence/v1/get-intel-timeline',
  },
  {
    rpc: 'GetSimilarEvents',
    file: 'get_similar_events',
    path: '/api/intelligence/v1/get-similar-events',
  },
] as const;

describe('proto definitions', () => {
  it('defines the shared IntelHistoryRecord once', () => {
    assert.match(recordProtoSrc, /message IntelHistoryRecord/);
    assert.match(recordProtoSrc, /int64 occurred_at = 9 \[\(sebuf\.http\.int64_encoding\) = INT64_ENCODING_NUMBER\]/);
    assert.match(recordProtoSrc, /int64 ingested_at = 10 \[\(sebuf\.http\.int64_encoding\) = INT64_ENCODING_NUMBER\]/);
    assert.match(recordProtoSrc, /double score = 11/);
    // Defined once, reused by all three request files (satellite.proto pattern).
    assert.equal(/message IntelHistoryRecord/.test(searchProtoSrc), false);
    for (const src of [searchProtoSrc, timelineProtoSrc, similarProtoSrc]) {
      assert.match(src, /import "worldmonitor\/intelligence\/v1\/intel_history_record\.proto"/);
    }
  });

  for (const { rpc, file } of RPCS) {
  it(`declares ${rpc} in service.proto`, () => {
      assert.match(
        serviceProtoSrc,
        new RegExp(`rpc ${rpc}\\(${rpc}Request\\) returns \\(${rpc}Response\\)`),
      );
      assert.match(serviceProtoSrc, new RegExp(`import "worldmonitor/intelligence/v1/${file}\\.proto"`));
    });
  }

  it('signals upstream failure with a declared proto field, not an out-of-band cast', () => {
    for (const src of [searchProtoSrc, timelineProtoSrc, similarProtoSrc]) {
      assert.match(src, /bool upstream_unavailable = \d+/);
    }
  });

  it('constrains the free-text inputs', () => {
    assert.match(searchProtoSrc, /\(buf\.validate\.field\)\.string\.min_len = 2/);
    assert.match(searchProtoSrc, /\(buf\.validate\.field\)\.string\.max_len = 500/);
    assert.match(similarProtoSrc, /\(buf\.validate\.field\)\.string\.min_len = 10/);
    assert.match(similarProtoSrc, /\(buf\.validate\.field\)\.string\.max_len = 1000/);
  });

  it('caps limit at the ceilings convex/intelHistory.ts enforces', () => {
    assert.match(searchProtoSrc, /\(buf\.validate\.field\)\.int32\.lte = 64/);
    assert.match(timelineProtoSrc, /\(buf\.validate\.field\)\.int32\.lte = 200/);
    assert.match(similarProtoSrc, /\(buf\.validate\.field\)\.int32\.lte = 32/);
  });
});

describe('handler registration', () => {
  it('registers all three handlers in handler.ts', () => {
    for (const name of ['searchIntelHistory', 'getIntelTimeline', 'getSimilarEvents']) {
      assert.match(handlerIndexSrc, new RegExp(`import \\{ ${name} \\} from`));
      assert.match(handlerIndexSrc, new RegExp(`\\s+${name},`));
    }
  });
});

describe('gateway wiring', () => {
  for (const { path } of RPCS) {
    it(`gates ${path} behind Pro in both registries`, () => {
      assert.match(premiumPathsSrc, new RegExp(`'${path}'`));
      assert.match(entitlementSrc, new RegExp(`'${path}': 1`));
    });
  }

  it('assigns the GET timeline route a slow gateway cache tier', () => {
    assert.match(
      gatewaySrc,
      /'\/api\/intelligence\/v1\/get-intel-timeline':\s*'slow'/,
    );
  });

  it('does not register POST semantic reads in the GET-only gateway cache tier map', () => {
    for (const path of [
      '/api/intelligence/v1/search-intel-history',
      '/api/intelligence/v1/get-similar-events',
    ]) {
      assert.doesNotMatch(gatewaySrc, new RegExp(`'${path}':\\s*'slow'`));
    }
  });

  it('fails closed on the two embedding-backed routes', () => {
    for (const path of [
      '/api/intelligence/v1/search-intel-history',
      '/api/intelligence/v1/get-similar-events',
    ]) {
      const policyIdx = rateLimitSrc.indexOf('export const ENDPOINT_RATE_POLICIES');
      const failClosedIdx = rateLimitSrc.indexOf('export const FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED');
      assert.ok(rateLimitSrc.slice(policyIdx, failClosedIdx).includes(`'${path}'`), `${path} needs an endpoint policy`);
      assert.ok(rateLimitSrc.slice(failClosedIdx).includes(`'${path}'`), `${path} needs a fail-closed requirement`);
    }
  });
});

describe('generated OpenAPI', () => {
  for (const { path } of RPCS) {
  it(`publishes the expected method for ${path}`, () => {
      assert.ok(openApiJson.paths[path], `${path} missing from IntelligenceService.openapi.json`);
      const method = path.includes('search-intel-history') || path.includes('get-similar-events') ? 'post' : 'get';
      assert.ok(openApiJson.paths[path]?.[method], `${path} must be a ${method.toUpperCase()} operation`);
    });
  }
});
