#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const config = loadSharedConfig('grocery-basket.json');

const CANONICAL_KEY = 'economic:grocery-basket:v1';
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
const FIRECRAWL_DELAY_MS = 500;

// Hardcoded FX fallbacks — used when Yahoo Finance returns null/zero
const FX_FALLBACKS = {
  // Middle East (pegged)
  AED: 0.2723, SAR: 0.2666, QAR: 0.2747, KWD: 3.2520,
  BHD: 2.6525, OMR: 2.5974, JOD: 1.4104, EGP: 0.0192, LBP: 0.0000112,
  // Major currencies
  USD: 1.0000, GBP: 1.2700, EUR: 1.0850, JPY: 0.0067,
  CNY: 0.1380, INR: 0.0120, AUD: 0.6500, CAD: 0.7400,
  BRL: 0.1900, MXN: 0.0490, ZAR: 0.0540, TRY: 0.0290,
  KRW: 0.0007, SGD: 0.7400, PKR: 0.0036,
  // Emerging
  NGN: 0.00062, KES: 0.0077, ARS: 0.00084, IDR: 0.000063, PHP: 0.0173,
};

async function fetchFxRates() {
  const rates = {};
  for (const [currency, symbol] of Object.entries(config.fxSymbols)) {
    if (currency === 'USD') { rates['USD'] = 1.0; continue; }
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        rates[currency] = FX_FALLBACKS[currency] || null;
        continue;
      }
      const data = await resp.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      rates[currency] = (price != null && price > 0) ? price : (FX_FALLBACKS[currency] ?? null);
    } catch {
      rates[currency] = FX_FALLBACKS[currency] || null;
    }
    await sleep(100);
  }
  console.log('  FX rates fetched:', JSON.stringify(rates));
  return rates;
}

async function searchExa(query, sites, locationCode) {
  const apiKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
  if (!apiKey) throw new Error('EXA_API_KEYS or EXA_API_KEY not set');

  const body = {
    query,
    numResults: 5,
    type: 'auto',
    // Restrict to known local supermarket/retailer domains per country — prevents EXA
    // neural search from returning USD-priced global comparison pages (Numbeo, Tridge, etc.)
    includeDomains: sites,
    // Bias results toward the target country's web
    userLocation: locationCode,
    contents: {
      summary: {
        // Explicitly request ISO currency code so regex can reliably match
        query: 'What is the retail price of this product? State amount and ISO currency code (e.g. GBP 1.50, EUR 2.99, JPY 193).',
      },
    },
  };

  const resp = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': CHROME_UA,
    },
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

// Firecrawl fallback — renders JS-heavy SPA pages and extracts prices via LLM schema
async function scrapeFirecrawl(url, expectedCurrency) {
  const apiKey = process.env.FIRECRAWL_API_KEY || '';
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['extract'],
        extract: {
          prompt: `Find the retail unit price of the grocery product on this page. Return the numeric price and ISO 4217 currency code (e.g. ${expectedCurrency}).`,
          schema: {
            type: 'object',
            properties: {
              price: { type: 'number', description: 'Retail price as a number' },
              currency: { type: 'string', description: 'ISO 4217 currency code, e.g. SAR, KRW, USD' },
            },
            required: ['price', 'currency'],
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(`    [Firecrawl] ${resp.status}: ${txt.slice(0, 80)}`);
      return null;
    }
    const data = await resp.json();
    const ex = data?.data?.extract;
    if (!ex?.price || ex.price <= 0) return null;
    const ccy = (ex.currency || '').toUpperCase().trim();
    if (ccy !== expectedCurrency) {
      console.warn(`    [Firecrawl] currency mismatch: got ${ccy}, expected ${expectedCurrency}`);
      return null;
    }
    const minPrice = CURRENCY_MIN[expectedCurrency] ?? 0;
    if (ex.price <= minPrice || ex.price >= 100000) return null;
    return { price: ex.price, currency: expectedCurrency, source: url };
  } catch (err) {
    console.warn(`    [Firecrawl] error: ${err.message}`);
    return null;
  }
}

// All supported currency codes — keep in sync with grocery-basket.json fxSymbols
const CCY = 'USD|GBP|EUR|JPY|CNY|INR|AUD|CAD|BRL|MXN|ZAR|TRY|NGN|KRW|SGD|PKR|AED|SAR|QAR|KWD|BHD|OMR|EGP|JOD|LBP|KES|ARS|IDR|PHP';

// Currency symbol → ISO code map for sites that use symbols instead of ISO codes
const SYMBOL_MAP = { '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₩': 'KRW', '₹': 'INR', '₦': 'NGN', 'R$': 'BRL' };

// Minimum plausible local price per currency — prevents matching product codes / IDs
// e.g. IDR 4 = $0.0003 (nonsense), NGN 20 = $0.01 (nonsense), KRW 5 = $0.004 (nonsense)
const CURRENCY_MIN = { NGN: 50, IDR: 500, ARS: 50, KRW: 1000, ZAR: 2, PKR: 20, LBP: 1000 };

// Maximum plausible USD price per item — catches bulk/wholesale products (e.g. 25lb salt bag)
// Applied only to USD-denominated countries; other currencies vary too widely in purchasing power
const ITEM_USD_MAX = { sugar: 8, salt: 5, rice: 6, pasta: 4, potatoes: 6, oil: 15, flour: 8, eggs: 12, milk: 8, bread: 8 };

// Pattern order matters: try currency-FIRST (e.g. "GBP 1.50") before number-first
// to avoid matching pack sizes / weights that precede a currency token (e.g. "12 SAR" in "eggs 12 SAR 8.99")
const PRICE_PATTERNS = [
  new RegExp(`(${CCY})\\s*(\\d+(?:\\.\\d{1,3})?)`, 'i'),  // CCY then number (preferred)
  new RegExp(`(\\d+(?:\\.\\d{1,3})?)\\s*(${CCY})`, 'i'),  // number then CCY (fallback — use last match)
];

function matchPrice(text, url) {
  // Pattern 0: currency-first — take the first match (safe, no ambiguity)
  const re0 = PRICE_PATTERNS[0];
  const m0 = text.match(re0);
  if (m0) {
    const price = parseFloat(m0[2]);
    const currency = m0[1].toUpperCase();
    const minPrice = CURRENCY_MIN[currency] ?? 0;
    if (price > minPrice && price < 100000) return { price, currency, source: url || '' };
  }
  // Pattern 1: number-first — collect ALL matches and take the LAST one to avoid
  // matching pack counts / weights (e.g. "12" in "eggs 12 pack SAR 8.99")
  const re1 = PRICE_PATTERNS[1];
  const allMatches = [...text.matchAll(new RegExp(re1.source, 'gi'))];
  if (allMatches.length) {
    for (const match of allMatches.reverse()) {
      const price = parseFloat(match[1]);
      const currency = match[2].toUpperCase();
      const minPrice = CURRENCY_MIN[currency] ?? 0;
      if (price > minPrice && price < 100000) return { price, currency, source: url || '' };
    }
  }
  // Fallback: currency symbols (£, €, ¥, ₹, ₩, ₦, R$)
  for (const [sym, iso] of Object.entries(SYMBOL_MAP)) {
    const re = new RegExp(`${sym.replace('$', '\\$')}\\s*(\\d+(?:[.,]\\d{1,3})?)`, 'i');
    const m = text.match(re);
    if (m) {
      const price = parseFloat(m[1].replace(',', '.'));
      const minPrice = CURRENCY_MIN[iso] ?? 0;
      if (price > minPrice && price < 100000) return { price, currency: iso, source: url || '' };
    }
  }
  return null;
}

function extractPrice(result, expectedCurrency) {
  const url = result.url || '';
  const summary = result?.summary;
  if (summary && typeof summary === 'string') {
    const hit = matchPrice(summary, url);
    if (hit && hit.currency !== expectedCurrency) {
      console.warn(`    [extractPrice] currency mismatch: got ${hit.currency}, expected ${expectedCurrency} — ${url}`);
      return null;
    }
    if (hit) return hit;
  }
  // Fallback: title
  const fromTitle = matchPrice(result.title || '', url);
  if (fromTitle && fromTitle.currency !== expectedCurrency) return null;
  return fromTitle;
}

async function fetchGroceryBasketPrices(prevSnapshot) {
  const fxRates = await fetchFxRates();

  const countriesResult = [];

  for (const country of config.countries) {
    console.log(`\n  Processing ${country.flag} ${country.name} (${country.currency})...`);
    const fxRate = fxRates[country.currency] || FX_FALLBACKS[country.currency] || null;

    // Process all items concurrently — 100ms stagger to respect EXA/Firecrawl rate limits
    const itemPrices = await Promise.all(config.items.map(async (item, idx) => {
      await sleep(idx * 200); // stagger starts — 200ms prevents EXA rate limit with 10 concurrent

      let localPrice = null;
      let sourceSite = '';

      let exaUrls = [];
      try {
        const exaResult = await searchExa(`${item.query} price`, country.sites, country.code);

        if (exaResult?.results?.length) {
          exaUrls = exaResult.results.map(r => r.url).filter(Boolean);
          for (const result of exaResult.results) {
            const extracted = extractPrice(result, country.currency);
            if (!extracted) continue;
            // Reject bulk/warehouse sizes by checking USD equivalent against per-item cap
            if (fxRate && ITEM_USD_MAX[item.id]) {
              const usdEquiv = extracted.price * fxRate;
              if (usdEquiv > ITEM_USD_MAX[item.id]) {
                console.warn(`    [bulk] ${item.id}: ${extracted.price} ${country.currency} ($${usdEquiv.toFixed(2)}) > max $${ITEM_USD_MAX[item.id]} — skipping`);
                continue;
              }
            }
            localPrice = extracted.price;
            sourceSite = extracted.source;
            break;
          }
        }
      } catch (err) {
        console.warn(`    [${country.code}/${item.id}] EXA error: ${err.message}`);
      }

      // Firecrawl fallback — renders JS-heavy SPAs (noon.com, coupang, shopee, etc.)
      if (localPrice === null && exaUrls.length > 0) {
        for (const url of exaUrls.slice(0, 2)) {
          const fc = await scrapeFirecrawl(url, country.currency);
          if (!fc) continue;
          // Apply same bulk cap to Firecrawl results
          if (fxRate && ITEM_USD_MAX[item.id]) {
            const usdEquiv = fc.price * fxRate;
            if (usdEquiv > ITEM_USD_MAX[item.id]) {
              console.warn(`    [FC bulk] ${item.id}: ${fc.price} ${country.currency} ($${usdEquiv.toFixed(2)}) > max — skipping`);
              continue;
            }
          }
          localPrice = fc.price;
          sourceSite = fc.source;
          console.log(`    [FC✓] ${item.id}: ${url.slice(0, 55)}`);
          break;
        }
      }

      const usdPrice = localPrice !== null && fxRate ? +(localPrice * fxRate).toFixed(4) : null;
      const status = localPrice !== null ? `${localPrice} ${country.currency} = $${usdPrice}` : 'N/A';
      console.log(`    ${item.id}: ${status}`);

      return {
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        localPrice: localPrice !== null ? +localPrice.toFixed(4) : null,
        usdPrice,
        currency: country.currency,
        sourceSite,
        available: localPrice !== null,
      };
    }));

    let totalUsd = 0;
    for (const ip of itemPrices) if (ip.usdPrice !== null) totalUsd += ip.usdPrice;

    countriesResult.push({
      code: country.code,
      name: country.name,
      currency: country.currency,
      flag: country.flag,
      totalUsd: +totalUsd.toFixed(2),
      fxRate: fxRate || 0,
      items: itemPrices,
    });
  }

  // Only rank countries with enough items found — a country with 4/10 items
  // could appear "cheapest" purely due to missing data, not actual prices.
  const MIN_ITEMS_FOR_RANKING = Math.ceil(config.items.length * 0.7); // ≥ 70% coverage
  const rankable = countriesResult.filter(c => {
    const found = c.items.filter(ip => ip.available).length;
    return c.totalUsd > 0 && found >= MIN_ITEMS_FOR_RANKING;
  });
  const cheapest = rankable.length ? rankable.reduce((a, b) => a.totalUsd < b.totalUsd ? a : b).code : '';
  const mostExpensive = rankable.length ? rankable.reduce((a, b) => a.totalUsd > b.totalUsd ? a : b).code : '';

  // Compute WoW per country
  const wowAvailable = prevSnapshot?.countries?.length > 0;
  if (wowAvailable) {
    const prevMap = Object.fromEntries(prevSnapshot.countries.map(c => [c.code, c.totalUsd]));
    for (const country of countriesResult) {
      if (country.totalUsd > 0 && prevMap[country.code] != null && prevMap[country.code] > 0) {
        country.wowPct = +((country.totalUsd - prevMap[country.code]) / prevMap[country.code] * 100).toFixed(2);
      } else {
        country.wowPct = null;
      }
    }
  }

  const wowCountries = wowAvailable ? countriesResult.filter(c => c.wowPct != null) : [];
  const wowAvgPct = wowCountries.length > 0
    ? +(wowCountries.reduce((s, c) => s + c.wowPct, 0) / wowCountries.length).toFixed(2)
    : 0;

  return {
    countries: countriesResult,
    fetchedAt: new Date().toISOString(),
    cheapestCountry: cheapest,
    mostExpensiveCountry: mostExpensive,
    wowAvgPct,
    wowAvailable,
    prevFetchedAt: wowAvailable ? (prevSnapshot.fetchedAt ?? '') : '',
  };
}

const prevSnapshot = await readCurrentSnapshot();

await runSeed('economic', 'grocery-basket', CANONICAL_KEY, () => fetchGroceryBasketPrices(prevSnapshot), {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => data?.countries?.length > 0,
  recordCount: (data) => data?.countries?.length || 0,
  extraKeys: prevSnapshot ? [{
    key: `${CANONICAL_KEY}:prev`,
    transform: () => prevSnapshot,  // write PRE-overwrite snapshot; ignore new data
    ttl: CACHE_TTL * 2,
  }] : undefined,
});
