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

import { loadEnvFile, runSeed, fetchYahooFxRates, SHARED_FX_FALLBACKS, sleep } from './_seed-utils.mjs';
import { fetchAvCurrencyRate } from './_shared-av.mjs';

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

await runSeed('shared', 'fx-rates', CANONICAL_KEY, async () => {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const rates = { USD: 1.0 };

  // --- Primary: Alpha Vantage CURRENCY_EXCHANGE_RATE ---
  if (avKey) {
    let avHits = 0;
    for (const currency of ALL_CURRENCIES) {
      if (currency === 'USD') continue;
      if (avHits > 0) await sleep(900); // ~67 req/min — safe under 75/min limit
      const rate = await fetchAvCurrencyRate(currency, avKey);
      if (rate !== null) {
        rates[currency] = rate;
        avHits++;
      }
    }
    console.log(`  [AV] ${avHits}/${ALL_CURRENCIES.length - 1} currencies fetched`);
  }

  // --- Fallback: Yahoo for any currencies not covered by AV ---
  const missing = ALL_CURRENCIES.filter(c => c !== 'USD' && rates[c] == null);
  if (missing.length > 0) {
    const yahooSymbols = Object.fromEntries(missing.map(c => [c, `${c}USD=X`]));
    const yahooRates = await fetchYahooFxRates(yahooSymbols, FX_FALLBACKS);
    Object.assign(rates, yahooRates);
    console.log(`  [Yahoo] ${missing.length} currencies fetched`);
  }

  console.log('  Total:', Object.keys(rates).length, 'currencies');
  return rates;
}, {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => data && typeof data === 'object' && Object.keys(data).length > 10,
  recordCount: (data) => Object.keys(data).length,
  sourceVersion: 'alphavantage+yahoo-fx',
});
