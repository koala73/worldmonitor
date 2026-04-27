#!/usr/bin/env node
/**
 * Migration driver for the (digestMode=realtime, sensitivity=all) backfill.
 * Flips affected rows to digestMode='daily' (preserving sensitivity='all') so
 * the user's "I want all events" intent is preserved as a batched delivery.
 *
 * TEMP MIGRATION SCRIPT — remove after the migration runs in production.
 * See plans/forbid-realtime-all-events.md §4b.
 *
 * Usage:
 *   export CONVEX_URL=...
 *   export MIGRATION_ADMIN_SECRET=...
 *   node scripts/migrate-realtime-all-to-daily.mjs --dry-run   # preview only
 *   node scripts/migrate-realtime-all-to-daily.mjs             # live run
 *
 * Idempotent: each page filters to "still in forbidden state" before patching;
 * already-migrated rows are skipped on re-run. Pages 200 rows per call to keep
 * each Convex transaction inside the per-call write budget.
 */
'use strict';

import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';

const convexUrl = process.env.CONVEX_URL;
const adminSecret = process.env.MIGRATION_ADMIN_SECRET;

if (!convexUrl) {
  console.error('CONVEX_URL not set');
  process.exit(1);
}
if (!adminSecret) {
  console.error('MIGRATION_ADMIN_SECRET not set');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const PAGE_SIZE = 200;
const DEFAULT_DIGEST_HOUR = 8;
const DEFAULT_DIGEST_TIMEZONE = 'UTC';

const c = new ConvexHttpClient(convexUrl);

let cursor = null;
let total = 0;
let pages = 0;
const t0 = Date.now();

try {
  do {
    const r = await c.mutation(api.alertRules._migrateRealtimeAllPage, {
      cursor,
      pageSize: PAGE_SIZE,
      dryRun,
      defaultDigestHour: DEFAULT_DIGEST_HOUR,
      defaultDigestTimezone: DEFAULT_DIGEST_TIMEZONE,
      adminSecret,
    });
    pages++;
    total += r.migrated;
    console.log(`[migrate] page ${pages}: ${dryRun ? 'wouldMigrate' : 'migrated'}=${r.migrated}, total=${total}, isDone=${r.isDone}`);
    cursor = r.isDone ? null : r.nextCursor;
  } while (cursor);
} catch (err) {
  // Do not echo the supplied secret on error.
  console.error('[migrate] error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const verb = dryRun ? '[DRY-RUN] would migrate' : 'migrated';
console.log(`[migrate] DONE: ${verb} ${total} rows in ${pages} pages, ${(Date.now() - t0) / 1000}s`);
