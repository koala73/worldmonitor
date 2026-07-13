import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readJson = <T>(path: string): T => JSON.parse(readText(path)) as T;

interface StockEntry {
  symbol: string;
  name: string;
  display: string;
}

interface StockConfig {
  symbols: StockEntry[];
  yahooOnly: string[];
}

const CHINA_BASKET: StockEntry[] = [
  { symbol: '000001.SS', name: 'Shanghai Composite', display: 'SSEC' },
  { symbol: '^HSI', name: 'Hang Seng', display: 'HSI' },
  { symbol: '600519.SS', name: 'Kweichow Moutai', display: 'MOUTAI' },
  { symbol: '601318.SS', name: 'Ping An Insurance', display: 'PINGAN-A' },
  { symbol: '600900.SS', name: 'China Yangtze Power', display: 'CYPC' },
  { symbol: '300750.SZ', name: 'CATL', display: 'CATL' },
  { symbol: '688981.SS', name: 'SMIC', display: 'SMIC-A' },
  { symbol: '0700.HK', name: 'Tencent', display: 'TENCENT' },
  { symbol: '1211.HK', name: 'BYD', display: 'BYD-H' },
  { symbol: '0939.HK', name: 'China Construction Bank', display: 'CCB-H' },
  { symbol: '0857.HK', name: 'PetroChina', display: 'PETROCHINA-H' },
];

const CLIENT_VARIANT_BLOCKS: Record<string, string> = {
  full: 'FULL_FEEDS',
  finance: 'FINANCE_FEEDS',
};

function clientCategoryBlock(variant: string, category: string): string | null {
  const src = readText('src/config/feeds.ts');
  const variantBlock = CLIENT_VARIANT_BLOCKS[variant];
  assert.ok(variantBlock, `client variant ${variant} must have a feed block mapping`);
  const variantMarker = `const ${variantBlock}: Record<string, Feed[]> = {`;
  const variantStart = src.indexOf(variantMarker);
  assert.notEqual(variantStart, -1, `client variant block ${variantBlock} must exist`);
  const variantRest = src.slice(variantStart + variantMarker.length);
  const nextVariant = variantRest.search(/^const [A-Z_]+_FEEDS:/m);
  const variantBody = nextVariant === -1 ? variantRest : variantRest.slice(0, nextVariant);
  const marker = `  ${category}: [`;
  const start = variantBody.indexOf(marker);
  if (start === -1) return null;
  const bodyStart = start + marker.length;
  const rest = variantBody.slice(bodyStart);
  const nextCategory = rest.search(/^ {2}[A-Za-z][\w-]*:\s*\[/m);
  return nextCategory === -1 ? rest : rest.slice(0, nextCategory);
}

function clientRouteClass(variant: string, category: string, name: string): 'google-news' | 'direct' | null {
  const block = clientCategoryBlock(variant, category);
  if (!block) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`name:\\s*['"]${escaped}['"][^\\n]*url:\\s*([^\\n]+)`));
  if (!match) return null;
  return /news\.google\.com\/rss\/search/i.test(match[1]!) ? 'google-news' : 'direct';
}

function serverRouteClass(variant: string, category: string, name: string): 'google-news' | 'direct' | null {
  const feed = VARIANT_FEEDS[variant]?.[category]?.find((entry) => entry.name === name);
  if (!feed) return null;
  return /news\.google\.com\/rss\/search/i.test(feed.url) ? 'google-news' : 'direct';
}

describe('China A/H-share market coverage (#5272)', () => {
  const canonical = readJson<StockConfig>('shared/stocks.json');
  const railwayMirror = readJson<StockConfig>('scripts/shared/stocks.json');

  it('ships a compact exchange-qualified cross-sector basket with display metadata', () => {
    const actual = new Map(canonical.symbols.map((entry) => [entry.symbol, entry]));
    for (const expected of CHINA_BASKET) {
      assert.deepEqual(actual.get(expected.symbol), expected, `${expected.symbol} metadata drifted or is missing`);
      assert.ok(canonical.yahooOnly.includes(expected.symbol), `${expected.symbol} must use the Yahoo relay path`);
    }
  });

  it('keeps the browser and Railway stock configurations identical', () => {
    assert.deepEqual(railwayMirror, canonical);
  });

  it('makes the long-running Railway relay consume stock symbols and metadata from the shared config', () => {
    const relay = readText('scripts/ais-relay.cjs');
    assert.match(relay, /const _stockCfg = requireShared\('stocks\.json'\)/);
    assert.match(relay, /const MARKET_SYMBOLS = _stockCfg\.symbols\.map\(\(s\) => s\.symbol\)/);
    assert.match(relay, /const MARKET_META = new Map\(_stockCfg\.symbols\.map/);
  });

  it('keeps available quotes when one requested China symbol is unavailable', async () => {
    const { filterMarketQuotes } = await import('../server/worldmonitor/market/v1/list-market-quotes.ts');
    const response = filterMarketQuotes({
      quotes: [
        { symbol: '600519.SS', name: 'Kweichow Moutai', display: 'MOUTAI', price: 1400, change: 1, sparkline: [] },
        { symbol: '0700.HK', name: 'Tencent', display: 'TENCENT', price: 520, change: -0.5, sparkline: [] },
      ],
      finnhubSkipped: true,
      skipReason: 'test fallback',
      rateLimited: false,
    }, ['600519.SS', '999999.SS', '0700.HK']);

    assert.deepEqual(response.quotes.map((quote) => quote.symbol), ['600519.SS', '0700.HK']);
    assert.equal(response.finnhubSkipped, true);
    assert.equal(response.skipReason, 'test fallback');
  });
});

describe('China client/server news digest parity (#5272)', () => {
  const expectedMembership = new Map<string, { variant: string; category: string }>([
    ['Xinhua', { variant: 'full', category: 'asia' }],
    ['MIIT (China)', { variant: 'full', category: 'asia' }],
    ['MOFCOM (China)', { variant: 'full', category: 'asia' }],
    ['PBoC Watch', { variant: 'finance', category: 'centralbanks' }],
  ]);

  for (const [name, { variant, category }] of expectedMembership) {
    it(`${name} matches client/server ${variant}.${category} membership and routing class`, () => {
      const clientRoute = clientRouteClass(variant, category, name);
      const serverRoute = serverRouteClass(variant, category, name);
      assert.notEqual(clientRoute, null, `${name} must remain in client ${category}`);
      assert.notEqual(serverRoute, null, `${name} must be present in server ${category}`);
      assert.equal(serverRoute, clientRoute, `${name} client/server routing class drifted`);
      const otherVariant = variant === 'full' ? 'finance' : 'full';
      assert.equal(
        clientRouteClass(otherVariant, category, name),
        null,
        `${name} must not be found in client ${otherVariant}.${category}`,
      );
    });
  }

  it('keeps China source-tier and state-affiliation disclosures intact', () => {
    const tiers = readJson<Record<string, number>>('shared/source-tiers.json');
    assert.equal(tiers['MIIT (China)'], 1);
    assert.equal(tiers['MOFCOM (China)'], 1);
    assert.equal(tiers.Xinhua, 3);
    assert.equal(readText('scripts/shared/source-tiers.json'), readText('shared/source-tiers.json'));
    assert.match(
      readText('src/config/feeds.ts'),
      /'Xinhua':\s*\{\s*risk:\s*'high',\s*stateAffiliated:\s*'China'/,
    );
  });
});
