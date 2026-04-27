#!/usr/bin/env node
/**
 * Recipient-list driver for the (realtime, all) courtesy email.
 *
 * Joins the forbidden-state alertRules rows with their owners' verified email
 * channels and writes the result as JSON to stdout. Pipe to a file and feed it
 * into your sender of choice (Resend dashboard import, send-script, etc.).
 *
 * Pagination + fail-closed: the driver loops the paginated query until
 * `isDone` and only writes JSON to stdout AFTER the full loop completes
 * successfully. If any page errors, exit non-zero with no partial JSON output.
 * This is the explicit fix for the P1 "warning + partial output" footgun —
 * since the next migration step makes the original recipient set
 * unreconstructable, partial capture would mean permanently-lost recipients.
 *
 * MUST be run BEFORE the migration — once rows flip to digestMode='daily',
 * the forbidden-state filter no longer distinguishes them from organic digest
 * users.
 *
 * TEMP MIGRATION SCRIPT — remove in the PR 2 cleanup commit alongside the
 * Convex query. See plans/forbid-realtime-all-events.md §4d.
 *
 * Usage:
 *   export CONVEX_URL=https://<your-prod-deployment>.convex.cloud
 *   export MIGRATION_ADMIN_SECRET=<value-set-via-`convex env set --prod`>
 *   node scripts/migrate-list-affected-emails.mjs > /tmp/recipients.json
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

// Accumulate across pages. Do NOT print partial output — capture the full
// recipient set first, then atomically dump to stdout. If any page errors,
// exit non-zero with stderr message and zero stdout output.
let cursor = null;
let pages = 0;
let totalAffected = 0;
const allRecipients = [];

try {
  do {
    const r = await c.query(api.alertRules._listAffectedUserEmailsPage, { cursor, adminSecret });
    pages++;
    totalAffected += r.affectedInPage;
    allRecipients.push(...r.recipients);
    cursor = r.isDone ? null : r.nextCursor;
  } while (cursor);
} catch (err) {
  // Do not echo the supplied secret on error.
  console.error('[list-emails] error mid-pagination — NOT writing partial JSON:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.error(
  `[list-emails] pages: ${pages}, affected rows total: ${totalAffected}, recipients with verified email: ${allRecipients.length}`,
);
// Only reaches here if every page succeeded.
console.log(JSON.stringify(allRecipients, null, 2));
