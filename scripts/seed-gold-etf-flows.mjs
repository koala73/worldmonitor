#!/usr/bin/env node

import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { readBoundedResponseBytes } from './_china-exchange-transport.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);

const GLD_KEY = 'market:gold-etf-flows:v1';
const GLD_TTL = 86400;

// SPDR migrated from the legacy CSV archive to a Next.js JSON/XLSX API in
// early 2026. The old URL (/assets/dynamic/GLD/GLD_US_archive_EN.csv) now
// silently returns a PDF (Content-Type: application/pdf, ~700 KB) which
// broke the original CSV parser with "Parsed only 0 rows" on every run.
//
// The new endpoint serves the full history as XLSX (~530 KB, sheet "US GLD
// Historical Archive", ~5500 rows). Parse with exceljs (already in scripts
// package deps).
const GLD_API_BASE = 'https://api.spdrgoldshares.com/api/v1';
const GLD_ORIGIN = 'https://www.spdrgoldshares.com';
const GLD_HIST_URL = `${GLD_API_BASE}/historical-archive?product=gld&exchange=NYSE&lang=en`;

function parseSpdrNumber(raw) {
  if (raw == null) return NaN;
  const s = String(raw).replace(/[$,\s£€¥]/g, '').replace(/^US\$/i, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseSpdrDate(raw) {
  if (!raw) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // "18-Nov-2004" / "10-Apr-2026"
  const m1 = s.match(/^(\d{1,2})-(\w{3})-(\d{4})$/);
  if (m1) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const mm = months[m1[2].toLowerCase()];
    if (mm) return `${m1[3]}-${String(mm).padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  }
  // "April 13, 2026" (used by the /data endpoint; kept for forward compat if
  // we ever backfill from that source).
  const m2 = s.match(/^(\w+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (m2) {
    const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    const mm = months[m2[1].toLowerCase()];
    if (mm) return `${m2[3]}-${String(mm).padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  }
  return '';
}

/**
 * Parse the XLSX historical archive into an ascending-by-date array of
 * `{ date, tonnes, aum, nav }` records. Exposed for unit tests.
 */
// The archive is ~530 KB and inflates to a few MB. ExcelJS inflates every
// entry in memory, and JSZip acts on each entry's declared size, so a small
// download could otherwise expand without bound.
export const MAX_GLD_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const MAX_GLD_XLSX_EXPANDED_BYTES = 200 * 1024 * 1024;

export async function readGldArchive(resp) {
  return Buffer.from(await readBoundedResponseBytes(resp, MAX_GLD_ARCHIVE_BYTES));
}

function tooLarge(maxBytes) {
  return new Error(`SPDR historical-archive XLSX expands past ${maxBytes} bytes`);
}

function notAZip(detail) {
  return new Error(`SPDR historical-archive is not a readable XLSX: ${detail}`);
}

/**
 * Throws unless the workbook's ZIP entries, both as declared in the central
 * directory and as actually inflated, total at most `maxBytes`.
 */
export function assertXlsxExpansionWithin(buf, maxBytes = MAX_GLD_XLSX_EXPANDED_BYTES) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw notAZip('no end of central directory');
  // JSZip reads a different directory when any end-record field is at its
  // maximum (its ZIP64 branch) or when a ZIP64 locator precedes the record.
  const disks = [buf.readUInt16LE(eocd + 4), buf.readUInt16LE(eocd + 6)];
  const counts = [buf.readUInt16LE(eocd + 8), buf.readUInt16LE(eocd + 10)];
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if ([...disks, ...counts].includes(0xFFFF) || dirSize === 0xFFFFFFFF || dirOffset === 0xFFFFFFFF
    || (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50)) {
    throw notAZip('ZIP64 archives are not accepted');
  }
  // JSZip shifts every offset by any gap between the directory's declared end
  // and the end record (bytes prepended to the archive). Refuse that layout so
  // the offsets read here are the ones it uses.
  if (dirOffset + dirSize !== eocd) throw notAZip('central directory does not end at the end record');
  // JSZip walks the records by signature and ignores the declared count, so
  // walk them the same way and refuse an archive whose count disagrees.
  const count = counts[1];
  let at = dirOffset;
  let declared = 0;
  let inflated = 0;
  let records = 0;
  while (at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50) {
    records++;
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    declared += buf.readUInt32LE(at + 24);
    if (declared > maxBytes) throw tooLarge(maxBytes);
    const local = buf.readUInt32LE(at + 42);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw notAZip('bad local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressedSize);
    if (method === 0) {
      inflated += data.length;
    } else if (method === 8) {
      try {
        inflated += inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes - inflated) }).length;
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(maxBytes);
        throw notAZip(err?.message || 'inflate failed');
      }
    } else {
      throw notAZip(`compression method ${method}`);
    }
    if (inflated > maxBytes) throw tooLarge(maxBytes);
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  if (records !== count) throw notAZip(`${records} central directory records, expected ${count}`);
  if (at !== eocd) throw notAZip('central directory does not end at the end record');
}

export async function parseGldArchiveXlsx(xlsxBuffer) {
  assertXlsxExpansionWithin(xlsxBuffer);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuffer);
  const ws = wb.worksheets.find(w => w.name !== 'Disclaimer') || wb.worksheets[1] || wb.worksheets[0];
  if (!ws || ws.rowCount < 10) return [];

  // Column layout (header row 1; observed 2026-04):
  //   1 Date | 2 Closing Price | 3 Ounces/Share | 4 NAV/Share | 5 IOPV | 6 Mid
  //   7 Premium/Discount | 8 Volume | 9 Total Ounces | 10 Tonnes | 11 Total NAV USD
  const COL_DATE = 1, COL_NAV = 2, COL_TONNES = 10, COL_AUM = 11;

  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const date = parseSpdrDate(row.getCell(COL_DATE).value);
    if (!date) continue;
    const tonnes = parseSpdrNumber(row.getCell(COL_TONNES).value);
    if (!Number.isFinite(tonnes) || tonnes <= 0) continue;
    const aum = parseSpdrNumber(row.getCell(COL_AUM).value);
    const nav = parseSpdrNumber(row.getCell(COL_NAV).value);
    out.push({
      date,
      tonnes,
      aum: Number.isFinite(aum) ? aum : 0,
      nav: Number.isFinite(nav) ? nav : 0,
    });
  }
  // Sort ascending so index arithmetic for deltas is obvious.
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export function computeFlows(history) {
  if (!history.length) return null;
  const latest = history[history.length - 1];
  const byAgo = (days) => history[Math.max(0, history.length - 1 - days)];
  const w1 = byAgo(5);
  const m1 = byAgo(21);
  const y1 = byAgo(252);
  const pct = (from, to) => from > 0 ? ((to - from) / from) * 100 : 0;
  const spark = history.slice(-90).map(p => p.tonnes);
  return {
    asOfDate: latest.date,
    tonnes: +latest.tonnes.toFixed(2),
    aumUsd: +latest.aum.toFixed(0),
    nav: +latest.nav.toFixed(2),
    changeW1Tonnes: +(latest.tonnes - w1.tonnes).toFixed(2),
    changeM1Tonnes: +(latest.tonnes - m1.tonnes).toFixed(2),
    changeY1Tonnes: +(latest.tonnes - y1.tonnes).toFixed(2),
    changeW1Pct: +pct(w1.tonnes, latest.tonnes).toFixed(2),
    changeM1Pct: +pct(m1.tonnes, latest.tonnes).toFixed(2),
    changeY1Pct: +pct(y1.tonnes, latest.tonnes).toFixed(2),
    sparkline90d: spark,
  };
}

async function fetchGldFlows() {
  const resp = await fetch(GLD_HIST_URL, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
      // The SPDR API silently swaps the payload for a PDF when these headers
      // are absent — always send browser-ish Origin/Referer.
      Origin: GLD_ORIGIN,
      Referer: `${GLD_ORIGIN}/usa/historical-data/`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`SPDR historical-archive HTTP ${resp.status}`);
  const ct = resp.headers.get('content-type') || '';
  if (!/spreadsheet|xlsx|octet-stream/i.test(ct)) {
    throw new Error(`SPDR historical-archive returned non-XLSX content-type: ${ct}`);
  }
  const buf = await readGldArchive(resp);
  const history = await parseGldArchiveXlsx(buf);
  if (history.length < 30) throw new Error(`Parsed only ${history.length} rows — SPDR XLSX format may have changed`);
  const flows = computeFlows(history);
  if (!flows) throw new Error('flows computation returned null');
  return { updatedAt: new Date().toISOString(), ...flows };
}

export function declareRecords(data) {
  return Number.isFinite(data?.tonnes) && data.tonnes > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith('seed-gold-etf-flows.mjs')) {
  runSeed('market', 'gold-etf-flows', GLD_KEY, fetchGldFlows, {
    ttlSeconds: GLD_TTL,
    validateFn: data => Number.isFinite(data?.tonnes) && data.tonnes > 0,
    recordCount: () => 1,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 2880,
    sourceVersion: 'spdr-gld-xlsx-v1',
  }).catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}
