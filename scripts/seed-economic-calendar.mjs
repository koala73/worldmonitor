#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();

const CANONICAL_KEY = 'economic:econ-calendar:v1';
const CACHE_TTL = 129600; // 36h — 3× a 12h cron interval

// FRED release IDs for major US macro events
// https://api.stlouisfed.org/fred/releases
const FRED_RELEASES = [
  { id: 10,  event: 'CPI',              unit: '%' },
  { id: 50,  event: 'Nonfarm Payrolls', unit: 'K' },
  { id: 53,  event: 'GDP',              unit: '%' },
  { id: 54,  event: 'PCE',              unit: '%' },
  { id: 9,   event: 'Retail Sales',     unit: '%' },
];

// Fallback FOMC rate decision dates (day 2 of each 2-day meeting = decision day)
// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
// Used only when live fetch fails
const FOMC_DATES_FALLBACK = [
  '2026-01-28', '2026-03-18', '2026-04-29',
  '2026-06-17', '2026-07-29', '2026-09-16',
  '2026-10-28', '2026-12-09',
];

// Fallback ECB Governing Council monetary policy dates (press conference = Day 2)
// Source: ecb.europa.eu/press/calendars/mgcgc/html/index.en.html
// Used only when live fetch fails
const ECB_RATE_DATES_FALLBACK = [
  '2026-01-30', '2026-03-19', '2026-04-30',
  '2026-06-11', '2026-07-23', '2026-09-10',
  '2026-10-29', '2026-12-17',
];

// Eurostat dataset IDs for EU macro releases (free, no auth required)
// Response includes plannedDisseminationDate in extension.datasetMetadata.disseminationSchedule
const EUROSTAT_DATASETS = [
  { id: 'prc_hicp_manr', event: 'EU HICP (CPI)',       country: 'EU', impact: 'high',   unit: '%' },
  { id: 'une_rt_m',      event: 'EU Unemployment Rate', country: 'EU', impact: 'medium', unit: '%' },
  { id: 'namq_10_gdp',   event: 'Euro Area GDP',        country: 'EA', impact: 'high',   unit: '%' },
];

// Scrape FOMC meeting dates from the official Fed calendar page.
// Takes the second day of each 2-day meeting as the rate decision date.
// Falls back to FOMC_DATES_FALLBACK if the page is unreachable or parse fails.
async function fetchFomcDates(fallback) {
  try {
    const resp = await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const MONTHS = {
      January: '01', February: '02', March: '03', April: '04',
      May: '05', June: '06', July: '07', August: '08',
      September: '09', October: '10', November: '11', December: '12',
    };
    const MON = Object.keys(MONTHS).join('|');
    const dates = [];
    // Same-month: "January 27-28, 2026" → day2=28
    const reSame = new RegExp(`\\b(${MON})\\s+\\d{1,2}[-\u2013](\\d{1,2})\\*?\\s*,\\s*(20\\d{2})`, 'g');
    // Cross-month: "January 28 - February 1, 2026" → month2+day2
    const reCross = new RegExp(`\\b${MON}\\s+\\d{1,2}\\s*[-\u2013]\\s*(${MON})\\s+(\\d{1,2})\\*?\\s*,\\s*(20\\d{2})`, 'g');
    let m;
    while ((m = reSame.exec(html)) !== null) {
      const [, month, day2, year] = m;
      dates.push(`${year}-${MONTHS[month]}-${day2.padStart(2, '0')}`);
    }
    while ((m = reCross.exec(html)) !== null) {
      const [, month2, day2, year] = m;
      dates.push(`${year}-${MONTHS[month2]}-${day2.padStart(2, '0')}`);
    }

    const unique = [...new Set(dates)].sort();
    if (unique.length === 0) throw new Error('no dates parsed from Fed page');
    console.log(`  FOMC: fetched ${unique.length} meeting dates from federalreserve.gov`);
    return unique;
  } catch (err) {
    console.warn(`  FOMC dates fetch failed (${err.message}) — using fallback`);
    return fallback;
  }
}

// Scrape ECB Governing Council monetary policy meeting dates from the official ECB calendar.
// Filters to Day 2 entries (press conference day = rate decision announcement).
// Falls back to ECB_RATE_DATES_FALLBACK if the page is unreachable or parse fails.
async function fetchEcbCouncilDates(fallback) {
  try {
    const resp = await fetch('https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html', {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const dates = [];
    // Find all datetime="YYYY-MM-DD" positions; for each, scan only up to the NEXT datetime= attr
    // to avoid bleeding context from adjacent calendar entries
    const dateRe = /datetime="(\d{4}-\d{2}-\d{2})"/g;
    const allMatches = [...html.matchAll(dateRe)];
    for (let i = 0; i < allMatches.length; i++) {
      const match = allMatches[i];
      const nextIdx = allMatches[i + 1]?.index ?? match.index + 800;
      const ctx = html.slice(match.index, nextIdx);
      if (/monetary policy/i.test(ctx) && /\bDay\s*2\b/i.test(ctx)) {
        dates.push(match[1]);
      }
    }

    const unique = [...new Set(dates)].sort();
    if (unique.length === 0) throw new Error('no dates parsed from ECB page');
    console.log(`  ECB: fetched ${unique.length} council dates from ecb.europa.eu`);
    return unique;
  } catch (err) {
    console.warn(`  ECB council dates fetch failed (${err.message}) — using fallback`);
    return fallback;
  }
}

async function fetchEurostatRelease(datasetId, today, toDate) {
  const url =
    `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${datasetId}` +
    `?lastTimePeriod=1&format=JSON`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Eurostat HTTP ${resp.status} (dataset=${datasetId})`);

  const data = await resp.json();

  const schedule = data?.extension?.datasetMetadata?.disseminationSchedule;
  if (!schedule) return [];

  const dates = [];
  const planned = schedule.plannedDisseminationDate;
  if (planned && typeof planned === 'string') {
    const d = planned.slice(0, 10);
    if (d >= today && d <= toDate) dates.push(d);
  } else if (Array.isArray(planned)) {
    for (const p of planned) {
      const d = typeof p === 'string' ? p.slice(0, 10) : p?.date?.slice(0, 10);
      if (d && d >= today && d <= toDate) dates.push(d);
    }
  }

  return dates;
}

async function fetchFredReleaseDates(releaseId, apiKey, today, toDate) {
  const url =
    `https://api.stlouisfed.org/fred/release/dates` +
    `?release_id=${releaseId}` +
    `&sort_order=asc` +
    `&limit=1000` +
    `&include_release_dates_with_no_data=true` +
    `&api_key=${apiKey}` +
    `&file_type=json`;

  const data = await fredFetchJson(url, _proxyAuth);
  return (data.release_dates ?? [])
    .map((e) => e.date)
    .filter((d) => d >= today && d <= toDate);
}

async function fetchEconomicCalendar() {
  const apiKey = process.env.FRED_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  // Fetch FOMC and ECB dates dynamically; fall back to hardcoded if unavailable
  console.log('  Fetching FOMC and ECB Governing Council dates...');
  const [fomcAllDates, ecbAllDates] = await Promise.all([
    fetchFomcDates(FOMC_DATES_FALLBACK),
    fetchEcbCouncilDates(ECB_RATE_DATES_FALLBACK),
  ]);

  const fomcEvents = fomcAllDates
    .filter((d) => d >= today && d <= toDate)
    .map((date) => ({ event: 'FOMC Rate Decision', country: 'US', date, impact: 'high', actual: '', estimate: '', previous: '', unit: '' }));

  const ecbEvents = ecbAllDates
    .filter((d) => d >= today && d <= toDate)
    .map((date) => ({ event: 'ECB Rate Decision', country: 'EU', date, impact: 'high', actual: '', estimate: '', previous: '', unit: '' }));

  if (fomcEvents.length === 0) {
    console.warn('  WARNING: no upcoming FOMC dates in next 30 days');
  }
  if (ecbEvents.length === 0) {
    console.warn('  WARNING: no upcoming ECB dates in next 30 days');
  }

  const events = [...fomcEvents, ...ecbEvents];

  // Fetch Eurostat EU macro release dates (no API key required)
  console.log(`  Fetching Eurostat EU release dates ${today} → ${toDate}`);
  await Promise.all(
    EUROSTAT_DATASETS.map(async ({ id, event, country, impact, unit }) => {
      try {
        const dates = await fetchEurostatRelease(id, today, toDate);
        console.log(`  ${event} (eurostat=${id}): ${dates.length} upcoming date(s)`);
        for (const date of dates) {
          events.push({ event, country, date, impact, actual: '', estimate: '', previous: '', unit });
        }
      } catch (err) {
        console.warn(`  Eurostat ${id} failed: ${err.message} — skipping`);
      }
    }),
  );

  if (!apiKey) {
    console.warn('  FRED_API_KEY missing — returning FOMC + ECB + Eurostat dates only');
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { events, fromDate: today, toDate, total: events.length };
  }

  console.log(`  Fetching FRED economic release calendar ${today} → ${toDate}`);

  await Promise.all(
    FRED_RELEASES.map(async ({ id, event, unit }) => {
      try {
        const dates = await fetchFredReleaseDates(id, apiKey, today, toDate);
        console.log(`  ${event} (release_id=${id}): ${dates.length} upcoming date(s)`);
        for (const date of dates) {
          events.push({ event, country: 'US', date, impact: 'high', actual: '', estimate: '', previous: '', unit });
        }
      } catch (err) {
        console.warn(`  FRED release ${id} (${event}) failed: ${err.message} — skipping`);
      }
    }),
  );

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  console.log(`  Total events: ${events.length}`);

  return { events, fromDate: today, toDate, total: events.length };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

if (process.argv[1]?.endsWith('seed-economic-calendar.mjs')) {
  runSeed('economic', 'econ-calendar', CANONICAL_KEY, fetchEconomicCalendar, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'fred-v1',
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
