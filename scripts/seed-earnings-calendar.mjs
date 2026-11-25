#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const KEY = 'market:earnings-calendar:v1';
const TTL = 129600; // 36h — 3× a 12h cron interval
export const EARNINGS_CALENDAR_CAP = 100;

// Keep aligned with NQ_INFLUENCE_SYMBOLS in src/config/nq-context.ts.
export const NQ_INFLUENCE_EARNINGS_SYMBOLS = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'AVGO',
  'TSLA',
];

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function compareEarningsEntries(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return (b.revenueEstimate ?? 0) - (a.revenueEstimate ?? 0);
}

/**
 * Take up to `count` entries, one per date in turn, largest revenue first
 * within each date, so a busy day cannot crowd out the rest of the window.
 */
function takeAcrossDates(entries, count) {
  const byDate = new Map();
  for (const entry of [...entries].sort(compareEarningsEntries)) {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date).push(entry);
  }
  const days = [...byDate.values()];
  const taken = [];
  for (let round = 0; taken.length < count && days.some(day => round < day.length); round++) {
    for (const day of days) {
      if (taken.length >= count) break;
      if (round < day.length) taken.push(day[round]);
    }
  }
  return taken;
}

/**
 * Reserve every matching NQ influence report from the normalized window,
 * then budget one quarter of the cap for recent reports and the rest for
 * upcoming reports. Either window can use space the other does not need.
 */
export function boundEarningsCalendar(normalized, {
  cap = EARNINGS_CALENDAR_CAP,
  reservedSymbols = NQ_INFLUENCE_EARNINGS_SYMBOLS,
  today = toDateStr(new Date()),
} = {}) {
  const reservedSet = new Set(reservedSymbols);
  const reserved = [];
  const past = [];
  const upcoming = [];
  for (const entry of Array.isArray(normalized) ? normalized : []) {
    if (reservedSet.has(entry.symbol)) reserved.push(entry);
    else if (entry.date < today) past.push(entry);
    else upcoming.push(entry);
  }
  const remaining = Math.max(0, cap - reserved.length);
  const reservedPast = reserved.filter(entry => entry.date < today).length;
  const pastBudget = Math.floor(cap / 4) - reservedPast;
  const unusedUpcomingSlots = remaining - upcoming.length;
  const pastSlots = Math.min(remaining, Math.max(0, pastBudget, unusedUpcomingSlots));
  const selectedPast = takeAcrossDates(past, pastSlots);
  return [...reserved, ...selectedPast, ...takeAcrossDates(upcoming, remaining - selectedPast.length)]
    .sort(compareEarningsEntries);
}

async function fetchAll() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.warn('  FINNHUB_API_KEY not set — skipping');
    return { earnings: [], unavailable: true, asOf: new Date().toISOString() };
  }

  const now = new Date();
  const from = new Date(now);
  // #4922/#4929 review: include the past week so brief consumers can show
  // recent beats/misses — a today-forward window can only ever contain
  // same-day morning reporters.
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 14);

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
    })
    // Keep companies with meaningful analyst coverage:
    // - revenue estimate > 0 && >= $10M → large/mid-cap (primary filter)
    // - revenue estimate === 0 OR null → pre-revenue (biotech, SPACs) or financial/REIT
    //   with no revenue line — use |EPS| >= $0.05 as proxy for analyst coverage depth
    //   ($0.05 keeps well-covered loss-making companies; $0.10 was too aggressive)
    // - revenue estimate > 0 && < $10M → small-cap / micro-cap → always drop
    .filter(e => {
      if (e.revenueEstimate != null && e.revenueEstimate > 0) return e.revenueEstimate >= 10_000_000;
      if (e.epsEstimate != null) return Math.abs(e.epsEstimate) >= 0.05;
      return false;
    });

  const earnings = boundEarningsCalendar(normalized, { today: toDateStr(now) });

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
