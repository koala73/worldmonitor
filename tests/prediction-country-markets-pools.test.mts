// fetchCountryMarkets reads the producer-ranked country projection first. Its
// rollout fallback still has to union every disjoint bootstrap pool so a market
// does not disappear only because it was classified as tech or finance.
//
// Loaded through an esbuild stub bundle (the pattern in
// tests/giving-service-recovery.test.mts) because the module is browser-side and
// imports the generated RPC client, the bootstrap hydration cache, and config.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const entryPath = resolve(root, 'src/services/prediction/index.ts');

interface CountryMarketsTestState {
  rpcCalls: { category: string; query: string }[];
  rpcMarketsByCategory: Record<string, unknown[]>;
  hydrated?: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __wmCountryMarketsTestState: CountryMarketsTestState | undefined;
}

function protoMarket(title: string, volume: number) {
  return {
    id: title,
    title,
    yesPrice: 0.5,
    volume,
    url: `https://polymarket.com/event/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    closesAt: Date.parse('2099-01-01T00:00:00Z'),
    category: '',
    source: 'MARKET_SOURCE_POLYMARKET',
  };
}

function bootstrapMarket(title: string, volume: number) {
  return {
    title,
    yesPrice: 50,
    volume,
    url: `https://polymarket.com/event/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    endDate: '2099-01-01T00:00:00Z',
    source: 'polymarket',
  };
}

async function loadPredictionService() {
  const stubModules = new Map<string, string>([
    ['rpc-client-stub', `export function getRpcBaseUrl() { return 'https://example.test'; }`],
    ['config-stub', `export const SITE_VARIANT = 'full';`],
    ['utils-stub', `
      export function createCircuitBreaker() {
        return { execute: async (fn, fallback) => { try { return await fn(); } catch { return fallback; } } };
      }
    `],
    ['bootstrap-stub', `
      export function getHydratedData() {
        return globalThis.__wmCountryMarketsTestState?.hydrated;
      }
    `],
    ['generated-rpc-clients-stub', `
      export class PredictionServiceClient {
        async listPredictionMarkets(req) {
          const state = globalThis.__wmCountryMarketsTestState;
          state.rpcCalls.push({ category: req.category, query: req.query });
          return { markets: state.rpcMarketsByCategory[req.category] ?? [] };
        }
      }
    `],
  ]);
  const aliases = new Map([
    ['@/services/rpc-client', 'rpc-client-stub'],
    ['@/config', 'config-stub'],
    ['@/utils', 'utils-stub'],
    ['@/services/bootstrap', 'bootstrap-stub'],
    ['@/services/generated-rpc-clients', 'generated-rpc-clients-stub'],
  ]);

  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    loader: { '.json': 'json' },
    plugins: [{
      name: 'country-markets-pool-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubModules.get(args.path),
          loader: 'ts',
        }));
      },
    }],
  });

  const bundleUrl =
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  return import(bundleUrl);
}

after(() => {
  delete globalThis.__wmCountryMarketsTestState;
});

describe('fetchCountryMarkets uses the producer country index', () => {
  it('sends one ISO2 request instead of literal-title category fan-out', async () => {
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: {} };
    const service = await loadPredictionService();
    await service.fetchCountryMarkets('China', 'CN');

    assert.deepEqual(globalThis.__wmCountryMarketsTestState!.rpcCalls, [{
      category: 'country:CN',
      query: '',
    }]);
  });

  it('returns the server-ranked cross-pool country selection', async () => {
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [],
      rpcMarketsByCategory: {
        'country:CN': [
          protoMarket('Will China invade Taiwan by 2027?', 5_000_000),
          protoMarket('Will China ship the best AI model?', 9_000_000),
        ],
      },
    };
    const service = await loadPredictionService();
    const out = await service.fetchCountryMarkets('China', 'CN');

    const titles = out.map((m: { title: string }) => m.title);
    assert.ok(titles.some((t: string) => t.includes('invade Taiwan')), `geo market missing: ${titles}`);
    assert.ok(titles.some((t: string) => t.includes('best AI model')), `tech market missing: ${titles}`);
  });

  it('unions all three buckets in the bootstrap fallback', async () => {
    // RPC returns nothing, so the bootstrap fallback is the only path. A
    // tech-classified country market lives ONLY in the tech bucket now.
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [],
      rpcMarketsByCategory: {},
      hydrated: {
        geopolitical: [],
        tech: [bootstrapMarket('Will China ship the best AI model', 9_000_000)],
        finance: [bootstrapMarket('Will China cut its policy rate', 4_000_000)],
        fetchedAt: Date.now(),
      },
    };
    const service = await loadPredictionService();
    const out = await service.fetchCountryMarkets('China', 'CN');

    const titles = out.map((m: { title: string }) => m.title);
    assert.ok(titles.some((t: string) => t.includes('best AI model')), `tech bucket missing: ${titles}`);
    assert.ok(titles.some((t: string) => t.includes('policy rate')), `finance bucket missing: ${titles}`);
  });

  it('keeps precise country aliases in the bootstrap rollout fallback', async () => {
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [],
      rpcMarketsByCategory: {},
      hydrated: {
        geopolitical: [
          bootstrapMarket('Will Trump nominate the next Fed chair?', 5_000_000),
          bootstrapMarket('Will the Fed pause rates?', 4_000_000),
          bootstrapMarket('Will The Last of Us win best drama?', 9_000_000),
        ],
        tech: [],
        finance: [],
        fetchedAt: Date.now(),
      },
    };
    const service = await loadPredictionService();
    const out = await service.fetchCountryMarkets('United States', 'US');

    assert.deepEqual(out.map((m: { title: string }) => m.title), [
      'Will Trump nominate the next Fed chair?',
      'Will the Fed pause rates?',
    ]);
  });

  it('uses the UK alias when the literal country name is absent', async () => {
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [],
      rpcMarketsByCategory: {},
      hydrated: {
        geopolitical: [bootstrapMarket('Will the UK hold an early election?', 2_000_000)],
        tech: [],
        finance: [],
        fetchedAt: Date.now(),
      },
    };
    const service = await loadPredictionService();
    const out = await service.fetchCountryMarkets('United Kingdom', 'GB');

    assert.deepEqual(out.map((m: { title: string }) => m.title), [
      'Will the UK hold an early election?',
    ]);
  });
});
