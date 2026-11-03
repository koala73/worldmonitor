// A signed-in free account must not read a dataset the REST surface sells at
// a paid tier. #7433 gated seven derived-analytics routes but left two of them
// readable through the free-account `get_market_data` bundle as a documented
// exception; the owner closed that exception, and this suite keeps every
// non-subscription MCP tool from reopening the same door.
import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { getRequiredTier, TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { executeTool } from '../api/mcp/dispatch.ts';
import type { CacheToolDef, McpToolExecutionContext, ToolDef } from '../api/mcp/types.ts';
import { HMAC_SECRET, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const PAID_PATHS: ReadonlySet<string> = new Set([...TIER_GATED_PATHS, ...PREMIUM_RPC_PATHS]);

const handlerSource = (path: string) =>
  readFileSync(new URL(`../server/worldmonitor/${path.slice('/api/'.length)}.ts`, import.meta.url), 'utf8');

// Redis keys behind the paid REST routes from the #7433 family (#6436, #6438,
// #6439, #6448, #6449) plus Comtrade flows. A trailing `:` entry is a prefix.
// Each entry is checked against the handler that sells it, so a renamed key
// fails here instead of silently leaving this list.
const PAID_DATASET_KEYS: ReadonlyArray<{ key: string; path: string }> = [
  { key: 'market:physical-premium:v1', path: '/api/market/v1/get-physical-premiums' },
  { key: 'market:physical-divergence:v1', path: '/api/market/v1/get-physical-divergence-index' },
  { key: 'supply-chain:mineral-production:v1', path: '/api/supply-chain/v1/get-mineral-production' },
  { key: 'military:industrial-base:v1', path: '/api/military/v1/get-defense-industrial-base' },
  { key: 'military:arms-suppliers:v1', path: '/api/military/v1/get-defense-industrial-base' },
  { key: 'comtrade:flows:', path: '/api/trade/v1/list-comtrade-flows' },
];
// The three #6449 vulnerability routes share one cohort key, defined in a
// helper module rather than in each handler.
const VULNERABILITY_COHORT = {
  key: 'supply-chain:vulnerability:cohort:v1',
  paths: [
    '/api/supply-chain/v1/get-country-vulnerabilities',
    '/api/supply-chain/v1/get-chokepoint-dependencies',
    '/api/supply-chain/v1/list-vulnerability-rankings',
  ],
};

// Gated `_apiPaths` a non-subscription tool may serve without locking them.
// Key: `<tool> <path>`; value: why the overlap is acceptable. Empty by owner
// decision: #7433's get_market_data exception is closed. An entry that stops
// matching a real overlap fails the build, so this list cannot rot.
const ALLOWED_EXCEPTIONS: Readonly<Record<string, string>> = {};

const stripMethod = (apiPath: string) => apiPath.replace(/^[A-Z]+\s+/, '').split('?')[0]!;
const isFreeAccountReachable = (tool: ToolDef) => toolAccess(tool) !== 'subscription';
const matchesPaid = (key: string, paid: string) => paid.endsWith(':') ? key.startsWith(paid) || key === paid.slice(0, -1) : key === paid;

function subscriptionKeys(tool: ToolDef): Record<string, string> {
  return (tool as CacheToolDef)._subscriptionCacheKeys ?? {};
}

// Every gated path a non-subscription tool serves that its own
// `_subscriptionCacheKeys` does not lock for free accounts.
function unlockedGatedPaths(registry: readonly ToolDef[]): string[] {
  return registry.filter(isFreeAccountReachable).flatMap((tool) => {
    const locked = new Set(Object.values(subscriptionKeys(tool)));
    return (tool._apiPaths ?? []).map(stripMethod)
      .filter((path) => PAID_PATHS.has(path) && !locked.has(path))
      .map((path) => `${tool.name} ${path}`);
  });
}

// Every paid key a non-subscription tool can read for a free account.
function unlockedPaidKeys(registry: readonly ToolDef[], paidKeys: readonly string[]): string[] {
  return registry.filter(isFreeAccountReachable).flatMap((tool) => {
    const locked = subscriptionKeys(tool);
    const keys = [...((tool as CacheToolDef)._cacheKeys ?? []), ...((tool as { _coverageKeys?: string[] })._coverageKeys ?? [])];
    return keys.filter((key) => !Object.hasOwn(locked, key) && paidKeys.some((paid) => matchesPaid(key, paid)))
      .map((key) => `${tool.name} ${key}`);
  });
}

const ALL_PAID_KEYS = [...PAID_DATASET_KEYS.map((entry) => entry.key), VULNERABILITY_COHORT.key];

describe('free-account MCP tools never serve paid datasets', () => {
  it('pins each paid dataset key to the gated handler that sells it', () => {
    for (const { key, path } of PAID_DATASET_KEYS) {
      assert.ok(PAID_PATHS.has(path), `${path} is gated`);
      const literal = key.endsWith(':') ? key.slice(0, -1) : key;
      assert.ok(handlerSource(path).includes(`'${literal}'`), `${path} reads ${literal}`);
    }
    // Comtrade flows are tier-1 and Pro-RPC, and the registry still carries
    // them, on a subscription tool only (checked below).
    const comtrade = '/api/trade/v1/list-comtrade-flows';
    assert.ok(PREMIUM_RPC_PATHS.has(comtrade));
    assert.equal(getRequiredTier(comtrade), 1);
    assert.match(handlerSource(comtrade), /const KEY_PREFIX = 'comtrade:flows'/);
    assert.ok(TOOL_REGISTRY.some((tool) => (tool as CacheToolDef)._cacheKeys?.includes('comtrade:flows:v1')));
    const cohortModule = readFileSync(new URL('../server/worldmonitor/supply-chain/v1/_vulnerability-projection.ts', import.meta.url), 'utf8');
    assert.ok(cohortModule.includes(`VULNERABILITY_COHORT_KEY = '${VULNERABILITY_COHORT.key}'`));
    for (const path of VULNERABILITY_COHORT.paths) {
      assert.ok(PAID_PATHS.has(path), `${path} is gated`);
      assert.match(handlerSource(path), /VULNERABILITY_COHORT_KEY/);
    }
  });

  it('every gated _apiPaths entry on a non-subscription tool is locked or an allowed exception', () => {
    const unlocked = unlockedGatedPaths(TOOL_REGISTRY);
    assert.deepEqual(unlocked.filter((overlap) => !Object.hasOwn(ALLOWED_EXCEPTIONS, overlap)), []);
    for (const exception of Object.keys(ALLOWED_EXCEPTIONS)) {
      assert.ok(unlocked.includes(exception), `ALLOWED_EXCEPTIONS entry "${exception}" no longer matches a real overlap; delete it`);
    }
  });

  it('no paid dataset key is readable by a free-account tool', () => {
    assert.deepEqual(unlockedPaidKeys(TOOL_REGISTRY, ALL_PAID_KEYS), []);
  });

  it('the checks above still detect an unlocked overlap (canary)', () => {
    const market = TOOL_REGISTRY.find((tool) => tool.name === 'get_market_data') as CacheToolDef;
    assert.equal(toolAccess(market), 'free-account');
    const { _subscriptionCacheKeys: _locked, ...reopened } = market;
    assert.deepEqual(unlockedGatedPaths([reopened as ToolDef]), [
      'get_market_data /api/market/v1/get-physical-premiums',
      'get_market_data /api/market/v1/get-physical-divergence-index',
    ]);
    assert.deepEqual(unlockedPaidKeys([reopened as ToolDef], ALL_PAID_KEYS), [
      'get_market_data market:physical-premium:v1',
      'get_market_data market:physical-divergence:v1',
    ]);
    assert.deepEqual(unlockedPaidKeys([{ ...reopened, _cacheKeys: ['comtrade:flows:v1'] } as ToolDef], ALL_PAID_KEYS), ['get_market_data comtrade:flows:v1']);
  });

  it('every _subscriptionCacheKeys entry names a key the tool reads and a gated path it serves', () => {
    for (const tool of TOOL_REGISTRY) {
      for (const [key, path] of Object.entries(subscriptionKeys(tool))) {
        assert.ok((tool as CacheToolDef)._cacheKeys.includes(key), `${tool.name} locks ${key} but does not read it`);
        assert.ok(PAID_PATHS.has(path), `${tool.name} maps ${key} to ungated ${path}`);
        assert.ok(tool._apiPaths.map(stripMethod).includes(path), `${tool.name} maps ${key} to ${path} outside its _apiPaths`);
      }
    }
  });
});

describe('free-account cache reads skip _subscriptionCacheKeys', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let reads: string[];

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    reads = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const read = decodeURIComponent(String(url));
      reads.push(read);
      // A divergence miss keeps the stub clear of its stored-contract validator.
      return new Response(JSON.stringify({ result: read.includes('market:physical-divergence:v1') ? null : JSON.stringify({ ok: 1 }) }));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  const context = (freeAccount: boolean): McpToolExecutionContext => ({
    inboundHostClass: 'apex',
    downstreamOrigin: 'https://api.worldmonitor.app',
    downstreamOriginTag: 'https://api.worldmonitor.app',
    ...(freeAccount ? { freeAccountAllowance: true as const } : {}),
  });
  const readKey = (key: string) => reads.some((url) => url.includes(key));

  for (const tool of TOOL_REGISTRY.filter((candidate) => Object.keys(subscriptionKeys(candidate)).length > 0)) {
    for (const [label, params] of [['default', {}], ['asset_class commodity', { asset_class: ['commodity'] }]] as const) {
      it(`${tool.name} (${label}): free account never reads the locked keys and is told they are locked`, async () => {
        const value = await executeTool(tool as CacheToolDef, params, undefined, context(true)) as Record<string, unknown>;
        const locked = Object.keys(subscriptionKeys(tool));
        for (const key of locked) {
          assert.equal(readKey(key), false, `${key} read for a free account`);
          assert.equal(readKey(`seed-meta:${key.replace(/:v\d+$/, '')}`), false, `seed-meta for ${key} read for a free account`);
        }
        assert.ok(locked.length > 0 && reads.length > 0, 'the free datasets are still read');
        const data = value.data as Record<string, unknown>;
        for (const section of value.locked as string[]) assert.equal(Object.hasOwn(data, section), false, `${section} in data`);
        assert.equal((value.locked as string[]).length, locked.length);
        assert.match(String(value.upgradeUrl), /^https:\/\//);
      });
    }

    it(`${tool.name}: a subscriber still reads every key`, async () => {
      const value = await executeTool(tool as CacheToolDef, {}, undefined, context(false)) as Record<string, unknown>;
      for (const key of Object.keys(subscriptionKeys(tool))) assert.ok(readKey(key), `${key} read for a subscriber`);
      assert.equal(value.locked, undefined);
      assert.equal(value.upgradeUrl, undefined);
    });
  }

  it('drops a locked key\'s seed-meta freshness check for a free account only', async () => {
    const tool: CacheToolDef = {
      name: 'synthetic_bundle',
      title: 'Synthetic',
      description: 'Synthetic bundle.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      _outputBudgetBytes: 4096,
      _cacheKeys: ['synthetic:free:v1', 'synthetic:paid:v2'],
      _subscriptionCacheKeys: { 'synthetic:paid:v2': '/api/market/v1/get-physical-premiums' },
      _freshnessChecks: [
        { key: 'seed-meta:synthetic:free', maxStaleMin: 30 },
        { key: 'seed-meta:synthetic:paid', maxStaleMin: 30 },
      ],
      _apiPaths: [],
    };
    const fresh = JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 });
    globalThis.fetch = (async (url: string | URL | Request) => {
      const read = decodeURIComponent(String(url));
      reads.push(read);
      // The paid seed-meta is missing: read, it would mark the call stale.
      const result = read.includes('seed-meta:synthetic:paid') ? null
        : read.includes('seed-meta:') ? fresh : JSON.stringify({ rows: [1] });
      return new Response(JSON.stringify({ result }));
    }) as typeof fetch;

    const free = await executeTool(tool, {}, undefined, context(true)) as Record<string, unknown>;
    assert.equal(readKey('synthetic:paid'), false);
    assert.equal(free.stale, false, 'a dataset the caller cannot see does not mark its call stale');
    assert.deepEqual(free.locked, ['paid']);
    assert.deepEqual(Object.keys(free.data as object), ['free']);

    reads = [];
    const paid = await executeTool(tool, {}, undefined, context(false)) as Record<string, unknown>;
    assert.ok(readKey('seed-meta:synthetic:paid') && readKey('synthetic:paid:v2'));
    assert.equal(paid.stale, true);
  });

  it('resources/read for a free account reaches the same lock (worldmonitor://markets/{symbol}/quote)', async () => {
    const { mcpHandler } = await import(`../api/mcp.ts?invariant=${Date.now()}`);
    const { deps } = makeProDeps({
      getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 }),
    });
    const res = await mcpHandler(proReq('POST', {
      jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'worldmonitor://markets/GC=F/quote' },
    }), deps);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.ok(readKey('market:commodities-bootstrap:v1'), 'the resource read ran');
    assert.equal(readKey('market:physical-premium:v1'), false);
    assert.equal(readKey('market:physical-divergence:v1'), false);
    assert.match(text, /physical-premium/, 'the resource names the locked dataset');
  });
});
