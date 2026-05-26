#!/usr/bin/env node

/**
 * Dedicated FX rates seed — fetches all currencies used across bigmac + grocery-basket
 * and writes them to shared:fx-rates:v1 (25h TTL).
 *
 * Deploy as a Railway cron service (daily, e.g. "0 6 * * *") so downstream
 * weekly seeds always find a warm cache and make zero Yahoo FX calls themselves.
 * Saves ~90 Yahoo Finance calls per weekly seed cycle.
 *
 * Railway setup: rootDirectory=. startCommand="node scripts/seed-fx-rates.mjs"
 */

import { loadEnvFile, runSeed, fetchYahooFxRates, SHARED_FX_FALLBACKS } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'shared:fx-rates:v1';
const CACHE_TTL = 25 * 3600; // 25 hours — covers daily cron with 1h drift buffer

// Union of all currencies used by bigmac + grocery-basket seeds
const ALL_CURRENCIES = [
  // Americas
  'USD', 'CAD', 'MXN', 'BRL', 'ARS', 'COP', 'CLP',
  // Europe
  'GBP', 'EUR', 'CHF', 'NOK', 'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'UAH',
  // Asia-Pacific
  'CNY', 'JPY', 'KRW', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'INR', 'PKR',
  // Middle East
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'JOD', 'LBP', 'ILS',
  // Africa
  'ZAR', 'NGN', 'KES',
  // Extra (grocery-basket only)
  'TRY',
];

const FX_SYMBOLS = Object.fromEntries(
  ALL_CURRENCIES.map(c => [c, `${c}USD=X`])
);

const FX_FALLBACKS = SHARED_FX_FALLBACKS;

export function declareRecords(data) {
  return data && typeof data === 'object' ? Object.keys(data).length : 0;
}

await runSeed('shared', 'fx-rates', CANONICAL_KEY, async () => {
  // Always fetch live — this seed IS the cache writer, bypass getSharedFxRates
  const rates = await fetchYahooFxRates(FX_SYMBOLS, FX_FALLBACKS);
  console.log('  Fetched', Object.keys(rates).length, 'currencies');
  return rates;
}, {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => data && typeof data === 'object' && Object.keys(data).length > 10,
  recordCount: (data) => Object.keys(data).length,
  sourceVersion: 'yahoo-fx-shared',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 3600,
});
