#!/usr/bin/env node
/**
 * Recipient-list driver for the (realtime, all) courtesy email.
 *
 * Joins the forbidden-state alertRules rows with their owners' verified email
 * channels and writes the result as JSON to stdout. Pipe to a file and feed it
 * into your sender of choice (Resend dashboard import, send-script, etc.).
 *
 * MUST be run BEFORE the migration — once rows are flipped to digestMode='daily',
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

try {
  const r = await c.query(api.alertRules._listAffectedUserEmails, { adminSecret });
  if (!r.pageDone) {
    // Defensive — production currently has ~29 rows, well under the 500-row page.
    // If this ever fires, paginate the query (mirror _countRealtimeAllRules's loop).
    console.error('[list-emails] WARNING: alertRules table exceeded one page; recipients may be incomplete');
  }
  console.error(
    `[list-emails] affected rows: ${r.affectedRowCount}, recipients with verified email: ${r.recipients.length}`,
  );
  console.log(JSON.stringify(r.recipients, null, 2));
} catch (err) {
  // Do not echo the supplied secret on error.
  console.error('[list-emails] error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
