#!/usr/bin/env node
/**
 * One-time script to import bounced emails from a Resend CSV export
 * into the Convex emailSuppressions table via the authenticated
 * /relay/bulk-suppress-emails HTTP action.
 *
 * Usage:
 *   CONVEX_SITE_URL=<your-convex-site-url> RELAY_SHARED_SECRET=<secret> \
 *     node scripts/import-bounced-emails.mjs <csv-path>
 *
 * The CSV must have headers including "to" and "last_event".
 * Only rows with last_event=bounced are imported.
 */
import { readFileSync } from 'node:fs';

const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET;

if (!CONVEX_SITE_URL) {
  console.error('CONVEX_SITE_URL env var required (e.g. https://your-app.convex.site)');
  process.exit(1);
}
if (!RELAY_SECRET) {
  console.error('RELAY_SHARED_SECRET env var required');
  process.exit(1);
}

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/import-bounced-emails.mjs <csv-path>');
  process.exit(1);
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

const raw = readFileSync(csvPath, 'utf-8');
const lines = raw.split('\n').filter(Boolean);
const header = parseCsvLine(lines[0]);
const toIdx = header.indexOf('to');
const eventIdx = header.indexOf('last_event');

if (toIdx === -1 || eventIdx === -1) {
  console.error('CSV must have "to" and "last_event" columns');
  console.error('Found columns:', header.join(', '));
  process.exit(1);
}

const bouncedEmails = [];
for (let i = 1; i < lines.length; i++) {
  const cols = parseCsvLine(lines[i]);
  if (cols[eventIdx] === 'bounced' && cols[toIdx]) {
    bouncedEmails.push(cols[toIdx].trim().toLowerCase());
  }
}

const unique = [...new Set(bouncedEmails)];
console.log(`Found ${unique.length} unique bounced emails from ${lines.length - 1} rows`);

const BATCH_SIZE = 100;
let totalAdded = 0;
let totalSkipped = 0;

for (let i = 0; i < unique.length; i += BATCH_SIZE) {
  const batch = unique.slice(i, i + BATCH_SIZE).map(email => ({
    email,
    reason: 'bounce',
    source: 'csv-import-2026-04',
  }));

  const res = await fetch(`${CONVEX_SITE_URL}/relay/bulk-suppress-emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RELAY_SECRET}`,
    },
    body: JSON.stringify({ emails: batch }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed (${res.status}): ${body}`);
    process.exit(1);
  }

  const result = await res.json();
  totalAdded += result.added;
  totalSkipped += result.skipped;
  console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: +${result.added} added, ${result.skipped} skipped`);
}

console.log(`\nDone: ${totalAdded} added, ${totalSkipped} already suppressed`);
