import { query } from '../client.js';

export async function upsertProductMatch(input: {
  retailerProductId: string;
  canonicalProductId: string;
  basketItemId: string;
  matchScore: number;
  matchStatus: 'auto' | 'approved';
}): Promise<void> {
  await query(
    `INSERT INTO product_matches
       (retailer_product_id, canonical_product_id, basket_item_id, match_score, match_status, evidence_json)
     VALUES ($1,$2,$3,$4,$5,'{}')
     ON CONFLICT (retailer_product_id, canonical_product_id)
     DO UPDATE SET
       basket_item_id  = EXCLUDED.basket_item_id,
       match_score     = EXCLUDED.match_score,
       match_status    = EXCLUDED.match_status,
       pin_disabled_at = NULL`,
    [
      input.retailerProductId,
      input.canonicalProductId,
      input.basketItemId,
      input.matchScore,
      input.matchStatus,
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
