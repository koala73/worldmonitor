#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
loadEnvFile(import.meta.url);

const GLD_KEY = 'market:gold-etf-flows:v1';
const GLD_TTL = 86400;
const GLD_URL = 'https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_archive_EN.csv';

// SPDR publishes a daily CSV of GLD holdings. Columns observed (header order):
// Date, Gold (oz), Total Net Assets, NAV, Shares Outstanding
// Some archive versions use tonnes directly. We parse defensively — either Gold
// column is converted to tonnes on the way out (1 tonne = 32,150.7 troy oz).
const TROY_OZ_PER_TONNE = 32_150.7;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { header: [], rows: [] };
  const splitLine = (l) => {
    // Handles simple CSV with optional double-quoted cells containing commas.
    const out = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  // Strip UTF-8 BOM from first header cell — SPDR's CSV has been observed
  // both with and without one; without this, findCol('date') silently returns
  // -1 and the outer 30-row guard throws a misleading "format may have changed".
  const header = splitLine(lines[0]).map(h => h.trim().toLowerCase().replace(/^\ufeff/, ''));
  const rows = lines.slice(1).map(splitLine);
  return { header, rows };
}

function toNum(s) {
  if (!s) return NaN;
  const n = parseFloat(String(s).replace(/[,$"]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function parseIsoDate(s) {
  // SPDR typically writes "DD-MMM-YY" (e.g. 10-Apr-26) or "M/D/YYYY". Normalize.
  if (!s) return '';
  const raw = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const m1 = raw.match(/^(\d{1,2})[-/](\w{3})[-/](\d{2,4})$/);
  if (m1) {
    const [, d, mon, y] = m1;
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const mm = months[mon.toLowerCase()];
    if (!mm) return '';
    const yyyy = y.length === 2 ? (parseInt(y, 10) >= 50 ? `19${y}` : `20${y}`) : y;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(parseInt(d, 10)).padStart(2, '0')}`;
  }
  const m2 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) {
    const [, mm, dd, yyyy] = m2;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return '';
}

export function parseGldArchive(csvText) {
  const { header, rows } = parseCsv(csvText);
  if (!header.length || !rows.length) return [];

  const findCol = (...candidates) => {
    for (const c of candidates) {
      const idx = header.findIndex(h => h === c || h.startsWith(c));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const idxDate = findCol('date');
  const idxOz = findCol('gold troy oz', 'gold (oz)', 'gold oz', 'ounces');
  const idxTonnes = findCol('gold (tonnes)', 'gold tonnes', 'tonnes', 'metric tonnes');
  const idxAum = findCol('total net assets', 'net assets', 'aum');
  const idxNav = findCol('nav', 'price per share', 'share price');
  if (idxDate === -1 || (idxOz === -1 && idxTonnes === -1)) return [];

  const out = [];
  for (const r of rows) {
    const date = parseIsoDate(r[idxDate]);
    if (!date) continue;
    let tonnes = NaN;
    if (idxTonnes !== -1) tonnes = toNum(r[idxTonnes]);
    if (!Number.isFinite(tonnes) && idxOz !== -1) {
      const oz = toNum(r[idxOz]);
      if (Number.isFinite(oz) && oz > 0) tonnes = oz / TROY_OZ_PER_TONNE;
    }
    if (!Number.isFinite(tonnes) || tonnes <= 0) continue;
    const aum = idxAum !== -1 ? toNum(r[idxAum]) : NaN;
    const nav = idxNav !== -1 ? toNum(r[idxNav]) : NaN;
    out.push({ date, tonnes, aum: Number.isFinite(aum) ? aum : 0, nav: Number.isFinite(nav) ? nav : 0 });
  }
  // Sort ascending by date so index arithmetic for deltas is obvious.
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
  const resp = await fetch(GLD_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`SPDR GLD archive HTTP ${resp.status}`);
  const text = await resp.text();
  const history = parseGldArchive(text);
  if (history.length < 30) throw new Error(`Parsed only ${history.length} rows — SPDR format may have changed`);
  const flows = computeFlows(history);
  if (!flows) throw new Error('flows computation returned null');
  return { updatedAt: new Date().toISOString(), ...flows };
}

if (process.argv[1]?.endsWith('seed-gold-etf-flows.mjs')) {
  runSeed('market', 'gold-etf-flows', GLD_KEY, fetchGldFlows, {
    ttlSeconds: GLD_TTL,
    validateFn: data => Number.isFinite(data?.tonnes) && data.tonnes > 0,
    recordCount: () => 1,
  }).catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}
