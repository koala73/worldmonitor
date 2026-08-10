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

import { loadEnvFile, runSeed, fetchYahooFxRatesWithProvenance } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';

const CANONICAL_KEY = 'shared:fx-rates:v1';
const CACHE_TTL = 25 * 3600; // 25 hours — covers daily cron with 1h drift buffer
const MIN_LIVE_RATE_COUNT = 11; // Preserve the previous >10-key floor, now counting only real Yahoo quotes.

// Union of all currencies used by bigmac + grocery-basket seeds
export const ALL_CURRENCIES = [
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

function fallbackCurrencySet(data) {
  if (!Array.isArray(data?.fallbackCurrencies)) return null;
  const fallbackCurrencies = data.fallbackCurrencies;
  const fallbackSet = new Set(fallbackCurrencies);
  if (fallbackSet.size !== fallbackCurrencies.length) return null;
  if ([...fallbackSet].some(c => c === 'USD' || !ALL_CURRENCIES.includes(c))) return null;
  return fallbackSet;
}

export function buildFxRatesPayload({ rates, fallbackCurrencies }) {
  const payload = { ...rates };
  const uniqueFallbacks = [...new Set(fallbackCurrencies)];
  for (const currency of uniqueFallbacks) payload[currency] = null;
  payload.fallbackCurrencies = uniqueFallbacks;
  return payload;
}

export function declareRecords(data) {
  const fallbackSet = fallbackCurrencySet(data);
  if (fallbackSet === null) return 0;
  return ALL_CURRENCIES.filter((currency) => (
    currency !== 'USD'
    && !fallbackSet.has(currency)
    && Number.isFinite(data[currency])
    && data[currency] > 0
  )).length;
}

export function validateFxPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const fallbackSet = fallbackCurrencySet(data);
  if (fallbackSet === null) return false;
  for (const currency of ALL_CURRENCIES) {
    if (fallbackSet.has(currency)) {
      if (data[currency] !== null) return false;
    } else if (!Number.isFinite(data[currency]) || data[currency] <= 0) {
      return false;
    }
  }
  return declareRecords(data) >= MIN_LIVE_RATE_COUNT;
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  loadEnvFile(import.meta.url);
  await runSeed('shared', 'fx-rates', CANONICAL_KEY, async () => {
    // Always fetch live — this seed IS the cache writer, bypass getSharedFxRates.
    // Pass no constants: canonical gaps stay null and provenance stays explicit.
    const result = await fetchYahooFxRatesWithProvenance(FX_SYMBOLS, {});
    const payload = buildFxRatesPayload(result);
    console.log(
      '  Fetched',
      declareRecords(payload),
      'live currencies;',
      payload.fallbackCurrencies.length,
      'unavailable',
    );
    return payload;
  }, {
    ttlSeconds: CACHE_TTL,
    validateFn: validateFxPayload,
    sourceVersion: 'yahoo-fx-shared-v2',
    declareRecords,
    schemaVersion: 2,
    maxStaleMin: 3600,
  });
}
