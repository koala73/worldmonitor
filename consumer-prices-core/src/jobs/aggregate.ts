/**
 * Aggregate job: computes basket indices from latest price observations.
 * Runs as an independent Railway cron service (02:15-05:15 UTC, hourly) after each scrape tick.
 * Produces Fixed Basket Index and Value Basket Index per methodology.
 */
import { query, closePool, withTransaction, type QueryExecutor } from '../db/client.js';
import { loadAllBasketConfigs } from '../config/loader.js';
import { validateAll } from './validate.js';
import { FX_RATES_TO_USD } from '../fx/rates.js';
import { MAX_OBSERVATION_AGE_DAYS } from '../observation-freshness.js';
import { INDEX_METHODOLOGY_VERSION } from '../index-methodology.js';

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
       SELECT price, unit_price, currency_code, observed_at, in_stock
       FROM price_observations
       WHERE retailer_product_id = rp.id
       ORDER BY observed_at DESC, id DESC LIMIT 1
     ) po ON po.in_stock = true
       AND rp.last_seen_at >= NOW() - make_interval(days => $3)
     WHERE b.slug = $1`,
    [basketSlug, marketCode, MAX_OBSERVATION_AGE_DAYS],
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

// Baseline per item = average price on the first day it was observed on or after
// baseDate. A single fixed day leaves every item observed later without a
// baseline, which is how every basket sat at a fallback 100 for seven months.
async function getBaselinePrices(basketItemIds: string[], baseDate: string): Promise<Map<string, number>> {
  const result = await query<{ basket_item_id: string; price: string }>(
    `WITH obs AS (
       SELECT pm.basket_item_id, po.price, DATE_TRUNC('day', po.observed_at) AS day
       FROM price_observations po
       JOIN product_matches pm ON pm.retailer_product_id = po.retailer_product_id
       WHERE pm.basket_item_id = ANY($1)
         AND pm.match_status IN ('auto', 'approved')
         AND pm.pin_disabled_at IS NULL
         AND po.in_stock = true
         AND po.observed_at >= $2::date
     ),
     first_day AS (
       SELECT basket_item_id, MIN(day) AS day FROM obs GROUP BY basket_item_id
     )
     SELECT obs.basket_item_id, AVG(obs.price)::numeric(12,2) AS price
     FROM obs
     JOIN first_day ON first_day.basket_item_id = obs.basket_item_id AND first_day.day = obs.day
     GROUP BY obs.basket_item_id`,
    [basketItemIds, baseDate],
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.basket_item_id, parseFloat(row.price));
  }
  return map;
}

// Null when no item has a baseline: an index of 100 there would claim "no change".
function computeFixedIndex(rows: BasketRow[], baselines: Map<string, number>): number | null {
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

  if (totalWeight === 0) return null;
  return 100 * (weightedSum / totalWeight);
}

function computeValueIndex(rows: BasketRow[], baselines: Map<string, number>): number | null {
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

  if (totalWeight === 0) return null;
  return 100 * (weightedSum / totalWeight);
}

interface PreviousIndex {
  date: string;
  value: number;
}

function seriesKey(category: string | null, metricKey: string) {
  return `${category ?? ''}|${metricKey}`;
}

function inputKey(basketItemId: string, retailerProductId: string) {
  return `${basketItemId}|${retailerProductId}`;
}

// Latest current-methodology index row before this run's date for each
// series, with the (basket item, product, price) rows that day was computed
// from. The run's own date is excluded so an hourly rerun recomputes from the
// same anchor instead of compounding on itself. One statement, one snapshot:
// a run for the anchor date committing between two reads would otherwise pair
// its old level with its replacement prices. The stored inputs, not a fresh
// look at observation history, are what the next link divides by, so a scrape
// that landed after the aggregate, or a product that was not in that day's
// basket, cannot enter the anchor.
async function getAnchors(basketId: string, metricDate: string) {
  const result = await query<{
    kind: 'index' | 'input';
    category: string | null;
    metric_key: string | null;
    metric_date: string;
    metric_value: string | null;
    basket_item_id: string | null;
    retailer_product_id: string | null;
    price: string | null;
  }>(
    `WITH prev AS (
       SELECT DISTINCT ON (category, metric_key) category, metric_key, metric_date, metric_value
       FROM computed_indices
       WHERE basket_id = $1 AND retailer_id IS NULL
         AND metric_key IN ('essentials_index', 'value_index')
         AND methodology_version = $2
         AND metric_date < $3::date
       ORDER BY category, metric_key, metric_date DESC
     )
     SELECT 'index' AS kind, category, metric_key, to_char(metric_date, 'YYYY-MM-DD') AS metric_date,
            metric_value, NULL::uuid AS basket_item_id, NULL::uuid AS retailer_product_id, NULL::numeric AS price
     FROM prev
     UNION ALL
     SELECT 'input', NULL, NULL, to_char(i.metric_date, 'YYYY-MM-DD'), NULL, i.basket_item_id, i.retailer_product_id, i.price
     FROM computed_index_inputs i
     WHERE i.basket_id = $1 AND i.metric_date IN (SELECT DISTINCT metric_date FROM prev)`,
    [basketId, INDEX_METHODOLOGY_VERSION, metricDate],
  );
  const previous = new Map<string, PreviousIndex>();
  const inputsByDate = new Map<string, Map<string, number>>();
  for (const r of result.rows) {
    if (r.kind === 'index') {
      previous.set(seriesKey(r.category, r.metric_key!), { date: r.metric_date, value: parseFloat(r.metric_value!) });
    } else {
      if (!inputsByDate.has(r.metric_date)) inputsByDate.set(r.metric_date, new Map());
      inputsByDate.get(r.metric_date)!.set(inputKey(r.basket_item_id!, r.retailer_product_id!), parseFloat(r.price!));
    }
  }
  return { previous, inputsByDate };
}

// Matched-model chain link. A product entering or leaving the basket must not
// move the index, so the change since the previous index row is measured only
// over (item, product) pairs used on both dates: the ratio of the index
// computed on that common set now to the same index computed on it with the
// anchor's stored prices. With no change in composition this equals the direct
// index's own change.
function chainIndex(
  rows: BasketRow[],
  baselines: Map<string, number>,
  previous: PreviousIndex | undefined,
  inputsByDate: Map<string, Map<string, number>>,
  compute: (rows: BasketRow[], baselines: Map<string, number>) => number | null,
  label: string,
): number | null {
  if (!previous) return compute(rows, baselines); // first current-methodology day seeds the chain
  const prevPrices = inputsByDate.get(previous.date) ?? new Map<string, number>();
  const matched = rows.filter((r) => prevPrices.has(inputKey(r.basketItemId, r.retailerProductId)));
  const now = compute(matched, baselines);
  const then = compute(
    matched.map((r) => ({ ...r, price: prevPrices.get(inputKey(r.basketItemId, r.retailerProductId))! })),
    baselines,
  );
  // Nothing in common with the anchor: every product was replaced. No price
  // change can be measured, so the new products are linked in at the previous
  // level (standard sample replacement) instead of re-seeding from the direct
  // index, whose different level would read as a price move.
  if (now === null || then === null || then === 0) {
    logger.warn(`${label}: no products in common with ${previous.date}; linked in at the previous level`);
    return previous.value;
  }
  return previous.value * (now / then);
}

async function writeComputedIndex(
  basketId: string,
  metricDate: string,
  retailerId: string | null,
  category: string | null,
  metricKey: string,
  metricValue: number,
  execute: QueryExecutor = query,
) {
  // ON CONFLICT must reference the exact partial index predicate matching the row being inserted.
  // The original constraint fires only when both retailer_id and category are NOT NULL.
  // Partial indices (005_computed_indices_null_idx) handle the two NULL cases.
  if (retailerId === null && category === null) {
    await execute(
      `INSERT INTO computed_indices (basket_id, retailer_id, category, metric_date, metric_key, metric_value, methodology_version)
       VALUES ($1, NULL, NULL, $2::date, $3, $4, $5)
       ON CONFLICT (basket_id, metric_date, metric_key) WHERE retailer_id IS NULL AND category IS NULL
       DO UPDATE SET metric_value = EXCLUDED.metric_value, methodology_version = EXCLUDED.methodology_version`,
      [basketId, metricDate, metricKey, metricValue, INDEX_METHODOLOGY_VERSION],
    );
  } else if (retailerId === null) {
    await execute(
      `INSERT INTO computed_indices (basket_id, retailer_id, category, metric_date, metric_key, metric_value, methodology_version)
       VALUES ($1, NULL, $3, $2::date, $4, $5, $6)
       ON CONFLICT (basket_id, category, metric_date, metric_key) WHERE retailer_id IS NULL AND category IS NOT NULL
       DO UPDATE SET metric_value = EXCLUDED.metric_value, methodology_version = EXCLUDED.methodology_version`,
      [basketId, metricDate, category, metricKey, metricValue, INDEX_METHODOLOGY_VERSION],
    );
  } else {
    await execute(
      `INSERT INTO computed_indices (basket_id, retailer_id, category, metric_date, metric_key, metric_value, methodology_version)
       VALUES ($1, $3, $4, $2::date, $5, $6, $7)
       ON CONFLICT (basket_id, retailer_id, category, metric_date, metric_key)
       DO UPDATE SET metric_value = EXCLUDED.metric_value, methodology_version = EXCLUDED.methodology_version`,
      [basketId, metricDate, retailerId, category, metricKey, metricValue, INDEX_METHODOLOGY_VERSION],
    );
  }
}

type IndexWrite = [retailerId: string | null, category: string | null, metricKey: string, metricValue: number];

// Returns false when the basket was aggregated without its indices (migration
// 013 not applied), so the run can fail instead of reporting success.
export async function aggregateBasket(basketSlug: string, marketCode: string): Promise<boolean> {
  const configs = loadAllBasketConfigs();
  const basketConfig = configs.find((b) => b.slug === basketSlug && b.marketCode === marketCode);
  if (!basketConfig) {
    logger.warn(`Basket ${basketSlug}:${marketCode} not found in config`);
    return true;
  }

  const basketResult = await query<{ id: string }>(`SELECT id FROM baskets WHERE slug = $1`, [basketSlug]);
  if (!basketResult.rows.length) {
    logger.warn(`Basket ${basketSlug} not found in DB — run seed first`);
    return true;
  }
  const basketId = basketResult.rows[0].id;

  // One date for the whole run: separate NOW()::date reads would split a run
  // that crosses midnight across two metric dates and two chain anchors.
  // Migrations are applied by hand, so this code can reach production before
  // 013 does; without the inputs table no index can be chained.
  const runResult = await query<{ metric_date: string; has_inputs: boolean }>(
    `SELECT to_char(NOW()::date, 'YYYY-MM-DD') AS metric_date,
            to_regclass('computed_index_inputs') IS NOT NULL AS has_inputs`,
  );
  const metricDate = runResult.rows[0].metric_date;
  const hasInputs = runResult.rows[0].has_inputs;

  const rows = await getBasketRows(basketSlug, marketCode);
  if (rows.length === 0) {
    // Record the empty basket for today. Returning without a write left the
    // last aggregated day as the newest one, and the overview republished
    // those indices as current. An earlier run today may already have written
    // indices, spreads and category rows; clear them so the series cannot
    // show a price level for a day with no coverage.
    // One transaction: a failed coverage write must not leave the day's
    // indices deleted with nothing in their place, or the overview would fall
    // back to an older covered day.
    await withTransaction(async (execute) => {
      await execute(`SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2))`, [basketId, metricDate]);
      await execute(`DELETE FROM computed_indices
       WHERE basket_id = $1 AND metric_date = $2::date`, [basketId, metricDate]);
      if (hasInputs) {
        await execute(`DELETE FROM computed_index_inputs WHERE basket_id = $1 AND metric_date = $2::date`, [basketId, metricDate]);
      }
      await writeComputedIndex(basketId, metricDate, null, null, 'coverage_pct', 0, execute);
    });
    logger.warn(`No fresh matched products for ${basketSlug}:${marketCode} — coverage recorded as 0`);
    return true;
  }

  const uniqueItemIds = [...new Set(rows.map((r) => r.basketItemId))];
  const baselines = await getBaselinePrices(uniqueItemIds, basketConfig.baseDate);

  const { previous, inputsByDate } = hasInputs
    ? await getAnchors(basketId, metricDate)
    : { previous: new Map<string, PreviousIndex>(), inputsByDate: new Map<string, Map<string, number>>() };
  const chain = (series: BasketRow[], category: string | null, metricKey: string, compute: typeof computeFixedIndex) =>
    hasInputs
      ? chainIndex(series, baselines, previous.get(seriesKey(category, metricKey)), inputsByDate, compute, `${basketSlug}:${category ?? 'all'}:${metricKey}`)
      : null;
  if (!hasInputs) logger.warn(`${basketSlug}:${marketCode}: computed_index_inputs is missing — apply migration 013; indices not written`);

  const writes: IndexWrite[] = [];
  const essentialsIndex = chain(rows, null, 'essentials_index', computeFixedIndex);
  const valueIndex = chain(rows, null, 'value_index', computeValueIndex);

  const coverageCount = new Set(rows.map((r) => r.basketItemId)).size;
  const totalItems = basketConfig.items.length;
  const coveragePct = (coverageCount / totalItems) * 100;

  if (essentialsIndex !== null) writes.push([null, null, 'essentials_index', essentialsIndex]);
  if (valueIndex !== null) writes.push([null, null, 'value_index', valueIndex]);
  writes.push([null, null, 'coverage_pct', coveragePct]);

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
      writes.push([null, null, 'retailer_spread_pct', Math.round(spreadPct * 10) / 10]);
    } else {
      // Insufficient overlap — write explicit 0 to prevent stale noisy value persisting
      writes.push([null, null, 'retailer_spread_pct', 0]);
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
    const catEssentials = chain(catRows, category, 'essentials_index', computeFixedIndex);
    const catCoverage =
      (new Set(catRows.map((r) => r.basketItemId)).size /
        Math.max(1, basketConfig.items.filter((i) => i.category === category).length)) *
      100;
    if (catEssentials !== null) writes.push([null, category, 'essentials_index', catEssentials]);
    writes.push([null, category, 'coverage_pct', catCoverage]);
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
    writes.push([null, null, 'basket_total_usd', Math.round(basketTotalLocal * fxRate * 100) / 100]);
  }

  // Only prices that contributed to today's index are stored as its inputs.
  // An item with no baseline was skipped by the index; storing it would make
  // it a "continuing" product tomorrow and move the link on its first baseline.
  const inputs = rows.filter((r) => baselines.get(r.basketItemId));

  // The day's rows are replaced as one set: the lock serialises overlapping
  // runs for this basket and date, and clearing the day first removes series a
  // rerun no longer produces (a category that dropped out), which would
  // otherwise linger as tomorrow's anchor with no inputs behind it. Only this
  // job writes computed_indices.
  await withTransaction(async (execute) => {
    await execute(`SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2))`, [basketId, metricDate]);
    await execute(`DELETE FROM computed_indices WHERE basket_id = $1 AND metric_date = $2::date`, [basketId, metricDate]);
    if (hasInputs) {
      await execute(`DELETE FROM computed_index_inputs WHERE basket_id = $1 AND metric_date = $2::date`, [basketId, metricDate]);
      await execute(
        `INSERT INTO computed_index_inputs (basket_id, metric_date, basket_item_id, retailer_product_id, price)
         SELECT $1, $2::date, i.item, i.product, i.price
         FROM unnest($3::uuid[], $4::uuid[], $5::numeric[]) AS i(item, product, price)
         ON CONFLICT DO NOTHING`,
        [basketId, metricDate, inputs.map((r) => r.basketItemId), inputs.map((r) => r.retailerProductId), inputs.map((r) => r.price)],
      );
    }
    for (const [retailerId, category, metricKey, metricValue] of writes) {
      await writeComputedIndex(basketId, metricDate, retailerId, category, metricKey, metricValue, execute);
    }
  });

  logger.info(`${basketSlug}:${marketCode} essentials=${essentialsIndex?.toFixed(2) ?? 'none'} value=${valueIndex?.toFixed(2) ?? 'none'} baselines=${baselines.size}/${uniqueItemIds.length} coverage=${coveragePct.toFixed(1)}%`);
  return hasInputs;
}

export async function aggregateAll() {
  const configs = loadAllBasketConfigs();
  let failed = 0;
  let unindexed = 0;
  for (const c of configs) {
    try {
      if (!(await aggregateBasket(c.slug, c.marketCode))) unindexed++;
    } catch (err) {
      logger.warn(`aggregateBasket ${c.slug}:${c.marketCode} failed: ${err}`);
      failed++;
    }
  }
  if (failed > 0) throw new Error(`${failed}/${configs.length} basket(s) failed`);
  // Coverage was written, but no index was: the cron must not read as healthy.
  if (unindexed > 0) throw new Error(`${unindexed}/${configs.length} basket(s) wrote no index — apply migration 013 (computed_index_inputs)`);
}

export async function validateAndAggregateAll() {
  await validateAll();
  await aggregateAll();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Terminal success marker (format mirrors runSeed() in scripts/_seed-utils.mjs) so the crash
  // diagnostic can distinguish a clean run from a silent death. Chained BEFORE .catch so a
  // rejection — including the `N/M basket(s) failed` throw — skips it.
  const runStartedAt = Date.now();
  validateAndAggregateAll()
    .then(() => console.log(`\n=== Done (${Date.now() - runStartedAt}ms) ===`))
    .finally(() => closePool())
    // Mirror scrape.ts: a failed aggregate must fail the cron (Railway green
    // deploys on exit 0 — console.error alone reported success on 0/N).
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
