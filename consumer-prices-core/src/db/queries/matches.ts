import { query } from '../client.js';

export async function upsertProductMatch(input: {
  retailerProductId: string;
  canonicalProductId: string;
  basketItemId: string;
  matchScore: number;
  matchStatus: 'auto' | 'approved' | 'candidate';
  evidence?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO product_matches
       (retailer_product_id, canonical_product_id, basket_item_id, match_score, match_status, evidence_json)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (retailer_product_id, canonical_product_id)
     DO UPDATE SET
       basket_item_id  = EXCLUDED.basket_item_id,
       match_score     = EXCLUDED.match_score,
       -- Curated states are immutable via the scrape upsert:
       --   'approved' — human accepted the match
       --   'review'   — validate-job quarantined on price outlier, or
       --                human sent it back for review (see jobs/validate.ts)
       --   'rejected' — human explicitly blocked this URL
       -- Conflict key is (retailer_product_id, canonical_product_id), so
       -- rediscovery is the normal path for these rows. Without this
       -- guard a re-scrape writes 'auto' or 'candidate' and silently
       -- re-enables a previously quarantined URL in aggregate queries
       -- (aggregate.ts / snapshots filter on ('auto','approved')).
       -- Only machine-written states ('auto', 'candidate') are allowed
       -- to move to the fresh validator verdict.
       match_status    = CASE
         WHEN product_matches.match_status IN ('approved', 'review', 'rejected')
           THEN product_matches.match_status
         ELSE EXCLUDED.match_status
       END,
       evidence_json   = EXCLUDED.evidence_json,
       -- Only clear pin_disabled_at when the row is actually moving back
       -- to a machine-writable state. A 'review'/'rejected' row keeps
       -- its disabled flag until the review workflow resolves it.
       pin_disabled_at = CASE
         WHEN product_matches.match_status IN ('review', 'rejected')
           THEN product_matches.pin_disabled_at
         ELSE NULL
       END`,
    [
      input.retailerProductId,
      input.canonicalProductId,
      input.basketItemId,
      input.matchScore,
      input.matchStatus,
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  // Reset stale counters when Exa re-discovers a product — fresh match means the URL works.
  await query(
    `UPDATE retailer_products
     SET consecutive_out_of_stock = 0, pin_error_count = 0
     WHERE id = $1`,
    [input.retailerProductId],
  );
}

export async function getBasketItemId(basketSlug: string, canonicalName: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT bi.id FROM basket_items bi
     JOIN baskets b ON b.id = bi.basket_id
     JOIN canonical_products cp ON cp.id = bi.canonical_product_id
     WHERE b.slug = $1 AND cp.canonical_name = $2 AND bi.active = true
     LIMIT 1`,
    [basketSlug, canonicalName],
  );
  return result.rows[0]?.id ?? null;
}

export async function getPinnedUrlsForRetailer(
  retailerId: string,
): Promise<Map<string, { sourceUrl: string; productId: string; matchId: string }>> {
  // Returns Map<"basketSlug:canonicalName", { sourceUrl, productId, matchId }>
  // Compound key prevents collisions if multi-basket-per-market ever exists.
  // Excludes soft-disabled pins, and products with OOS/error counters >= 3.
  const result = await query<{
    canonical_name: string;
    basket_slug: string;
    source_url: string;
    product_id: string;
    match_id: string;
  }>(
    `SELECT DISTINCT ON (pm.basket_item_id)
       cp.canonical_name,
       b.slug AS basket_slug,
       rp.source_url,
       rp.id AS product_id,
       pm.id AS match_id
     FROM product_matches pm
     JOIN retailer_products rp ON rp.id = pm.retailer_product_id
     JOIN basket_items bi ON bi.id = pm.basket_item_id
     JOIN baskets b ON b.id = bi.basket_id
     JOIN canonical_products cp ON cp.id = bi.canonical_product_id
     WHERE rp.retailer_id = $1
       AND pm.match_status IN ('auto', 'approved')
       AND pm.pin_disabled_at IS NULL
       AND rp.consecutive_out_of_stock < 3
       AND rp.pin_error_count < 3
     ORDER BY pm.basket_item_id, pm.match_score DESC`,
    [retailerId],
  );
  const map = new Map<string, { sourceUrl: string; productId: string; matchId: string }>();
  for (const row of result.rows) {
    const key = `${row.basket_slug}:${row.canonical_name}`;
    map.set(key, { sourceUrl: row.source_url, productId: row.product_id, matchId: row.match_id });
  }
  return map;
}

/**
 * Returns disabled pins for recovery probing — pins where the scrape job
 * stopped fetching due to the 3-strike disable rule, paired with the new
 * auto-recovery counter (consecutive_in_stock).
 *
 * Without this path, decay restarts after the migration: once a pin gets
 * disabled, getPinnedUrlsForRetailer excludes it forever, the scrape job
 * never observes it again, the recovery counter never increments, and the
 * sticky marker is never cleared. See PR #3627 fresh-eyes review (P1).
 *
 * Bounded by `limit` so a retailer with hundreds of disabled pins doesn't
 * explode the scrape budget. Recovery probes get one fetch per cycle each;
 * with `limit=10` and ~30 disabled pins per retailer, full coverage is
 * ~3 days, recovery to 3-in-stock is ~9 days. Acceptable for a daily-cron
 * scrape; tunable if budget allows.
 *
 * Aggregation queries (worldmonitor.ts buildSpreadSnapshot etc.) continue
 * to filter `pm.pin_disabled_at IS NULL`, so disabled pins probed here
 * still don't affect spread quality during the recovery window.
 *
 * GLOBAL FIFO: ranked CTE picks the OLDEST-disabled match per basket_item
 * (one representative per item to avoid duplicate probes for the same
 * basket entry), then orders globally by pin_disabled_at ASC and applies
 * the LIMIT.
 *
 * NOT to be replaced with `DISTINCT ON (pm.basket_item_id) ORDER BY
 * pm.basket_item_id, pm.pin_disabled_at ASC` — that ORDER BY-then-LIMIT
 * sorts the deduped set by basket_item_id (UUID order), not pin_disabled_at,
 * so the lowest-UUID basket_items would be probed every cycle while
 * higher-UUID disabled pins would starve forever. This bug was caught in
 * PR #3627 review (P1). Ranked-CTE + outer ORDER BY is the right shape.
 */
export async function getDisabledPinsForRecovery(
  retailerId: string,
  limit: number,
): Promise<Map<string, { sourceUrl: string; productId: string; matchId: string }>> {
  const result = await query<{
    canonical_name: string;
    basket_slug: string;
    source_url: string;
    product_id: string;
    match_id: string;
  }>(
    `SELECT canonical_name, basket_slug, source_url, product_id, match_id
       FROM (
         SELECT
           cp.canonical_name,
           b.slug AS basket_slug,
           rp.source_url,
           rp.id AS product_id,
           pm.id AS match_id,
           pm.pin_disabled_at,
           ROW_NUMBER() OVER (
             PARTITION BY pm.basket_item_id
             ORDER BY pm.pin_disabled_at ASC
           ) AS rn
         FROM product_matches pm
         JOIN retailer_products rp ON rp.id = pm.retailer_product_id
         JOIN basket_items bi ON bi.id = pm.basket_item_id
         JOIN baskets b ON b.id = bi.basket_id
         JOIN canonical_products cp ON cp.id = bi.canonical_product_id
         WHERE rp.retailer_id = $1
           AND pm.match_status IN ('auto', 'approved')
           AND pm.pin_disabled_at IS NOT NULL
       ) ranked
      WHERE rn = 1
      ORDER BY pin_disabled_at ASC
      LIMIT $2`,
    [retailerId, limit],
  );
  const map = new Map<string, { sourceUrl: string; productId: string; matchId: string }>();
  for (const row of result.rows) {
    const key = `${row.basket_slug}:${row.canonical_name}`;
    map.set(key, { sourceUrl: row.source_url, productId: row.product_id, matchId: row.match_id });
  }
  return map;
}
