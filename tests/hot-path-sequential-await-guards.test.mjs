import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const componentsDir = resolve(repoRoot, 'src/components');

const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

// Panels that used to build their RPC client with two serialized dynamic
// imports:
//
//   const { MarketServiceClient } = await import('@/generated/client/...');
//   const { getRpcBaseUrl } = await import('@/services/rpc-client');
//
// On every panel mount that paid two module round trips before the first
// request could leave. The shared idiom resolves both through the panel
// chunk's static module graph and defers only the client chunk:
//
//   const getMarketClient = createLazyClient(
//     () => new MarketServiceClient(getRpcBaseUrl(), { fetch: rpcFetch }),
//   );
const LAZY_PANEL_CLIENTS = [
  'src/components/CotPositioningPanel.ts',
  'src/components/EarningsCalendarPanel.ts',
  'src/components/EconomicCalendarPanel.ts',
  'src/components/FSIPanel.ts',
  'src/components/FearGreedPanel.ts',
  'src/components/LiquidityShiftsPanel.ts',
  'src/components/MacroTilesPanel.ts',
  'src/components/MarketBreadthPanel.ts',
  'src/components/MaterialEventsPanel.ts',
  'src/components/NqCatalystsPanel.ts',
  'src/components/PositioningPanel.ts',
  'src/components/YieldCurvePanel.ts',
];

const LAZY_PANEL_CLIENT =
  /createLazyClient\(\s*\(\)\s*=>\s*new\s+\w+ServiceClient\(\s*getRpcBaseUrl\(\)/;

function componentSources() {
  return readdirSync(componentsDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      rel: `src/components/${name}`,
      source: readFileSync(join(componentsDir, name), 'utf8'),
    }));
}

describe('panel RPC clients — one module round trip, not two', () => {
  it('no component dynamically imports a generated client', () => {
    // Generated clients reach components through the lazy constructor registry
    // in `@/services/generated-rpc-clients`, which keeps the client chunks out
    // of the initial graph and loads each one at most once.
    const offenders = componentSources()
      .filter(({ source }) => /import\(\s*['"]@\/generated\/client\//.test(source))
      .map(({ rel }) => rel);
    assert.deepEqual(
      offenders,
      [],
      'components must not dynamically import @/generated/client/*; build the client with '
        + 'createLazyClient(() => new XServiceClient(getRpcBaseUrl(), ...)) from '
        + '@/services/generated-rpc-clients so the generated client chunk is loaded lazily and once',
    );
  });

  for (const rel of LAZY_PANEL_CLIENTS) {
    const source = read(rel);

    it(`${rel} builds its client through createLazyClient`, () => {
      assert.match(
        source,
        LAZY_PANEL_CLIENT,
        `${rel} must construct its RPC client with `
          + 'createLazyClient(() => new XServiceClient(getRpcBaseUrl(), ...))',
      );
    });

    it(`${rel} awaits no client factory`, () => {
      assert.doesNotMatch(
        source,
        /await\s+get\w*Client\(\)/,
        `${rel} getters are createLazyClient instances and are synchronous — awaiting one adds a `
          + 'microtask hop before every request and breaks the idiom',
      );
    });
  }
});

describe('first-paint map init — one round trip, not two', () => {
  // The MapLibre stylesheet chunk and the DeckGL renderer chunk are independent
  // and both must land before the first map paint. Serializing them put two
  // round trips on the LCP critical path.
  const source = read('src/components/MapContainer.ts');

  it('fetches the MapLibre stylesheet and the DeckGL chunk together', () => {
    assert.match(source, /import\('\.\/DeckGLMap'\)/);
    assert.doesNotMatch(
      source,
      /^\s*await\s+loadMapLibreCss\(\);/m,
      'await loadMapLibreCss() must not stand alone before the DeckGL import; put both in one '
        + 'Promise.all so the two chunks load in parallel',
    );
  });
});
