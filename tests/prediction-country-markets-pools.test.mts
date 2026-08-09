// fetchCountryMarkets must reach every pool after #5733 made the producer's
// geopolitical/tech/finance buckets a disjoint partition.
//
// Before the fix, `bootstrap.geopolitical` was an unfiltered copy of every
// market, so BOTH of this function's paths could ignore the tech pool and still
// see tech-classified markets. Now they cannot:
//   - the RPC fan-out must query a tech category, because it early-returns as
//     soon as any geopolitics/economy match is found and would otherwise never
//     reach the fallback below;
//   - the bootstrap fallback must union all three buckets.
// Both holes were live in the same function, so this pins both.
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

describe('fetchCountryMarkets reaches every pool (#5733)', () => {
  it('queries a tech category in the RPC fan-out, not just geopolitics + economy', async () => {
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: {} };
    const service = await loadPredictionService();
    await service.fetchCountryMarkets('China');

    const categories = globalThis.__wmCountryMarketsTestState!.rpcCalls.map((c) => c.category).sort();
    assert.deepEqual(categories, ['economy', 'geopolitics', 'tech']);
  });

  it('does not let a geopolitics hit early-return past the tech pool', async () => {
    // This is the actual defect: the function returns as soon as any
    // geopolitics/economy market matches the country, so a tech-only category
    // would never be seen if it were not in the fan-out above.
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [],
      rpcMarketsByCategory: {
        geopolitics: [protoMarket('Will China invade Taiwan by 2027?', 5_000_000)],
        tech: [protoMarket('Will China ship the best AI model?', 9_000_000)],
      },
    };
    const service = await loadPredictionService();
    const out = await service.fetchCountryMarkets('China');

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
    const out = await service.fetchCountryMarkets('China');

    const titles = out.map((m: { title: string }) => m.title);
    assert.ok(titles.some((t: string) => t.includes('best AI model')), `tech bucket missing: ${titles}`);
    assert.ok(titles.some((t: string) => t.includes('policy rate')), `finance bucket missing: ${titles}`);
  });
});
