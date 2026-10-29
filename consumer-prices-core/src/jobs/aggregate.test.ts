import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client.js', () => ({ query, closePool: vi.fn() }));
vi.mock('../config/loader.js', () => ({
  loadAllBasketConfigs: () => [{
    slug: 'test', marketCode: 'AE', baseDate: '2025-01-01',
    items: [{ category: 'dairy' }, { category: 'bread' }],
  }],
}));
const { aggregateBasket } = await import('./aggregate.js');
const { INDEX_METHODOLOGY_VERSION } = await import('../index-methodology.js');

function basketRow(item: string, category: string, retailer: string, price: number) {
  return { basket_item_id: item, category, weight: '1', retailer_product_id: `${retailer}-${item}`,
    retailer_slug: retailer, price: String(price), unit_price: null, currency_code: 'AED',
    observed_at: new Date('2026-10-29T02:00:00Z') };
}

function indexWrites() {
  return query.mock.calls
    .filter(([sql]) => (sql as string).includes('INSERT INTO computed_indices'))
    .map(([, args]) => args as unknown[]);
}

function respond(basketRows: unknown[], baselineRows: unknown[]) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM baskets')) return { rows: [{ id: 'basket' }] };
    if (sql.includes('FROM baskets b') && sql.includes('JOIN basket_items')) return { rows: basketRows };
    if (sql.includes('FROM price_observations po')) return { rows: baselineRows };
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => { query.mockReset(); });

it('measures prices against each item’s first observed price, not a date before collection began', async () => {
  respond(
    [basketRow('milk', 'dairy', 'a', 12), basketRow('bread', 'bread', 'a', 5)],
    [{ basket_item_id: 'milk', price: '10' }, { basket_item_id: 'bread', price: '5' }],
  );
  await aggregateBasket('test', 'AE');

  const baselineSql = query.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('FROM price_observations po'))!;
  expect(baselineSql).toContain('po.observed_at >= $2::date');
  expect(baselineSql).toContain('MIN(');
  expect(baselineSql).not.toContain("DATE_TRUNC('day', po.observed_at) = $2::date");

  const overall = Object.fromEntries(indexWrites().filter((args) => args.length === 4).map(([, key, value]) => [key, value]));
  expect(overall.essentials_index).toBeCloseTo(110); // milk +20%, bread flat
  expect(overall.value_index).toBeCloseTo(110);
});

it('writes no index instead of a fabricated 100 when no item has a baseline', async () => {
  respond([basketRow('milk', 'dairy', 'a', 12)], []);
  await aggregateBasket('test', 'AE');

  const keys = indexWrites().map((args) => (args.length === 4 ? args[1] : args[2]));
  expect(keys).not.toContain('essentials_index');
  expect(keys).not.toContain('value_index');
  expect(keys).toContain('coverage_pct');
});

it('tags index rows with the first-observation methodology so earlier fallback rows are not compared against', async () => {
  respond([basketRow('milk', 'dairy', 'a', 12)], [{ basket_item_id: 'milk', price: '10' }]);
  await aggregateBasket('test', 'AE');

  const indexSql = query.mock.calls
    .filter(([sql]) => (sql as string).includes('INSERT INTO computed_indices'))
    .map(([sql]) => sql as string);
  for (const sql of indexSql) expect(sql).not.toContain("'1')");

  expect(INDEX_METHODOLOGY_VERSION).toBe('2');
  const writes = indexWrites();
  expect(writes.length).toBeGreaterThan(0);
  for (const args of writes) expect(args[args.length - 1]).toBe(INDEX_METHODOLOGY_VERSION);
});
