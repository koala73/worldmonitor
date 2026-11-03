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
import { classifyMatchAdmission } from './scrape-coverage.js';
import type { ValidatorResult } from '../adapters/validator.js';
import { MAX_OBSERVATION_AGE_DAYS } from '../observation-freshness.js';

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
  currencyCode?: string;
  reviewedBy: string | null;
  observationId: string;
  admitted: boolean;
}

async function validateBasket(basketSlug: string, marketCode: string): Promise<void> {
  const result = await query<{
    match_id: string;
    basket_item_id: string;
    match_status: string;
    retailer_slug: string;
    canonical_name: string;
    price: string;
    currency_code: string | null;
    reviewed_by: string | null;
    observation_id: string;
    validator: ValidatorResult | null;
  }>(
    `SELECT pm.id AS match_id, pm.basket_item_id, pm.match_status,
            r.slug AS retailer_slug, cp.canonical_name, po.price, r.currency_code,
            pm.reviewed_by, po.id AS observation_id,
            po.raw_payload_json->'validator' AS validator
     FROM product_matches pm
     JOIN retailer_products rp ON rp.id = pm.retailer_product_id AND rp.active = true
     JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $2 AND r.active = true
     JOIN basket_items bi ON bi.id = pm.basket_item_id AND bi.active = true
     JOIN baskets b ON b.id = bi.basket_id AND b.slug = $1
     JOIN canonical_products cp ON cp.id = pm.canonical_product_id
     JOIN LATERAL (
       SELECT id, price, in_stock, raw_payload_json FROM price_observations
       WHERE retailer_product_id = rp.id
       ORDER BY observed_at DESC, id DESC LIMIT 1
     ) po ON po.in_stock = true
       AND rp.last_seen_at >= NOW() - make_interval(days => $3)
     WHERE pm.match_status IN ('auto', 'approved', 'review')
       AND pm.pin_disabled_at IS NULL`,
    [basketSlug, marketCode, MAX_OBSERVATION_AGE_DAYS],
  );

  const rows: MatchRow[] = result.rows.map((r) => ({
    matchId: r.match_id,
    basketItemId: r.basket_item_id,
    matchStatus: r.match_status,
    retailerSlug: r.retailer_slug,
    canonicalName: r.canonical_name,
    price: parseFloat(r.price),
    currencyCode: typeof r.currency_code === 'string' ? r.currency_code : undefined,
    reviewedBy: r.reviewed_by,
    observationId: r.observation_id,
    admitted: classifyMatchAdmission(r.validator ?? undefined).status === 'auto',
  }));

  // Group by basket item
  const byItem = new Map<string, MatchRow[]>();
  for (const r of rows) {
    if (!byItem.has(r.basketItemId)) byItem.set(r.basketItemId, []);
    byItem.get(r.basketItemId)!.push(r);
  }

  // Retailers a scrape saw within the window, per item, whatever their stock.
  // The priced query above also drops a retailer whose latest observation is
  // out of stock; that says nothing about this item's price, so releasing a
  // hold then would publish a price this job flagged. A hold is released only
  // when no other retailer has been seen at all. Loaded once, on first need.
  let seenRetailers: Map<string, number> | null = null;
  const othersSeen = async (basketItemId: string): Promise<boolean> => {
    if (!seenRetailers) {
      const seen = await query<{ basket_item_id: string; retailers: number }>(
        `SELECT pm.basket_item_id, COUNT(DISTINCT r.id)::int AS retailers
         FROM product_matches pm
         JOIN retailer_products rp ON rp.id = pm.retailer_product_id
         JOIN retailers r ON r.id = rp.retailer_id AND r.market_code = $2 AND r.active = true
         JOIN basket_items bi ON bi.id = pm.basket_item_id AND bi.active = true
         JOIN baskets b ON b.id = bi.basket_id AND b.slug = $1
         WHERE pm.match_status <> 'rejected'
           AND rp.last_seen_at >= NOW() - make_interval(days => $3)
         GROUP BY pm.basket_item_id`,
        [basketSlug, marketCode, MAX_OBSERVATION_AGE_DAYS],
      );
      seenRetailers = new Map(seen.rows.map((r) => [r.basket_item_id, Number(r.retailers)]));
    }
    return (seenRetailers.get(basketItemId) ?? 0) > 1;
  };

  let flagged = 0;
  let restored = 0;

  for (const [basketItemId, itemRows] of byItem) {
    // Need >= 2 retailers to compute a meaningful cross-retailer median.
    // Single-retailer items cannot be sanity-checked, so nothing is flagged —
    // but a hold this job placed while a peer existed is released once no
    // scrape has seen that peer within the window, or the item stays held
    // forever.
    const pricesByRetailer = new Map<string, number[]>();
    for (const row of itemRows) {
      const prices = pricesByRetailer.get(row.retailerSlug) ?? [];
      prices.push(row.price);
      pricesByRetailer.set(row.retailerSlug, prices);
    }
    const peered = pricesByRetailer.size >= 2;
    const peerPrices = [...pricesByRetailer.values()].map(prices => median(prices));
    const med = peered ? median(peerPrices) : 0;
    if (peered && med === 0) continue;
    const disputedPair = peerPrices.length === 2 &&
      Math.max(...peerPrices) / Math.min(...peerPrices) > UPPER_RATIO;

    for (const row of itemRows) {
      const ratio = peered ? row.price / med : 1;
      const isOutlier = peered && (disputedPair || ratio > UPPER_RATIO || ratio < LOWER_RATIO);
      const wasReview = row.matchStatus === 'review';

      if (isOutlier && !wasReview) {
        await query(
          `UPDATE product_matches
           SET match_status = 'review',
               evidence_json = evidence_json || $2,
               reviewed_by = CASE WHEN match_status = 'approved' THEN reviewed_by ELSE 'validate-job' END,
               reviewed_at = CASE WHEN match_status = 'approved' THEN reviewed_at ELSE NOW() END
           WHERE id = $1 AND match_status IN ('auto', 'approved')`,
          [row.matchId, JSON.stringify({
            flaggedAt: new Date().toISOString(),
            previousMatchStatus: row.matchStatus,
            previousReviewedBy: row.reviewedBy,
            reason: disputedPair ? 'price_disagreement' : 'price_outlier',
            price: row.price,
            medianPrice: Math.round(med * 100) / 100,
            ratio: Math.round(ratio * 100) / 100,
            threshold: disputedPair ? `>${UPPER_RATIO}x peer`
              : ratio > UPPER_RATIO ? `>${UPPER_RATIO}x median` : `<${LOWER_RATIO}x median`,
          })],
        );
        logger.warn(
          `  FLAGGED  ${row.canonicalName.padEnd(30)} ${row.retailerSlug.padEnd(20)}` +
          `${(row.currencyCode ?? "").padEnd(3)}${row.price.toFixed(2).padStart(7)}  (median=${med.toFixed(2)}, ratio=${ratio.toFixed(2)}x)`,
        );
        flagged++;
      } else if (
        !isOutlier && wasReview && row.reviewedBy === 'validate-job' && row.admitted &&
        (peered || !(await othersSeen(basketItemId)))
      ) {
        // Price returned to normal range — restore so it flows into aggregate again.
        await query(
          `UPDATE product_matches
           SET match_status = 'auto',
               evidence_json = evidence_json || $2,
               reviewed_by = 'validate-job',
               reviewed_at = NOW()
           WHERE id = $1 AND match_status = 'review' AND reviewed_by = 'validate-job'
             AND pin_disabled_at IS NULL
             AND $3 = (SELECT id::text FROM price_observations
                       WHERE retailer_product_id = product_matches.retailer_product_id
                       ORDER BY observed_at DESC, id DESC LIMIT 1)`,
          [row.matchId, JSON.stringify(peered ? {
            restoredAt: new Date().toISOString(),
            reason: 'price_within_range',
            price: row.price,
            medianPrice: Math.round(med * 100) / 100,
            ratio: Math.round(ratio * 100) / 100,
          } : {
            restoredAt: new Date().toISOString(),
            reason: 'no_fresh_peer',
            price: row.price,
          }), row.observationId],
        );
        logger.info(
          `  RESTORED ${row.canonicalName.padEnd(30)} ${row.retailerSlug.padEnd(20)}` +
          `${(row.currencyCode ?? "").padEnd(3)}${row.price.toFixed(2).padStart(7)}  ${peered ? 'now within range' : 'no fresh peer'}`,
        );
        restored++;
      }
    }
  }

  const singleRetailerItems = [...byItem.values()].filter(rows => new Set(rows.map(row => row.retailerSlug)).size < 2).length;
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
