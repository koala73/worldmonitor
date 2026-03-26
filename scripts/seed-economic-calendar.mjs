#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:econ-calendar:v1';
const CACHE_TTL = 129600; // 36h — 3× a 12h cron interval

const HIGH_PRIORITY_TERMS = [
  'fomc', 'fed funds', 'federal funds', 'nonfarm', 'non-farm',
  'cpi', 'pce', 'gdp', 'unemployment', 'payroll', 'retail sales', 'pmi', 'ism',
];

const ALLOWED_COUNTRIES = new Set(['US', 'UK', 'EUR', 'EU', 'DE', 'FR', 'JP', 'CN']);

function isHighPriority(eventName) {
  const lower = (eventName || '').toLowerCase();
  return HIGH_PRIORITY_TERMS.some((term) => lower.includes(term));
}

function normalizeImpact(raw) {
  if (raw === null || raw === undefined) return 'low';
  const s = String(raw).toLowerCase();
  if (s === '3' || s === 'high') return 'high';
  if (s === '2' || s === 'medium' || s === 'moderate') return 'medium';
  return 'low';
}

function toDateString(timeStr) {
  if (!timeStr) return '';
  const d = new Date(timeStr);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(timeStr)) return timeStr.slice(0, 10);
  return '';
}

function formatValue(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function buildFallbackEvents() {
  const year = new Date().getFullYear();
  return [
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-01-29`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-03-19`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-05-07`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-06-18`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-07-30`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-09-17`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-11-05`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
    { event: 'FOMC Rate Decision', country: 'US', date: `${year}-12-17`, impact: 'high', actual: '', estimate: '', previous: '', unit: '' },
  ].filter((e) => e.date >= new Date().toISOString().slice(0, 10));
}

async function fetchEconomicCalendar() {
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    console.warn('  FINNHUB_API_KEY missing — returning hardcoded FOMC dates');
    const events = buildFallbackEvents();
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    return { events, fromDate: today, toDate: future, total: events.length };
  }

  const today = new Date();
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 30 * 86400_000).toISOString().slice(0, 10);

  const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}`;

  console.log(`  Fetching Finnhub economic calendar ${from} → ${to}`);

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    throw new Error(`Finnhub HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const raw = data?.economicCalendar ?? [];

  console.log(`  Raw events from Finnhub: ${raw.length}`);

  const filtered = raw.filter((item) => {
    const country = (item.country || '').toUpperCase();
    if (!ALLOWED_COUNTRIES.has(country)) return false;
    const impact = normalizeImpact(item.impact);
    if (impact === 'high') return true;
    if (isHighPriority(item.event)) return true;
    return false;
  });

  const transformed = filtered.map((item) => ({
    event: item.event || '',
    country: (item.country || '').toUpperCase(),
    date: toDateString(item.time || item.date || ''),
    impact: normalizeImpact(item.impact),
    actual: formatValue(item.actual),
    estimate: formatValue(item.estimate),
    previous: formatValue(item.prev),
    unit: formatValue(item.unit),
  }));

  transformed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const events = transformed.slice(0, 60);

  console.log(`  Filtered to ${events.length} events`);

  return { events, fromDate: from, toDate: to, total: events.length };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

if (process.argv[1]?.endsWith('seed-economic-calendar.mjs')) {
  runSeed('economic', 'econ-calendar', CANONICAL_KEY, fetchEconomicCalendar, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'finnhub-v1',
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
