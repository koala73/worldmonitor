#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

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

// 2026 FOMC rate decision dates (Fed publishes full year schedule in advance)
// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
const FOMC_DATES_2026 = [
  '2026-01-29', '2026-03-19', '2026-05-07',
  '2026-06-18', '2026-07-30', '2026-09-17',
  '2026-11-05', '2026-12-17',
];

// 2026 ECB Governing Council monetary policy meeting dates
// Source: ecb.europa.eu/press/govcdec/mopo/html/index.en.html
const ECB_RATE_DATES_2026 = [
  '2026-01-30', '2026-03-06', '2026-04-17',
  '2026-06-05', '2026-07-24', '2026-09-11',
  '2026-10-29', '2026-12-17',
];

// Eurostat dataset IDs for EU macro releases (free, no auth required)
// Response includes plannedDisseminationDate in extension.datasetMetadata.disseminationSchedule
const EUROSTAT_DATASETS = [
  { id: 'prc_hicp_manr', event: 'EU HICP (CPI)',       country: 'EU', impact: 'high',   unit: '%' },
  { id: 'une_rt_m',      event: 'EU Unemployment Rate', country: 'EU', impact: 'medium', unit: '%' },
  { id: 'namq_10_gdp',   event: 'Euro Area GDP',        country: 'EA', impact: 'high',   unit: '%' },
];

function buildFomcEvents(today) {
  return FOMC_DATES_2026
    .filter((d) => d >= today)
    .map((date) => ({
      event: 'FOMC Rate Decision',
      country: 'US',
      date,
      impact: 'high',
      actual: '',
      estimate: '',
      previous: '',
      unit: '',
    }));
}

function buildEcbEvents(today) {
  const upcoming = ECB_RATE_DATES_2026.filter((d) => d >= today);
  if (upcoming.length === 0) {
    console.warn('  WARNING: no upcoming ECB dates — ECB_RATE_DATES_2026 needs updating for the new year');
  }
  return upcoming.map((date) => ({
    event: 'ECB Rate Decision',
    country: 'EU',
    date,
    impact: 'high',
    actual: '',
    estimate: '',
    previous: '',
    unit: '',
  }));
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

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`FRED release/dates HTTP ${resp.status} (release_id=${releaseId})`);

  const data = await resp.json();
  return (data.release_dates ?? [])
    .map((e) => e.date)
    .filter((d) => d >= today && d <= toDate);
}

async function fetchEconomicCalendar() {
  const apiKey = process.env.FRED_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const fomcEvents = buildFomcEvents(today);
  const ecbEvents = buildEcbEvents(today);

  if (fomcEvents.length === 0) {
    console.warn('  WARNING: no upcoming FOMC dates — FOMC_DATES_2026 needs updating for the new year');
  }

  const events = [...fomcEvents, ...ecbEvents];

  // Fetch Eurostat EU macro release dates (no API key required)
  console.log(`  Fetching Eurostat EU release dates ${today} → ${toDate}`);
  await Promise.allSettled(
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
      const dates = await fetchFredReleaseDates(id, apiKey, today, toDate);
      console.log(`  ${event} (release_id=${id}): ${dates.length} upcoming date(s)`);
      for (const date of dates) {
        events.push({ event, country: 'US', date, impact: 'high', actual: '', estimate: '', previous: '', unit });
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
