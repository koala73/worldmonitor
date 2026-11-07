/**
 * Simple forward-only migration runner.
 * Run: tsx src/db/migrate.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import type pg from 'pg';
import { getPool } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION_TIMEOUT_MS = 30 * 60_000;

async function run() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await pool.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`);
  const appliedSet = new Set(applied.rows.map((r) => r.version));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    if (appliedSet.has(version)) {
      console.log(`  [skip] ${file}`);
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  [run]  ${file}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The shared pool caps statements at 30s for request paths; schema
      // changes and backfills may legitimately run longer. pg reads a
      // query_timeout of 0 as unset, so lift both limits to an explicit bound.
      await client.query(`SET LOCAL statement_timeout = ${MIGRATION_TIMEOUT_MS}`);
      // pg's runtime honours a per-query query_timeout; its QueryConfig type omits it.
      const migration: pg.QueryConfig & { query_timeout: number } = { text: sql, query_timeout: MIGRATION_TIMEOUT_MS + 5_000 };
      await client.query(migration);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
      await client.query('COMMIT');
      console.log(`  [done] ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  [fail] ${file}:`, err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('Migrations complete.');
}

run().catch(console.error);
