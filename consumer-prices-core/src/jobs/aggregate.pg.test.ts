/**
 * The chained index against a real Postgres: the anchor SQL, the stored
 * inputs, the per-basket lock and the migration-013 fallback run as written,
 * not through a mocked client. CONSUMER_PRICES_TEST_DATABASE_URL names a
 * server the suite may create databases on (CI provides a throwaway service);
 * the suite creates its own database there, never touches the one the URL
 * names, and drops only what it created. Locally it skips without the URL.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const serverUrl = process.env.CONSUMER_PRICES_TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const RETAILER_A = '00000000-0000-0000-0000-00000000000a';
const RETAILER_B = '00000000-0000-0000-0000-00000000000b';
const EGGS_A = '00000000-0000-0000-0000-0000000000e1';
const EGGS_B = '00000000-0000-0000-0000-0000000000e2';
const BREAD_A = '00000000-0000-0000-0000-0000000000b1';
const RUN = '00000000-0000-0000-0000-0000000000f1';
const LOCK_KEY = `hashtext('consumer-prices-aggregate|' || $1)`;

describe.skipIf(!serverUrl && !process.env.CI)('chained basket index (real Postgres)', () => {
  const dbName = `cp_aggregate_test_${randomBytes(6).toString('hex')}`;
  let testUrl = '';
  let db: typeof import('../db/client.js');
  let job: typeof import('./aggregate.js');

  async function onServer(text: string) {
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    try { await admin.query(text); } finally { await admin.end(); }
  }

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

  // Index rows on the newest metric date the job wrote, keyed "category|metric".
  // Reading the written date (not the clock) keeps the assertions right when a
  // run straddles midnight.
  async function latest() {
    const rows = await sql(
      `SELECT COALESCE(ci.category, 'all') AS cat, ci.metric_key AS k, ci.metric_value AS v
       FROM computed_indices ci JOIN baskets b ON b.id = ci.basket_id
       WHERE b.slug = 'essentials-ae' AND ci.metric_key IN ('essentials_index', 'value_index')
         AND ci.metric_date = (SELECT MAX(metric_date) FROM computed_indices)`,
    );
    return Object.fromEntries(rows.map((r) => [`${r.cat}|${r.k}`, Number(r.v)]));
  }

  async function all() {
    return sql(`SELECT metric_date::text AS d, COALESCE(category, '') AS c, metric_key AS k, metric_value AS v
                FROM computed_indices ORDER BY 1, 2, 3`);
  }

  // Moves everything written so far to strictly earlier dates, as if the last
  // run had happened the day before the next one, whatever the clock says.
  async function endDay() {
    await sql(`UPDATE computed_indices SET metric_date = metric_date - 2`);
    await sql(`UPDATE computed_index_inputs SET metric_date = metric_date - 2`);
  }

  async function basketId() {
    return (await sql(`SELECT id FROM baskets WHERE slug = 'essentials-ae'`))[0].id;
  }

  beforeAll(async () => {
    expect(serverUrl, 'CI must provide CONSUMER_PRICES_TEST_DATABASE_URL for the real-Postgres index proof').toBeTruthy();
    await onServer(`CREATE DATABASE ${dbName}`);
    const url = new URL(serverUrl!);
    url.pathname = `/${dbName}`;
    testUrl = url.href;
    process.env.DATABASE_URL = testUrl;
    db = await import('../db/client.js');
    job = await import('./aggregate.js');
  });

  afterAll(async () => {
    await db?.closePool();
    if (testUrl) await onServer(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  });

  beforeEach(async () => {
    // The database is this suite's own, so resetting its schema is safe.
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

  it('chains from the stored anchor prices, keeps confirmed old prices, and reruns idempotently', async () => {
    expect(await job.aggregateBasket('essentials-ae', 'ae')).toBe(true);
    const day1 = await latest();
    expect(day1['all|essentials_index']).toBeCloseTo(90, 2); // eggs 10/12, bread 5/5, weights .12/.08
    expect(day1['eggs|essentials_index']).toBeCloseTo(83.33, 2);
    expect(day1['bread|essentials_index']).toBeCloseTo(100, 2);
    expect(Number((await sql(`SELECT count(*) AS n FROM computed_index_inputs`))[0].n)).toBe(3);

    await endDay();
    // Lands after the anchor's aggregate: re-reading observation history would
    // make it the anchor's price and hide the increase.
    await observe(BREAD_A, 5.5, '0 seconds');
    await job.aggregateBasket('essentials-ae', 'ae');
    const once = await all();
    await job.aggregateBasket('essentials-ae', 'ae');
    expect(await all()).toEqual(once);
    const day2 = await latest();
    expect(day2['bread|essentials_index']).toBeCloseTo(110, 2);
    expect(day2['eggs|essentials_index']).toBeCloseTo(83.33, 2);
    expect(day2['all|essentials_index']).toBeCloseTo(93.89, 2);
  });

  it('holds an item index when one of its retailers stops listing it', async () => {
    await job.aggregateBasket('essentials-ae', 'ae');
    await endDay();
    await observe(EGGS_A, 12, '0 seconds', false); // A out of stock; nothing changed price
    await job.aggregateBasket('essentials-ae', 'ae');
    expect((await latest())['eggs|essentials_index']).toBeCloseTo(83.33, 2);
  });

  it('makes a run wait on the per-basket lock, then complete once it is released', async () => {
    const holder = new pg.Client({ connectionString: testUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`, [await basketId()]);
      let finished = false;
      const run = job.aggregateBasket('essentials-ae', 'ae').then((ok) => { finished = true; return ok; });

      const waiting = async () => Number((await holder.query(
        `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid <> pg_backend_pid()`,
      )).rows[0].n);
      const deadline = Date.now() + 10_000;
      while ((await waiting()) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(await waiting()).toBe(1);
      expect(finished).toBe(false);
      expect(Number((await holder.query(`SELECT count(*) AS n FROM computed_indices`)).rows[0].n)).toBe(0);

      await holder.query('COMMIT');
      expect(await run).toBe(true);
      expect((await latest())['all|essentials_index']).toBeCloseTo(90, 2);
      expect(Number((await sql(`SELECT count(*) AS n FROM computed_index_inputs`))[0].n)).toBe(3);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  });

  it('keeps existing indices and reports failure while migration 013 is missing', async () => {
    await job.aggregateBasket('essentials-ae', 'ae');
    const before = await latest();
    await sql(`DROP TABLE computed_index_inputs`);
    expect(await job.aggregateBasket('essentials-ae', 'ae')).toBe(false);
    expect(await latest()).toEqual(before);
  });

  it('keeps existing indices for an empty basket while migration 013 is missing', async () => {
    await job.aggregateBasket('essentials-ae', 'ae');
    const before = await latest();
    await sql(`DROP TABLE computed_index_inputs`);
    await sql(`UPDATE retailer_products SET last_seen_at = NOW() - interval '30 days'`); // nothing fresh
    expect(await job.aggregateBasket('essentials-ae', 'ae')).toBe(false);
    expect(await latest()).toEqual(before);
  });
});
