import { createHash } from 'node:crypto';
import { query } from '../client.js';
import type { PriceObservation } from '../models.js';

export interface InsertObservationInput {
  retailerProductId: string;
  scrapeRunId: string;
  price: number;
  listPrice?: number | null;
  promoPrice?: number | null;
  currencyCode: string;
  unitPrice?: number | null;
  unitBasisQty?: number | null;
  unitBasisUnit?: string | null;
  inStock?: boolean;
  promoText?: string | null;
  rawPayloadJson: Record<string, unknown>;
}

export function hashPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 64);
}

export async function insertObservation(input: InsertObservationInput): Promise<string> {
  const rawHash = hashPayload(input.rawPayloadJson);

  const existing = await query<{ id: string }>(
    `SELECT id FROM price_observations WHERE retailer_product_id = $1 AND raw_hash = $2 ORDER BY observed_at DESC LIMIT 1`,
    [input.retailerProductId, rawHash],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const result = await query<{ id: string }>(
    `INSERT INTO price_observations
      (retailer_product_id, scrape_run_id, observed_at, price, list_price, promo_price,
       currency_code, unit_price, unit_basis_qty, unit_basis_unit, in_stock, promo_text,
       raw_payload_json, raw_hash)
     VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.retailerProductId,
      input.scrapeRunId,
      input.price,
      input.listPrice ?? null,
      input.promoPrice ?? null,
      input.currencyCode,
      input.unitPrice ?? null,
      input.unitBasisQty ?? null,
      input.unitBasisUnit ?? null,
      input.inStock ?? true,
      input.promoText ?? null,
      JSON.stringify(input.rawPayloadJson),
      rawHash,
    ],
  );
  return result.rows[0].id;
}

export async function getLatestObservations(
  retailerProductIds: string[],
): Promise<PriceObservation[]> {
  if (retailerProductIds.length === 0) return [];

  const result = await query<PriceObservation>(
    `SELECT DISTINCT ON (retailer_product_id) *
     FROM price_observations
     WHERE retailer_product_id = ANY($1) AND in_stock = true
     ORDER BY retailer_product_id, observed_at DESC`,
    [retailerProductIds],
  );
  return result.rows;
}

export async function getPriceHistory(
  retailerProductId: string,
  daysBack: number,
): Promise<Array<{ date: Date; price: number; unitPrice: number | null }>> {
  const result = await query<{ date: Date; price: number; unit_price: number | null }>(
    `SELECT date_trunc('day', observed_at) AS date,
            AVG(price)::numeric(12,2) AS price,
            AVG(unit_price)::numeric(12,4) AS unit_price
     FROM price_observations
     WHERE retailer_product_id = $1
       AND observed_at > NOW() - ($2 || ' days')::INTERVAL
       AND in_stock = true
     GROUP BY 1
     ORDER BY 1`,
    [retailerProductId, daysBack],
  );
  return result.rows.map((r) => ({ date: r.date, price: r.price, unitPrice: r.unit_price }));
}
