import { createHash } from 'node:crypto';
import { query, type QueryExecutor } from '../client.js';

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

export async function insertObservation(
  input: InsertObservationInput,
  execute: QueryExecutor = query,
): Promise<string> {
  const rawHash = hashPayload(input.rawPayloadJson);

  // Deduplicate only consecutive identical payloads. Searching the full
  // history can return an older row after a different observation became
  // latest; callers could then promote a match while the intervening evidence
  // remained the row aggregates selected.
  const existing = await execute<{ id: string; raw_hash: string }>(
    `SELECT id, raw_hash FROM price_observations WHERE retailer_product_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1`,
    [input.retailerProductId],
  );
  if (existing.rows[0]?.raw_hash === rawHash) return existing.rows[0].id;

  const result = await execute<{ id: string }>(
    `INSERT INTO price_observations
      (retailer_product_id, scrape_run_id, observed_at, price, list_price, promo_price,
       currency_code, unit_price, unit_basis_qty, unit_basis_unit, in_stock, promo_text,
       raw_payload_json, raw_hash)
     VALUES ($1,$2,clock_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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

