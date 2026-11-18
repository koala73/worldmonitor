/**
 * The chained index against a real Postgres: the anchor SQL, the stored
 * inputs, the per-basket lock and the migration-013 fallback run as written,
 * not through a mocked client. CI provides CONSUMER_PRICES_TEST_DATABASE_URL
 * (a throwaway database it recreates); locally the suite skips without one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.CONSUMER_PRICES_TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const RETAILER_A = '00000000-0000-0000-0000-00000000000a';
const RETAILER_B = '00000000-0000-0000-0000-00000000000b';
const EGGS_A = '00000000-0000-0000-0000-0000000000e1';
const EGGS_B = '00000000-0000-0000-0000-0000000000e2';
const BREAD_A = '00000000-0000-0000-0000-0000000000b1';
const RUN = '00000000-0000-0000-0000-0000000000f1';

describe.skipIf(!databaseUrl && !process.env.CI)('chained basket index (real Postgres)', () => {
  let db: typeof import('../db/client.js');
  let job: typeof import('./aggregate.js');

  // No params = simple protocol, which a multi-statement migration file needs.
  async function sql(text: string, params?: unknown[]) {
    return (await db.query<Record<string, string>>(text, params)).rows;
  }

  async function observe(product: string, price: number, ago: string, inStock = true) {
    await sql(
      `INSERT INTO price_observations (retailer_product_id, scrape_run_id, observed_at, price, currency_code, in_stock, raw_hash)
       VALUES ($1, $2, NOW() - $3::interval, $4, 'AED', $5, md5(random()::text))`,
      [product, RUN, ago, price, inStock],
    );
  }

  async function indices() {
    const rows = await sql(
      `SELECT to_char(ci.metric_date, 'YYYY-MM-DD') AS d, COALESCE(ci.category, 'all') AS cat, ci.metric_key AS k, ci.metric_value AS v
       FROM computed_indices ci JOIN baskets b ON b.id = ci.basket_id
       WHERE b.slug = 'essentials-ae' AND ci.metric_key IN ('essentials_index', 'value_index')`,
    );
    return Object.fromEntries(rows.map((r) => [`${r.d}|${r.cat}|${r.k}`, Number(r.v)]));
  }

  async function today() {
    return (await sql(`SELECT to_char(NOW()::date, 'YYYY-MM-DD') AS d`))[0].d;
  }

  // Moves everything the job wrote today to yesterday, as if the last run had happened then.
  async function endDay() {
    await sql(`UPDATE computed_indices SET metric_date = metric_date - 1`);
    await sql(`UPDATE computed_index_inputs SET metric_date = metric_date - 1`);
  }

  beforeEach(async () => {
    expect(databaseUrl, 'CI must provide CONSUMER_PRICES_TEST_DATABASE_URL for the real-Postgres index proof').toBeTruthy();
    process.env.DATABASE_URL = databaseUrl;
    db ??= await import('../db/client.js');
    job ??= await import('./aggregate.js');
    await sql(`DROP SCHEMA public CASCADE`);
    await sql(`CREATE SCHEMA public`);
    // Same bookkeeping as src/db/migrate.ts, which some migrations read.
    await sql(`CREATE TABLE schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      await sql(readFileSync(join(migrationsDir, file), 'utf8'));
      await sql(`INSERT INTO schema_migrations (version) VALUES ($1)`, [file.replace('.sql', '')]);
    }
    await sql(`INSERT INTO retailers (id, slug, name, market_code, country_code, currency_code, base_url) VALUES
      ($1, 'ra', 'A', 'ae', 'AE', 'AED', 'https://a'), ($2, 'rb', 'B', 'ae', 'AE', 'AED', 'https://b')`, [RETAILER_A, RETAILER_B]);
    await sql(`INSERT INTO canonical_products (id, canonical_name, category) VALUES ('00000000-0000-0000-0000-0000000000c1', 'x', 'eggs')`);
    await sql(`INSERT INTO retailer_products (id, retailer_id, source_url, raw_title, last_seen_at) VALUES
      ($1, $4, 'u1', 'eggs a', NOW()), ($2, $5, 'u2', 'eggs b', NOW()), ($3, $4, 'u3', 'bread a', NOW())`,
    [EGGS_A, EGGS_B, BREAD_A, RETAILER_A, RETAILER_B]);
    await sql(
      `INSERT INTO product_matches (retailer_product_id, canonical_product_id, basket_item_id, match_score, match_status)
       SELECT v.p, '00000000-0000-0000-0000-0000000000c1',
              (SELECT bi.id FROM basket_items bi JOIN baskets b ON b.id = bi.basket_id
               WHERE b.slug = 'essentials-ae' AND bi.category = v.c LIMIT 1), 1, 'auto'
       FROM (VALUES ($1::uuid, 'eggs'), ($2::uuid, 'eggs'), ($3::uuid, 'bread')) AS v(p, c)`,
      [EGGS_A, EGGS_B, BREAD_A],
    );
    await sql(`INSERT INTO scrape_runs (id, retailer_id) VALUES ($1, $2)`, [RUN, RETAILER_A]);
    // Eggs at A: an unchanged payload whose reused observation is 20 days old,
    // still confirmed by a current last_seen_at.
    await observe(EGGS_A, 12, '20 days');
    await observe(EGGS_B, 8, '1 hour');
    await observe(BREAD_A, 5, '1 hour');
  });

  afterAll(async () => { await db?.closePool(); });

  it('chains from the stored anchor prices, keeps confirmed old prices, and reruns idempotently', async () => {
    expect(await job.aggregateBasket('essentials-ae', 'ae')).toBe(true);
    const day1 = await indices();
    const d1 = await today();
    expect(day1[`${d1}|all|essentials_index`]).toBeCloseTo(90, 2); // eggs 10/12, bread 5/5, weights .12/.08
    expect(day1[`${d1}|eggs|essentials_index`]).toBeCloseTo(83.33, 2);
    expect(day1[`${d1}|bread|essentials_index`]).toBeCloseTo(100, 2);
    expect(Number((await sql(`SELECT count(*) AS n FROM computed_index_inputs`))[0].n)).toBe(3);

    await endDay();
    // Lands after the anchor's aggregate: re-reading observation history would
    // make it the anchor's price and hide the increase.
    await observe(BREAD_A, 5.5, '0 seconds');
    await job.aggregateBasket('essentials-ae', 'ae');
    await job.aggregateBasket('essentials-ae', 'ae');
    const day2 = await indices();
    const d2 = await today();
    expect(day2[`${d2}|bread|essentials_index`]).toBeCloseTo(110, 2);
    expect(day2[`${d2}|eggs|essentials_index`]).toBeCloseTo(83.33, 2);
    expect(day2[`${d2}|all|essentials_index`]).toBeCloseTo(93.89, 2);
  });

  it('holds an item index when one of its retailers stops listing it', async () => {
    await job.aggregateBasket('essentials-ae', 'ae');
    await endDay();
    await observe(EGGS_A, 12, '0 seconds', false); // A out of stock; nothing changed price
    await job.aggregateBasket('essentials-ae', 'ae');
    const d2 = await today();
    expect((await indices())[`${d2}|eggs|essentials_index`]).toBeCloseTo(83.33, 2);
  });

  it('serialises overlapping runs for one basket into one consistent set of rows', async () => {
    await Promise.all([job.aggregateBasket('essentials-ae', 'ae'), job.aggregateBasket('essentials-ae', 'ae')]);
    expect(Number((await sql(`SELECT count(*) AS n FROM computed_index_inputs`))[0].n)).toBe(3);
    expect((await indices())[`${await today()}|all|essentials_index`]).toBeCloseTo(90, 2);
  });

  it('keeps existing indices and reports failure while migration 013 is missing', async () => {
    await job.aggregateBasket('essentials-ae', 'ae');
    const before = await indices();
    await sql(`DROP TABLE computed_index_inputs`);
    expect(await job.aggregateBasket('essentials-ae', 'ae')).toBe(false);
    expect(await indices()).toEqual(before);
  });
});
