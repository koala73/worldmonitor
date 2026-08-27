import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path: string) => readFileSync(resolve(root, path), 'utf8');

function parseLiteralRanges(source: string, label: string): string[] {
  const match = source.match(/VALID_RANGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  assert.ok(match, `${label} must declare VALID_RANGES as a literal Set`);
  return [...match[1].matchAll(/['"](\d+d)['"]/g)].map((entry) => entry[1]);
}

function parsePublishRanges(source: string, builder: string): string[] {
  const loop = [...source.matchAll(/for \(const range of \[([^\]]+)\]\) \{([\s\S]*?)\n\s*\}/g)]
    .find((entry) => entry[2].includes(builder));
  assert.ok(loop, `publish.ts must fan out ${builder} from a literal range list`);
  return [...loop[1].matchAll(/['"](\d+d)['"]/g)].map((entry) => entry[1]);
}

function parseProtoRanges(source: string, label: string): string[] {
  const match = source.match(/range is one of ([^.]+)\./);
  assert.ok(match, `${label} must document its accepted ranges`);
  return [...match[1].matchAll(/"(\d+d)"/g)].map((entry) => entry[1]);
}

function parseManualSeederWrites(source: string): Array<{ key: string; metaKey: string }> {
  const sourceFile = ts.createSourceFile(
    'seed-consumer-prices.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let writesDeclaration: ts.VariableDeclaration | undefined;
  const findWrites = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'writes'
    ) {
      writesDeclaration = node;
      return;
    }
    ts.forEachChild(node, findWrites);
  };
  findWrites(sourceFile);

  const initializer = writesDeclaration?.initializer;
  assert.ok(initializer && ts.isArrayLiteralExpression(initializer), 'manual seeder must declare writes as an array');

  return initializer.elements.map((element, index) => {
    assert.ok(ts.isObjectLiteralExpression(element), `writes[${index}] must be an object literal`);
    const readTemplateProperty = (name: string): string | null => {
      const property = element.properties.find((candidate) => (
        ts.isPropertyAssignment(candidate)
        && ts.isIdentifier(candidate.name)
        && candidate.name.text === name
      ));
      assert.ok(property && ts.isPropertyAssignment(property), `writes[${index}] must declare ${name}`);
      if (!ts.isTemplateExpression(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer)) {
        return null;
      }
      return property.initializer.getText(sourceFile).slice(1, -1);
    };
    const key = readTemplateProperty('key');
    const metaKey = readTemplateProperty('metaKey');
    return key && metaKey ? { key, metaKey } : null;
  }).filter((entry): entry is { key: string; metaKey: string } => entry !== null);
}

function assertManualSeederWritesRange(
  writes: Array<{ key: string; metaKey: string }>,
  dataset: string,
  suffix: string,
  range: string,
): void {
  const canonicalKey = `consumer-prices:${dataset}:\${MARKET}${suffix}:${range}`;
  const seedMetaKey = `seed-meta:${canonicalKey}`;
  assert.ok(
    writes.some((entry) => entry.key === canonicalKey && entry.metaKey === seedMetaKey),
    `manual seeder must write ${canonicalKey} with ${seedMetaKey}`,
  );
}

describe('consumer-prices range producer parity', () => {
  it('keeps both handler range sets aligned with the manual and authoritative producers', () => {
    const basketHandlerRanges = parseLiteralRanges(
      readSource('server/worldmonitor/consumer-prices/v1/get-consumer-price-basket-series.ts'),
      'basket-series handler',
    );
    const categoriesHandlerRanges = parseLiteralRanges(
      readSource('server/worldmonitor/consumer-prices/v1/list-consumer-price-categories.ts'),
      'categories handler',
    );
    const manualSeeder = readSource('scripts/seed-consumer-prices.mjs');
    const manualWrites = parseManualSeederWrites(manualSeeder);
    const publisher = readSource('consumer-prices-core/src/jobs/publish.ts');
    const basketProto = readSource(
      'proto/worldmonitor/consumer_prices/v1/get_consumer_price_basket_series.proto',
    );
    const categoriesProto = readSource(
      'proto/worldmonitor/consumer_prices/v1/list_consumer_price_categories.proto',
    );

    assert.deepEqual(
      parsePublishRanges(publisher, 'buildBasketSeriesSnapshot'),
      basketHandlerRanges,
      'authoritative basket-series publisher ranges must match the handler',
    );
    assert.deepEqual(
      parsePublishRanges(publisher, 'buildCategoriesSnapshot'),
      categoriesHandlerRanges,
      'authoritative categories publisher ranges must match the handler',
    );
    assert.deepEqual(
      parseProtoRanges(basketProto, 'basket-series proto'),
      basketHandlerRanges,
      'basket-series proto ranges must match the handler',
    );
    assert.deepEqual(
      parseProtoRanges(categoriesProto, 'categories proto'),
      categoriesHandlerRanges,
      'categories proto ranges must match the handler',
    );
    assert.match(basketProto, /Unsupported values use "30d"\./);
    assert.match(categoriesProto, /Unsupported values use "30d"\./);
    assert.match(
      basketProto,
      /range is the effective normalized range used for the returned snapshot\./,
    );
    assert.match(
      categoriesProto,
      /range is the effective normalized range used for the returned snapshot\./,
    );

    for (const range of basketHandlerRanges) {
      assertManualSeederWritesRange(manualWrites, 'basket-series', ':${BASKET}', range);
    }
    for (const range of categoriesHandlerRanges) {
      assertManualSeederWritesRange(manualWrites, 'categories', '', range);
    }
  });
});

const cacheStore = new Map<string, unknown>();
const requestedKeys: string[] = [];
const originalFetch = globalThis.fetch;

let getConsumerPriceBasketSeries: typeof import('../server/worldmonitor/consumer-prices/v1/get-consumer-price-basket-series.ts').getConsumerPriceBasketSeries;
let listConsumerPriceCategories: typeof import('../server/worldmonitor/consumer-prices/v1/list-consumer-price-categories.ts').listConsumerPriceCategories;

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';

  mock.method(globalThis, 'fetch', async (url, init) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const match = href.match(/\/get\/([^/?#]+)$/);
    if (!match) return originalFetch(url, init);

    const key = decodeURIComponent(match[1]);
    requestedKeys.push(key);
    const value = cacheStore.get(key);
    return new Response(JSON.stringify({ result: value === undefined ? null : JSON.stringify(value) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  ({ getConsumerPriceBasketSeries } = await import('../server/worldmonitor/consumer-prices/v1/get-consumer-price-basket-series.ts'));
  ({ listConsumerPriceCategories } = await import('../server/worldmonitor/consumer-prices/v1/list-consumer-price-categories.ts'));
});

after(() => {
  mock.restoreAll();
});

beforeEach(() => {
  cacheStore.clear();
  requestedKeys.length = 0;
});

describe('consumer-prices unsupported range fallback', () => {
  it('serves the backed 30d basket series for range=180d without reporting an upstream fault', async () => {
    const expected = {
      marketCode: 'ae',
      basketSlug: 'essentials-ae',
      asOf: '1787788800000',
      currencyCode: 'AED',
      range: '30d',
      essentialsSeries: [{ date: '2026-08-27', index: 101.2 }],
      valueSeries: [{ date: '2026-08-27', index: 99.8 }],
      upstreamUnavailable: false,
    };
    cacheStore.set('consumer-prices:basket-series:ae:essentials-ae:30d', expected);

    const response = await getConsumerPriceBasketSeries({}, {
      marketCode: 'ae',
      basketSlug: 'essentials-ae',
      range: '180d',
    });

    assert.deepEqual(response, expected);
    assert.deepEqual(requestedKeys, ['consumer-prices:basket-series:ae:essentials-ae:30d']);
  });

  it('serves the backed 30d categories for range=180d without reporting an upstream fault', async () => {
    const expected = {
      marketCode: 'ae',
      asOf: '1787788800000',
      range: '30d',
      categories: [{
        slug: 'dairy',
        name: 'Dairy',
        wowPct: 0.3,
        momPct: 1.2,
        currentIndex: 101.2,
        sparkline: [100, 101.2],
        coveragePct: 100,
        itemCount: 10,
      }],
      upstreamUnavailable: false,
    };
    cacheStore.set('consumer-prices:categories:ae:30d', expected);

    const response = await listConsumerPriceCategories({}, {
      marketCode: 'ae',
      basketSlug: 'essentials-ae',
      range: '180d',
    });

    assert.deepEqual(response, expected);
    assert.deepEqual(requestedKeys, ['consumer-prices:categories:ae:30d']);
  });
});
