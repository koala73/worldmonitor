#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const KEY = 'market:earnings-calendar:v1';
const TTL = 129600; // 36h — 3× a 12h cron interval
const MAX_PUBLISHED_EARNINGS = 100;

export const NQ_INFLUENCE_SYMBOLS = Object.freeze([
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'AVGO',
  'TSLA',
]);

function compareEarnings(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  const revenueOrder = (b.revenueEstimate ?? 0) - (a.revenueEstimate ?? 0);
  if (revenueOrder !== 0) return revenueOrder;
  const symbolOrder = a.symbol.localeCompare(b.symbol);
  if (symbolOrder !== 0) return symbolOrder;
  return a.hour.localeCompare(b.hour);
}

function reportKey(entry) {
  return `${entry.symbol}\u0000${entry.date}`;
}

function uniqueSorted(entries) {
  const seen = new Set();
  return [...entries].sort(compareEarnings).filter((entry) => {
    const key = reportKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Keep companies with meaningful analyst coverage. Positive revenue estimates
// below $10M are micro-cap noise; entries without a usable revenue line need an
// absolute EPS estimate of at least $0.05 as the coverage proxy.
function hasMeaningfulCoverage(entry) {
  if (entry.revenueEstimate != null && entry.revenueEstimate > 0) {
    return entry.revenueEstimate >= 10_000_000;
  }
  if (entry.epsEstimate != null) return Math.abs(entry.epsEstimate) >= 0.05;
  return false;
}

export function selectEarningsForPublication(normalizedEntries) {
  const entries = Array.isArray(normalizedEntries) ? normalizedEntries : [];
  const influenceSet = new Set(NQ_INFLUENCE_SYMBOLS);
  const reserved = uniqueSorted(entries.filter((entry) => influenceSet.has(entry.symbol)));
  const selected = reserved.slice(0, MAX_PUBLISHED_EARNINGS);
  const selectedKeys = new Set(selected.map(reportKey));

  if (selected.length < MAX_PUBLISHED_EARNINGS) {
    const general = uniqueSorted(entries.filter(hasMeaningfulCoverage));
    for (const entry of general) {
      const key = reportKey(entry);
      if (selectedKeys.has(key)) continue;
      selected.push(entry);
      selectedKeys.add(key);
      if (selected.length === MAX_PUBLISHED_EARNINGS) break;
    }
  }

  return selected.sort(compareEarnings);
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchAll() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn('  FINNHUB_API_KEY not set — skipping');
    return { earnings: [], unavailable: true, asOf: new Date().toISOString() };
  }

  const from = new Date();
  // #4922/#4929 review: include the past week so brief consumers can show
  // recent beats/misses — a today-forward window can only ever contain
  // same-day morning reporters.
  from.setDate(from.getDate() - 7);
  const to = new Date();
  to.setDate(to.getDate() + 14);

  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${toDateStr(from)}&to=${toDateStr(to)}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`Finnhub earnings calendar HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const raw = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];

  const normalized = raw
    .filter(e => e.symbol)
    .map(e => {
      const epsEst = e.epsEstimate != null ? Number(e.epsEstimate) : null;
      const epsAct = e.epsActual != null ? Number(e.epsActual) : null;
      const revEst = e.revenueEstimate != null ? Number(e.revenueEstimate) : null;
      const revAct = e.revenueActual != null ? Number(e.revenueActual) : null;
      const hasActuals = epsAct != null;
      let surpriseDirection = '';
      if (hasActuals && epsEst != null) {
        if (epsAct > epsEst) surpriseDirection = 'beat';
        else if (epsAct < epsEst) surpriseDirection = 'miss';
      }
      return {
        symbol: String(e.symbol),
        company: e.name ? String(e.name) : String(e.symbol),
        date: e.date ? String(e.date) : '',
        hour: e.hour ? String(e.hour) : '',
        epsEstimate: epsEst,
        revenueEstimate: revEst,
        epsActual: epsAct,
        revenueActual: revAct,
        hasActuals,
        surpriseDirection,
      };
    });

  const earnings = selectEarningsForPublication(normalized);

  console.log(`  Fetched ${earnings.length} earnings entries (from ${raw.length} total)`);
  return { earnings, unavailable: false, asOf: new Date().toISOString() };
}

function validate(data) {
  // >= 3 distinguishes a healthy result from an over-aggressive filter or a near-empty API response
  return Array.isArray(data?.earnings) && data.earnings.length >= 3;
}

export function declareRecords(data) {
  return Array.isArray(data?.earnings) ? data.earnings.length : 0;
}

if (process.argv[1]?.endsWith('seed-earnings-calendar.mjs')) {
  runSeed('market', 'earnings-calendar', KEY, fetchAll, {
    validateFn: validate,
    ttlSeconds: TTL,
    sourceVersion: 'finnhub-v1',
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 1440,
  }).catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}
