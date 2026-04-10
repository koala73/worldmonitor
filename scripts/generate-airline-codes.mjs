#!/usr/bin/env node
/**
 * scripts/generate-airline-codes.mjs
 * 
 * Refreshes server/_shared/airline-codes.ts GENERATED block from OpenFlights airlines.dat.
 * Run quarterly or when gaps are reported in prod.
 * 
 * Usage: node scripts/generate-airline-codes.mjs
 * 
 * Source: https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat
 * Format: ID, Name, Alias, IATA, ICAO, Callsign, Country, Active
 * License: Public Domain (OpenFlights)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AIRLINE_CODES_PATH = resolve(__dirname, '../server/_shared/airline-codes.ts');
const OPENFLIGHTS_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';

// ─── Fetch ───────────────────────────────────────────────────────────────────

let csvText;
try {
  const res = await fetch(OPENFLIGHTS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  csvText = await res.text();
} catch (err) {
  console.error(`Failed to fetch OpenFlights data: ${err.message}`);
  console.error('You can manually download from:', OPENFLIGHTS_URL);
  process.exit(1);
}

// ─── Parse ───────────────────────────────────────────────────────────────────

const previousIcaos = new Set();

// Re-use existing GENERATED entries to compute diff stats
try {
  const content = readFileSync(AIRLINE_CODES_PATH, 'utf8');
  const generatedMatch = content.match(
    /new Map<string,\s*\{\s*iata:\s*string;\s*name:\s*string\s*\}>\(\[\s*\n([\s\S]*?)\n\]\);/
  );
  if (generatedMatch) {
    const block = generatedMatch[1];
    const entryRe = /\['([A-Z]{3})',\s*\{ iata:\s*'([A-Z0-9]{2})',\s*name:\s*(.+?) \}\]/g;
    let m;
    while ((m = entryRe.exec(block)) !== null) {
      previousIcaos.add(m[1]);
    }
  }
} catch {
  // File doesn't exist yet — skip diff
}

const newEntries = [];
let skippedBadRow = 0;

for (const rawLine of csvText.split('\n')) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;

  // OpenFlights uses |-escaped fields; basic split handles most cases
  // eslint-disable-next-line no-control-regex
  const fields = line.split(',').map(f => f.replace(/^"|"$/g, '').replace(/\\N/g, '').trim());

  if (fields.length < 8) {
    skippedBadRow++;
    continue;
  }

  const [, name, , iata, icao, , , active] = fields;

  if (active !== 'Y') continue;
  if (!iata || iata.length !== 2) continue;
  if (!icao || icao.length !== 3) continue;
  // name must be non-empty after stripping \N sentinels
  if (!name) continue;

  newEntries.push({ icao, iata, name });
}

// Sort by ICAO for deterministic output
newEntries.sort((a, b) => a.icao.localeCompare(b.icao));

// ─── Diff stats ──────────────────────────────────────────────────────────────

const newIcaos = new Set(newEntries.map(e => e.icao));
const added = newEntries.filter(e => !previousIcaos.has(e.icao));
const removed = [...previousIcaos].filter(icao => !newIcaos.has(icao));

// ─── Generate GENERATED block ────────────────────────────────────────────────

const lines = newEntries.map(
  e => `  [${JSON.stringify(e.icao)}, { iata: ${JSON.stringify(e.iata)}, name: ${JSON.stringify(e.name)} }]`
);

const generatedBlock = `new Map<string, { iata: string; name: string }>([\n${lines.join(',\n')}\n])`;

// ─── Patch airline-codes.ts ──────────────────────────────────────────────────

let content;
try {
  content = readFileSync(AIRLINE_CODES_PATH, 'utf8');
} catch {
  console.error(`Could not read ${AIRLINE_CODES_PATH}`);
  process.exit(1);
}

const updated = content.replace(
  /const GENERATED = new Map<string,\s*\{\s*iata:\s*string;\s*name:\s*string\s*\}>\(\[\s*\n[\s\S]*?\n\]\);/,
  `const GENERATED = ${generatedBlock};`
);

writeFileSync(AIRLINE_CODES_PATH, updated, 'utf8');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`✓ Wrote ${newEntries.length} entries to ${AIRLINE_CODES_PATH}`);
if (added.length > 0) console.log(`  + ${added.length} new airlines (${added.slice(0, 5).map(e => e.icao).join(', ')}${added.length > 5 ? '…' : ''})`);
if (removed.length > 0) console.log(`  - ${removed.length} removed airlines`);
if (skippedBadRow > 0) console.log(`  (${skippedBadRow} malformed CSV rows skipped)`);
