#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
import { EVENT_SERIES, computePrintValues, fillEventActuals } from './_econ-actuals.mjs';

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

const FED_MONTHS = {
  January: '01', February: '02', March: '03', April: '04',
  May: '05', June: '06', July: '07', August: '08',
  September: '09', October: '10', November: '11', December: '12',
};

// Rate decision dates (second day of each 2-day meeting) from the Fed calendar page.
// The page lists meetings in per-year sections, and its notes also carry inline
// dates such as "January 25-26, 2028", so both formats are read on every page.
export function parseFomcDates(html) {
  const MON = Object.keys(FED_MONTHS).join('|');
  const dates = [];

  const reSame = new RegExp(`\\b(${MON})\\s+\\d{1,2}[-\u2013](\\d{1,2})\\*?\\s*,\\s*(20\\d{2})`, 'g');
  const reCross = new RegExp(`\\b(?:${MON})\\s+\\d{1,2}\\s*[-\u2013]\\s*(${MON})\\s+(\\d{1,2})\\*?\\s*,\\s*(20\\d{2})`, 'g');
  for (const [, month, day2, year] of html.matchAll(reSame)) {
    dates.push(`${year}-${FED_MONTHS[month]}-${day2.padStart(2, '0')}`);
  }
  for (const [, month2, day2, year] of html.matchAll(reCross)) {
    dates.push(`${year}-${FED_MONTHS[month2]}-${day2.padStart(2, '0')}`);
  }

  const monthByPrefix = Object.fromEntries(Object.entries(FED_MONTHS).map(([name, mm]) => [name.slice(0, 3), mm]));
  const yearRe = /\b(20\d{2})\s+FOMC\s+Meetings/gi;
  let yearMatch;
  while ((yearMatch = yearRe.exec(html)) !== null) {
    const year = yearMatch[1];
    const sectionStart = yearMatch.index;
    const nextYearIdx = html.indexOf(' FOMC Meetings', sectionStart + 20);
    const section = html.slice(sectionStart, nextYearIdx > sectionStart ? nextYearIdx : html.length);

    // Each meeting row: <div class="fomc-meeting__month"><strong>Apr/May</strong></div>
    // <div class="fomc-meeting__date">30-1*</div>. A range ending in a smaller day crosses into the last month.
    // Rows noted as a "Monetary Policy Strategy Meeting" announce no rate decision.
    for (const row of section.split('fomc-meeting__month').slice(1)) {
      const cells = row.match(/^[^>]*>\s*(?:<strong>)?([A-Za-z/]+)[\s\S]*?fomc-meeting__date[^>]*>\s*\d{1,2}\s*[-\u2013]\s*(\d{1,2})/);
      if (!cells || /strategy meeting/i.test(row)) continue;
      const mm = monthByPrefix[cells[1].split('/').at(-1).slice(0, 3)];
      if (mm) dates.push(`${year}-${mm}-${cells[2].padStart(2, '0')}`);
    }
  }

  return [...new Set(dates)].sort();
}

// Falls back to FOMC_DATES_FALLBACK if the page is unreachable or lists no meeting in `year`.
async function fetchFomcDates(fallback, year) {
  try {
    const resp = await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const dates = parseFomcDates(await resp.text());
    if (!dates.some((d) => d.startsWith(`${year}-`))) throw new Error(`no ${year} meeting dates parsed from Fed page`);
    console.log(`  FOMC: fetched ${dates.length} meeting dates from federalreserve.gov`);
    return dates;
  } catch (err) {
    console.warn(`  FOMC dates fetch failed (${err.message}) — using fallback`);
    return fallback;
  }
}

// Each calendar entry is a date followed by its own description, so a date counts as a
// rate decision only when the text between it and the next date is a monetary policy Day 2.
function ecbDecisionDates(html, dateRe, toIso) {
  const matches = [...html.matchAll(dateRe)];
  return matches
    .filter((match, i) => {
      const entry = html.slice(match.index, matches[i + 1]?.index ?? match.index + 800);
      return /monetary policy/i.test(entry) && /\bDay\s*2\b/i.test(entry);
    })
    .map(toIso);
}

// ECB Governing Council rate decision dates (Day 2, press conference day) from the ECB calendar.
export function parseEcbCouncilDates(html) {
  let dates = ecbDecisionDates(html, /datetime="(\d{4}-\d{2}-\d{2})"/g, (m) => m[1]);
  if (dates.length === 0) {
    dates = ecbDecisionDates(html, /(\d{1,2})\/(\d{2})\/(\d{4})/g, ([, dd, mm, yyyy]) => `${yyyy}-${mm}-${dd.padStart(2, '0')}`);
  }
  if (dates.length === 0) {
    dates = ecbDecisionDates(html, /\b(20\d{2}-\d{2}-\d{2})\b/g, (m) => m[1]);
  }
  return [...new Set(dates)].sort();
}

// Falls back to ECB_RATE_DATES_FALLBACK if the page is unreachable or parse fails.
async function fetchEcbCouncilDates(fallback) {
  try {
    const resp = await fetch('https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html', {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const dates = parseEcbCouncilDates(await resp.text());
    if (dates.length === 0) throw new Error('no dates parsed from ECB page');
    console.log(`  ECB: fetched ${dates.length} council dates from ecb.europa.eu`);
    return dates;
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
  // FRED returns release dates oldest-first under sort_order=asc, so
  // asc + limit=1000 captures only the OLDEST 1000 dates (decades of
  // history) and the upcoming-30d filter below sees nothing for
  // long-history releases. desc puts scheduled future releases (included
  // via include_release_dates_with_no_data=true) at the front of the page.
  const url =
    `https://api.stlouisfed.org/fred/release/dates` +
    `?release_id=${releaseId}` +
    `&sort_order=desc` +
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
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 31);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);

  // Fetch FOMC and ECB dates dynamically; fall back to hardcoded if unavailable
  console.log('  Fetching FOMC and ECB Governing Council dates...');
  const [fomcAllDates, ecbAllDates] = await Promise.all([
    fetchFomcDates(FOMC_DATES_FALLBACK, today.slice(0, 4)),
    fetchEcbCouncilDates(ECB_RATE_DATES_FALLBACK),
  ]);

  const fomcEvents = fomcAllDates
    .filter((d) => d >= fromDate && d <= toDate)
    .map((date) => ({ event: 'FOMC Rate Decision', country: 'US', date, impact: 'high', actual: '', estimate: '', previous: '', unit: '' }));

  const ecbEvents = ecbAllDates
    .filter((d) => d >= fromDate && d <= toDate)
    .map((date) => ({ event: 'ECB Rate Decision', country: 'EU', date, impact: 'high', actual: '', estimate: '', previous: '', unit: '' }));

  if (fomcEvents.length === 0) {
    console.warn('  WARNING: no upcoming FOMC dates in next 30 days');
  }
  if (ecbEvents.length === 0) {
    console.warn('  WARNING: no upcoming ECB dates in next 30 days');
  }

  const events = [...fomcEvents, ...ecbEvents];

  // Fetch Eurostat EU macro release dates (no API key required)
  console.log(`  Fetching Eurostat EU release dates ${fromDate} → ${toDate}`);
  await Promise.all(
    EUROSTAT_DATASETS.map(async ({ id, event, country, impact, unit }) => {
      try {
        const dates = await fetchEurostatRelease(id, fromDate, toDate);
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
    return { events, fromDate, toDate, total: events.length, asOf: now.toISOString() };
  }

  console.log(`  Fetching FRED economic release calendar ${fromDate} → ${toDate}`);

  await Promise.all(
    FRED_RELEASES.map(async ({ id, event, unit }) => {
      try {
        const dates = await fetchFredReleaseDates(id, apiKey, fromDate, toDate);
        console.log(`  ${event} (release_id=${id}): ${dates.length} upcoming date(s)`);
        for (const date of dates) {
          events.push({ event, country: 'US', date, impact: 'high', actual: '', estimate: '', previous: '', unit });
        }
      } catch (err) {
        console.warn(`  FRED release ${id} (${event}) failed: ${err.message} — skipping`);
      }
    }),
  );

  // #4922 (b): capture the PRINTS. Release calendars carry dates only;
  // NOTE consumer scope: the RPC (get-economic-calendar.ts) reconstructs
  // its proto response and does NOT forward recentPrints — it is a
  // Redis-side block for seeders/ops until the proto gains a field
  // (tracked in #4922). The user-visible win flows through the EVENT
  // actual/previous fields, which the proto already carries.
  // the values live in series observations and land same-day. Publish a
  // recentPrints block (always useful to market-brief consumers) and fill
  // actual/previous on any in-window event whose print is out.
  const recentPrints = [];
  const printsByEvent = {};
  await Promise.all(
    Object.entries(EVENT_SERIES).map(async ([eventName, { series, transform }]) => {
      try {
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}` +
          `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=4`;
        const json = await fredFetchJson(url, _proxyAuth);
        const print = computePrintValues(json?.observations, transform);
        if (print.actual) {
          const unit = FRED_RELEASES.find((release) => release.event === eventName)?.unit ?? '';
          printsByEvent[eventName] = print;
          recentPrints.push({ event: eventName, series, obsDate: print.obsDate, actual: print.actual, previous: print.previous, unit });
        }
      } catch (err) {
        console.warn(`  FRED observations ${series} (${eventName}) failed: ${err.message} — skipping print`);
      }
    }),
  );
  const filled = fillEventActuals(events, printsByEvent, today);
  console.log(`  Prints: ${recentPrints.length} series captured, ${filled} event(s) filled with actuals`);

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  console.log(`  Total events: ${events.length}`);

  return { events, recentPrints, fromDate, toDate, total: events.length, asOf: now.toISOString() };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

if (process.argv[1]?.endsWith('seed-economic-calendar.mjs')) {
  runSeed('economic', 'econ-calendar', CANONICAL_KEY, fetchEconomicCalendar, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'fred-v1',
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 1440,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
