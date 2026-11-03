#!/usr/bin/env node
// Regenerates scripts/data/dtm-admin1-points.json from the fieldmaps.io
// edge-matched humanitarian admin-1 points (OCHA COD-AB boundaries, CC BY-IGO).
//
// IOM DTM reports internal displacement per first-level region with an OCHA
// P-code (SD11 = Kassala) and no coordinates. The DTM seeder places each region
// at the point this file gives for its P-code. Only rows sourced from an OCHA
// Common Operational Dataset are kept, because DTM uses those P-codes.
//
// Each P-code maps to [lat, lng], rounded to two decimals.
//
// Usage:
//   curl -sO https://data.fieldmaps.io/edge-matched/humanitarian/intl/adm1_points.gpkg.zip
//   unzip adm1_points.gpkg.zip
//   node scripts/build-dtm-admin1-points.mjs adm1_points.gpkg

import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TARGET = new URL('./data/dtm-admin1-points.json', import.meta.url);

const [gpkgPath] = process.argv.slice(2);
if (!gpkgPath) {
  console.error('Usage: node scripts/build-dtm-admin1-points.mjs <adm1_points.gpkg>');
  process.exit(1);
}

const round = (n) => Math.round(n * 100) / 100;

// A GeoPackage geometry is an 8-byte header, an optional envelope sized by the
// flags byte, then standard WKB. Admin-1 points are WKB Points (type 1).
export function gpkgPoint(blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x47 || bytes[1] !== 0x50) return null;
  const envelopeSizes = [0, 32, 48, 48, 64];
  const envelope = envelopeSizes[(bytes[3] >> 1) & 0x07];
  if (envelope === undefined) return null;
  const wkb = 8 + envelope;
  const littleEndian = view.getUint8(wkb) === 1;
  if (view.getUint32(wkb + 1, littleEndian) !== 1) return null;
  const lng = view.getFloat64(wkb + 5, littleEndian);
  const lat = view.getFloat64(wkb + 13, littleEndian);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [round(lat), round(lng)];
}

const db = new DatabaseSync(gpkgPath, { readOnly: true });
const rows = db.prepare(`SELECT adm1_src, geom FROM adm1_points WHERE src_grp = 'COD' AND adm1_src IS NOT NULL ORDER BY adm1_src`).all();

const points = {};
for (const row of rows) {
  const point = gpkgPoint(row.geom);
  if (point) points[row.adm1_src] = point;
}

writeFileSync(TARGET, `${JSON.stringify(points)}\n`);
console.log(`Wrote ${Object.keys(points).length} admin-1 points to ${TARGET.pathname}`);
