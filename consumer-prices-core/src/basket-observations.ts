import { query, type QueryExecutor } from './db/client.js';
import { MAX_OBSERVATION_AGE_DAYS } from './observation-freshness.js';

export interface BasketRow {
  basketItemId: string;
  category: string;
  weight: number;
  retailerProductId: string;
  retailerSlug: string;
  retailerName: string;
  price: number;
  unitPrice: number | null;
  currencyCode: string;
  observedAt: Date;
  lastSeenAt: Date;
}

// The basket prices every published figure is computed from: each matched
// product's latest observation, kept only while it is in stock and a scrape
// confirmed it within MAX_OBSERVATION_AGE_DAYS.
export async function getBasketRows(basketSlug: string, marketCode: string, execute: QueryExecutor = query): Promise<BasketRow[]> {
  const result = await execute<{
    basket_item_id: string;
    category: string;
    weight: string;
    retailer_product_id: string;
    retailer_slug: string;
    retailer_name: string;
    price: string;
    unit_price: string | null;
    currency_code: string;
    observed_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT bi.id AS basket_item_id,
            bi.category,
            bi.weight,
            rp.id AS retailer_product_id,
            r.slug AS retailer_slug,
            r.name AS retailer_name,
            po.price,
            po.unit_price,
            po.currency_code,
            po.observed_at,
            rp.last_seen_at
     FROM baskets b
     JOIN basket_items bi ON bi.basket_id = b.id AND bi.active = true
     JOIN product_matches pm ON pm.basket_item_id = bi.id AND pm.match_status IN ('auto','approved') AND pm.pin_disabled_at IS NULL
     JOIN retailer_products rp ON rp.id = pm.retailer_product_id AND rp.active = true
     JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $2 AND r.active = true
     JOIN LATERAL (
       SELECT price, unit_price, currency_code, observed_at, in_stock
       FROM price_observations
       WHERE retailer_product_id = rp.id
       ORDER BY observed_at DESC, id DESC LIMIT 1
     ) po ON po.in_stock = true
       AND rp.last_seen_at >= statement_timestamp() - make_interval(days => $3)
     WHERE b.slug = $1`,
    [basketSlug, marketCode, MAX_OBSERVATION_AGE_DAYS],
  );

  return result.rows.map((r) => ({
    basketItemId: r.basket_item_id,
    category: r.category,
    weight: parseFloat(r.weight),
    retailerProductId: r.retailer_product_id,
    retailerSlug: r.retailer_slug,
    retailerName: r.retailer_name,
    price: parseFloat(r.price),
    unitPrice: r.unit_price ? parseFloat(r.unit_price) : null,
    currencyCode: r.currency_code,
    observedAt: r.observed_at,
    lastSeenAt: r.last_seen_at,
  }));
}

const MIN_SPREAD_ITEMS = 4;

export interface RetailerBasketTotal {
  slug: string;
  name: string;
  currencyCode: string;
  basketTotal: number;
  itemCount: number;
  rows: BasketRow[];
}

export interface RetailerSpread {
  retailers: RetailerBasketTotal[];
  spreadPct: number;
}

// Retailers are compared only on the basket items every one of them carries,
// each item priced at the retailer's cheapest matched product, so extra SKUs
// or uneven coverage cannot inflate a total.
export function computeRetailerSpread(rows: BasketRow[]): RetailerSpread {
  const cheapest = new Map<string, Map<string, BasketRow>>();
  for (const r of rows) {
    if (!cheapest.has(r.retailerSlug)) cheapest.set(r.retailerSlug, new Map());
    const items = cheapest.get(r.retailerSlug)!;
    const existing = items.get(r.basketItemId);
    if (!existing || r.price < existing.price) items.set(r.basketItemId, r);
  }
  const retailerItems = [...cheapest.values()];
  const commonItemIds = retailerItems.length
    ? [...retailerItems[0].keys()].filter((id) => retailerItems.every((items) => items.has(id)))
    : [];

  const retailers = [...cheapest.values()]
    .map((items) => {
      const used = commonItemIds.map((id) => items.get(id)!);
      const first = items.values().next().value!;
      return {
        slug: first.retailerSlug,
        name: first.retailerName,
        currencyCode: first.currencyCode,
        basketTotal: Math.round(used.reduce((sum, r) => sum + r.price, 0) * 100) / 100,
        itemCount: used.length,
        rows: used,
      };
    })
    .filter((r) => r.itemCount > 0)
    .sort((a, b) => a.basketTotal - b.basketTotal);

  const low = retailers[0]?.basketTotal ?? 0;
  const high = retailers[retailers.length - 1]?.basketTotal ?? 0;
  const spreadPct =
    retailers.length >= 2 && commonItemIds.length >= MIN_SPREAD_ITEMS && low > 0
      ? Math.round(((high - low) / low) * 100 * 10) / 10
      : 0;
  return { retailers, spreadPct };
}

// Average minutes since a scrape last confirmed each price. observed_at cannot
// stand in: an unchanged price keeps its first observation row for weeks.
export function confirmationAgeMin(rows: BasketRow[], now: number): number {
  if (rows.length === 0) return 0;
  const total = rows.reduce((sum, r) => sum + (now - r.lastSeenAt.getTime()) / 60_000, 0);
  return Math.round(total / rows.length);
}
