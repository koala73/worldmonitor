#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const API_BASE = 'https://api.usaspending.gov/api/v2';
const CANONICAL_KEY = 'economic:spending:v1';
const CACHE_TTL = 7200; // 2h — 1h buffer over 1h cron cadence (was 1h = 0 buffer)

const AWARD_TYPE_MAP = {
  'A': 'contract', 'B': 'contract', 'C': 'contract', 'D': 'contract',
  '02': 'grant', '03': 'grant', '04': 'grant', '05': 'grant',
  '06': 'grant', '10': 'grant',
  '07': 'loan', '08': 'loan',
};

function getDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

async function fetchSpending() {
  const periodStart = getDateDaysAgo(7);
  const periodEnd = getToday();

  const resp = await fetch(`${API_BASE}/search/spending_by_award/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      filters: {
        time_period: [{ start_date: periodStart, end_date: periodEnd }],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: [
        'Award ID', 'Recipient Name', 'Award Amount',
        'Awarding Agency', 'Description', 'Start Date', 'Award Type',
      ],
      limit: 15,
      order: 'desc',
      sort: 'Award Amount',
    }),
  });

  if (!resp.ok) throw new Error(`USASpending API error: ${resp.status}`);

  const data = await resp.json();
  const results = data.results || [];

  const awards = results.map(r => ({
    id: String(r['Award ID'] || ''),
    recipientName: String(r['Recipient Name'] || 'Unknown'),
    amount: Number(r['Award Amount']) || 0,
    agency: String(r['Awarding Agency'] || 'Unknown'),
    description: String(r.Description || '').slice(0, 200),
    startDate: String(r['Start Date'] || ''),
    awardType: AWARD_TYPE_MAP[String(r['Award Type'] || '')] || 'other',
  }));

  const totalAmount = awards.reduce((sum, a) => sum + a.amount, 0);

  return {
    awards,
    totalAmount,
    periodStart,
    periodEnd,
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return Array.isArray(data?.awards) && data.awards.length >= 1;
}

runSeed('economic', 'spending', CANONICAL_KEY, fetchSpending, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'usaspending-v2',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
