/**
 * Aggregate job: computes basket indices from latest price observations.
 * Runs as an independent Railway cron service (02:15 UTC daily) after scrape.
 * Produces Fixed Basket Index and Value Basket Index per methodology.
 */
import { query, closePool } from '../db/client.js';
import { loadAllBasketConfigs } from '../config/loader.js';
import { validateAll } from './validate.js';
import { FX_RATES_TO_USD } from '../fx/rates.js';

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[aggregate] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[aggregate] ${msg}`, ...args),
};

interface BasketRow {
  basketItemId: string;
  category: string;
  weight: number;
  retailerProductId: string;
  retailerSlug: string;
  price: number;
  unitPrice: number | null;
  currencyCode: string;
  observedAt: Date;
}


async function getBasketRows(basketSlug: string, marketCode: string): Promise<BasketRow[]> {
  const result = await query<{
    basket_item_id: string;
    category: string;
    weight: string;
    retailer_product_id: string;
    retailer_slug: string;
    price: string;
    unit_price: string | null;
    currency_code: string;
    observed_at: Date;
  }>(
    `SELECT bi.id AS basket_item_id,
            bi.category,
            bi.weight,
            rp.id AS retailer_product_id,
            r.slug AS retailer_slug,
            po.price,
            po.unit_price,
            po.currency_code,
            po.observed_at
     FROM baskets b
     JOIN basket_items bi ON bi.basket_id = b.id AND bi.active = true
     JOIN product_matches pm ON pm.basket_item_id = bi.id AND pm.match_status IN ('auto','approved') AND pm.pin_disabled_at IS NULL
     JOIN retailer_products rp ON rp.id = pm.retailer_product_id AND rp.active = true
     JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $2 AND r.active = true
     JOIN LATERAL (
       SELECT price, unit_price, currency_code, observed_at
       FROM price_observations
       WHERE retailer_product_id = rp.id AND in_stock = true
       ORDER BY observed_at DESC LIMIT 1
     ) po ON true
     WHERE b.slug = $1`,
    [basketSlug, marketCode],
  );

  return result.rows.map((r) => ({
    basketItemId: r.basket_item_id,
    category: r.category,
    weight: parseFloat(r.weight),
    retailerProductId: r.retailer_product_id,
    retailerSlug: r.retailer_slug,
    price: parseFloat(r.price),
    unitPrice: r.unit_price ? parseFloat(r.unit_price) : null,
    currencyCode: r.currency_code,
    observedAt: r.observed_at,
  }));
}

async function getBaselinePrices(basketItemIds: string[], baseDate: string): Promise<Map<string, number>> {
  const result = await query<{ basket_item_id: string; price: string }>(
    `SELECT pm.basket_item_id, AVG(po.price)::numeric(12,2) AS price
     FROM price_observations po
     JOIN product_matches pm ON pm.retailer_product_id = po.retailer_product_id
     WHERE pm.basket_item_id = ANY($1)
       AND pm.match_status IN ('auto', 'approved')
       AND pm.pin_disabled_at IS NULL
       AND po.in_stock = true
       AND DATE_TRUNC('day', po.observed_at) = $2::date
     GROUP BY pm.basket_item_id`,
    [basketItemIds, baseDate],
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.basket_item_id, parseFloat(row.price));
  }
  return map;
}

function computeFixedIndex(rows: BasketRow[], baselines: Map<string, number>): number {
  let weightedSum = 0;
  let totalWeight = 0;

  const byItem = new Map<string, BasketRow[]>();
  for (const r of rows) {
    if (!byItem.has(r.basketItemId)) byItem.set(r.basketItemId, []);
    byItem.get(r.basketItemId)!.push(r);
  }

  for (const [itemId, itemRows] of byItem) {
    const base = baselines.get(itemId);
    if (!base) continue;

    const avgPrice = itemRows.reduce((s, r) => s + r.price, 0) / itemRows.length;
    const weight = itemRows[0].weight;

    weightedSum += weight * (avgPrice / base);
    totalWeight += weight;
  }

  if (totalWeight === 0) return 100;
  return 100 * (weightedSum / totalWeight);
}

function computeValueIndex(rows: BasketRow[], baselines: Map<string, number>): number {
  // Value index: same as fixed index but using the cheapest available price
  // per basket item (floor price across retailers), not the average.
  const byItem = new Map<string, BasketRow[]>();
  for (const r of rows) {
    if (!byItem.has(r.basketItemId)) byItem.set(r.basketItemId, []);
    byItem.get(r.basketItemId)!.push(r);
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [itemId, itemRows] of byItem) {
    const base = baselines.get(itemId);
    if (!base) continue;

    const floorPrice = itemRows.reduce((min, r) => Math.min(min, r.price), Infinity);
    const weight = itemRows[0].weight;

    weightedSum += weight * (floorPrice / base);
    totalWeight += weight;
  }

  if (totalWeight === 0) return 100;
  return 100 * (weightedSum / totalWeight);
}

async function writeComputedIndex(
  basketId: string,
  retailerId: string | null,
  category: string | null,
  metricKey: string,
  metricValue: number,
) {
  // ON CONFLICT must reference the exact partial index predicate matching the row being inserted.
  // The original constraint fires only when both retailer_id and category are NOT NULL.
  // Partial indices (005_computed_indices_null_idx) handle the two NULL cases.
  if (retailerId === null && category === null) {
    await query(
      `INSERT INTO computed_indices (basket_id, retailer_id, category, metric_date, metric_key, metric_value, methodology_version)
       VALUES ($1, NULL, NULL, NOW()::date, $2, $3, '1')
       ON CONFLICT (basket_id, metric_date, metric_key) WHERE retailer_id IS NULL AND category IS NULL
       DO UPDATE SET metric_value = EXCLUDED.metric_value, methodology_version = EXCLUDED.methodology_version`,
      [basketId, metricKey, metricValue],
    );
  } else if (retailerId === null) {
    await query(
      `INSERT INTO computed_indices (basket_id, retailer_id, category, metric_date, metric_key, metric_value, methodology_version)
       VALUES ($1, NULL, $2, NOW()::date, $3, $4, '1')
       ON CONFLICT (basket_id, category, metric_date, metric_key) WHERE retailer_id IS NULL AND category IS NOT NULL
       DO UPDATE SET metric_value = EXCLUDED.metric_value, methodology_version = EXCLUDED.methodology_version`,
      [basketId, category, metricKey, metricValue],
    );
  } else {
    await query(
      `INSERT INTO computed_indices (basket_id, retailer_id, category, metric_date, metric_key, metric_value, methodology_version)
       VALUES ($1, $2, $3, NOW()::date, $4, $5, '1')
       ON CONFLICT (basket_id, retailer_id, category, metric_date, metric_key)
       DO UPDATE SET metric_value = EXCLUDED.metric_value, methodology_version = EXCLUDED.methodology_version`,
      [basketId, retailerId, category, metricKey, metricValue],
    );
  }
}

export async function aggregateBasket(basketSlug: string, marketCode: string) {
  const configs = loadAllBasketConfigs();
  const basketConfig = configs.find((b) => b.slug === basketSlug && b.marketCode === marketCode);
  if (!basketConfig) {
    logger.warn(`Basket ${basketSlug}:${marketCode} not found in config`);
    return;
  }

  const basketResult = await query<{ id: string }>(`SELECT id FROM baskets WHERE slug = $1`, [basketSlug]);
  if (!basketResult.rows.length) {
    logger.warn(`Basket ${basketSlug} not found in DB — run seed first`);
    return;
  }
  const basketId = basketResult.rows[0].id;

  const rows = await getBasketRows(basketSlug, marketCode);
  if (rows.length === 0) {
    logger.warn(`No matched products for ${basketSlug}:${marketCode}`);
    return;
  }

  const uniqueItemIds = [...new Set(rows.map((r) => r.basketItemId))];
  const baselines = await getBaselinePrices(uniqueItemIds, basketConfig.baseDate);

  const essentialsIndex = computeFixedIndex(rows, baselines);
  const valueIndex = computeValueIndex(rows, baselines);

  const coverageCount = new Set(rows.map((r) => r.basketItemId)).size;
  const totalItems = basketConfig.items.length;
  const coveragePct = (coverageCount / totalItems) * 100;

  await writeComputedIndex(basketId, null, null, 'essentials_index', essentialsIndex);
  await writeComputedIndex(basketId, null, null, 'value_index', valueIndex);
  await writeComputedIndex(basketId, null, null, 'coverage_pct', coveragePct);

  // Retailer spread: (most expensive basket - cheapest basket) / cheapest × 100
  // Only compare retailers on the INTERSECTION of basket items they all carry.
  // Also deduplicate: per (retailer, basketItem) take cheapest price to avoid
  // inflating totals when multiple SKUs are matched to the same basket item.
  const byRetailerItem = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byRetailerItem.has(r.retailerSlug)) byRetailerItem.set(r.retailerSlug, new Map());
    const itemMap = byRetailerItem.get(r.retailerSlug)!;
    const existing = itemMap.get(r.basketItemId);
    if (existing === undefined || r.price < existing) itemMap.set(r.basketItemId, r.price);
  }
  const MIN_SPREAD_ITEMS = 4;
  const retailerSlugs = [...byRetailerItem.keys()];
  if (retailerSlugs.length >= 2) {
    // Find basket items covered by every retailer
    const commonItemIds = [...byRetailerItem.get(retailerSlugs[0])!.keys()].filter((itemId) =>
      retailerSlugs.every((slug) => byRetailerItem.get(slug)!.has(itemId)),
    );
    if (commonItemIds.length >= MIN_SPREAD_ITEMS) {
      const retailerTotals = retailerSlugs.map((slug) =>
        commonItemIds.reduce((sum, id) => sum + byRetailerItem.get(slug)!.get(id)!, 0),
      );
      const spreadPct = ((Math.max(...retailerTotals) - Math.min(...retailerTotals)) / Math.min(...retailerTotals)) * 100;
      await writeComputedIndex(basketId, null, null, 'retailer_spread_pct', Math.round(spreadPct * 10) / 10);
    } else {
      // Insufficient overlap — write explicit 0 to prevent stale noisy value persisting
      await writeComputedIndex(basketId, null, null, 'retailer_spread_pct', 0);
      logger.info(`${basketSlug}: spread suppressed (${commonItemIds.length}/${MIN_SPREAD_ITEMS} common items)`);
    }
  }

  // Per-category indices for buildTopCategories snapshot
  const byCategory = new Map<string, BasketRow[]>();
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }

  for (const [category, catRows] of byCategory) {
    const catEssentials = computeFixedIndex(catRows, baselines);
    const catCoverage =
      (new Set(catRows.map((r) => r.basketItemId)).size /
        Math.max(1, basketConfig.items.filter((i) => i.category === category).length)) *
      100;
    await writeComputedIndex(basketId, null, category, 'essentials_index', catEssentials);
    await writeComputedIndex(basketId, null, category, 'coverage_pct', catCoverage);
  }

  // Absolute basket cost in USD for cross-country comparison
  const byItemForTotal = new Map<string, BasketRow[]>();
  for (const r of rows) {
    if (!byItemForTotal.has(r.basketItemId)) byItemForTotal.set(r.basketItemId, []);
    byItemForTotal.get(r.basketItemId)!.push(r);
  }
  let basketTotalLocal = 0;
  for (const itemRows of byItemForTotal.values()) {
    basketTotalLocal += itemRows.reduce((s, r) => s + r.price, 0) / itemRows.length;
  }
  const currencyCode = rows[0].currencyCode;
  const fxRate = FX_RATES_TO_USD[currencyCode];
  if (fxRate !== undefined) {
    await writeComputedIndex(basketId, null, null, 'basket_total_usd', Math.round(basketTotalLocal * fxRate * 100) / 100);
  }

  logger.info(`${basketSlug}:${marketCode} essentials=${essentialsIndex.toFixed(2)} value=${valueIndex.toFixed(2)} coverage=${coveragePct.toFixed(1)}%`);
}

export async function aggregateAll() {
  const configs = loadAllBasketConfigs();
  let failed = 0;
  for (const c of configs) {
    try {
      await aggregateBasket(c.slug, c.marketCode);
    } catch (err) {
      logger.warn(`aggregateBasket ${c.slug}:${c.marketCode} failed: ${err}`);
      failed++;
    }
  }
  if (failed > 0) throw new Error(`${failed}/${configs.length} basket(s) failed`);
}

export async function validateAndAggregateAll() {
  await validateAll();
  await aggregateAll();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateAndAggregateAll().finally(() => closePool()).catch(console.error);
}
