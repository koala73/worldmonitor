/**
 * Validate job: cross-retailer price sanity gate.
 *
 * Runs between scrape and aggregate in the Railway pipeline.
 * For each basket item, computes the median price across all active retailers
 * and flags product_matches as 'review' when the price deviates beyond the
 * configured thresholds. Previously-flagged matches that are now within range
 * are automatically restored to 'auto'.
 *
 * Aggregate only reads match_status IN ('auto','approved'), so flagged rows
 * are silently excluded from index computation until the data improves or is
 * manually approved.
 */
import { query, closePool } from '../db/client.js';
import { loadAllBasketConfigs } from '../config/loader.js';

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[validate] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[validate] ${msg}`, ...args),
};

// Thresholds: flag if price is more than UPPER_RATIO × median or less than LOWER_RATIO × median.
// Tuned for UAE grocery: catches wrong-product captures while tolerating genuine premium SKUs.
const UPPER_RATIO = 2.5;
const LOWER_RATIO = 0.35;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface MatchRow {
  matchId: string;
  basketItemId: string;
  matchStatus: string;
  retailerSlug: string;
  canonicalName: string;
  price: number;
}

async function validateBasket(basketSlug: string, marketCode: string): Promise<void> {
  const result = await query<{
    match_id: string;
    basket_item_id: string;
    match_status: string;
    retailer_slug: string;
    canonical_name: string;
    price: string;
  }>(
    `SELECT pm.id AS match_id, pm.basket_item_id, pm.match_status,
            r.slug AS retailer_slug, cp.canonical_name, po.price
     FROM product_matches pm
     JOIN retailer_products rp ON rp.id = pm.retailer_product_id AND rp.active = true
     JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $2 AND r.active = true
     JOIN basket_items bi ON bi.id = pm.basket_item_id AND bi.active = true
     JOIN baskets b ON b.id = bi.basket_id AND b.slug = $1
     JOIN canonical_products cp ON cp.id = pm.canonical_product_id
     JOIN LATERAL (
       SELECT price FROM price_observations
       WHERE retailer_product_id = rp.id AND in_stock = true
       ORDER BY observed_at DESC LIMIT 1
     ) po ON true
     WHERE pm.match_status IN ('auto', 'approved', 'review')
       AND pm.pin_disabled_at IS NULL`,
    [basketSlug, marketCode],
  );

  const rows: MatchRow[] = result.rows.map((r) => ({
    matchId: r.match_id,
    basketItemId: r.basket_item_id,
    matchStatus: r.match_status,
    retailerSlug: r.retailer_slug,
    canonicalName: r.canonical_name,
    price: parseFloat(r.price),
  }));

  // Group by basket item
  const byItem = new Map<string, MatchRow[]>();
  for (const r of rows) {
    if (!byItem.has(r.basketItemId)) byItem.set(r.basketItemId, []);
    byItem.get(r.basketItemId)!.push(r);
  }

  let flagged = 0;
  let restored = 0;

  for (const [, itemRows] of byItem) {
    // Need >= 2 retailers to compute a meaningful cross-retailer median.
    // Single-retailer items cannot be sanity-checked — skip.
    if (itemRows.length < 2) continue;

    const med = median(itemRows.map((r) => r.price));
    if (med === 0) continue;

    for (const row of itemRows) {
      const ratio = row.price / med;
      const isOutlier = ratio > UPPER_RATIO || ratio < LOWER_RATIO;
      const wasReview = row.matchStatus === 'review';

      if (isOutlier && !wasReview) {
        await query(
          `UPDATE product_matches
           SET match_status = 'review',
               evidence_json = evidence_json || $2,
               reviewed_by = 'validate-job',
               reviewed_at = NOW()
           WHERE id = $1`,
          [row.matchId, JSON.stringify({
            flaggedAt: new Date().toISOString(),
            reason: 'price_outlier',
            price: row.price,
            medianPrice: Math.round(med * 100) / 100,
            ratio: Math.round(ratio * 100) / 100,
            threshold: ratio > UPPER_RATIO ? `>${UPPER_RATIO}x median` : `<${LOWER_RATIO}x median`,
          })],
        );
        logger.warn(
          `  FLAGGED  ${row.canonicalName.padEnd(30)} ${row.retailerSlug.padEnd(20)}` +
          `AED ${row.price.toFixed(2).padStart(7)}  (median=${med.toFixed(2)}, ratio=${ratio.toFixed(2)}x)`,
        );
        flagged++;
      } else if (!isOutlier && wasReview) {
        // Price returned to normal range — restore so it flows into aggregate again.
        await query(
          `UPDATE product_matches
           SET match_status = 'auto',
               evidence_json = evidence_json || $2,
               reviewed_by = 'validate-job',
               reviewed_at = NOW()
           WHERE id = $1`,
          [row.matchId, JSON.stringify({
            restoredAt: new Date().toISOString(),
            reason: 'price_within_range',
            price: row.price,
            medianPrice: Math.round(med * 100) / 100,
            ratio: Math.round(ratio * 100) / 100,
          })],
        );
        logger.info(
          `  RESTORED ${row.canonicalName.padEnd(30)} ${row.retailerSlug.padEnd(20)}` +
          `AED ${row.price.toFixed(2).padStart(7)}  now within range`,
        );
        restored++;
      }
    }
  }

  const singleRetailerItems = [...byItem.values()].filter((r) => r.length < 2).length;
  logger.info(`${basketSlug}:${marketCode} — flagged=${flagged} restored=${restored} single-retailer-skipped=${singleRetailerItems}`);
}

export async function validateAll(): Promise<void> {
  const configs = loadAllBasketConfigs();
  let failed = 0;
  for (const c of configs) {
    logger.info(`Validating ${c.slug}:${c.marketCode}`);
    try {
      await validateBasket(c.slug, c.marketCode);
    } catch (err) {
      logger.warn(`validateBasket ${c.slug}:${c.marketCode} failed: ${err}`);
      failed++;
    }
  }
  if (failed > 0) throw new Error(`${failed}/${configs.length} basket(s) failed`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateAll().finally(() => closePool()).catch(console.error);
}
