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
  // Production returns dataAvailable: true whenever the country index exists,
  // including ISO2 codes with no records. An omitted or false value keeps the rollout fallback.
  rpcDataAvailable?: boolean;
  rpcFetchedAt?: number;
  rpcFailure?: boolean;
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
          if (state.rpcFailure) throw new Error('Controlled RPC failure');
          return {
            markets: state.rpcMarketsByCategory[req.category] ?? [],
            ...(state.rpcDataAvailable === undefined ? {} : { dataAvailable: state.rpcDataAvailable }),
            ...(state.rpcFetchedAt === undefined ? {} : { fetchedAt: state.rpcFetchedAt }),
          };
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

describe('original country contract metadata', () => {
  it('preserves the original website RPC list clock while keeping legacy array results', async () => {
    const originalClock = Date.parse('2026-10-09T07:41:45.410Z');
    const rows = Array.from({ length: 6 }, (_, index) => ({ ...protoMarket(`China contract ${index}`, 500 - index), id: `original-${index}` }));
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: { 'country:CN': rows }, rpcDataAvailable: true, rpcFetchedAt: originalClock };
    const service = await loadPredictionService();
    const result = await service.fetchCountryMarketsWithMetadata('China', 'CN');
    assert.equal(result.fetchedAt, originalClock);
    assert.deepEqual(result.markets.map((row: { id: string }) => row.id), rows.slice(0, 5).map(row => row.id));
    assert.deepEqual(await service.fetchCountryMarkets('China', 'CN'), result.markets);
    assert.equal(globalThis.__wmCountryMarketsTestState.rpcCalls.length, 2);
  });

  it('preserves a valid empty RPC list clock without using bootstrap fallback', async () => {
    const originalClock = Date.parse('2026-10-09T07:41:45.410Z');
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: {}, rpcDataAvailable: true, rpcFetchedAt: originalClock, hydrated: { geopolitical: [bootstrapMarket('Will China host the meeting?', 500)], tech: [], fetchedAt: originalClock + 1 } };
    const service = await loadPredictionService();
    assert.deepEqual(await service.fetchCountryMarketsWithMetadata('China', 'CN'), { markets: [], fetchedAt: originalClock });
  });

  it('keeps fallback clocks unknown after unavailable and failed RPC replies', async () => {
    const fallback = bootstrapMarket('Will China host the meeting?', 500);
    const service = await loadPredictionService();
    for (const rpcFailure of [false, true]) {
      globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: {}, rpcDataAvailable: false, rpcFetchedAt: 1791531705410, rpcFailure, hydrated: { geopolitical: [fallback], tech: [], fetchedAt: 1791531705420 } };
      assert.deepEqual(await service.fetchCountryMarketsWithMetadata('China', 'CN'), { markets: [fallback] });
    }
  });

  it('keeps an absent RPC clock and an empty fallback unknown', async () => {
    const service = await loadPredictionService();
    const row = protoMarket('China contract', 500);
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: { 'country:CN': [row] }, rpcDataAvailable: true };
    const result = await service.fetchCountryMarketsWithMetadata('China', 'CN');
    assert.equal(result.fetchedAt, undefined);
    assert.equal(result.markets[0].id, row.id);
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: {}, rpcDataAvailable: false, rpcFetchedAt: 1791531705410 };
    assert.deepEqual(await service.fetchCountryMarketsWithMetadata('China', 'CN'), { markets: [] });
  });

  it('retains distinct original RPC identifiers sharing one display link and exact probability', async () => {
    const service = await loadPredictionService();
    const first = { ...protoMarket('China controlled contract', 500), id: 'KXCHINA-27-T4', yesPrice: 0.6849, source: 'MARKET_SOURCE_KALSHI', url: 'https://kalshi.com/markets/kxchina' };
    const second = { ...first, id: 'KXCHINA-28-T4' };
    const mapped = [first, second].map(service.protoToMarket);
    assert.deepEqual(mapped.map((row: { id?: string }) => row.id), [first.id, second.id]);
    assert.equal(mapped[0].yesPrice, first.yesPrice * 100);
    assert.equal(mapped[0].url, first.url);
    const { id: ignoredId, ...withoutId } = first;
    assert.equal(service.protoToMarket(withoutId).id, undefined);
  });
});

describe('fetchCountryMarkets uses the producer country index', () => {
  it('preserves distinct Kalshi contracts sharing a series landing in bootstrap fallback', async () => {
    const first = { ...bootstrapMarket('Will China host the meeting in 2027?', 30000), source: 'kalshi', url: 'https://kalshi.com/markets/KXMEETING-27-CN', displayUrl: 'https://kalshi.com/markets/kxmeeting' };
    const second = { ...first, title: 'Will China host the meeting in 2028?', url: 'https://kalshi.com/markets/KXMEETING-28-CN', volume: 40000 };
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [], rpcMarketsByCategory: {}, rpcDataAvailable: false,
      hydrated: { geopolitical: [first], tech: [], finance: [second], fetchedAt: Date.now() },
    };
    const service = await loadPredictionService();
    const rows = await service.fetchCountryMarkets('China', 'CN');
    assert.deepEqual(rows.map((row: { title: string }) => row.title), [second.title, first.title]);
    assert.deepEqual(rows.map((row: { url: string }) => row.url), [second.url, first.url]);
    assert.ok(rows.every((row: { displayUrl: string }) => row.displayUrl === first.displayUrl));
  });

  it('preserves identity and display destination for ordinary hydrated prediction cards', async () => {
    const row = { ...bootstrapMarket('Will China host the meeting?', 30000), source: 'kalshi', url: 'https://kalshi.com/markets/KXMEETING-27-CN', displayUrl: 'https://kalshi.com/markets/kxmeeting' };
    globalThis.__wmCountryMarketsTestState = { rpcCalls: [], rpcMarketsByCategory: {}, hydrated: { geopolitical: [row], tech: [], finance: [], fetchedAt: Date.now() } };
    const service = await loadPredictionService();
    const result = await service.fetchPredictionCandidates();
    assert.equal(result.displayed[0].url, row.url);
    assert.equal(result.displayed[0].displayUrl, row.displayUrl);
    assert.equal(result.displayed[0].source, 'kalshi');
    assert.equal((globalThis.__wmCountryMarketsTestState!.hydrated as { geopolitical: { url: string }[] }).geopolitical[0].url, row.url);
  });

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

  it('returns empty when the country index is authoritative but has no ISO2 records', async () => {
    globalThis.__wmCountryMarketsTestState = {
      rpcCalls: [],
      rpcMarketsByCategory: { 'country:CN': [] },
      rpcDataAvailable: true,
      hydrated: {
        geopolitical: [],
        tech: [bootstrapMarket('Will China ship the best AI model', 9_000_000)],
        finance: [bootstrapMarket('Will China cut its policy rate', 4_000_000)],
        fetchedAt: Date.now(),
      },
    };
    const service = await loadPredictionService();
    const out = await service.fetchCountryMarkets('China', 'CN');

    assert.deepEqual(out, []);
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

  it('uses the shared country vocabulary in the bootstrap fallback', async () => {
    const cases = [
      ['France', 'FR', 'Will the French government survive the confidence vote?'],
      ['Germany', 'DE', 'Will the German chancellor call an early election?'],
      ['Saudi Arabia', 'SA', 'Will Saudi cut oil production this year?'],
      ['United Kingdom', 'GB', 'Will the UK hold an early election?'],
    ] as const;

    for (const [country, countryCode, title] of cases) {
      globalThis.__wmCountryMarketsTestState = {
        rpcCalls: [],
        rpcMarketsByCategory: {},
        hydrated: {
          geopolitical: [bootstrapMarket(title, 2_000_000)],
          tech: [],
          finance: [],
          fetchedAt: Date.now(),
        },
      };
      const service = await loadPredictionService();
      const out = await service.fetchCountryMarkets(country, countryCode);

      assert.deepEqual(out.map((m: { title: string }) => m.title), [title], countryCode);
    }
  });

  it('excludes the Norwegian Cruise brand while preserving independent Norway evidence in the fallback', async () => {
    const cases = [
      ['Norwegian Cruise passengers carried in 2026: Above 3.25 million', false],
      ['Will Norway hold an early election?', true],
      ['Will the Norwegian government hold an early election?', true],
      ['Will Norwegians approve the referendum?', true],
      ['Will Norwegian Cruise expand service to Norway?', true],
      ['Will Norwegian Cruise comply with Norwegian government rules?', true],
      ['Will Norwegian cruise tourism exceed 2025 levels?', true],
      ['Will a Norwegian cruise ship enter Russian waters?', true],
    ] as const;

    const actual: string[][] = [];
    const expectedTitles: string[][] = [];
    for (const rpcDataAvailable of [false, undefined]) {
      for (const [title, expected] of cases) {
        globalThis.__wmCountryMarketsTestState = {
          rpcCalls: [],
          rpcMarketsByCategory: {},
          rpcDataAvailable,
          hydrated: {
            geopolitical: [{ ...bootstrapMarket(title, 10_000), source: 'kalshi' }],
            tech: [],
            finance: [],
            fetchedAt: Date.now(),
          },
        };
        const service = await loadPredictionService();
        const out = await service.fetchCountryMarkets('Norway', 'NO');
        actual.push(out.map((entry: { title: string }) => entry.title));
        expectedTitles.push(expected ? [title] : []);
      }
    }
    assert.deepEqual(actual, expectedTitles);
  });

  it('keeps excluded demonym phrases out of the bootstrap fallback', async () => {
    const cases = [
      ['France', 'FR', 'Will French Hill win reelection?'],
      ['Netherlands', 'NL', 'Will Dutch Bros beat earnings?'],
      ['India', 'IN', 'Will Indian Wells expand the tournament?'],
      ['Greece', 'GR', 'Will Greek letters appear in the product name?'],
    ] as const;

    for (const [country, countryCode, title] of cases) {
      globalThis.__wmCountryMarketsTestState = {
        rpcCalls: [],
        rpcMarketsByCategory: {},
        hydrated: {
          geopolitical: [bootstrapMarket(title, 2_000_000)],
          tech: [],
          finance: [],
          fetchedAt: Date.now(),
        },
      };
      const service = await loadPredictionService();
      const out = await service.fetchCountryMarkets(country, countryCode);

      assert.deepEqual(out, [], countryCode);
    }
  });

  it('suppresses shadowed and embedded country names in the bootstrap fallback', async () => {
    const cases = [
      ['Republic of the Congo', 'CG', 'Will Democratic Republic of the Congo hold an election?'],
      ['Republic of the Congo', 'CG', 'Will Kinshasa, Congo hold a local election?'],
      ['Sudan', 'SD', 'Will South Sudan reach a peace agreement?'],
      ['Guinea', 'GN', 'Will Equatorial Guinea increase oil output?'],
    ] as const;

    for (const [country, countryCode, title] of cases) {
      globalThis.__wmCountryMarketsTestState = {
        rpcCalls: [],
        rpcMarketsByCategory: {},
        hydrated: {
          geopolitical: [bootstrapMarket(title, 2_000_000)],
          tech: [],
          finance: [],
          fetchedAt: Date.now(),
        },
      };
      const service = await loadPredictionService();
      const out = await service.fetchCountryMarkets(country, countryCode);

      assert.deepEqual(out, [], `${countryCode} must not claim ${title}`);
    }
  });

  it('keeps the specific country on overlapping titles in the bootstrap fallback', async () => {
    const cases = [
      ['DR Congo', 'CD', 'Will Democratic Republic of the Congo hold an election?'],
      ['DR Congo', 'CD', 'Will Kinshasa, Congo hold a local election?'],
      ['South Sudan', 'SS', 'Will South Sudan reach a peace agreement?'],
      ['Equatorial Guinea', 'GQ', 'Will Equatorial Guinea increase oil output?'],
    ] as const;

    for (const [country, countryCode, title] of cases) {
      globalThis.__wmCountryMarketsTestState = {
        rpcCalls: [],
        rpcMarketsByCategory: {},
        hydrated: {
          geopolitical: [bootstrapMarket(title, 2_000_000)],
          tech: [],
          finance: [],
          fetchedAt: Date.now(),
        },
      };
      const service = await loadPredictionService();
      const out = await service.fetchCountryMarkets(country, countryCode);

      assert.deepEqual(out.map((m: { title: string }) => m.title), [title], countryCode);
    }
  });
});
