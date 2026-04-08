#!/usr/bin/env node
/**
 * One-time script to import bounced emails from a Resend CSV export
 * into the Convex emailSuppressions table.
 *
 * Usage:
 *   CONVEX_URL=<your-convex-url> node scripts/import-bounced-emails.mjs <csv-path>
 *
 * The CSV must have headers: id,created_at,subject,from,to,cc,bcc,reply_to,last_event,...
 * Only rows with last_event=bounced are imported.
 */
import { readFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error('CONVEX_URL env var required');
  process.exit(1);
}

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/import-bounced-emails.mjs <csv-path>');
  process.exit(1);
}

const raw = readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').filter(Boolean);
const header = lines[0].split(',');
const toIdx = header.indexOf('to');
const eventIdx = header.indexOf('last_event');

if (toIdx === -1 || eventIdx === -1) {
  console.error('CSV must have "to" and "last_event" columns');
  process.exit(1);
}

const bouncedEmails = [];
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  if (cols[eventIdx] === 'bounced' && cols[toIdx]) {
    bouncedEmails.push(cols[toIdx].trim().toLowerCase());
  }
}

const unique = [...new Set(bouncedEmails)];
console.log(`Found ${unique.length} unique bounced emails from ${lines.length - 1} rows`);

const client = new ConvexHttpClient(CONVEX_URL);
const BATCH_SIZE = 100;
let totalAdded = 0;
let totalSkipped = 0;

for (let i = 0; i < unique.length; i += BATCH_SIZE) {
  const batch = unique.slice(i, i + BATCH_SIZE).map(email => ({
    email,
    reason: /** @type {const} */ ('bounce'),
    source: 'csv-import-2026-04',
  }));

  const result = await client.mutation('emailSuppressions:bulkSuppress', { emails: batch });
  totalAdded += result.added;
  totalSkipped += result.skipped;
  console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: +${result.added} added, ${result.skipped} skipped`);
}

console.log(`\nDone: ${totalAdded} added, ${totalSkipped} already suppressed`);
