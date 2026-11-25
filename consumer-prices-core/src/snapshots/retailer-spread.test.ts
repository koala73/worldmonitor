import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client.js', () => ({ query }));
const { buildOverviewSnapshot, buildRetailerSpreadSnapshot } = await import('./worldmonitor.js');

const NOW = new Date('2026-11-25T06:00:00Z').getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);

function row(retailer: string, name: string, item: string, price: number, seenMinAgo: number) {
  return {
    basket_item_id: item, category: 'dairy', weight: '1', retailer_product_id: `${retailer}-${item}-${price}`,
    retailer_slug: retailer, retailer_name: name, price: String(price), unit_price: null, currency_code: 'AED',
    observed_at: minutesAgo(40_000), last_seen_at: minutesAgo(seenMinAgo),
  };
}

// Lulu carries all four items, plus a dearer second SKU for milk that must not
// count. Carrefour lacks bread, so bread drops out of both totals.
const BASKET_ROWS = [
  row('lulu_ae', 'Lulu Hypermarket UAE', 'milk', 5, 60),
  row('lulu_ae', 'Lulu Hypermarket UAE', 'milk', 9, 60),
  row('lulu_ae', 'Lulu Hypermarket UAE', 'eggs', 10, 60),
  row('lulu_ae', 'Lulu Hypermarket UAE', 'rice', 20, 60),
  row('lulu_ae', 'Lulu Hypermarket UAE', 'oil', 15, 60),
  row('lulu_ae', 'Lulu Hypermarket UAE', 'bread', 4, 60),
  row('carrefour_ae', 'Carrefour UAE', 'milk', 6, 3000),
  row('carrefour_ae', 'Carrefour UAE', 'eggs', 12, 3000),
  row('carrefour_ae', 'Carrefour UAE', 'rice', 25, 3000),
  row('carrefour_ae', 'Carrefour UAE', 'oil', 17, 3000),
];

function serve(basketRows: unknown[]) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT b.id, b.slug FROM baskets')) return { rows: [{ id: 'b1', slug: 'essentials-ae' }] };
    if (sql.includes('FROM price_observations') && sql.includes('rp.last_seen_at')) return { rows: basketRows };
    if (sql.includes('ci.metric_key, ci.metric_value') && !sql.includes('INTERVAL')) {
      return { rows: [['essentials_index', 111.2], ['coverage_pct', 80]].map(([metric_key, v]) => ({ metric_key, metric_value: String(v) })) };
    }
    if (sql.includes('SELECT currency_code FROM retailers')) return { rows: [{ currency_code: 'AED' }] };
    if (sql.includes('data_source_health')) return { rows: [{ avg_lag_min: '5' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

it('shows the same retailer spread on the market overview as in the retailer comparison', async () => {
  serve(BASKET_ROWS);
  const overview = await buildOverviewSnapshot('ae');
  const detail = await buildRetailerSpreadSnapshot('ae', 'essentials-ae');

  expect(detail.retailers.map((r) => [r.name, r.basketTotal, r.itemCount])).toEqual([
    ['Lulu Hypermarket UAE', 50, 4],
    ['Carrefour UAE', 60, 4],
  ]);
  expect(detail.spreadPct).toBe(20);
  expect(overview.retailerSpreadPct).toBe(detail.spreadPct);
});

it('ages the market by when its compared prices were last confirmed, not by crawler runs', async () => {
  serve(BASKET_ROWS);
  const overview = await buildOverviewSnapshot('ae');
  const detail = await buildRetailerSpreadSnapshot('ae', 'essentials-ae');

  expect(detail.retailers.map((r) => [r.slug, r.freshnessMin])).toEqual([['lulu_ae', 60], ['carrefour_ae', 3000]]);
  expect(overview.freshnessLagMin).toBe((6 * 60 + 4 * 3000) / 10);
});

it('reports no spread on the overview or the comparison when fewer than four items are shared', async () => {
  serve(BASKET_ROWS.filter((r) => r.basket_item_id !== 'oil'));
  expect((await buildOverviewSnapshot('ae')).retailerSpreadPct).toBe(0);
  expect((await buildRetailerSpreadSnapshot('ae', 'essentials-ae')).spreadPct).toBe(0);
});
