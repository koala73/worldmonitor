// Tool-level coverage for the #5697 on-demand NLP utilities:
// classify_event, extract_entities, get_news_clusters, get_keyword_spikes.
// Follows the get_procurement_opportunities template: import the real edge
// handler, inject Pro deps, and mock only the network edges (canonical API
// fetches + Upstash REST for the spike tool).
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HMAC_SECRET,
  callBody,
  makeProDeps,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const FAKE_UPSTASH = 'https://fake-upstash.test';

const classifyResponse = {
  classification: {
    category: 'conflict',
    subcategory: 'critical',
    severity: 'SEVERITY_LEVEL_HIGH',
    confidence: 0.9,
    analysis: '',
    entities: [],
  },
};

const digestResponse = {
  generatedAt: '2026-07-28T12:00:00.000Z',
  feedStatuses: { Reuters: 'ok', 'AP News': 'ok', BleepingComputer: 'ok' },
  categories: {
    politics: {
      items: [
        { source: 'Reuters', title: 'Iran closes Strait of Hormuz to all tanker traffic', link: 'https://n/1', publishedAt: 1785405600000, isAlert: true, threat: { level: 'THREAT_LEVEL_CRITICAL', category: 'conflict', confidence: 0.9, source: 'llm' } },
        { source: 'AP News', title: 'Iran closes Strait of Hormuz, tanker traffic halted', link: 'https://n/2', publishedAt: 1785405900000, isAlert: false, credibilityScore: 73, threat: { level: 'THREAT_LEVEL_HIGH', category: 'conflict', confidence: 0.8, source: 'keyword' } },
      ],
    },
    tech: {
      items: [
        { source: 'BleepingComputer', title: 'CVE-2026-12345 exploited by APT28 against Microsoft cloud tenants', link: 'https://n/3', publishedAt: 1785406000000, isAlert: false, threat: { level: 'THREAT_LEVEL_MEDIUM', category: 'cyber', confidence: 0.7, source: 'keyword' } },
        // Duplicate of the politics item — the digest adapter must dedupe by link.
        { source: 'Reuters', title: 'Iran closes Strait of Hormuz to all tanker traffic', link: 'https://n/1', publishedAt: 1785405600000, isAlert: true },
      ],
    },
  },
};

// Emulates the real Upstash semantics rather than echoing fixtures back: a
// mock that ignores ZRANGE's arguments would stay green through a max/min
// swap (the natural ZRANGEBYSCORE-order mistake) that returns empty forever
// against real Redis.
function upstashPipelineResponder(commands, state) {
  const first = commands[0]?.[0];
  if (first === 'ZRANGE') {
    return commands.map((command) => {
      const [, key, max, min, byscore, rev, withscores, limitKw, offset, count] = command;
      assert.equal(key, 'digest:accumulator:v1:full:en');
      assert.deepEqual([byscore, rev, withscores, limitKw], ['BYSCORE', 'REV', 'WITHSCORES', 'LIMIT']);
      assert.equal(offset, '0');
      assert.equal(count, '800', 'each accumulator cohort must have an explicit fixed cap');
      assert.ok(Number(max) >= Number(min), 'REV BYSCORE takes max before min; swapped bounds return empty on real Redis');
      const maxScore = Number(max);
      const minScore = Number(min);
      const cap = Number(count);
      const pairs = [];
      for (let i = 0; i + 1 < state.zrangeFlat.length; i += 2) {
        const score = Number(state.zrangeFlat[i + 1]);
        if (score >= minScore && score <= maxScore) pairs.push([state.zrangeFlat[i], state.zrangeFlat[i + 1]]);
      }
      pairs.sort((a, b) => Number(b[1]) - Number(a[1])); // REV: newest first
      return { result: pairs.slice(0, cap).flat() };
    });
  }
  if (first === 'HMGET') {
    return commands.map((cmd) => {
      assert.deepEqual(cmd.slice(2), ['title', 'link'], 'HMGET must request title and link');
      const hash = String(cmd[1]).replace('story:track:v1:', '');
      return { result: [state.titlesByHash.get(hash) ?? null, state.linksByHash.get(hash) ?? null] };
    });
  }
  if (first === 'SMEMBERS') {
    return commands.map((cmd) => {
      const hash = String(cmd[1]).replace('story:sources:v1:', '');
      return { result: state.sourcesByHash.get(hash) ?? [] };
    });
  }
  if (first === 'SET') {
    state.storedPayloads.set(commands[0][1], commands[0][2]);
    return [{ result: 'OK' }];
  }
  return commands.map(() => ({ result: null }));
}

describe('#5697 NLP MCP tools', () => {
  let mcpHandler;
  let requests;
  let upstashState;
  let pipelineCalls;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = FAKE_UPSTASH;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    requests = [];
    pipelineCalls = 0;
    upstashState = {
      zrangeFlat: [],
      titlesByHash: new Map(),
      linksByHash: new Map(),
      sourcesByHash: new Map(),
      storedPayloads: new Map(),
      // Command verbs whose pipelines should fail (partial-outage simulation).
      failCommands: new Set(),
      pipelineReplyTransforms: new Map(),
    };

    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith(FAKE_UPSTASH)) {
        if (url.includes('/pipeline')) {
          const commands = JSON.parse(init.body);
          if (upstashState.failCommands.has(commands[0]?.[0])) {
            return new Response('upstash unavailable', { status: 500 });
          }
          // Count only spike-tool I/O; the per-minute limiter's evalsha rides
          // the same mocked endpoint and must not trip the cache assertions.
          if (['ZRANGE', 'HMGET', 'SMEMBERS', 'SET'].includes(commands[0]?.[0])) {
            pipelineCalls += 1;
          }
          const normalReply = upstashPipelineResponder(commands, upstashState);
          const transform = upstashState.pipelineReplyTransforms.get(commands[0]?.[0]);
          return Response.json(transform ? transform(normalReply) : normalReply);
        }
        // GET /get/<key>
        if (upstashState.failCacheRead) return new Response('upstash unavailable', { status: 500 });
        const key = decodeURIComponent(url.slice(`${FAKE_UPSTASH}/get/`.length));
        const stored = upstashState.storedPayloads.get(key) ?? null;
        return Response.json({ result: stored });
      }
      requests.push({ url, init });
      if (url.includes('/api/intelligence/v1/classify-event')) {
        return Response.json(classifyResponse);
      }
      if (url.includes('/api/news/v1/list-feed-digest')) {
        return Response.json(digestResponse);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const mod = await import(`../api/mcp.ts?nlp=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  async function callTool(name, args = {}, depsOverrides = {}) {
    const { deps, pipe } = makeProDeps(depsOverrides);
    const response = await mcpHandler(proReq('POST', callBody(name, args)), deps);
    const body = await response.json();
    const result = body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text) : null;
    return { response, body, result, pipe };
  }

  async function withDigestCategories(
    categories,
    run,
    feedStatuses = { fixture: 'empty' },
    coverage = undefined,
  ) {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/api/news/v1/list-feed-digest')) {
        requests.push({ url, init });
        return Response.json({
          generatedAt: '2026-07-28T12:00:00.000Z',
          feedStatuses,
          categories,
          ...(coverage ? { coverage } : {}),
        });
      }
      return previousFetch(input, init);
    };
    try {
      return await run();
    } finally {
      globalThis.fetch = previousFetch;
    }
  }

  it('lists all four tools with their caps in tools/list', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tools = (await listed.json()).result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get('classify_event')?.inputSchema.properties.text.maxLength, 500);
    assert.deepEqual(byName.get('classify_event')?.inputSchema.required, ['text']);
    assert.equal(byName.get('extract_entities')?.inputSchema.properties.text.maxLength, 2048);
    assert.equal(byName.get('extract_entities')?.inputSchema.properties.category.type, 'string');
    assert.ok(
      byName.get('extract_entities')?.inputSchema.properties.category.enum?.includes('commodities'),
      'extract_entities category enum must include commodities',
    );
    assert.ok(
      byName.get('extract_entities')?.inputSchema.properties.category.enum?.includes('intel'),
      'extract_entities category enum must include intel',
    );
    assert.deepEqual(
      byName.get('extract_entities')?.inputSchema.properties.variant.enum,
      ['full', 'tech'],
    );
    assert.ok(
      byName.get('extract_entities')?.inputSchema.properties.category.enum?.includes('vcblogs'),
      'extract_entities category enum must include Tech-only buckets',
    );
    assert.equal(byName.get('get_news_clusters')?.inputSchema.properties.limit.maximum, 25);
    assert.equal(byName.get('get_news_clusters')?.inputSchema.properties.category.type, 'string');
    assert.ok(
      byName.get('get_news_clusters')?.inputSchema.properties.category.enum?.includes('commodities'),
      'get_news_clusters category enum must include commodities',
    );
    assert.ok(
      byName.get('get_news_clusters')?.inputSchema.properties.category.enum?.includes('intel'),
      'get_news_clusters category enum must include intel',
    );
    assert.deepEqual(
      byName.get('get_news_clusters')?.inputSchema.properties.variant.enum,
      ['full', 'tech'],
    );
    assert.ok(
      byName.get('get_news_clusters')?.inputSchema.properties.category.enum?.includes('accelerators'),
      'get_news_clusters category enum must include Tech-only buckets',
    );
    const clusterSchema = byName.get('get_news_clusters')?.outputSchema.properties.clusters.items;
    assert.ok(clusterSchema.required.includes('primarySourceProvenance'));
    assert.ok(clusterSchema.required.includes('sourceProvenance'));
    assert.ok(clusterSchema.required.includes('credibilityScore'));
    assert.equal(clusterSchema.properties.credibilityScore.type, 'number');
    assert.equal(clusterSchema.properties.primarySourceProvenance.type, 'object');
    assert.equal(clusterSchema.properties.sourceProvenance.type, 'array');
    assert.equal(clusterSchema.properties.sourceProvenance.items.properties.source.type, 'string');
    assert.equal(clusterSchema.properties.sourceProvenance.items.properties.risk.type, 'string');
    assert.equal(clusterSchema.properties.sourceProvenance.items.properties.stateAffiliated.type, 'string');
    const digestCoverageFields = [
      'state',
      'servedItems',
      'servedPublishers',
      'feedsCompleted',
      'feedsTotal',
      'categoriesCompleted',
      'categoriesTotal',
      'missingCategories',
      'stale',
    ];
    for (const toolName of ['extract_entities', 'get_news_clusters']) {
      const coverageSchema = byName.get(toolName)?.outputSchema.properties.digestCoverage;
      assert.equal(coverageSchema?.type, 'object', `${toolName} must advertise digestCoverage`);
      assert.equal(coverageSchema?.additionalProperties, false);
      assert.deepEqual(coverageSchema?.required, digestCoverageFields);
      assert.deepEqual(
        coverageSchema?.properties.state.enum,
        ['complete', 'partial', 'stale', 'unavailable'],
      );
      assert.equal(coverageSchema?.properties.servedItems.type, 'integer');
      assert.equal(coverageSchema?.properties.servedPublishers.type, 'integer');
      assert.equal(coverageSchema?.properties.missingCategories.items.type, 'string');
      assert.equal(coverageSchema?.properties.stale.type, 'boolean');
    }
    assert.equal(byName.get('get_keyword_spikes')?.inputSchema.properties.window_hours.maximum, 12);
    const classifyOutput = byName.get('classify_event')?.outputSchema;
    assert.deepEqual(classifyOutput.properties.classification.required,
      ['category', 'level', 'severity', 'confidence']);
    assert.deepEqual(classifyOutput.properties.classification.properties.category.enum,
      ['conflict', 'protest', 'disaster', 'diplomatic', 'economic', 'terrorism', 'cyber',
        'health', 'environmental', 'military', 'crime', 'infrastructure', 'tech', 'general']);
    assert.deepEqual(classifyOutput.properties.classification.properties.level.enum,
      ['critical', 'high', 'medium', 'low', 'info']);
    assert.deepEqual(classifyOutput.properties.classification.properties.severity.enum,
      ['SEVERITY_LEVEL_HIGH', 'SEVERITY_LEVEL_MEDIUM', 'SEVERITY_LEVEL_LOW']);
    const spikeOutput = byName.get('get_keyword_spikes')?.outputSchema;
    assert.ok(
      spikeOutput.required.includes('sample_truncated'),
      'sample_truncated must be required on every get_keyword_spikes response',
    );
    assert.deepEqual(spikeOutput.properties.spikes.items.required,
      ['term', 'count', 'baseline', 'multiplier', 'uniqueSources', 'sourceNames', 'sampleHeadlines']);
    const sampleSchema = spikeOutput.properties.spikes.items.properties.sampleHeadlines;
    assert.equal(sampleSchema.items.type, 'object');
    assert.deepEqual(sampleSchema.items.required, ['title', 'source', 'link']);
    assert.equal(spikeOutput.properties.spikes.items.properties.sourceNames.type, 'array');
    assert.equal(spikeOutput.properties.spikes.items.properties.sourceNames.items.type, 'string');
    const { result: described } = await callTool('describe_tool', { tool_name: 'get_keyword_spikes' });
    assert.match(
      described?.description ?? '',
      /sourceNames/,
      'uncompressed description must mention the attributed sourceNames field',
    );
    assert.match(
      described?.description ?? '',
      /title, source, link/,
      'uncompressed description must describe the attributed sample headline shape',
    );
    const listedSpike = byName.get('get_keyword_spikes');
    assert.match(
      listedSpike?.description ?? '',
      /sourceNames/,
      'tools/list compressed description must still name sourceNames',
    );
    assert.match(
      listedSpike?.description ?? '',
      /title, source, link/,
      'tools/list compressed description must still name the sample shape',
    );
  });

  it('projects complete digest coverage through both digest-backed tools', async () => {
    const coverage = {
      state: 'complete',
      itemsServed: 3,
      publisherCount: 3,
      feedCompleted: 3,
      feedTotal: 3,
      categoryCompleted: 2,
      categoryTotal: 2,
      categoryStates: { politics: 'ok', tech: 'ok' },
    };
    const expected = {
      state: 'complete',
      servedItems: 3,
      servedPublishers: 3,
      feedsCompleted: 3,
      feedsTotal: 3,
      categoriesCompleted: 2,
      categoriesTotal: 2,
      missingCategories: [],
      stale: false,
    };

    await withDigestCategories(
      digestResponse.categories,
      async () => {
        for (const toolName of ['extract_entities', 'get_news_clusters']) {
          const { body, result } = await callTool(toolName, {});
          assert.equal(body.error, undefined, `${toolName} must return a normal tool result`);
          assert.deepEqual(result.digestCoverage, expected);
        }
      },
      digestResponse.feedStatuses,
      coverage,
    );
  });

  it('returns explicit unavailable coverage as a normal empty result for both tools', async () => {
    const coverage = {
      state: 'unavailable',
      itemsServed: 0,
      publisherCount: 0,
      feedCompleted: 0,
      feedTotal: 4,
      categoryCompleted: 0,
      categoryTotal: 1,
      categoryStates: { accelerators: 'missing' },
    };
    const expected = {
      state: 'unavailable',
      servedItems: 0,
      servedPublishers: 0,
      feedsCompleted: 0,
      feedsTotal: 4,
      categoriesCompleted: 0,
      categoriesTotal: 1,
      missingCategories: ['accelerators'],
      stale: false,
    };

    await withDigestCategories(
      {},
      async () => {
        const entities = await callTool('extract_entities', {
          variant: 'tech',
          category: 'accelerators',
        });
        assert.equal(entities.body.error, undefined);
        assert.equal(entities.result.mode, 'headlines');
        assert.equal(entities.result.headlineCount, 0);
        assert.deepEqual(entities.result.entities, []);
        assert.deepEqual(entities.result.patternEntities, []);
        assert.equal(entities.result.note, undefined);
        assert.deepEqual(entities.result.digestCoverage, expected);

        const clusters = await callTool('get_news_clusters', {
          variant: 'tech',
          category: 'accelerators',
        });
        assert.equal(clusters.body.error, undefined);
        assert.equal(clusters.result.headlineCount, 0);
        assert.equal(clusters.result.totalClusters, 0);
        assert.deepEqual(clusters.result.clusters, []);
        assert.equal(clusters.result.note, undefined);
        assert.deepEqual(clusters.result.digestCoverage, expected);
      },
      {},
      coverage,
    );
  });

  it('keeps empty malformed coverage on the retryable source-outage path', async () => {
    await withDigestCategories(
      {},
      async () => {
        for (const toolName of ['extract_entities', 'get_news_clusters']) {
          const { body, result } = await callTool(toolName, { variant: 'tech' });
          assert.equal(result, null);
          assert.equal(body.error?.code, -32003);
          assert.equal(body.error?.data?.retryable, true);
          assert.deepEqual(body.error?.data?.unavailable_inputs, ['news:digest:v1:tech:en']);
        }
      },
      {},
      { state: 'unknown' },
    );
  });

  describe('classify_event', () => {
    it('proxies the canonical route and maps subcategory to level', async () => {
      const { response, result, pipe } = await callTool('classify_event', { text: 'Iran closes Strait of Hormuz' });
      assert.equal(response.status, 200);
      const requestUrl = new URL(requests[0].url);
      assert.equal(requestUrl.pathname, '/api/intelligence/v1/classify-event');
      assert.equal(requestUrl.searchParams.get('title'), 'Iran closes Strait of Hormuz');
      assert.ok(requests[0].init.headers['X-WM-MCP-Internal'], 'internal entitlement identity required');
      assert.deepEqual(result.classification, {
        category: 'conflict', level: 'critical', severity: 'SEVERITY_LEVEL_HIGH', confidence: 0.9,
      });
      assert.equal(pipe.count, 1, 'classify_event must consume the daily quota reservation');
    });

    it('rejects missing and oversized text without reaching the route', async () => {
      const missing = await callTool('classify_event', {});
      assert.match(missing.result.error, /text is required/);
      assert.equal(missing.result.classification, null, 'error envelopes keep the required member present');
      const oversized = await callTool('classify_event', { text: 'x'.repeat(501) });
      assert.match(oversized.result.error, /500-character limit/);
      assert.equal(oversized.result.classification, null);
      assert.equal(requests.length, 0, 'validation failures must not fetch');
    });

    it('returns a null classification when the classifier declines', async () => {
      const originalFetchImpl = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/intelligence/v1/classify-event')) {
          requests.push({ url, init });
          return Response.json({});
        }
        return originalFetchImpl(input, init);
      };
      try {
        const { result } = await callTool('classify_event', { text: 'Unclassifiable filler headline' });
        assert.equal(result.classification, null, 'the documented declined-classification contract');
        assert.equal('error' in result, false, 'a declined classification is not a tool error');
      } finally {
        globalThis.fetch = originalFetchImpl;
      }
    });

    it('returns a null classification for invalid or incomplete upstream labels', async () => {
      const originalFetchImpl = globalThis.fetch;
      const upstreamPayloads = [
        { classification: { ...classifyResponse.classification, category: 'unknown' } },
        { classification: { category: 'conflict', subcategory: 'critical' } },
      ];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/intelligence/v1/classify-event')) {
          requests.push({ url, init });
          return Response.json(upstreamPayloads.shift());
        }
        return originalFetchImpl(input, init);
      };
      try {
        for (const text of ['Unknown category', 'Partial classifier payload']) {
          const { result } = await callTool('classify_event', { text });
          assert.equal(result.classification, null);
        }
      } finally {
        globalThis.fetch = originalFetchImpl;
      }
    });

    it('is outside the free allowance entirely — it fetches downstream (#6716)', async () => {
      // classify_event routes through server/gateway.ts, whose own
      // checkProMcpAccess re-check refuses a free entitlement. Charging an
      // allowance slot here would spend one of five daily calls on a gateway
      // 401, so the refusal happens first — before the meter and before any
      // upstream request.
      const { response, body } = await callTool('classify_event', { text: 'headline' }, {
        getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 }),
      });
      assert.equal(response.status, 403);
      assert.equal(body.error.code, -32002);
      assert.equal(body.error.data?.reason, 'upgrade-required');
      assert.ok(body.error.data?.upgradeUrl);
      assert.equal(requests.length, 0, 'no upstream request');
    });
  });

  describe('extract_entities', () => {
    it('extracts registry + pattern entities from supplied text without any fetch', async () => {
      const { result } = await callTool('extract_entities', {
        text: 'CVE-2026-12345 exploited by APT28 against Microsoft cloud tenants, Putin briefed',
      });
      assert.equal(result.mode, 'text');
      const ids = result.entities.map((e) => e.entityId);
      assert.ok(ids.includes('MSFT'), `expected MSFT in ${ids.join(', ')}`);
      const patterns = result.patternEntities.map((p) => `${p.kind}:${p.value}`);
      assert.ok(patterns.includes('cve:CVE-2026-12345'));
      assert.ok(patterns.includes('apt:APT28'));
      assert.ok(patterns.includes('leader:putin'));
      assert.equal(requests.length, 0, 'text mode must not fetch the digest');
    });

    it('rejects oversized text and non-string text while honoring its own outputSchema', async () => {
      for (const args of [{ text: 'y'.repeat(2049) }, { text: 42 }]) {
        const { result } = await callTool('extract_entities', args);
        assert.ok(result.error, `expected a validation error for ${JSON.stringify(args)}`);
        // outputSchema declares mode/entities/patternEntities required — a bare
        // {error} envelope breaks schema-validating agent clients.
        assert.equal(result.mode, 'text');
        assert.deepEqual(result.entities, []);
        assert.deepEqual(result.patternEntities, []);
      }
      assert.equal(requests.length, 0);
    });

    it('honors a non-default limit in text mode', async () => {
      const { result } = await callTool('extract_entities', {
        text: 'Microsoft, Apple, Nvidia, Google and Amazon brief Putin on CVE-2026-1111 and CVE-2026-2222',
        limit: 2,
      });
      assert.equal(result.entities.length, 2, 'limit must cap the registry entity list');
      assert.ok(result.patternEntities.length <= 2, 'limit must cap the pattern entity list too');
    });

    it('de-duplicates repeated pattern entities in text mode', async () => {
      const { result } = await callTool('extract_entities', {
        text: 'CVE-2026-12345 again: CVE-2026-12345 exploited by APT28, and APT28 resurfaces',
      });
      const values = result.patternEntities.map((p) => p.value);
      assert.deepEqual([...new Set(values)], values, 'repeated mentions must collapse to one entry');
      assert.ok(values.includes('CVE-2026-12345') && values.includes('APT28'));
    });

    it('aggregates entities across the digest when no text is given', async () => {
      const { result } = await callTool('extract_entities', {});
      assert.equal(result.mode, 'headlines');
      assert.equal(result.headlineCount, 3, 'digest adapter must dedupe the repeated link');
      assert.equal(result.generatedAt, '2026-07-28T12:00:00.000Z');
      const requestUrl = new URL(requests[0].url);
      assert.equal(requestUrl.pathname, '/api/news/v1/list-feed-digest');
      assert.equal(requestUrl.searchParams.get('variant'), 'full');
      const msft = result.entities.find((e) => e.entityId === 'MSFT');
      assert.ok(msft, 'aggregation must find Microsoft');
      assert.equal(msft.mentionCount, 1);
      const cve = result.patternEntities.find((p) => p.kind === 'cve');
      assert.equal(cve?.value, 'CVE-2026-12345');
    });

    it('can restrict digest aggregation to the commodities category', async () => {
      await withDigestCategories({
        politics: {
          items: [
            { source: 'AP', title: 'CVE-2026-9999 prompts emergency cyber summit', link: 'https://n/politics', publishedAt: 1785405600000 },
          ],
        },
        commodities: {
          items: [
            { source: 'Gold & Metals', title: 'Gold and copper futures rise on supply concerns', link: 'https://n/commodities', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('extract_entities', { category: 'commodities' });
        assert.equal(result.headlineCount, 1);
        assert.equal(result.category, 'commodities');
        assert.equal(result.note, undefined, 'known category must not emit a corrective note');
        assert.ok(result.entities.some((entity) => entity.entityId === 'GC=F'));
        assert.ok(result.entities.some((entity) => entity.entityId === 'HG=F'));
        assert.equal(
          result.patternEntities.some((entity) => entity.value === 'CVE-2026-9999'),
          false,
          'entities from sibling digest categories must not leak through the filter',
        );
      });
    });

    it('can aggregate a Tech-only digest category through the bounded variant input', async () => {
      await withDigestCategories({
        accelerators: {
          items: [
            { source: 'YC News', title: 'Y Combinator startups build on Microsoft cloud', link: 'https://n/yc', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('extract_entities', {
          variant: 'tech',
          category: 'accelerators',
        });
        const requestUrl = new URL(requests.at(-1).url);
        assert.equal(requestUrl.searchParams.get('variant'), 'tech');
        assert.equal(result.variant, 'tech');
        assert.equal(result.category, 'accelerators');
        assert.equal(result.headlineCount, 1);
        assert.ok(result.entities.some((entity) => entity.entityId === 'MSFT'));
      });
    });

    it('rejects an unknown digest variant without fetching', async () => {
      const requestCount = requests.length;
      const { result } = await callTool('extract_entities', { variant: 'finance' });
      assert.equal(result.mode, 'headlines');
      assert.equal(result.headlineCount, 0);
      assert.match(result.error, /variant must be one of: full, tech/);
      assert.equal(requests.length, requestCount);
    });

    it('can restrict digest aggregation to the intel category', async () => {
      await withDigestCategories({
        politics: {
          items: [
            { source: 'AP', title: 'CVE-2026-9999 prompts an emergency regional summit', link: 'https://n/politics', publishedAt: 1785405600000 },
          ],
        },
        intel: {
          items: [
            { source: 'Defense One', title: 'CVE-2026-7777 tracked by APT28 in military networks', link: 'https://n/intel', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('extract_entities', { category: 'intel' });
        assert.equal(result.headlineCount, 1);
        assert.equal(result.category, 'intel');
        assert.equal(result.note, undefined);
        assert.ok(result.patternEntities.some((entity) => entity.value === 'CVE-2026-7777'));
        assert.equal(
          result.patternEntities.some((entity) => entity.value === 'CVE-2026-9999'),
          false,
        );
      });
    });

    it('keeps a present but empty category distinct from an unknown category', async () => {
      await withDigestCategories({ commodities: { items: [] } }, async () => {
        const { result } = await callTool('extract_entities', { category: 'commodities' });
        assert.equal(result.headlineCount, 0);
        assert.equal(result.category, 'commodities');
        assert.equal(result.note, undefined);
        assert.deepEqual(result.entities, []);
        assert.deepEqual(result.patternEntities, []);
      });
    });

    it('lists the static category inventory when the digest has no buckets', async () => {
      await withDigestCategories({}, async () => {
        const { result } = await callTool('extract_entities', { category: 'commodities' });
        assert.equal(result.headlineCount, 0);
        assert.equal(result.category, 'commodities');
        assert.match(result.note, /Unknown digest category "commodities"/);
        assert.match(result.note, /intel/);
        assert.deepEqual(result.entities, []);
        assert.deepEqual(result.patternEntities, []);
      });
    });

    it('lists the selected Tech inventory when its digest has no buckets', async () => {
      await withDigestCategories({}, async () => {
        const { result } = await callTool('extract_entities', {
          variant: 'tech',
          category: 'commodities',
        });
        const requestUrl = new URL(requests.at(-1).url);
        assert.equal(requestUrl.searchParams.get('variant'), 'tech');
        assert.equal(result.variant, 'tech');
        assert.equal(result.headlineCount, 0);
        assert.match(result.note, /accelerators/);
        assert.doesNotMatch(result.note, /intel/);
      });
    });

    it('returns a retryable source outage when the Tech digest has no fallback', async () => {
      await withDigestCategories({}, async () => {
        const { body, result } = await callTool('extract_entities', {
          variant: 'tech',
          category: 'accelerators',
        });
        assert.equal(result, null);
        assert.equal(body.error?.code, -32003);
        assert.equal(body.error?.data?.retryable, true);
        assert.deepEqual(body.error?.data?.unavailable_inputs, ['news:digest:v1:tech:en']);
      }, {});
    });

    it('returns a corrective note when category is unknown', async () => {
      await withDigestCategories({
        politics: {
          items: [
            { source: 'AP', title: 'Summit talks resume in Geneva', link: 'https://n/politics', publishedAt: 1785405600000 },
          ],
        },
        commodities: {
          items: [
            { source: 'Oil & Gas', title: 'Crude oil futures rise on supply concerns', link: 'https://n/commodities', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('extract_entities', { category: 'commodity' });
        assert.equal(result.mode, 'headlines');
        assert.equal(result.headlineCount, 0);
        assert.equal(result.category, 'commodity');
        assert.match(result.note, /Unknown digest category "commodity"/);
        assert.match(result.note, /commodities/);
        assert.match(result.note, /politics/);
        assert.deepEqual(result.entities, []);
      });
    });
  });

  describe('get_news_clusters', () => {
    it('clusters the digest with the shared algorithm and projects compact clusters', async () => {
      const { result } = await callTool('get_news_clusters', {});
      assert.equal(result.headlineCount, 3);
      assert.equal(result.totalClusters, 2);
      const hormuz = result.clusters.find((c) => c.memberCount === 2);
      assert.ok(hormuz, 'the two Hormuz headlines must form one cluster');
      assert.deepEqual(new Set(hormuz.sources), new Set(['Reuters', 'AP News']));
      assert.equal(hormuz.primarySourceProvenance.riskReviewed, true);
      assert.equal(hormuz.primarySourceProvenance.typeReviewed, true);
      assert.deepEqual(
        new Set(hormuz.sourceProvenance.map((source) => source.source)),
        new Set(['Reuters', 'AP News']),
      );
      assert.ok(hormuz.topKeywords.includes('hormuz'));
      assert.equal(hormuz.threatLevel, 'critical');
      assert.equal(hormuz.isAlert, true);
      assert.equal(
        hormuz.credibilityScore,
        73,
        'cluster must preserve the digest score for its primary headline',
      );
      assert.ok(hormuz.firstSeen.endsWith('Z') && hormuz.lastUpdated.endsWith('Z'));
    });

    it('surfaces state affiliation and fail-closed review state for every projected source', async () => {
      await withDigestCategories({
        asia: {
          items: [
            { source: 'The Astana Times', title: 'Kazakhstan expands regional rail corridor', link: 'https://n/astana', publishedAt: 1785405600000 },
            { source: 'Unreviewed Local Desk', title: 'Kazakhstan regional rail corridor expands', link: 'https://n/local', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('get_news_clusters', { category: 'asia' });
        const cluster = result.clusters[0];
        const provenanceBySource = new Map(
          cluster.sourceProvenance.map((entry) => [entry.source, entry]),
        );
        assert.equal(provenanceBySource.get('The Astana Times').stateAffiliated, 'Kazakhstan');
        assert.equal(provenanceBySource.get('The Astana Times').riskReviewed, true);
        assert.equal(provenanceBySource.get('Unreviewed Local Desk').risk, 'unknown');
        assert.equal(provenanceBySource.get('Unreviewed Local Desk').riskReviewed, false);
        assert.equal(provenanceBySource.get('Unreviewed Local Desk').typeReviewed, false);
      });
    });

    it('stays inside the dispatcher budget at the maximum provenance-rich shape', async () => {
      const sources = Array.from(
        { length: 8 },
        (_, sourceIndex) => `source${sourceIndex}-${'s'.repeat(5_000)}`,
      );
      const items = Array.from({ length: 25 }, (_, clusterIndex) => (
        sources.map((source, sourceIndex) => ({
          source,
          title: `theater${clusterIndex} region${clusterIndex} corridor${clusterIndex} ${`topic${clusterIndex}`.repeat(1_000)}`,
          link: `https://example.test/story/${clusterIndex}/${sourceIndex}/${'x'.repeat(5_000)}`,
          publishedAt: 1785405600000 + clusterIndex * 1000 + sourceIndex,
        }))
      )).flat();

      await withDigestCategories({ politics: { items } }, async () => {
        const { result } = await callTool('get_news_clusters', { limit: 25 });
        assert.equal(result._budget_exceeded, undefined, JSON.stringify(result));
        assert.equal(result.clusters.length, 25);
        assert.ok(
          Buffer.byteLength(JSON.stringify(result), 'utf8') <= 262144,
          'the supported max shape must fit the declared 256 KiB budget',
        );
        assert.ok(
          result.clusters.every((cluster) => cluster.sourceProvenance.length === 8),
          'the fixture must actually exercise all eight provenance slots',
        );
        for (const cluster of result.clusters) {
          assert.ok(Buffer.byteLength(cluster.title, 'utf8') <= 512);
          assert.ok(Buffer.byteLength(cluster.link, 'utf8') <= 2_048);
          for (const source of cluster.sources) {
            assert.ok(Buffer.byteLength(source, 'utf8') <= 160);
          }
        }
      });
    });

    it('truncates multi-byte UTF-8 strings correctly at byte boundaries', async () => {
      // 2-byte UTF-8 character: 'ñ' (U+00F1) = 2 bytes
      // 3-byte UTF-8 character: '本' (U+672C) = 3 bytes
      // 4-byte UTF-8 character: '𒀀' (U+12000) = 4 bytes
      const multiByteSources = Array.from(
        { length: 8 },
        (_, sourceIndex) => `src${sourceIndex}-${'ñ'.repeat(26)}${'本'.repeat(17)}${'𒀀'.repeat(13)}`,
      );
      const items = [{
        source: multiByteSources[0],
        title: `Alert: ${'ñ'.repeat(85)}${'本'.repeat(57)}${'𒀀'.repeat(43)}`,
        link: `https://example.test/${'ñ'.repeat(340)}/${'本'.repeat(227)}/${'𒀀'.repeat(170)}`,
        publishedAt: 1785405600000,
      }];

      await withDigestCategories({ politics: { items } }, async () => {
        const { result } = await callTool('get_news_clusters', { limit: 1 });
        assert.equal(result.clusters.length, 1);
        const cluster = result.clusters[0];
        // Every field must be truncated to fit its byte budget without splitting
        // a multi-byte character. The truncation function must not produce
        // replacement characters or partially-encoded code points.
        assert.ok(Buffer.byteLength(cluster.title, 'utf8') <= 512,
          `title must be ≤512 UTF-8 bytes, got ${Buffer.byteLength(cluster.title, 'utf8')}`);
        assert.ok(Buffer.byteLength(cluster.link, 'utf8') <= 2_048,
          `link must be ≤2048 UTF-8 bytes, got ${Buffer.byteLength(cluster.link, 'utf8')}`);
        for (const source of cluster.sources) {
          assert.ok(Buffer.byteLength(source, 'utf8') <= 160,
            `source must be ≤160 UTF-8 bytes, got ${Buffer.byteLength(source, 'utf8')}`);
        }
        // Verify no partial multi-byte sequences survived truncation
        const decoder = new TextDecoder('utf8', { fatal: true });
        decoder.decode(new TextEncoder().encode(cluster.title));
        decoder.decode(new TextEncoder().encode(cluster.link));
        for (const source of cluster.sources) {
          decoder.decode(new TextEncoder().encode(source));
        }
      });
    });

    it('applies min_sources and limit filters', async () => {
      const { result } = await callTool('get_news_clusters', { min_sources: 2, limit: 1 });
      assert.equal(result.clusters.length, 1);
      assert.equal(result.clusters[0].memberCount, 2);
      assert.equal(result.clusters[0].distinctSourceCount, 2);
      assert.equal(result.totalClusters, 2, 'totalClusters reports the pre-filter count');
    });

    it('can restrict clustering to the commodities category', async () => {
      await withDigestCategories({
        politics: {
          items: [
            { source: 'AP', title: 'Diplomatic talks resume after regional summit', link: 'https://n/politics', publishedAt: 1785405600000 },
          ],
        },
        commodities: {
          items: [
            { source: 'Oil & Gas', title: 'Crude oil futures rise as OPEC supply tightens', link: 'https://n/commodities', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('get_news_clusters', { category: 'commodities' });
        assert.equal(result.headlineCount, 1);
        assert.equal(result.totalClusters, 1);
        assert.equal(result.category, 'commodities');
        assert.equal(result.note, undefined);
        assert.match(result.clusters[0].title, /Crude oil/);
      });
    });

    it('can cluster a Tech-only digest category through the bounded variant input', async () => {
      await withDigestCategories({
        vcblogs: {
          items: [
            { source: 'First Round Review', title: 'Startup founders improve product retention', link: 'https://n/vc', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('get_news_clusters', {
          variant: 'tech',
          category: 'vcblogs',
        });
        const requestUrl = new URL(requests.at(-1).url);
        assert.equal(requestUrl.searchParams.get('variant'), 'tech');
        assert.equal(result.variant, 'tech');
        assert.equal(result.category, 'vcblogs');
        assert.equal(result.headlineCount, 1);
        assert.equal(result.totalClusters, 1);
      });
    });

    it('rejects an unknown clustering variant without fetching', async () => {
      const requestCount = requests.length;
      const { result } = await callTool('get_news_clusters', { variant: 'finance' });
      assert.deepEqual(result.clusters, []);
      assert.equal(result.headlineCount, 0);
      assert.match(result.error, /variant must be one of: full, tech/);
      assert.equal(requests.length, requestCount);
    });

    it('can restrict clustering to the intel category', async () => {
      await withDigestCategories({
        politics: {
          items: [
            { source: 'AP', title: 'Diplomatic talks resume after regional summit', link: 'https://n/politics', publishedAt: 1785405600000 },
          ],
        },
        intel: {
          items: [
            { source: 'Defense One', title: 'Military networks targeted by APT28 operators', link: 'https://n/intel', publishedAt: 1785405700000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('get_news_clusters', { category: 'intel' });
        assert.equal(result.headlineCount, 1);
        assert.equal(result.totalClusters, 1);
        assert.equal(result.category, 'intel');
        assert.equal(result.note, undefined);
        assert.match(result.clusters[0].title, /Military networks/);
      });
    });

    it('keeps a present but empty category distinct from an unknown category', async () => {
      await withDigestCategories({ commodities: { items: [] } }, async () => {
        const { result } = await callTool('get_news_clusters', { category: 'commodities' });
        assert.equal(result.headlineCount, 0);
        assert.equal(result.totalClusters, 0);
        assert.equal(result.category, 'commodities');
        assert.equal(result.note, undefined);
        assert.deepEqual(result.clusters, []);
      });
    });

    it('lists the static category inventory when the digest has no buckets', async () => {
      await withDigestCategories({}, async () => {
        const { result } = await callTool('get_news_clusters', { category: 'commodities' });
        assert.equal(result.headlineCount, 0);
        assert.equal(result.totalClusters, 0);
        assert.equal(result.category, 'commodities');
        assert.match(result.note, /Unknown digest category "commodities"/);
        assert.match(result.note, /intel/);
        assert.deepEqual(result.clusters, []);
      });
    });

    it('returns a corrective note when category is unknown', async () => {
      await withDigestCategories({
        finance: {
          items: [
            { source: 'CNBC', title: 'Markets open higher on rate-cut bets', link: 'https://n/finance', publishedAt: 1785405600000 },
          ],
        },
      }, async () => {
        const { result } = await callTool('get_news_clusters', { category: 'markets' });
        assert.equal(result.headlineCount, 0);
        assert.equal(result.totalClusters, 0);
        assert.equal(result.category, 'markets');
        assert.deepEqual(result.clusters, []);
        assert.match(result.note, /Unknown digest category "markets"/);
        assert.match(result.note, /finance/);
      });
    });

    it('filters min_sources on distinct outlets, not repeat headlines from one outlet', async () => {
      const originalFetchImpl = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/news/v1/list-feed-digest')) {
          requests.push({ url, init });
          return Response.json({
            generatedAt: '2026-07-28T12:00:00.000Z',
            categories: {
              politics: {
                items: [
                  // Same outlet filing the same story twice: two members, ONE source.
                  { source: 'Reuters', title: 'Sanctions package advances through committee', link: 'https://s/1', publishedAt: 1785405600000, isAlert: false },
                  { source: 'Reuters', title: 'Sanctions package advances through committee vote', link: 'https://s/2', publishedAt: 1785405700000, isAlert: false },
                ],
              },
            },
          });
        }
        return originalFetchImpl(input, init);
      };
      try {
        const { result } = await callTool('get_news_clusters', { min_sources: 2 });
        assert.equal(result.totalClusters, 1, 'the two near-identical headlines cluster together');
        assert.equal(result.clusters.length, 0,
          'one outlet filing twice is not two-source corroboration');
      } finally {
        globalThis.fetch = originalFetchImpl;
      }
    });

    // #6428: the case above only exercises the SAME label twice, which a plain
    // Set already collapses. The bug this guards is one publisher arriving
    // under several of its OWN feed labels — the tool's documented promise is
    // "distinct outlets ... real corroboration, not one outlet filing twice",
    // and a label count cannot keep it.
    it('counts one publisher once across its own feed labels', async () => {
      const originalFetchImpl = globalThis.fetch;
      const digest = (sources) => ({
        generatedAt: '2026-07-28T12:00:00.000Z',
        categories: {
          politics: {
            items: sources.map((source, i) => ({
              source,
              title: `Sanctions package advances through committee ${'vote '.repeat(i)}`.trim(),
              link: `https://s/${i}`,
              publishedAt: 1785405600000 + i * 1000,
              isAlert: false,
            })),
          },
        },
      });
      const serve = (sources) => {
        globalThis.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.includes('/api/news/v1/list-feed-digest')) {
            requests.push({ url, init });
            return Response.json(digest(sources));
          }
          return originalFetchImpl(input, init);
        };
      };

      try {
        serve(['Reuters World', 'Reuters US', 'Reuters Business']);
        const oneWire = await callTool('get_news_clusters', { min_sources: 1 });
        assert.equal(oneWire.result.totalClusters, 1, 'fixture must cluster into one story');
        assert.equal(
          oneWire.result.clusters[0].distinctSourceCount,
          1,
          'three Reuters feed labels are one publisher',
        );
        assert.equal(
          oneWire.result.clusters[0].memberCount,
          3,
          'memberCount stays the article count — it is a volume signal, not corroboration',
        );
        assert.deepEqual(
          oneWire.result.clusters[0].sources,
          ['Reuters World', 'Reuters US', 'Reuters Business'],
          'the label list stays intact for attribution',
        );

        serve(['Reuters World', 'Reuters US', 'Reuters Business']);
        const filtered = await callTool('get_news_clusters', { min_sources: 2 });
        assert.equal(
          filtered.result.clusters.length,
          0,
          'min_sources filters on publishers, so one wire cannot satisfy min_sources: 2',
        );

        // Premise check: three real publishers must still pass, or the two
        // assertions above would hold on a clustering failure instead.
        serve(['Reuters World', 'BBC World', 'Al Jazeera']);
        const genuine = await callTool('get_news_clusters', { min_sources: 2 });
        assert.equal(genuine.result.clusters.length, 1);
        assert.equal(genuine.result.clusters[0].distinctSourceCount, 3);
      } finally {
        globalThis.fetch = originalFetchImpl;
      }
    });
  });

  describe('get_keyword_spikes', () => {
    function seedAccumulator() {
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 5; i++) {
        const hash = `spike${i}`;
        const lastSeen = now - i * 10 * 60 * 1000;
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Zaporizhzhia plant shelling escalates (${i})`);
        upstashState.linksByHash.set(hash, `https://example.test/spike-${i}`);
        upstashState.sourcesByHash.set(hash, [`source-${i % 3}`]);
      }
      for (let i = 0; i < 30; i++) {
        const hash = `base${i}`;
        const lastSeen = now - (3 + i) * 60 * 60 * 1000;
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Weather outlook stays calm (${i})`);
      }
      upstashState.zrangeFlat = flat;
    }

    it('returns attributed sample headlines and source names, not title-only counts', async () => {
      seedAccumulator();
      const { response, result } = await callTool('get_keyword_spikes', {});
      assert.equal(response.status, 200);
      const spike = result.spikes.find((s) => s.term === 'zaporizhzhia');
      assert.ok(spike, 'expected zaporizhzhia spike');
      assert.equal(spike.uniqueSources, 3);
      assert.deepEqual([...spike.sourceNames].sort(), ['source-0', 'source-1', 'source-2']);
      assert.ok(Array.isArray(spike.sampleHeadlines) && spike.sampleHeadlines.length > 0);
      assert.ok(
        spike.sampleHeadlines.every((sample) => typeof sample !== 'string'),
        'sampleHeadlines must not remain title-only strings',
      );
      assert.deepEqual(
        spike.sampleHeadlines.map((sample) => ({
          title: sample.title,
          source: sample.source,
          link: sample.link,
        })),
        [
          {
            title: 'Zaporizhzhia plant shelling escalates (0)',
            source: 'source-0',
            link: 'https://example.test/spike-0',
          },
          {
            title: 'Zaporizhzhia plant shelling escalates (1)',
            source: 'source-1',
            link: 'https://example.test/spike-1',
          },
          {
            title: 'Zaporizhzhia plant shelling escalates (2)',
            source: 'source-2',
            link: 'https://example.test/spike-2',
          },
        ],
      );
    });

    it('computes spikes from the story accumulator and caches the result', async () => {
      seedAccumulator();
      const first = await callTool('get_keyword_spikes', {});
      assert.equal(first.response.status, 200);
      assert.equal(first.result.story_count, 35);
      // The oldest pre-window story sits 32h back, so the exact sampled
      // PRE-WINDOW duration is 30h (32h total minus the 2h recent window).
      assert.ok(Math.abs(first.result.baseline_hours - 30) < 0.01,
        'baseline duration reflects the sampled 30h pre-window span');
      assert.equal(first.result.sample_truncated, false);
      const terms = first.result.spikes.map((s) => s.term);
      assert.ok(terms.includes('zaporizhzhia'), `expected zaporizhzhia, got: ${terms.join(', ')}`);
      const spike = first.result.spikes.find((s) => s.term === 'zaporizhzhia');
      assert.equal(spike.count, 5);
      assert.equal(spike.uniqueSources, 3);
      assert.equal(spike.sourceNames.length, spike.uniqueSources);
      assert.ok(upstashState.storedPayloads.size === 1, 'result must be cached');
      assert.ok(pipelineCalls > 0);

      // Second call must be served from the cache without touching pipelines.
      pipelineCalls = 0;
      const second = await callTool('get_keyword_spikes', {});
      assert.equal(pipelineCalls, 0, 'cached call must not re-run Redis pipelines');
      assert.deepEqual(
        second.result.spikes.map((s) => s.term),
        first.result.spikes.map((s) => s.term),
      );
    });

    it('treats an unreadable accumulator payload as degraded, not as a quiet window', async () => {
      // Non-empty reply whose pairs are all unparseable: without the guard this
      // computes over zero stories and caches a note-less empty result.
      const now = Date.now();
      upstashState.zrangeFlat = ['', String(now), '', String(now - 60_000)];

      const { result } = await callTool('get_keyword_spikes', {});
      assert.deepEqual(result.spikes, []);
      assert.match(result.note, /unreadable payload/);
      assert.equal(upstashState.storedPayloads.size, 0, 'a malformed read must not be cached');
    });

    it('returns an explicit note when the accumulator is empty', async () => {
      const { result } = await callTool('get_keyword_spikes', {});
      assert.deepEqual(result.spikes, []);
      assert.match(result.note, /accumulator unavailable or empty/);
    });

    it('clamps malformed window/min_count/limit params to defaults', async () => {
      seedAccumulator();
      const { result } = await callTool('get_keyword_spikes', { window_hours: 99.5, min_count: -3, limit: 'many' });
      assert.equal(result.window_hours, 2, 'non-integer window falls back to the default');
      // The cache key embeds the clamped minCount, so it proves the clamp
      // applied rather than the raw -3 reaching the spike math.
      assert.deepEqual([...upstashState.storedPayloads.keys()], ['intelligence:keyword-spikes:mcp:v3:2h:2'],
        'out-of-range integer min_count clamps to the schema minimum (2); the raw -3 must never reach the spike math');
      assert.ok(result.spikes.length <= 10, 'non-integer limit falls back to the default 10');
    });

    it('fetches a separately bounded baseline cohort when the newest 800 rows are all recent', async () => {
      // 900 recent rows fill a newest-first cap before it can reach these
      // pre-window rows. The second bounded cohort must still find the baseline.
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 900; i++) {
        const hash = `dense${i}`;
        const lastSeen = now - Math.floor(i * 4_000); // all inside the 2h recent window
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Zaporizhzhia alert expands (${i})`);
        upstashState.sourcesByHash.set(hash, [`src-${i % 5}`]);
      }
      for (let i = 0; i < 4; i++) {
        const hash = `dense-base${i}`;
        const lastSeen = now - (2.5 + i * 0.5) * 60 * 60 * 1000;
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Zaporizhzhia monitoring continues (${i})`);
      }
      upstashState.zrangeFlat = flat;

      const { result } = await callTool('get_keyword_spikes', {});
      assert.equal(result.sample_truncated, true, 'hitting the story cap must be disclosed');
      assert.ok(Math.abs(result.baseline_hours - 2) < 0.01,
        'baseline duration is measured from the 4h-old row to the 2h boundary');
      assert.equal(result.story_count, 804, 'recent and baseline cohorts are independently bounded and combined');
      assert.ok(result.spikes.some((spike) => spike.term === 'zaporizhzhia'));
      assert.equal(upstashState.storedPayloads.size, 1, 'a complete two-cohort result remains cacheable');
    });

    it('returns baseline-unavailable without spikes or caching when no pre-window rows exist', async () => {
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 900; i++) {
        const hash = `recent-only${i}`;
        flat.push(hash, String(now - i * 4_000));
        upstashState.titlesByHash.set(hash, `Zaporizhzhia alert expands (${i})`);
        upstashState.sourcesByHash.set(hash, [`src-${i % 5}`]);
      }
      upstashState.zrangeFlat = flat;

      const { result } = await callTool('get_keyword_spikes', {});
      assert.deepEqual(result.spikes, []);
      assert.equal(result.baseline_hours, 0);
      assert.equal(result.sample_truncated, true);
      assert.match(result.note, /baseline unavailable/i);
      assert.equal(upstashState.storedPayloads.size, 0,
        'a recent-only sample must not poison cache with cold-start spikes');
    });

    it('preserves a positive fractional baseline duration below one decimal hour', async () => {
      const now = Date.now();
      const windowMs = 2 * 60 * 60 * 1000;
      upstashState.zrangeFlat = [
        'fractional-recent', String(now - 1_000),
        'fractional-baseline', String(now - windowMs - 60_000),
      ];
      upstashState.titlesByHash.set('fractional-recent', 'Fractional recent headline');
      upstashState.titlesByHash.set('fractional-baseline', 'Fractional baseline headline');
      upstashState.sourcesByHash.set('fractional-recent', ['Reuters']);

      const { result } = await callTool('get_keyword_spikes', {});
      assert.ok(result.baseline_hours > 0 && result.baseline_hours < 0.1,
        'an available short baseline must stay distinguishable from the zero/unavailable sentinel');
      assert.equal(result.story_count, 2);
      assert.equal(upstashState.storedPayloads.size, 1,
        'a complete fractional baseline remains cacheable');
    });

    it('exercises multi-chunk HMGET/SMEMBERS reassembly past the 200-item boundary', async () => {
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 450; i++) {
        const hash = `chunk${i}`;
        flat.push(hash, String(now - i * 1_000));
        upstashState.titlesByHash.set(hash, `Chunk boundary headline ${i}`);
        upstashState.sourcesByHash.set(hash, [`outlet-${i % 4}`]);
      }
      flat.push('chunk-baseline', String(now - 3 * 60 * 60 * 1000));
      upstashState.titlesByHash.set('chunk-baseline', 'Chunk boundary baseline headline');
      upstashState.zrangeFlat = flat;

      const { result } = await callTool('get_keyword_spikes', {});
      assert.equal(result.story_count, 451, 'titles from every chunk must be reassembled');
      assert.equal(result.sample_truncated, false);
    });

    it('does not cache a partial story-store read and says so', async () => {
      seedAccumulator();
      upstashState.failCommands.add('HMGET');

      const { result } = await callTool('get_keyword_spikes', {});
      assert.match(result.note, /partial story-store read/);
      assert.equal(upstashState.storedPayloads.size, 0,
        'a degraded corpus must never poison the shared 10-minute cache');
    });

    it('does not cache an unavailable accumulator pipeline', async () => {
      seedAccumulator();
      upstashState.failCommands.add('ZRANGE');

      const { result } = await callTool('get_keyword_spikes', {});
      assert.deepEqual(result.spikes, []);
      assert.match(result.note, /accumulator unavailable or empty/);
      assert.equal(upstashState.storedPayloads.size, 0);
    });

    for (const command of ['HMGET', 'SMEMBERS']) {
      for (const [condition, transform] of [
        ['short', (reply) => reply.slice(0, -1)],
        ['malformed', (reply) => reply.map(() => ({ result: 'not-an-array' }))],
        ['per-command error', (reply) => reply.map((item, index) => (
          index === 0 ? { error: 'WRONGTYPE simulated' } : item
        ))],
      ]) {
        it(`treats a ${condition} ${command} pipeline reply as degraded and never caches it`, async () => {
          seedAccumulator();
          upstashState.pipelineReplyTransforms.set(command, transform);

          const { result } = await callTool('get_keyword_spikes', {});
          assert.match(result.note, /partial story-store read/);
          assert.equal(upstashState.storedPayloads.size, 0);
        });
      }
    }

    it('treats a missing HMGET title as degraded and never caches it', async () => {
      seedAccumulator();
      upstashState.pipelineReplyTransforms.set('HMGET', (reply) => reply.map((item, index) => (
        index === 0 ? { result: [null, 'https://example.test/missing-title'] } : item
      )));

      const { result } = await callTool('get_keyword_spikes', {});
      assert.match(result.note, /partial story-store read/);
      assert.equal(upstashState.storedPayloads.size, 0);
    });

    it('treats a missing HMGET link as an empty string and still caches', async () => {
      seedAccumulator();
      upstashState.pipelineReplyTransforms.set('HMGET', (reply) => reply.map((item, index) => (
        index === 0 ? { result: ['Zaporizhzhia plant shelling escalates (0)', null] } : item
      )));

      const { result } = await callTool('get_keyword_spikes', {});
      assert.equal(result.note, undefined);
      assert.equal(upstashState.storedPayloads.size, 1);
      const spike = result.spikes.find((s) => s.term === 'zaporizhzhia');
      assert.equal(spike.sampleHeadlines[0].link, '');
    });

    it('falls back to live computation when the cache read fails', async () => {
      seedAccumulator();
      upstashState.failCacheRead = true;

      const { response, result } = await callTool('get_keyword_spikes', {});
      assert.equal(response.status, 200, 'a cache-read outage must degrade, not error the tool');
      assert.ok(result.spikes.map((s) => s.term).includes('zaporizhzhia'));
    });
  });
});

// The edge bundle cannot import server/_shared/cache-keys.ts, so get_keyword_spikes
// hardcodes the accumulator/story-track/story-sources key strings. Tests CAN import
// both sides, so this pins them together: a server-side key-version bump would
// otherwise leave the tool reading dead keys and reporting "accumulator unavailable"
// forever, with every other test still green.
describe('#5697 spike-tool Redis key drift', () => {
  it('keeps the hardcoded key literals aligned with server/_shared/cache-keys.ts', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { STORY_TRACK_KEY_PREFIX, STORY_SOURCES_KEY_PREFIX, DIGEST_ACCUMULATOR_KEY } =
      await import('../server/_shared/cache-keys.ts');

    // Read the whole registry dir: pinning one filename is how a static guard
    // silently loses reach when the code it guards moves to a sibling module.
    const registryDir = new URL('../api/mcp/registry/', import.meta.url);
    const src = readdirSync(registryDir)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => readFileSync(new URL(f, registryDir), 'utf8'))
      .join('\n');
    assert.ok(
      src.includes(`'${DIGEST_ACCUMULATOR_KEY('full', 'en')}'`),
      `the MCP registry must read the canonical accumulator key ${DIGEST_ACCUMULATOR_KEY('full', 'en')}`,
    );
    assert.ok(
      src.includes(`\`${STORY_TRACK_KEY_PREFIX}\${`),
      `the MCP registry must build story-track keys from ${STORY_TRACK_KEY_PREFIX}`,
    );
    assert.ok(
      src.includes(`\`${STORY_SOURCES_KEY_PREFIX}\${`),
      `the MCP registry must build story-sources keys from ${STORY_SOURCES_KEY_PREFIX}`,
    );
  });
});
