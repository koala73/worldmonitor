#!/usr/bin/env node
// Operator-run data acquisition for the /research/ chokepoint transit reports.
//
// Fetches the full daily transit-call history for a set of chokepoints from the
// IMF PortWatch public ArcGIS FeatureServer (the same upstream and normalization
// as scripts/seed-portwatch.mjs) and freezes it into a versioned snapshot under
// docs/snapshots/. The static corpus build consumes ONLY the committed snapshot:
// this script is never invoked by `npm run build` or CI, so the published report
// stays deterministic and reproducible from repo contents alone.
//
// Usage:
//   node scripts/build-chokepoint-transit-snapshot.mjs \
//     --edition 2026-07 \
//     [--since 2019-01-01] \
//     [--chokepoints hormuz_strait,bab_el_mandeb,suez,cape_of_good_hope]
//
// Missing upstream days are enumerated per chokepoint in `missingDates` and are
// never forward-filled or coerced to zero — report rendering must treat them as
// explicitly absent observations.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHistory, CHOKEPOINTS } from './seed-portwatch.mjs';
import { CHROME_UA } from './_seed-utils.mjs';

const ARCGIS_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const OUT_FIELDS = [
  'date',
  'n_container', 'n_dry_bulk', 'n_general_cargo', 'n_roro', 'n_tanker', 'n_total',
  'capacity_container', 'capacity_dry_bulk', 'capacity_general_cargo', 'capacity_roro', 'capacity_tanker',
];
const PAGE_SIZE = 2000;
const FETCH_TIMEOUT = 30_000;
const DEFAULT_SINCE = '2019-01-01';
const DEFAULT_CHOKEPOINTS = ['hormuz_strait', 'bab_el_mandeb', 'suez', 'cape_of_good_hope'];
const SNAPSHOT_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const args = { since: DEFAULT_SINCE, chokepoints: DEFAULT_CHOKEPOINTS, edition: null };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--edition') { args.edition = value; i++; }
    else if (key === '--since') { args.since = value; i++; }
    else if (key === '--chokepoints') { args.chokepoints = value.split(',').map(s => s.trim()).filter(Boolean); i++; }
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}$/.test(args.edition ?? '')) {
    throw new Error('--edition YYYY-MM is required (names the snapshot file and edition id)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    throw new Error(`--since must be YYYY-MM-DD, got: ${args.since}`);
  }
  return args;
}

function buildWhere(portname, since) {
  return `portname='${portname.replace(/'/g, "''")}' AND date >= timestamp '${since} 00:00:00'`;
}

export async function fetchAllPages(portname, since) {
  const all = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      where: buildWhere(portname, since),
      outFields: OUT_FIELDS.join(','),
      orderByFields: 'date ASC',
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });
    const resp = await fetch(`${ARCGIS_BASE}?${params}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${portname}`);
    const body = await resp.json();
    if (body.error) throw new Error(`ArcGIS error for ${portname}: ${body.error.message}`);
    if (body.features?.length) all.push(...body.features);
    if (!body.exceededTransferLimit || !body.features?.length) break;
    // Advance by rows actually returned: the layer's server-side maxRecordCount
    // (1000) is below our requested page size, so += PAGE_SIZE would skip rows.
    offset += body.features.length;
  }
  return all;
}

export function enumerateMissingDates(history) {
  if (history.length < 2) return [];
  const present = new Set(history.map(d => d.date));
  const missing = [];
  const cursor = new Date(`${history[0].date}T00:00:00Z`);
  const end = new Date(`${history[history.length - 1].date}T00:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (!present.has(iso)) missing.push(iso);
  }
  return missing;
}

// History rows on single lines: reviewable diffs without a 40k-line file.
export function serializeSnapshot(snapshot) {
  const { chokepoints, ...header } = snapshot;
  const lines = ['{'];
  for (const [key, value] of Object.entries(header)) {
    const pretty = JSON.stringify(value, null, 2).split('\n').join('\n  ');
    lines.push(`  ${JSON.stringify(key)}: ${pretty},`);
  }
  lines.push('  "chokepoints": {');
  const cpEntries = Object.entries(chokepoints);
  cpEntries.forEach(([id, cp], cpIndex) => {
    const { history, ...meta } = cp;
    lines.push(`    ${JSON.stringify(id)}: {`);
    for (const [key, value] of Object.entries(meta)) {
      lines.push(`      ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
    lines.push('      "history": [');
    history.forEach((row, rowIndex) => {
      lines.push(`        ${JSON.stringify(row)}${rowIndex < history.length - 1 ? ',' : ''}`);
    });
    lines.push('      ]');
    lines.push(`    }${cpIndex < cpEntries.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const byId = new Map(CHOKEPOINTS.map(cp => [cp.id, cp]));
  const unknown = args.chokepoints.filter(id => !byId.has(id));
  if (unknown.length) throw new Error(`Unknown chokepoint id(s): ${unknown.join(', ')}`);

  const capturedAt = new Date().toISOString();
  const chokepoints = {};
  for (const id of [...args.chokepoints].sort()) {
    const cp = byId.get(id);
    process.stderr.write(`Fetching ${cp.name} since ${args.since}...\n`);
    const features = await fetchAllPages(cp.name, args.since);
    if (features.length === 0) {
      throw new Error(`Upstream returned 0 rows for ${cp.name} — refusing to freeze an empty series`);
    }
    const history = buildHistory(features);
    chokepoints[id] = {
      portwatchName: cp.name,
      observationStart: history[0].date,
      observationEnd: history[history.length - 1].date,
      rowCount: history.length,
      missingDates: enumerateMissingDates(history),
      history,
    };
    process.stderr.write(`  ${history.length} rows (${history[0].date} → ${history[history.length - 1].date})\n`);
  }

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: `chokepoint-transit-${args.edition}`,
    edition: args.edition,
    capturedAt,
    source: {
      name: 'IMF PortWatch daily chokepoint transit calls',
      publisher: 'International Monetary Fund / UN Global Platform',
      url: 'https://portwatch.imf.org/',
      dataset: 'Daily_Chokepoints_Data (ArcGIS FeatureServer layer 0)',
      endpoint: ARCGIS_BASE,
      attribution:
        'IMF PortWatch (portwatch.imf.org), based on UN Global Platform AIS data. Consult portwatch.imf.org for upstream terms of use.',
    },
    query: {
      since: args.since,
      outFields: OUT_FIELDS,
      wherePattern: buildWhere('<portwatchName>', args.since),
      pageSize: PAGE_SIZE,
    },
    units: {
      container: 'vessel transit calls per day',
      dryBulk: 'vessel transit calls per day',
      generalCargo: 'vessel transit calls per day',
      roro: 'vessel transit calls per day',
      tanker: 'vessel transit calls per day',
      cargo: 'vessel transit calls per day (container + dryBulk + generalCargo + roro)',
      total: 'vessel transit calls per day (all classes)',
      capContainer: 'aggregate capacity of transiting container vessels, deadweight tonnage (DWT)',
      capDryBulk: 'aggregate capacity of transiting dry-bulk vessels, DWT',
      capGeneralCargo: 'aggregate capacity of transiting general-cargo vessels, DWT',
      capRoro: 'aggregate capacity of transiting ro-ro vessels, DWT',
      capTanker: 'aggregate capacity of transiting tanker vessels, DWT',
    },
    chokepoints,
  };

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'docs', 'snapshots', `chokepoint-transit-${args.edition}.json`,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  const serialized = serializeSnapshot(snapshot);
  JSON.parse(serialized); // self-check: the custom formatter must emit valid JSON
  writeFileSync(outPath, serialized);
  process.stderr.write(`Wrote ${outPath}\n`);
}

const isMain = process.argv[1]?.endsWith('build-chokepoint-transit-snapshot.mjs');
if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
