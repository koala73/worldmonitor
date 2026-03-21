#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:bigmac:v1';
const CACHE_TTL = 864000; // 10 days — weekly seed with 3-day cron-drift buffer
const EXA_DELAY_MS = 150;

async function readCurrentSnapshot() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    return result ? JSON.parse(result) : null;
  } catch {
    return null;
  }
}

const FX_FALLBACKS = {
  // Middle East
  AED: 0.2723, SAR: 0.2666, QAR: 0.2747, KWD: 3.2520,
  BHD: 2.6525, OMR: 2.5974, JOD: 1.4104, EGP: 0.0204, LBP: 0.0000112,
  // Major currencies
  USD: 1.0000, GBP: 1.2700, EUR: 1.0850, JPY: 0.0067, CHF: 1.1300,
  CNY: 0.1380, INR: 0.0120, AUD: 0.6500, CAD: 0.7400, NZD: 0.5900,
  BRL: 0.1900, MXN: 0.0490, ZAR: 0.0540, TRY: 0.0290, KRW: 0.0007,
  SGD: 0.7400, HKD: 0.1280, TWD: 0.0310, THB: 0.0280, IDR: 0.000063,
  NOK: 0.0920, SEK: 0.0930, DKK: 0.1450, PLN: 0.2450, CZK: 0.0430,
  HUF: 0.0028, RON: 0.2200, PHP: 0.0173, VND: 0.000040, MYR: 0.2250,
  PKR: 0.0036, ILS: 0.2750, ARS: 0.00084, COP: 0.000240, CLP: 0.00108,
  UAH: 0.0240, NGN: 0.00062, KES: 0.0077,
};

const COUNTRIES = [
  // Americas
  { code: 'US', name: 'United States', currency: 'USD', flag: '🇺🇸' },
  { code: 'CA', name: 'Canada',        currency: 'CAD', flag: '🇨🇦' },
  { code: 'MX', name: 'Mexico',        currency: 'MXN', flag: '🇲🇽' },
  { code: 'BR', name: 'Brazil',        currency: 'BRL', flag: '🇧🇷' },
  { code: 'AR', name: 'Argentina',     currency: 'ARS', flag: '🇦🇷' },
  { code: 'CO', name: 'Colombia',      currency: 'COP', flag: '🇨🇴' },
  { code: 'CL', name: 'Chile',         currency: 'CLP', flag: '🇨🇱' },
  // Europe
  { code: 'GB', name: 'UK',            currency: 'GBP', flag: '🇬🇧' },
  { code: 'DE', name: 'Germany',       currency: 'EUR', flag: '🇩🇪' },
  { code: 'FR', name: 'France',        currency: 'EUR', flag: '🇫🇷' },
  { code: 'IT', name: 'Italy',         currency: 'EUR', flag: '🇮🇹' },
  { code: 'ES', name: 'Spain',         currency: 'EUR', flag: '🇪🇸' },
  { code: 'CH', name: 'Switzerland',   currency: 'CHF', flag: '🇨🇭' },
  { code: 'NO', name: 'Norway',        currency: 'NOK', flag: '🇳🇴' },
  { code: 'SE', name: 'Sweden',        currency: 'SEK', flag: '🇸🇪' },
  { code: 'DK', name: 'Denmark',       currency: 'DKK', flag: '🇩🇰' },
  { code: 'PL', name: 'Poland',        currency: 'PLN', flag: '🇵🇱' },
  { code: 'CZ', name: 'Czechia',       currency: 'CZK', flag: '🇨🇿' },
  { code: 'HU', name: 'Hungary',       currency: 'HUF', flag: '🇭🇺' },
  { code: 'RO', name: 'Romania',       currency: 'RON', flag: '🇷🇴' },
  { code: 'UA', name: 'Ukraine',       currency: 'UAH', flag: '🇺🇦' },
  // Asia-Pacific
  { code: 'CN', name: 'China',         currency: 'CNY', flag: '🇨🇳' },
  { code: 'JP', name: 'Japan',         currency: 'JPY', flag: '🇯🇵' },
  { code: 'KR', name: 'South Korea',   currency: 'KRW', flag: '🇰🇷' },
  { code: 'AU', name: 'Australia',     currency: 'AUD', flag: '🇦🇺' },
  { code: 'NZ', name: 'New Zealand',   currency: 'NZD', flag: '🇳🇿' },
  { code: 'SG', name: 'Singapore',     currency: 'SGD', flag: '🇸🇬' },
  { code: 'HK', name: 'Hong Kong',     currency: 'HKD', flag: '🇭🇰' },
  { code: 'TW', name: 'Taiwan',        currency: 'TWD', flag: '🇹🇼' },
  { code: 'TH', name: 'Thailand',      currency: 'THB', flag: '🇹🇭' },
  { code: 'MY', name: 'Malaysia',      currency: 'MYR', flag: '🇲🇾' },
  { code: 'ID', name: 'Indonesia',     currency: 'IDR', flag: '🇮🇩' },
  { code: 'PH', name: 'Philippines',   currency: 'PHP', flag: '🇵🇭' },
  { code: 'VN', name: 'Vietnam',       currency: 'VND', flag: '🇻🇳' },
  { code: 'IN', name: 'India',         currency: 'INR', flag: '🇮🇳' },
  { code: 'PK', name: 'Pakistan',      currency: 'PKR', flag: '🇵🇰' },
  // Middle East
  { code: 'AE', name: 'UAE',           currency: 'AED', flag: '🇦🇪' },
  { code: 'SA', name: 'Saudi Arabia',  currency: 'SAR', flag: '🇸🇦' },
  { code: 'QA', name: 'Qatar',         currency: 'QAR', flag: '🇶🇦' },
  { code: 'KW', name: 'Kuwait',        currency: 'KWD', flag: '🇰🇼' },
  { code: 'BH', name: 'Bahrain',       currency: 'BHD', flag: '🇧🇭' },
  { code: 'OM', name: 'Oman',          currency: 'OMR', flag: '🇴🇲' },
  { code: 'EG', name: 'Egypt',         currency: 'EGP', flag: '🇪🇬' },
  { code: 'JO', name: 'Jordan',        currency: 'JOD', flag: '🇯🇴' },
  { code: 'LB', name: 'Lebanon',       currency: 'LBP', flag: '🇱🇧' },
  { code: 'IL', name: 'Israel',        currency: 'ILS', flag: '🇮🇱' },
  // Africa
  { code: 'ZA', name: 'South Africa',  currency: 'ZAR', flag: '🇿🇦' },
  { code: 'NG', name: 'Nigeria',       currency: 'NGN', flag: '🇳🇬' },
  { code: 'KE', name: 'Kenya',         currency: 'KES', flag: '🇰🇪' },
];

const FX_SYMBOLS = Object.fromEntries(
  [...new Set(COUNTRIES.map(c => c.currency))].map(ccy => [ccy, `${ccy}USD=X`])
);

// Handle both plain numbers and thousands-separated (480,000 LBP or 12,000 KRW)
const NUM = '\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d{1,3})?';
const CCY = 'USD|GBP|EUR|JPY|CHF|CNY|INR|AUD|CAD|NZD|BRL|MXN|ZAR|TRY|KRW|SGD|HKD|TWD|THB|IDR|NOK|SEK|DKK|PLN|CZK|HUF|RON|PHP|VND|MYR|PKR|ILS|ARS|COP|CLP|UAH|NGN|KES|AED|SAR|QAR|KWD|BHD|OMR|EGP|JOD|LBP';
const PRICE_PATTERNS = [
  new RegExp(`(${NUM})\\s*(${CCY})`, 'i'),
  new RegExp(`(${CCY})\\s*(${NUM})`, 'i'),
];

function parseNum(s) { return parseFloat(s.replace(/[,\s]/g, '')); }

function matchPrice(text, url) {
  for (const re of PRICE_PATTERNS) {
    const match = text.match(re);
    if (match) {
      const [price, currency] = /^\d/.test(match[1])
        ? [parseNum(match[1]), match[2].toUpperCase()]
        : [parseNum(match[2]), match[1].toUpperCase()];
      if (price > 0 && price < 10_000_000) return { price, currency, source: url || '' };
    }
  }
  return null;
}

async function fetchFxRates() {
  const rates = {};
  for (const [currency, symbol] of Object.entries(FX_SYMBOLS)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) { rates[currency] = FX_FALLBACKS[currency] ?? null; continue; }
      const data = await resp.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      rates[currency] = (price != null && price > 0) ? price : (FX_FALLBACKS[currency] ?? null);
    } catch {
      rates[currency] = FX_FALLBACKS[currency] ?? null;
    }
    await sleep(100);
  }
  console.log('  FX rates fetched:', JSON.stringify(rates));
  return rates;
}

async function searchExa(query, includeDomains = null) {
  const apiKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
  if (!apiKey) throw new Error('EXA_API_KEYS or EXA_API_KEY not set');

  const body = {
    query,
    numResults: 5,
    type: 'auto',
    contents: { summary: { query: 'What is the current Big Mac price in local currency and USD?' } },
  };
  if (includeDomains) body.includeDomains = includeDomains;

  const resp = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.warn(`  EXA ${resp.status}: ${text.slice(0, 100)}`);
    return null;
  }
  return resp.json();
}

async function fetchBigMacPrices(prevSnapshot) {
  const fxRates = await fetchFxRates();
  const results = [];

  for (const country of COUNTRIES) {
    await sleep(EXA_DELAY_MS);
    console.log(`\n  Processing ${country.flag} ${country.name} (${country.currency})...`);

    const fxRate = fxRates[country.currency] ?? FX_FALLBACKS[country.currency] ?? null;
    let localPrice = null;
    let usdPrice = null;
    let sourceSite = '';

    try {
      // Include currency code in query — helps EXA find per-country specialist pages
      const query = `Big Mac price ${country.name} ${country.currency}`;
      const SPECIALIST_SITES = ['theburgerindex.com', 'eatmyindex.com'];

      // Specialist Big Mac Index sites only — clean, verified per-country data
      const exaResult = await searchExa(query, SPECIALIST_SITES);
      await sleep(EXA_DELAY_MS);

      if (exaResult?.results?.length) {
        for (const result of exaResult.results) {
          const summary = result?.summary;
          if (!summary || typeof summary !== 'string') continue;
          const hit = matchPrice(summary, result.url || '');
          if (hit?.currency === country.currency) {
            localPrice = hit.price;
            sourceSite = hit.source;
            break;
          }
        }
      }
    } catch (err) {
      console.warn(`    [${country.code}] EXA error: ${err.message}`);
    }

    if (usdPrice === null) {
      usdPrice = localPrice !== null && fxRate ? +(localPrice * fxRate).toFixed(4) : null;
    }
    const status = localPrice !== null ? `${localPrice} ${country.currency} = $${usdPrice}` : 'N/A';
    console.log(`    Big Mac: ${status}`);

    results.push({
      code: country.code,
      name: country.name,
      currency: country.currency,
      flag: country.flag,
      localPrice: localPrice !== null ? +localPrice.toFixed(4) : null,
      usdPrice,
      fxRate: fxRate || 0,
      sourceSite,
      available: usdPrice !== null,
    });
  }

  const withData = results.filter(r => r.usdPrice != null);
  const cheapest = withData.length ? withData.reduce((a, b) => a.usdPrice < b.usdPrice ? a : b).code : '';
  const mostExpensive = withData.length ? withData.reduce((a, b) => a.usdPrice > b.usdPrice ? a : b).code : '';

  // Compute WoW per country
  const wowAvailable = prevSnapshot?.countries?.length > 0;
  if (wowAvailable) {
    const prevMap = Object.fromEntries(prevSnapshot.countries.map(c => [c.code, c.usdPrice]));
    for (const r of results) {
      if (r.usdPrice != null && prevMap[r.code] != null && prevMap[r.code] > 0) {
        r.wowPct = +((r.usdPrice - prevMap[r.code]) / prevMap[r.code] * 100).toFixed(2);
      } else {
        r.wowPct = null;
      }
    }
  }

  const wowCountries = wowAvailable ? results.filter(r => r.wowPct != null) : [];
  const wowAvgPct = wowCountries.length > 0
    ? +(wowCountries.reduce((s, r) => s + r.wowPct, 0) / wowCountries.length).toFixed(2)
    : 0;

  return {
    countries: results,
    fetchedAt: new Date().toISOString(),
    cheapestCountry: cheapest,
    mostExpensiveCountry: mostExpensive,
    wowAvgPct,
    wowAvailable,
    prevFetchedAt: wowAvailable ? (prevSnapshot.fetchedAt ?? '') : '',
  };
}

const prevSnapshot = await readCurrentSnapshot();

await runSeed('economic', 'bigmac', CANONICAL_KEY, () => fetchBigMacPrices(prevSnapshot), {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => data?.countries?.length > 0,
  recordCount: (data) => data?.countries?.filter(c => c.available).length || 0,
  extraKeys: prevSnapshot ? [{
    key: `${CANONICAL_KEY}:prev`,
    transform: () => prevSnapshot,  // write PRE-overwrite snapshot; ignore new data
    ttl: CACHE_TTL * 2,
  }] : undefined,
});
