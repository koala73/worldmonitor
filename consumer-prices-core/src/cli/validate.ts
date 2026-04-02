/**
 * Validates DB state: baskets, basket_items, retailers, and recent observations.
 * Run: tsx src/cli/validate.ts
 * Exit 0 = healthy, Exit 1 = issues found.
 */
import 'dotenv/config';
import { getPool } from '../db/client.js';

const pool = getPool();
let issues = 0;

async function check(label: string, sql: string, params: unknown[], expectMin: number) {
  const result = await pool.query<{ count: string }>(sql, params as never[]);
  const count = parseInt(result.rows[0]?.count ?? '0', 10);
  const ok = count >= expectMin;
  console.log(`  [${ok ? 'OK' : 'FAIL'}] ${label}: ${count} (expected ≥ ${expectMin})`);
  if (!ok) issues++;
}

async function run() {
  console.log('[validate] Checking DB state...');

  await check('Baskets', `SELECT COUNT(*) FROM baskets`, [], 1);
  await check('Basket items', `SELECT COUNT(*) FROM basket_items WHERE active = true`, [], 12);
  await check(
    'Canonical products',
    `SELECT COUNT(*) FROM canonical_products WHERE active = true`,
    [],
    12,
  );
  await check('Retailers', `SELECT COUNT(*) FROM retailers WHERE active = true`, [], 1);
  await check(
    'Price observations (any)',
    `SELECT COUNT(*) FROM price_observations`,
    [],
    0,
  );
  await check(
    'Product matches (auto)',
    `SELECT COUNT(*) FROM product_matches WHERE match_status = 'auto'`,
    [],
    0,
  );
  await check(
    'Computed indices',
    `SELECT COUNT(*) FROM computed_indices`,
    [],
    0,
  );

  const freshResult = await pool.query<{ slug: string; last_run_at: Date | null }>(
    `SELECT r.slug, dsh.last_successful_run_at AS last_run_at
     FROM retailers r
     LEFT JOIN data_source_health dsh ON dsh.retailer_id = r.id
     WHERE r.active = true`,
  );
  for (const row of freshResult.rows) {
    const age = row.last_run_at
      ? Math.round((Date.now() - row.last_run_at.getTime()) / 1000 / 60) + 'min ago'
      : 'never scraped';
    console.log(`  [INFO] ${row.slug}: last successful scrape ${age}`);
  }

  await pool.end();
  if (issues > 0) {
    console.error(`[validate] ${issues} check(s) failed.`);
    process.exit(1);
  }
  console.log('[validate] All checks passed.');
}

run().catch((err) => {
  console.error('[validate]', err);
  process.exit(1);
});
