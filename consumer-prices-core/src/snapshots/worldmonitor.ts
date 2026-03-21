/**
 * Builds compact WorldMonitor-ready snapshot payloads from computed indices.
 * All types are shaped to match the proto-generated TypeScript interfaces so
 * snapshots can be written to Redis and read directly by WorldMonitor handlers.
 */
import { query } from '../db/client.js';

// ---------------------------------------------------------------------------
// Snapshot interfaces — mirror proto-generated response types exactly
// (asOf is int64 → string per protobuf JSON mapping)
// ---------------------------------------------------------------------------

export interface WMCategorySnapshot {
  slug: string;
  name: string;
  wowPct: number;
  momPct: number;
  currentIndex: number;
  sparkline: number[];
  coveragePct: number;
  itemCount: number;
}

export interface WMOverviewSnapshot {
  marketCode: string;
  asOf: string;
  currencyCode: string;
  essentialsIndex: number;
  valueBasketIndex: number;
  wowPct: number;
  momPct: number;
  retailerSpreadPct: number;
  coveragePct: number;
  freshnessLagMin: number;
  topCategories: WMCategorySnapshot[];
  upstreamUnavailable: false;
}

export interface WMPriceMover {
  productId: string;
  title: string;
  category: string;
  retailerSlug: string;
  changePct: number;
  currentPrice: number;
  currencyCode: string;
}

export interface WMMoversSnapshot {
  marketCode: string;
  asOf: string;
  range: string;
  risers: WMPriceMover[];
  fallers: WMPriceMover[];
  upstreamUnavailable: false;
}

export interface WMRetailerSpread {
  slug: string;
  name: string;
  basketTotal: number;
  deltaVsCheapest: number;
  deltaVsCheapestPct: number;
  itemCount: number;
  freshnessMin: number;
  currencyCode: string;
}

export interface WMRetailerSpreadSnapshot {
  marketCode: string;
  asOf: string;
  basketSlug: string;
  currencyCode: string;
  retailers: WMRetailerSpread[];
  spreadPct: number;
  upstreamUnavailable: false;
}

export interface WMRetailerFreshness {
  slug: string;
  name: string;
  lastRunAt: string;
  status: string;
  parseSuccessRate: number;
  freshnessMin: number;
}

export interface WMFreshnessSnapshot {
  marketCode: string;
  asOf: string;
  retailers: WMRetailerFreshness[];
  overallFreshnessMin: number;
  stalledCount: number;
  upstreamUnavailable: false;
}

export interface WMBasketPoint {
  date: string;
  index: number;
}

export interface WMBasketSeriesSnapshot {
  marketCode: string;
  basketSlug: string;
  asOf: string;
  currencyCode: string;
  range: string;
  essentialsSeries: WMBasketPoint[];
  valueSeries: WMBasketPoint[];
  upstreamUnavailable: false;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function buildTopCategories(basketId: string): Promise<WMCategorySnapshot[]> {
  const result = await query<{
    category: string;
    current_index: number | null;
    prev_week_index: number | null;
    coverage_pct: number | null;
  }>(
    `WITH today AS (
       SELECT category, metric_key, metric_value::float AS metric_value
       FROM computed_indices
       WHERE basket_id = $1 AND category IS NOT NULL AND retailer_id IS NULL AND metric_date = CURRENT_DATE
     ),
     last_week AS (
       SELECT category, metric_key, metric_value::float AS metric_value
       FROM computed_indices
       WHERE basket_id = $1 AND category IS NOT NULL AND retailer_id IS NULL
         AND metric_date = (
           SELECT MAX(metric_date) FROM computed_indices
           WHERE basket_id = $1 AND category IS NOT NULL
             AND metric_date < CURRENT_DATE - INTERVAL '6 days'
         )
     )
     SELECT
       cats.category,
       MAX(CASE WHEN t.metric_key = 'essentials_index' THEN t.metric_value END) AS current_index,
       MAX(CASE WHEN lw.metric_key = 'essentials_index' THEN lw.metric_value END) AS prev_week_index,
       MAX(CASE WHEN t.metric_key = 'coverage_pct' THEN t.metric_value END) AS coverage_pct
     FROM (SELECT DISTINCT category FROM today) cats
     JOIN today t ON t.category = cats.category
     LEFT JOIN last_week lw ON lw.category = cats.category AND lw.metric_key = t.metric_key
     GROUP BY cats.category
     HAVING MAX(CASE WHEN t.metric_key = 'essentials_index' THEN 1 ELSE 0 END) = 1
     ORDER BY ABS(COALESCE(MAX(CASE WHEN t.metric_key = 'essentials_index' THEN t.metric_value END), 100) - 100) DESC
     LIMIT 8`,
    [basketId],
  );

  return result.rows.map((r) => {
    const cur = r.current_index ?? 100;
    const prev = r.prev_week_index;
    const wowPct = prev && prev > 0 ? Math.round(((cur - prev) / prev) * 100 * 10) / 10 : 0;
    const slug = r.category
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return {
      slug,
      name: r.category.charAt(0).toUpperCase() + r.category.slice(1),
      wowPct,
      momPct: 0, // TODO: requires 30-day baseline per category
      currentIndex: Math.round(cur * 10) / 10,
      sparkline: [], // TODO: requires per-category date series query
      coveragePct: Math.round((r.coverage_pct ?? 0) * 10) / 10,
      itemCount: 0, // TODO: requires basket_items count query per category
    };
  });
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

export async function buildOverviewSnapshot(marketCode: string): Promise<WMOverviewSnapshot> {
  const now = Date.now();

  // Resolve basket id for category queries
  const basketIdResult = await query<{ id: string }>(
    `SELECT b.id FROM baskets b WHERE b.market_code = $1 LIMIT 1`,
    [marketCode],
  );
  const basketId = basketIdResult.rows[0]?.id ?? null;

  const [indexResult, prevWeekResult, prevMonthResult, spreadResult, currencyResult, freshnessResult] =
    await Promise.all([
      query<{ metric_key: string; metric_value: string }>(
        `SELECT ci.metric_key, ci.metric_value
         FROM computed_indices ci
         JOIN baskets b ON b.id = ci.basket_id
         WHERE b.market_code = $1
           AND ci.retailer_id IS NULL AND ci.category IS NULL
           AND ci.metric_date = (
             SELECT MAX(metric_date) FROM computed_indices ci2 JOIN baskets b2 ON b2.id = ci2.basket_id
             WHERE b2.market_code = $1 AND ci2.retailer_id IS NULL
           )`,
        [marketCode],
      ),
      query<{ metric_key: string; metric_value: string }>(
        `SELECT ci.metric_key, ci.metric_value
         FROM computed_indices ci
         JOIN baskets b ON b.id = ci.basket_id
         WHERE b.market_code = $1
           AND ci.retailer_id IS NULL AND ci.category IS NULL
           AND ci.metric_date = (
             SELECT MAX(metric_date) FROM computed_indices ci2 JOIN baskets b2 ON b2.id = ci2.basket_id
             WHERE b2.market_code = $1 AND ci2.retailer_id IS NULL
               AND ci2.metric_date < CURRENT_DATE - INTERVAL '6 days'
           )`,
        [marketCode],
      ),
      query<{ metric_key: string; metric_value: string }>(
        `SELECT ci.metric_key, ci.metric_value
         FROM computed_indices ci
         JOIN baskets b ON b.id = ci.basket_id
         WHERE b.market_code = $1
           AND ci.retailer_id IS NULL AND ci.category IS NULL
           AND ci.metric_date = (
             SELECT MAX(metric_date) FROM computed_indices ci2 JOIN baskets b2 ON b2.id = ci2.basket_id
             WHERE b2.market_code = $1 AND ci2.retailer_id IS NULL
               AND ci2.metric_date < CURRENT_DATE - INTERVAL '29 days'
           )`,
        [marketCode],
      ),
      query<{ spread_pct: string }>(
        `SELECT metric_value AS spread_pct FROM computed_indices ci
         JOIN baskets b ON b.id = ci.basket_id
         WHERE b.market_code = $1 AND ci.metric_key = 'retailer_spread_pct'
         ORDER BY ci.metric_date DESC LIMIT 1`,
        [marketCode],
      ),
      query<{ currency_code: string }>(
        `SELECT currency_code FROM retailers WHERE market_code = $1 AND active = true LIMIT 1`,
        [marketCode],
      ),
      query<{ avg_lag_min: string }>(
        `SELECT AVG(EXTRACT(EPOCH FROM (NOW() - last_successful_run_at)) / 60)::int AS avg_lag_min
         FROM data_source_health dsh
         JOIN retailers r ON r.id = dsh.retailer_id
         WHERE r.market_code = $1`,
        [marketCode],
      ),
    ]);

  const metrics: Record<string, number> = {};
  for (const row of indexResult.rows) metrics[row.metric_key] = parseFloat(row.metric_value);

  const prevWeek: Record<string, number> = {};
  for (const row of prevWeekResult.rows) prevWeek[row.metric_key] = parseFloat(row.metric_value);

  const prevMonth: Record<string, number> = {};
  for (const row of prevMonthResult.rows) prevMonth[row.metric_key] = parseFloat(row.metric_value);

  const ess = metrics.essentials_index ?? 100;
  const val = metrics.value_index ?? 100;
  const prevEss = prevWeek.essentials_index;
  const prevMonthEss = prevMonth.essentials_index;
  const wowPct = prevEss ? Math.round(((ess - prevEss) / prevEss) * 100 * 10) / 10 : 0;
  const momPct = prevMonthEss ? Math.round(((ess - prevMonthEss) / prevMonthEss) * 100 * 10) / 10 : 0;

  const topCategories = basketId ? await buildTopCategories(basketId) : [];

  return {
    marketCode,
    asOf: String(now),
    currencyCode: currencyResult.rows[0]?.currency_code ?? 'USD',
    essentialsIndex: Math.round(ess * 10) / 10,
    valueBasketIndex: Math.round(val * 10) / 10,
    wowPct,
    momPct,
    retailerSpreadPct: spreadResult.rows[0]?.spread_pct
      ? Math.round(parseFloat(spreadResult.rows[0].spread_pct) * 10) / 10
      : 0,
    coveragePct: Math.round((metrics.coverage_pct ?? 0) * 10) / 10,
    freshnessLagMin: freshnessResult.rows[0]?.avg_lag_min
      ? parseInt(freshnessResult.rows[0].avg_lag_min, 10)
      : 0,
    topCategories,
    upstreamUnavailable: false,
  };
}

export async function buildMoversSnapshot(
  marketCode: string,
  rangeDays: number,
): Promise<WMMoversSnapshot> {
  const now = Date.now();
  const range = `${rangeDays}d`;

  const result = await query<{
    product_id: string;
    raw_title: string;
    category_text: string;
    retailer_slug: string;
    current_price: string;
    currency_code: string;
    change_pct: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (rp.id) rp.id, rp.raw_title, rp.category_text, r.slug AS retailer_slug,
              po.price, r.currency_code
       FROM retailer_products rp
       JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $1 AND r.active = true
       JOIN price_observations po ON po.retailer_product_id = rp.id AND po.in_stock = true
       ORDER BY rp.id, po.observed_at DESC
     ),
     past AS (
       SELECT DISTINCT ON (rp.id) rp.id, po.price AS past_price
       FROM retailer_products rp
       JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $1
       JOIN price_observations po ON po.retailer_product_id = rp.id
         AND po.observed_at BETWEEN NOW() - ($2 || ' days')::INTERVAL - INTERVAL '1 day'
                                 AND NOW() - ($2 || ' days')::INTERVAL
       ORDER BY rp.id, po.observed_at DESC
     )
     SELECT l.id AS product_id, l.raw_title, l.category_text, l.retailer_slug,
            l.price AS current_price, l.currency_code,
            ROUND(((l.price - p.past_price) / p.past_price * 100)::numeric, 2) AS change_pct
     FROM latest l
     JOIN past p ON p.id = l.id
     WHERE p.past_price > 0
     ORDER BY ABS((l.price - p.past_price) / p.past_price) DESC
     LIMIT 30`,
    [marketCode, rangeDays],
  );

  const all = result.rows.map((r) => ({
    productId: r.product_id,
    title: r.raw_title,
    category: r.category_text ?? 'other',
    retailerSlug: r.retailer_slug,
    currentPrice: parseFloat(r.current_price),
    currencyCode: r.currency_code,
    changePct: parseFloat(r.change_pct),
  }));

  return {
    marketCode,
    asOf: String(now),
    range,
    risers: all.filter((r) => r.changePct > 0).slice(0, 10),
    fallers: all.filter((r) => r.changePct < 0).slice(0, 10),
    upstreamUnavailable: false,
  };
}

export async function buildRetailerSpreadSnapshot(
  marketCode: string,
  basketSlug: string,
): Promise<WMRetailerSpreadSnapshot> {
  const now = Date.now();

  const result = await query<{
    retailer_slug: string;
    retailer_name: string;
    basket_total: string;
    item_count: string;
    currency_code: string;
    freshness_min: string | null;
  }>(
    `SELECT r.slug AS retailer_slug, r.name AS retailer_name, r.currency_code,
            SUM(po.price) AS basket_total, COUNT(*) AS item_count,
            EXTRACT(EPOCH FROM (NOW() - MAX(po.observed_at))) / 60 AS freshness_min
     FROM baskets b
     JOIN basket_items bi ON bi.basket_id = b.id AND bi.active = true
     JOIN product_matches pm ON pm.basket_item_id = bi.id AND pm.match_status IN ('auto','approved')
     JOIN retailer_products rp ON rp.id = pm.retailer_product_id AND rp.active = true
     JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $2 AND r.active = true
     JOIN LATERAL (
       SELECT price, observed_at
       FROM price_observations
       WHERE retailer_product_id = rp.id AND in_stock = true
       ORDER BY observed_at DESC LIMIT 1
     ) po ON true
     WHERE b.slug = $1
     GROUP BY r.slug, r.name, r.currency_code
     ORDER BY basket_total ASC`,
    [basketSlug, marketCode],
  );

  const retailers: WMRetailerSpread[] = result.rows.map((r) => ({
    slug: r.retailer_slug,
    name: r.retailer_name,
    basketTotal: parseFloat(r.basket_total),
    deltaVsCheapest: 0,
    deltaVsCheapestPct: 0,
    itemCount: parseInt(r.item_count, 10),
    freshnessMin: r.freshness_min ? parseInt(r.freshness_min, 10) : 0,
    currencyCode: r.currency_code,
  }));

  if (retailers.length > 0) {
    const cheapest = retailers[0].basketTotal;
    for (const r of retailers) {
      r.deltaVsCheapest = Math.round((r.basketTotal - cheapest) * 100) / 100;
      r.deltaVsCheapestPct =
        cheapest > 0 ? Math.round(((r.basketTotal - cheapest) / cheapest) * 100 * 10) / 10 : 0;
    }
  }

  const spreadPct =
    retailers.length >= 2
      ? Math.round(
          ((retailers[retailers.length - 1].basketTotal - retailers[0].basketTotal) /
            retailers[0].basketTotal) *
            100 *
            10,
        ) / 10
      : 0;

  return {
    marketCode,
    asOf: String(now),
    basketSlug,
    currencyCode: result.rows[0]?.currency_code ?? 'USD',
    retailers,
    spreadPct,
    upstreamUnavailable: false,
  };
}

export async function buildFreshnessSnapshot(marketCode: string): Promise<WMFreshnessSnapshot> {
  const now = Date.now();

  const result = await query<{
    slug: string;
    name: string;
    last_run_at: Date | null;
    last_run_status: string | null;
    parse_success_rate: string | null;
    freshness_min: string | null;
  }>(
    `SELECT r.slug, r.name,
            dsh.last_successful_run_at AS last_run_at,
            dsh.last_run_status,
            dsh.parse_success_rate,
            EXTRACT(EPOCH FROM (NOW() - dsh.last_successful_run_at)) / 60 AS freshness_min
     FROM retailers r
     LEFT JOIN data_source_health dsh ON dsh.retailer_id = r.id
     WHERE r.market_code = $1 AND r.active = true`,
    [marketCode],
  );

  const retailers: WMRetailerFreshness[] = result.rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : '',
    status: r.last_run_status ?? 'unknown',
    parseSuccessRate: r.parse_success_rate ? parseFloat(r.parse_success_rate) : 0,
    freshnessMin: r.freshness_min ? parseInt(r.freshness_min, 10) : 0,
  }));

  const freshnessValues = retailers.map((r) => r.freshnessMin).filter((v) => v > 0);
  const overallFreshnessMin =
    freshnessValues.length > 0
      ? Math.round(freshnessValues.reduce((a, b) => a + b, 0) / freshnessValues.length)
      : 0;

  const stalledCount = retailers.filter((r) => r.freshnessMin === 0 || r.freshnessMin > 240).length;

  return {
    marketCode,
    asOf: String(now),
    retailers,
    overallFreshnessMin,
    stalledCount,
    upstreamUnavailable: false,
  };
}

export async function buildBasketSeriesSnapshot(
  marketCode: string,
  basketSlug: string,
  range: string,
): Promise<WMBasketSeriesSnapshot> {
  const now = Date.now();
  const days = parseInt(range.replace('d', ''), 10) || 30;

  const [essResult, valResult, currencyResult] = await Promise.all([
    query<{ metric_date: Date; metric_value: string }>(
      `SELECT ci.metric_date, ci.metric_value
       FROM computed_indices ci
       JOIN baskets b ON b.id = ci.basket_id
       WHERE b.slug = $1 AND b.market_code = $2
         AND ci.metric_key = 'essentials_index'
         AND ci.retailer_id IS NULL AND ci.category IS NULL
         AND ci.metric_date >= CURRENT_DATE - ($3 || ' days')::INTERVAL
       ORDER BY ci.metric_date ASC`,
      [basketSlug, marketCode, days],
    ),
    query<{ metric_date: Date; metric_value: string }>(
      `SELECT ci.metric_date, ci.metric_value
       FROM computed_indices ci
       JOIN baskets b ON b.id = ci.basket_id
       WHERE b.slug = $1 AND b.market_code = $2
         AND ci.metric_key = 'value_index'
         AND ci.retailer_id IS NULL AND ci.category IS NULL
         AND ci.metric_date >= CURRENT_DATE - ($3 || ' days')::INTERVAL
       ORDER BY ci.metric_date ASC`,
      [basketSlug, marketCode, days],
    ),
    query<{ currency_code: string }>(
      `SELECT currency_code FROM retailers WHERE market_code = $1 AND active = true LIMIT 1`,
      [marketCode],
    ),
  ]);

  return {
    marketCode,
    basketSlug,
    asOf: String(now),
    currencyCode: currencyResult.rows[0]?.currency_code ?? 'USD',
    range,
    essentialsSeries: essResult.rows.map((r) => ({
      date: r.metric_date.toISOString().slice(0, 10),
      index: Math.round(parseFloat(r.metric_value) * 10) / 10,
    })),
    valueSeries: valResult.rows.map((r) => ({
      date: r.metric_date.toISOString().slice(0, 10),
      index: Math.round(parseFloat(r.metric_value) * 10) / 10,
    })),
    upstreamUnavailable: false,
  };
}

export interface WMCategoriesSnapshot {
  marketCode: string;
  asOf: string;
  range: string;
  categories: WMCategorySnapshot[];
  upstreamUnavailable: false;
}

export async function buildCategoriesSnapshot(marketCode: string, range: string): Promise<WMCategoriesSnapshot> {
  const now = Date.now();

  const basketIdResult = await query<{ id: string }>(
    `SELECT b.id FROM baskets b WHERE b.market_code = $1 LIMIT 1`,
    [marketCode],
  );
  const basketId = basketIdResult.rows[0]?.id ?? null;
  const categories = basketId ? await buildTopCategories(basketId) : [];

  return {
    marketCode,
    asOf: String(now),
    range,
    categories,
    upstreamUnavailable: false,
  };
}
