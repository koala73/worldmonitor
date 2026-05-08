/**
 * Pin disable + auto-recovery helpers — extracted from scrape.ts so they
 * can be unit-tested in isolation (scrape.ts pulls a heavy transitive
 * dep tree including exa-js, playwright, etc.; this module only needs
 * `query`).
 *
 * The 3-strike threshold is symmetric on both sides:
 *   - 3 consecutive OOS  → set pin_disabled_at  (handleStaleOnOutOfStock)
 *   - 3 consecutive in-stock → clear pin_disabled_at (handleStaleOnInStock)
 *
 * See migration 009 + memory `sticky-disable-without-auto-recovery-decays`
 * for why both halves shipping together matters.
 */
import { query } from '../db/client.js';

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[scrape-pin] ${msg}`, ...args),
};

/**
 * Auto-recovery: when a pinned product is in-stock for ≥3 consecutive
 * scrapes, clear the sticky pin_disabled_at marker so the match flows
 * back into aggregation.
 *
 * Idempotent — the WHERE pin_disabled_at IS NOT NULL clause makes the
 * clear a no-op on already-active matches, so we don't bump reviewed_at
 * or otherwise touch rows that were never disabled.
 */
export async function handleStaleOnInStock(productId: string, matchId: string, targetId: string): Promise<void> {
  const { rows } = await query<{ in_stock_count: string }>(
    `UPDATE retailer_products
        SET consecutive_in_stock = consecutive_in_stock + 1,
            consecutive_out_of_stock = 0,
            pin_error_count = 0
      WHERE id = $1
  RETURNING consecutive_in_stock AS in_stock_count`,
    [productId],
  );
  const inStockCount = parseInt(rows[0]?.in_stock_count ?? '0', 10);
  if (inStockCount >= 3) {
    const { rowCount } = await query(
      `UPDATE product_matches
          SET pin_disabled_at = NULL
        WHERE id = $1 AND pin_disabled_at IS NOT NULL`,
      [matchId],
    );
    if (rowCount && rowCount > 0) {
      logger.info(`auto-recovered stale pin for ${targetId} (${inStockCount}x in-stock)`);
    }
  }
}

/**
 * Existing 3-strike disable rule (migration 007). Kept here for symmetry
 * with the recovery helper. Resets consecutive_in_stock to 0 so the
 * recovery counter can't accumulate falsely across failed runs.
 */
export async function handleStaleOnOutOfStock(productId: string, matchId: string, targetId: string): Promise<void> {
  const { rows } = await query<{ c: string }>(
    `UPDATE retailer_products
        SET consecutive_out_of_stock = consecutive_out_of_stock + 1,
            consecutive_in_stock = 0
      WHERE id = $1
  RETURNING consecutive_out_of_stock AS c`,
    [productId],
  );
  const count = parseInt(rows[0]?.c ?? '0', 10);
  if (count >= 3) {
    await query(`UPDATE product_matches SET pin_disabled_at = NOW() WHERE id = $1`, [matchId]);
    logger.info(`soft-disabled stale pin for ${targetId} (${count}x out-of-stock)`);
  }
}

/**
 * Pin-error counterpart: when an Exa fallback fires (the original pin URL
 * stopped resolving), increment the error counter and disable on the
 * 3-strike threshold. Resets consecutive_in_stock to 0 — same symmetry
 * argument as handleStaleOnOutOfStock.
 */
export async function handlePinError(productId: string, matchId: string, targetId: string): Promise<void> {
  const { rows } = await query<{ c: string }>(
    `UPDATE retailer_products
        SET pin_error_count = pin_error_count + 1,
            consecutive_in_stock = 0
      WHERE id = $1
  RETURNING pin_error_count AS c`,
    [productId],
  );
  const count = parseInt(rows[0]?.c ?? '0', 10);
  if (count >= 3) {
    await query(`UPDATE product_matches SET pin_disabled_at = NOW() WHERE id = $1`, [matchId]);
    logger.info(`soft-disabled stale pin for ${targetId} (${count}x errors)`);
  }
}
