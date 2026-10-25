#!/usr/bin/env node
// @ts-check
//
// Vendors the sdr-enthusiasts plane-alert-db aircraft watchlist into
// scripts/data/plane-alert-watchlist.json, keyed on the ICAO 24-bit hex the
// military flight seeder already ingests (#6228).
//
// The upstream CSV is community-curated and changes often, so the conversion
// is a committed script rather than a one-off: re-running it is the refresh
// path, and --check is the drift check that says whether the vendored copy
// still matches upstream. Nothing fetches this list at runtime; the seeder
// reads the committed JSON only.
//
// Only the Mil and Gov groups are vendored. They are the rows that can name a
// contact the military feed already tracks (air forces, navies, heads of
// state, coastguards, "Dictator Alert"). Civ and Pol would double the file for
// aircraft the feed never admits; widen INCLUDED_GROUPS if a consumer appears.
//
// License: the upstream database is ODbL-1.0 and its contents DbCL-1.0. The
// vendored JSON is a derived database and stays under ODbL; the metadata block
// carries the attribution the license requires.
//
// Usage:
//   node scripts/build-plane-alert-watchlist.mjs                   # fetch upstream, rewrite the JSON
//   node scripts/build-plane-alert-watchlist.mjs --input db.csv    # convert a local copy instead
//   node scripts/build-plane-alert-watchlist.mjs --check           # exit 1 when the committed JSON drifts from upstream

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PLANE_ALERT_SOURCE_URL = 'https://github.com/sdr-enthusiasts/plane-alert-db';
export const PLANE_ALERT_CSV_URL = 'https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main/plane-alert-db.csv';
export const PLANE_ALERT_TARGET = new URL('./data/plane-alert-watchlist.json', import.meta.url);
export const INCLUDED_GROUPS = ['Mil', 'Gov'];
export const WATCHLIST_COLUMNS = ['hex', 'registration', 'operator', 'type', 'icaoType', 'group', 'category'];
const SCHEMA_VERSION = 1;
const USER_AGENT = 'WorldMonitor plane-alert-db refresh (+https://worldmonitor.app)';
const HEX_RE = /^[0-9A-F]{6}$/;

// Header names as upstream spells them. The "$" and "#" prefixes are
// planefence rendering hints, not part of the value.
const CSV_COLUMNS = {
  hex: '$ICAO',
  registration: '$Registration',
  operator: '$Operator',
  type: '$Type',
  icaoType: '$ICAO Type',
  group: '#CMPG',
  category: 'Category',
};

/**
 * RFC 4180 parser for the upstream CSV: quoted fields may contain commas,
 * doubled quotes and line breaks, and the file may use CRLF line endings.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * Column-mapped upstream rows. Throws when a required header is missing so a
 * renamed upstream column fails the refresh instead of vendoring blanks.
 * @param {string} text
 * @returns {Array<Record<keyof typeof CSV_COLUMNS, string>>}
 */
export function parsePlaneAlertCsv(text) {
  const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!header) throw new Error('plane-alert-db.csv is empty');
  const index = {};
  for (const [key, name] of Object.entries(CSV_COLUMNS)) {
    const at = header.indexOf(name);
    if (at === -1) throw new Error(`plane-alert-db.csv header is missing the "${name}" column`);
    index[key] = at;
  }
  return rows.map((cells) => {
    const record = /** @type {Record<keyof typeof CSV_COLUMNS, string>} */ ({});
    for (const key of Object.keys(CSV_COLUMNS)) record[key] = (cells[index[key]] ?? '').trim();
    return record;
  });
}

/**
 * @param {ReturnType<typeof parsePlaneAlertCsv>} records
 * @param {{ retrievedAt: string, sourceSha256: string }} meta
 */
export function buildWatchlist(records, meta) {
  const byHex = new Map();
  let skippedRows = 0;
  let excludedRows = 0;
  for (const record of records) {
    if (!INCLUDED_GROUPS.includes(record.group)) {
      excludedRows += 1;
      continue;
    }
    const hex = record.hex.toUpperCase();
    // Upstream has a handful of five-character hexes left by spreadsheet
    // edits; a key the seeder can never match is not worth vendoring.
    if (!HEX_RE.test(hex) || byHex.has(hex)) {
      skippedRows += 1;
      continue;
    }
    byHex.set(hex, [hex, record.registration, record.operator, record.type, record.icaoType, record.group, record.category]);
  }
  const aircraft = [...byHex.keys()].sort().map((hex) => byHex.get(hex));
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'sdr-enthusiasts/plane-alert-db, plane-alert-db.csv',
    sourceUrl: PLANE_ALERT_SOURCE_URL,
    sourceFileUrl: PLANE_ALERT_CSV_URL,
    license: 'ODbL-1.0 (database), DbCL-1.0 (contents)',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1.0/',
    attribution: 'Copyright (C) 2022-2024 by SDR-Enthusiasts, Ramon F. Kolb (kx1t), and contributors',
    retrievedAt: meta.retrievedAt,
    sourceSha256: meta.sourceSha256,
    includedGroups: INCLUDED_GROUPS,
    upstreamRows: records.length,
    excludedRows,
    skippedRows,
    rows: aircraft.length,
    columns: WATCHLIST_COLUMNS,
    aircraft,
  };
}

/** One aircraft per line so a refresh diff reads as added and removed hexes. */
export function serializeWatchlist(watchlist) {
  const { aircraft, ...head } = watchlist;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, ',\n');
  const body = aircraft.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
  return `${headJson}  "aircraft": [\n${body}\n  ]\n}\n`;
}

/**
 * What changed between the committed watchlist and a rebuild. retrievedAt and
 * sourceSha256 are expected to differ on every refresh, so they are not drift.
 * @returns {{ added: string[], removed: string[], changed: string[], metadata: string[] }}
 */
export function diffWatchlist(committed, rebuilt) {
  const key = (rows) => new Map(rows.map((row) => [row[0], JSON.stringify(row)]));
  const before = key(committed.aircraft);
  const after = key(rebuilt.aircraft);
  const added = [...after.keys()].filter((hex) => !before.has(hex));
  const removed = [...before.keys()].filter((hex) => !after.has(hex));
  const changed = [...after.keys()].filter((hex) => before.has(hex) && before.get(hex) !== after.get(hex));
  const metadata = ['schemaVersion', 'includedGroups', 'columns', 'license', 'sourceFileUrl']
    .filter((field) => JSON.stringify(committed[field]) !== JSON.stringify(rebuilt[field]));
  return { added, removed, changed, metadata };
}

export function hasDrift(diff) {
  return diff.added.length + diff.removed.length + diff.changed.length + diff.metadata.length > 0;
}

async function fetchUpstreamCsv() {
  const response = await fetch(PLANE_ALERT_CSV_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv' } });
  if (!response.ok) throw new Error(`plane-alert-db.csv fetch failed: HTTP ${response.status}`);
  return response.text();
}

async function main(argv) {
  const check = argv.includes('--check');
  const inputAt = argv.indexOf('--input');
  const text = inputAt === -1 ? await fetchUpstreamCsv() : readFileSync(argv[inputAt + 1], 'utf8');
  const rebuilt = buildWatchlist(parsePlaneAlertCsv(text), {
    retrievedAt: new Date().toISOString().slice(0, 10),
    sourceSha256: createHash('sha256').update(text).digest('hex'),
  });
  const summary = `${rebuilt.rows} aircraft from ${rebuilt.upstreamRows} upstream rows (${rebuilt.excludedRows} outside ${INCLUDED_GROUPS.join('/')}, ${rebuilt.skippedRows} skipped)`;
  if (check) {
    const committed = JSON.parse(readFileSync(PLANE_ALERT_TARGET, 'utf8'));
    const diff = diffWatchlist(committed, rebuilt);
    if (!hasDrift(diff)) {
      console.log(`plane-alert-watchlist.json matches upstream: ${summary}`);
      return 0;
    }
    console.error(`plane-alert-watchlist.json drifts from upstream: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length} aircraft`
      + (diff.metadata.length ? `, metadata: ${diff.metadata.join(', ')}` : '')
      + `; rerun without --check to refresh (committed ${committed.retrievedAt})`);
    return 1;
  }
  writeFileSync(PLANE_ALERT_TARGET, serializeWatchlist(rebuilt));
  console.log(`wrote ${fileURLToPath(PLANE_ALERT_TARGET)}: ${summary}`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
