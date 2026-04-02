import { query } from '../client.js';
import type { CanonicalProduct, RetailerProduct } from '../models.js';

export async function upsertRetailerProduct(input: {
  retailerId: string;
  retailerSku: string | null;
  sourceUrl: string;
  rawTitle: string;
  rawBrand?: string | null;
  rawSizeText?: string | null;
  imageUrl?: string | null;
  categoryText?: string | null;
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO retailer_products
       (retailer_id, retailer_sku, source_url, raw_title, raw_brand, raw_size_text,
        image_url, category_text, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
     ON CONFLICT (retailer_id, source_url) DO UPDATE
       SET raw_title = EXCLUDED.raw_title,
           raw_brand = EXCLUDED.raw_brand,
           raw_size_text = EXCLUDED.raw_size_text,
           image_url = EXCLUDED.image_url,
           category_text = EXCLUDED.category_text,
           last_seen_at = NOW()
     RETURNING id`,
    [
      input.retailerId,
      input.retailerSku ?? null,
      input.sourceUrl,
      input.rawTitle,
      input.rawBrand ?? null,
      input.rawSizeText ?? null,
      input.imageUrl ?? null,
      input.categoryText ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getRetailerProductsByRetailer(retailerId: string): Promise<RetailerProduct[]> {
  const result = await query<RetailerProduct>(
    `SELECT * FROM retailer_products WHERE retailer_id = $1 AND active = true`,
    [retailerId],
  );
  return result.rows;
}

export async function getCanonicalProducts(marketCode?: string): Promise<CanonicalProduct[]> {
  const result = await query<CanonicalProduct>(
    `SELECT * FROM canonical_products WHERE active = true ORDER BY canonical_name`,
    [],
  );
  return result.rows;
}

export async function upsertCanonicalProduct(input: {
  canonicalName: string;
  brandNorm?: string | null;
  category: string;
  variantNorm?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  baseQuantity?: number | null;
  baseUnit?: string | null;
}): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO canonical_products
       (canonical_name, brand_norm, category, variant_norm, size_value, size_unit,
        base_quantity, base_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (canonical_name, category)
       WHERE brand_norm IS NULL AND variant_norm IS NULL AND size_value IS NULL AND size_unit IS NULL
     DO UPDATE SET base_quantity = EXCLUDED.base_quantity, base_unit = EXCLUDED.base_unit
     RETURNING id`,
    [
      input.canonicalName,
      input.brandNorm ?? null,
      input.category,
      input.variantNorm ?? null,
      input.sizeValue ?? null,
      input.sizeUnit ?? null,
      input.baseQuantity ?? null,
      input.baseUnit ?? null,
    ],
  );
  return result.rows[0].id;
}

