#!/usr/bin/env node
/**
 * Discovery driver for the (digestMode=realtime, sensitivity=all) backfill.
 *
 * TEMP MIGRATION SCRIPT — remove after the migration runs in production.
 * See plans/forbid-realtime-all-events.md §4a.
 *
 * Usage:
 *   export CONVEX_URL=...
 *   export MIGRATION_ADMIN_SECRET=...   (must match the value set via
 *                                        `npx convex env set MIGRATION_ADMIN_SECRET ...`)
 *   node scripts/migrate-discover-realtime-all.mjs
 *
 * Output: JSON summary to stdout — total matched, enabled-vs-disabled split,
 * per-variant counts, and a small sample of {_id, userId, variant} for spot-checks.
 * The script paginates through `alertRules` 500 rows per call; each Convex query
 * call returns counts only (no full rows) to stay well inside result limits.
 */

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

const c = new ConvexHttpClient(convexUrl);

let cursor = null;
const totals = { matched: 0, enabledMatched: 0, variantCounts: {}, samples: [] };
const t0 = Date.now();
let pages = 0;

try {
  do {
    const r = await c.query(api.alertRules._countRealtimeAllRules, { cursor, adminSecret });
    pages++;
    totals.matched += r.matched;
    totals.enabledMatched += r.enabledMatched;
    for (const [k, v] of Object.entries(r.variantCounts)) {
      totals.variantCounts[k] = (totals.variantCounts[k] ?? 0) + v;
    }
    if (totals.samples.length < 20) {
      totals.samples.push(...r.sample.slice(0, 20 - totals.samples.length));
    }
    cursor = r.isDone ? null : r.nextCursor;
  } while (cursor);
} catch (err) {
  // Do not echo the supplied secret on error.
  console.error('[discover] error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log(JSON.stringify({
  matched: totals.matched,
  enabledMatched: totals.enabledMatched,
  disabledMatched: totals.matched - totals.enabledMatched,
  variantCounts: totals.variantCounts,
  samples: totals.samples,
  pagesScanned: pages,
  elapsedSec: (Date.now() - t0) / 1000,
}, null, 2));
