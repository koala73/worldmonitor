#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

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

async function fetchFredReleaseDates(releaseId, apiKey, today, toDate) {
  const url =
    `https://api.stlouisfed.org/fred/release/dates` +
    `?release_id=${releaseId}` +
    `&sort_order=asc` +
    `&limit=1000` +
    `&include_release_dates_with_no_data=true` +
    `&api_key=${apiKey}` +
    `&file_type=json`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

  if (!apiKey) {
    console.warn('  FRED_API_KEY missing — returning FOMC dates only');
    return { events: fomcEvents, fromDate: today, toDate, total: fomcEvents.length };
  }

  console.log(`  Fetching FRED economic release calendar ${today} → ${toDate}`);

  const events = [...fomcEvents];

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
