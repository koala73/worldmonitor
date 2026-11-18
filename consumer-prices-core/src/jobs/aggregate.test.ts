import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client.js', () => ({ query, closePool: vi.fn(), withTransaction: (fn: (q: typeof query) => unknown) => fn(query) }));
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

const RUN_DATE = '2026-11-18';
function runDateRow(date: string, hasInputs = true) {
  return { rows: [{ metric_date: date, has_inputs: hasInputs }] };
}

function indexWrites() {
  return query.mock.calls
    .filter(([sql]) => (sql as string).includes('INSERT INTO computed_indices'))
    .map(([, args]) => args as unknown[]);
}

function respond(basketRows: unknown[], baselineRows: unknown[]) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM baskets')) return { rows: [{ id: 'basket' }] };
    if (sql.includes('has_inputs')) return runDateRow(RUN_DATE);
    if (sql.includes('FROM baskets b') && sql.includes('JOIN basket_items')) return { rows: basketRows };
    if (sql.includes('WITH obs AS')) return { rows: baselineRows };
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

  const baselineSql = query.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('WITH obs AS'))!;
  expect(baselineSql).toContain('po.observed_at >= $2::date');
  expect(baselineSql).toContain('MIN(');
  expect(baselineSql).not.toContain("DATE_TRUNC('day', po.observed_at) = $2::date");

  const overall = Object.fromEntries(indexWrites().filter((args) => args.length === 5).map(([, , key, value]) => [key, value]));
  expect(overall.essentials_index).toBeCloseTo(110); // milk +20%, bread flat
  expect(overall.value_index).toBeCloseTo(110);
});

it('writes no index instead of a fabricated 100 when no item has a baseline', async () => {
  respond([basketRow('milk', 'dairy', 'a', 12)], []);
  await aggregateBasket('test', 'AE');

  const keys = indexWrites().map((args) => (args.length === 5 ? args[2] : args[3]));
  expect(keys).not.toContain('essentials_index');
  expect(keys).not.toContain('value_index');
  expect(keys).toContain('coverage_pct');
});

it('tags index rows with the chained methodology so earlier rows with composition jumps are not compared against', async () => {
  respond([basketRow('milk', 'dairy', 'a', 12)], [{ basket_item_id: 'milk', price: '10' }]);
  await aggregateBasket('test', 'AE');

  const indexSql = query.mock.calls
    .filter(([sql]) => (sql as string).includes('INSERT INTO computed_indices'))
    .map(([sql]) => sql as string);
  for (const sql of indexSql) expect(sql).not.toContain("'1')");

  expect(INDEX_METHODOLOGY_VERSION).toBe('3');
  const writes = indexWrites();
  expect(writes.length).toBeGreaterThan(0);
  for (const args of writes) expect(args[args.length - 1]).toBe(INDEX_METHODOLOGY_VERSION);
});

// Day-by-day runs against a fake store. Each run keeps the index rows and the
// index inputs it wrote, so the next run reads them back as the previous day.
type Row = ReturnType<typeof basketRow>;
let indexHistory: { date: string; category: string | null; key: string; value: number }[] = [];
let inputHistory: { date: string; item: string; product: string; price: number }[] = [];

async function runDay(date: string, rows: Row[], baselineRows: unknown[], hasInputs = true) {
  query.mockReset();
  query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SELECT id FROM baskets')) return { rows: [{ id: 'basket' }] };
    if (sql.includes('has_inputs')) return runDateRow(date, hasInputs);
    if (sql.includes('FROM baskets b') && sql.includes('JOIN basket_items')) return { rows };
    if (sql.includes('WITH obs AS')) return { rows: baselineRows };
    if (sql.includes('FROM computed_indices') && sql.includes('metric_date < $3::date')) {
      const latest = new Map<string, (typeof indexHistory)[number]>();
      for (const h of indexHistory) {
        if (h.date >= (args[2] as string)) continue;
        const k = `${h.category}|${h.key}`;
        if (!latest.has(k) || latest.get(k)!.date < h.date) latest.set(k, h);
      }
      return { rows: [...latest.values()].map((h) => ({ category: h.category, metric_key: h.key, metric_date: h.date, metric_value: String(h.value) })) };
    }
    if (sql.includes('FROM computed_index_inputs')) {
      const days = args[1] as string[];
      return { rows: inputHistory.filter((i) => days.includes(i.date))
        .map((i) => ({ metric_date: i.date, basket_item_id: i.item, retailer_product_id: i.product, price: String(i.price) })) };
    }
    if (sql.includes('DELETE FROM computed_index_inputs')) {
      inputHistory = inputHistory.filter((i) => i.date !== args[1]);
    }
    if (sql.includes('INSERT INTO computed_index_inputs')) {
      const [, d, items, products, prices] = args as [string, string, string[], string[], number[]];
      items.forEach((item, n) => inputHistory.push({ date: d, item, product: products[n], price: prices[n] }));
    }
    if (sql.includes('INSERT INTO computed_indices')) {
      const a = args;
      const [category, key, value] = a.length === 5 ? [null, a[2], a[3]] : [a[a.length - 4], a[a.length - 3], a[a.length - 2]];
      indexHistory = indexHistory.filter((h) => !(h.date === a[1] && h.category === category && h.key === key));
      indexHistory.push({ date: a[1] as string, category: category as string | null, key: key as string, value: value as number });
    }
    return { rows: [], rowCount: 1 };
  });
  await aggregateBasket('test', 'AE');
}

function indexOn(date: string, key = 'essentials_index', category: string | null = null) {
  return indexHistory.find((h) => h.date === date && h.key === key && h.category === category)?.value;
}

describe('index composition: products and items leaving or joining the basket', () => {
  beforeEach(() => { indexHistory = []; inputHistory = []; });
  const baselines = [{ basket_item_id: 'milk', price: '10' }, { basket_item_id: 'bread', price: '5' }];

  it('holds when one of two retailers stops listing an item and no price changed', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 12), basketRow('milk', 'dairy', 'b', 8), basketRow('bread', 'bread', 'a', 5)], baselines);
    await runDay('2026-11-13', [basketRow('milk', 'dairy', 'b', 8), basketRow('bread', 'bread', 'a', 5)], baselines);
    expect(indexOn('2026-11-12')).toBeCloseTo(100);
    expect(indexOn('2026-11-13')).toBeCloseTo(100);
    expect(indexOn('2026-11-13', 'value_index')).toBeCloseTo(indexOn('2026-11-12', 'value_index')!);
    expect(indexOn('2026-11-13', 'essentials_index', 'dairy')).toBeCloseTo(indexOn('2026-11-12', 'essentials_index', 'dairy')!);
  });

  it('holds when a retailer joins an item at a price below its peers', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 15), basketRow('bread', 'bread', 'a', 5)], baselines);
    await runDay('2026-11-13', [basketRow('milk', 'dairy', 'a', 15), basketRow('milk', 'dairy', 'b', 10), basketRow('bread', 'bread', 'a', 5)], baselines);
    expect(indexOn('2026-11-12')).toBeCloseTo(125);
    expect(indexOn('2026-11-13')).toBeCloseTo(125);
  });

  it('holds when a whole item drops out, and again when it returns at the same price', async () => {
    const both = [basketRow('milk', 'dairy', 'a', 12), basketRow('bread', 'bread', 'a', 5)];
    await runDay('2026-11-12', both, baselines);
    await runDay('2026-11-13', [basketRow('bread', 'bread', 'a', 5)], baselines);
    await runDay('2026-11-14', both, baselines);
    expect(indexOn('2026-11-12')).toBeCloseTo(110);
    expect(indexOn('2026-11-13')).toBeCloseTo(110);
    expect(indexOn('2026-11-14')).toBeCloseTo(110);
  });

  it('holds a category index when one of its items drops out', async () => {
    const cheese = { basket_item_id: 'cheese', price: '20' };
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 15), basketRow('cheese', 'dairy', 'a', 20)], [...baselines, cheese]);
    await runDay('2026-11-13', [basketRow('cheese', 'dairy', 'a', 20)], [...baselines, cheese]);
    expect(indexOn('2026-11-12', 'essentials_index', 'dairy')).toBeCloseTo(125);
    expect(indexOn('2026-11-13', 'essentials_index', 'dairy')).toBeCloseTo(125);
  });

  it('still moves by the real change in prices that were observed on both days', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 12), basketRow('bread', 'bread', 'a', 5)], baselines);
    await runDay('2026-11-13', [basketRow('milk', 'dairy', 'a', 13.2), basketRow('bread', 'bread', 'a', 5)], baselines);
    // Same as measuring both items against their baselines directly: (1.32 + 1) / 2.
    expect(indexOn('2026-11-13')).toBeCloseTo(116);
    expect(indexOn('2026-11-13', 'essentials_index', 'dairy')).toBeCloseTo(132);
  });

  it('gives the same value when the job reruns on the same day', async () => {
    const day1 = [basketRow('milk', 'dairy', 'a', 12), basketRow('bread', 'bread', 'a', 5)];
    const day2 = [basketRow('milk', 'dairy', 'a', 13.2), basketRow('bread', 'bread', 'a', 5)];
    await runDay('2026-11-12', day1, baselines);
    await runDay('2026-11-13', day2, baselines);
    const first = indexOn('2026-11-13');
    await runDay('2026-11-13', day2, baselines);
    expect(indexOn('2026-11-13')).toBeCloseTo(first!);
  });
  it('links in at the previous level when every product in an item was replaced', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 12)], baselines);
    await runDay('2026-11-13', [basketRow('milk', 'dairy', 'b', 8)], baselines);
    expect(indexOn('2026-11-12', 'essentials_index', 'dairy')).toBeCloseTo(120);
    expect(indexOn('2026-11-13', 'essentials_index', 'dairy')).toBeCloseTo(120);
  });

  it('chains from the prices the anchor row was computed from, after a gap day', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 10), basketRow('bread', 'bread', 'a', 5)], baselines);
    // 11-13 never aggregated; 11-14 measures against 11-12's stored inputs.
    await runDay('2026-11-14', [basketRow('milk', 'dairy', 'a', 11), basketRow('bread', 'bread', 'a', 5)], baselines);
    expect(indexOn('2026-11-14')).toBeCloseTo(105);
    expect(inputHistory.filter((i) => i.date === '2026-11-14').map((i) => [i.item, i.product, i.price]))
      .toEqual([['milk', 'a-milk', 11], ['bread', 'a-bread', 5]]);
  });

  it('writes no index, rather than an unchained one, while the inputs table is missing', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 12)], baselines, false);
    expect(indexOn('2026-11-12')).toBeUndefined();
    expect(indexOn('2026-11-12', 'value_index')).toBeUndefined();
    expect(indexOn('2026-11-12', 'coverage_pct')).toBeDefined();
    const inputSql = query.mock.calls.map(([sql]) => sql as string).filter((sql) => !sql.includes('has_inputs'));
    expect(inputSql.some((sql) => sql.includes('computed_index_inputs'))).toBe(false);
  });

  it('stamps every write and the anchor lookup with the one date read at the start of the run', async () => {
    await runDay('2026-11-12', [basketRow('milk', 'dairy', 'a', 12), basketRow('bread', 'bread', 'a', 5)], baselines);
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    expect(sqls.filter((sql) => sql.includes('NOW()::date')).length).toBe(1);
    expect(sqls.find((sql) => sql.includes('metric_date < $3::date'))).toBeDefined();
    for (const args of indexWrites()) expect(args[1]).toBe('2026-11-12');
  });
});
