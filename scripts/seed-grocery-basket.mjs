#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep, readSeedSnapshot, bulkReadLearnedRoutes, bulkWriteLearnedRoutes, isAllowedRouteHost, processItemRoute, getSharedFxRates, SHARED_FX_FALLBACKS } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const config = loadSharedConfig('grocery-basket.json');

const CANONICAL_KEY = 'economic:grocery-basket:v1';
const CACHE_TTL = 864000; // 10 days — weekly seed with 3-day cron-drift buffer
// Bump when basket composition changes materially — invalidates WoW until a new baseline runs.
const BASKET_VERSION = 2; // v2: oil changed from sunflower to canola
const EXA_DELAY_MS = 150;

const FIRECRAWL_DELAY_MS = 500;

const FX_FALLBACKS = SHARED_FX_FALLBACKS;


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

// Fast learned-route replay: direct fetch + matchPrice + same guardrails as EXA/Firecrawl paths.
// Inline (not in _seed-utils) because it closes over CURRENCY_MIN, ITEM_USD_MAX, matchPrice.
async function tryDirectFetch(url, expectedCurrency, itemId, fxRate) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    const hit = matchPrice(text.slice(0, 10_000), url);
    if (!hit || hit.currency !== expectedCurrency) return null;
    const minPrice = CURRENCY_MIN[expectedCurrency] ?? 0;
    if (hit.price <= minPrice || hit.price >= 100_000) return null;
    if (fxRate && ITEM_USD_MAX[itemId] && hit.price * fxRate > ITEM_USD_MAX[itemId]) {
      console.warn(`    [learned bulk] ${itemId}: ${hit.price} ${expectedCurrency} ($${(hit.price * fxRate).toFixed(2)}) > max — skipping`);
      return null;
    }
    return hit.price;
  } catch {
    return null;
  }
}

// All supported currency codes — keep in sync with grocery-basket.json fxSymbols
const CCY = 'USD|GBP|EUR|JPY|CNY|INR|AUD|CAD|BRL|MXN|ZAR|TRY|NGN|KRW|SGD|PKR|AED|SAR|QAR|KWD|BHD|OMR|EGP|JOD|LBP|KES|ARS|IDR|PHP';

// Currency symbol → ISO code map for sites that use symbols instead of ISO codes
const SYMBOL_MAP = { '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₩': 'KRW', '₹': 'INR', '₦': 'NGN', 'R$': 'BRL' };

// Minimum plausible local price per currency — prevents matching product codes / IDs
// e.g. IDR 4 = $0.0003 (nonsense), NGN 20 = $0.01 (nonsense), KRW 5 = $0.004 (nonsense)
// JPY: grocery items in Japan cost 100+ yen; under 50 = product code or sub-unit price.
// TRY: Turkish supermarket shelf prices ≥ 10 TRY; under 10 = per-100g sub-unit match.
// EGP: Egyptian supermarket prices ≥ 5 EGP; under 5 = subsidised/fractional unit.
// INR: Indian supermarket prices ≥ 12 INR; under 12 = product code or stale clearance.
const CURRENCY_MIN = { NGN: 50, IDR: 500, ARS: 50, KRW: 1000, ZAR: 2, PKR: 20, LBP: 1000, JPY: 50, TRY: 10, EGP: 5, INR: 12 };

// Maximum plausible USD price per item — catches bulk/wholesale/specialty products.
// Set to ~2× the most expensive legitimate retail price globally for each item.
// Previous caps were too loose (e.g. sugar: 8 allowed 5.99 EUR organic sugar from carrefour.fr).
const ITEM_USD_MAX = { sugar: 3.5, salt: 2.5, rice: 6, pasta: 3.5, potatoes: 6, oil: 10, flour: 4.5, eggs: 12, milk: 5, bread: 6 };

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
  const fxRates = await getSharedFxRates(config.fxSymbols, FX_FALLBACKS);

  const countriesResult = [];

  // Load all learned routes in one pipeline request before the country loop.
  // Include sentinel keys for one-time migrations so each eviction only fires once.
  const OIL_MIGRATION_KEY = '_migration:canola-oil-v1';
  const BAD_PRICES_KEY    = '_migration:bad-prices-v1'; // JP/TR/EG/IN sub-unit scrapes + JP site change
  const routeKeys = [...config.countries.flatMap(c => config.items.map(i => `${c.code}:${i.id}`)), OIL_MIGRATION_KEY, BAD_PRICES_KEY];
  const learnedRoutes = await bulkReadLearnedRoutes('grocery-basket', routeKeys).catch((err) => {
    console.warn(`  [routes] load failed (non-fatal): ${err.message}`);
    return new Map();
  });
  const routeUpdates = new Map();
  const routeDeletes = new Set();
  console.log(`  [routes] loaded ${learnedRoutes.size} learned routes`);

  // One-time migration: evict stale oil routes when query changed sunflower → canola.
  // Guarded by OIL_MIGRATION_KEY so it only fires once; subsequent runs skip entirely.
  if (!learnedRoutes.has(OIL_MIGRATION_KEY)) {
    const oilEvictions = new Set(config.countries.map(c => `${c.code}:oil`).filter(k => learnedRoutes.has(k)));
    if (oilEvictions.size > 0) {
      console.log(`  [routes] one-time migration: evicting ${oilEvictions.size} stale oil routes (sunflower → canola)`);
      await bulkWriteLearnedRoutes('grocery-basket', new Map(), oilEvictions).catch(err =>
        console.warn(`  [routes] oil eviction failed (non-fatal): ${err.message}`)
      );
      for (const k of oilEvictions) learnedRoutes.delete(k);
    }
    routeUpdates.set(OIL_MIGRATION_KEY, 'done'); // persisted at end of run alongside other route updates
  }

  // One-time eviction: clear known-bad routes from the previous site config (JP) and
  // from confirmed sub-unit price scrapes (TR/EG/IN). Forces fresh EXA searches on next run.
  // All JP routes evicted because sites changed from aggregators (kakaku.com) to supermarkets.
  if (!learnedRoutes.has(BAD_PRICES_KEY)) {
    const knownBad = new Set([
      ...config.countries.filter(c => c.code === 'JP').flatMap(c => config.items.map(i => `JP:${i.id}`)),
      'TR:sugar', 'TR:eggs', 'TR:milk', 'TR:oil',
      'EG:salt', 'EG:bread', 'EG:milk',
      'IN:potatoes', 'IN:milk',
    ].filter(k => learnedRoutes.has(k)));
    if (knownBad.size > 0) {
      console.log(`  [routes] one-time eviction: clearing ${knownBad.size} known-bad price routes (JP sites + TR/EG/IN sub-unit)`);
      await bulkWriteLearnedRoutes('grocery-basket', new Map(), knownBad).catch(err =>
        console.warn(`  [routes] bad-prices eviction failed (non-fatal): ${err.message}`)
      );
      for (const k of knownBad) learnedRoutes.delete(k);
    }
    routeUpdates.set(BAD_PRICES_KEY, 'done');
  }

  for (const country of config.countries) {
    console.log(`\n  Processing ${country.flag} ${country.name} (${country.currency})...`);
    const fxRate = fxRates[country.currency] || FX_FALLBACKS[country.currency] || null;
    const allowedHosts = country.sites.map(s => s.replace(/^www\./, '').split('/')[0]);

    // Process all items concurrently — 100ms stagger to respect EXA/Firecrawl rate limits
    const itemPrices = await Promise.all(config.items.map(async (item, idx) => {
      await sleep(idx * 200); // stagger starts — 200ms prevents EXA rate limit with 10 concurrent

      const routeKey = `${country.code}:${item.id}`;
      const learned = learnedRoutes.get(routeKey);

      // --- Learned route fast path + EXA fallback ---
      const { localPrice, sourceSite, routeUpdate, routeDelete } = await processItemRoute({
        learned,
        allowedHosts,
        currency: country.currency,
        itemId: item.id,
        fxRate,
        itemUsdMax: ITEM_USD_MAX[item.id] || null,
        tryDirectFetch,
        scrapeFirecrawl,
        fetchViaExa: async () => {
          let exaPrice = null;
          let exaSite = '';
          let exaUrls = [];
          try {
            const exaResult = await searchExa(`${item.query} price`, country.sites, country.code);
            if (exaResult?.results?.length) {
              exaUrls = exaResult.results.map(r => r.url).filter(Boolean);
              for (const result of exaResult.results) {
                const extracted = extractPrice(result, country.currency);
                if (!extracted) continue;
                if (fxRate && ITEM_USD_MAX[item.id]) {
                  const usdEquiv = extracted.price * fxRate;
                  if (usdEquiv > ITEM_USD_MAX[item.id]) {
                    console.warn(`    [bulk] ${item.id}: ${extracted.price} ${country.currency} ($${usdEquiv.toFixed(2)}) > max $${ITEM_USD_MAX[item.id]} — skipping`);
                    continue;
                  }
                }
                exaPrice = extracted.price;
                exaSite = extracted.source;
                break;
              }
            }
          } catch (err) {
            console.warn(`    [${country.code}/${item.id}] EXA error: ${err.message}`);
          }
          // Firecrawl fallback for EXA-discovered URLs (handles JS-heavy SPAs)
          if (exaPrice === null && exaUrls.length > 0) {
            for (const url of exaUrls.slice(0, 2)) {
              const fc = await scrapeFirecrawl(url, country.currency);
              if (!fc) continue;
              if (fxRate && ITEM_USD_MAX[item.id]) {
                const usdEquiv = fc.price * fxRate;
                if (usdEquiv > ITEM_USD_MAX[item.id]) {
                  console.warn(`    [FC bulk] ${item.id}: ${fc.price} ${country.currency} ($${usdEquiv.toFixed(2)}) > max — skipping`);
                  continue;
                }
              }
              exaPrice = fc.price;
              exaSite = fc.source;
              console.log(`    [FC✓] ${item.id}: ${url.slice(0, 55)}`);
              break;
            }
          }
          return exaPrice !== null ? { localPrice: exaPrice, sourceSite: exaSite } : null;
        },
        sleep,
        firecrawlDelayMs: FIRECRAWL_DELAY_MS,
      });

      if (routeDelete) routeDeletes.add(routeKey);
      if (routeUpdate) routeUpdates.set(routeKey, routeUpdate);

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

  // Persist learned routes for next run (non-fatal)
  await bulkWriteLearnedRoutes('grocery-basket', routeUpdates, routeDeletes).catch(err =>
    console.warn(`  [routes] write failed (non-fatal): ${err.message}`)
  );

  // Cross-country outlier gate — bilateral: rejects per-item prices that are either
  //   > 4× the median (bulk/wholesale/specialty scrape error)
  //   < ¼ the median (sub-unit price, product code, stale scraped value)
  // Both directions evict the learned route so the bad URL isn't replayed next seed.
  const itemIds = config.items.map(i => i.id);
  const outlierEvictions = new Set();
  for (const itemId of itemIds) {
    const pricePoints = countriesResult
      .map(c => c.items.find(i => i.itemId === itemId)?.usdPrice)
      .filter(p => p != null && p > 0);
    if (pricePoints.length < 3) continue; // need ≥ 3 data points for meaningful median
    pricePoints.sort((a, b) => a - b);
    const median = pricePoints[Math.floor(pricePoints.length / 2)];
    const ceiling = median * 4;
    const floor = median / 4;
    for (const country of countriesResult) {
      const item = country.items.find(i => i.itemId === itemId);
      if (!item?.usdPrice || item.usdPrice <= 0) continue;
      const isHigh = item.usdPrice > ceiling;
      const isLow  = item.usdPrice < floor;
      if (!isHigh && !isLow) continue;
      const reason = isHigh
        ? `$${item.usdPrice.toFixed(4)} > 4× median $${median.toFixed(2)}`
        : `$${item.usdPrice.toFixed(4)} < ¼ median $${median.toFixed(2)}`;
      console.warn(`  [outlier] ${country.code}/${itemId}: ${reason} — clearing + evicting learned route`);
      item.available = false;
      item.localPrice = null;
      item.usdPrice = null;
      outlierEvictions.add(`${country.code}:${itemId}`);
    }
  }
  if (outlierEvictions.size > 0) {
    await bulkWriteLearnedRoutes('grocery-basket', new Map(), outlierEvictions).catch(err =>
      console.warn(`  [routes] outlier eviction write failed (non-fatal): ${err.message}`)
    );
  }
  // Recompute totals after outlier pass
  for (const country of countriesResult) {
    country.totalUsd = +country.items.reduce((s, ip) => s + (ip.usdPrice ?? 0), 0).toFixed(2);
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

  // Compute WoW per country — only valid when prev snapshot used the same basket composition.
  // A version mismatch (e.g. oil changed from sunflower to canola) would produce bogus deltas.
  const wowAvailable = prevSnapshot?.countries?.length > 0 && prevSnapshot.basketVersion === BASKET_VERSION;
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
    basketVersion: BASKET_VERSION,
  };
}

const prevSnapshot = await readSeedSnapshot(CANONICAL_KEY);

await runSeed('economic', 'grocery-basket', CANONICAL_KEY, () => fetchGroceryBasketPrices(prevSnapshot), {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => {
    if (!data?.countries?.length) return false;
    const minItems = Math.ceil(config.items.length * 0.4); // 40% item coverage per country
    const covered = data.countries.filter(c => c.items.filter(i => i.available).length >= minItems);
    if (covered.length < 5) { console.warn(`  [validate] only ${covered.length} countries with ≥40% item coverage — rejecting`); return false; }
    return true;
  },
  recordCount: (data) => data?.countries?.length || 0,
  extraKeys: prevSnapshot ? [{
    key: `${CANONICAL_KEY}:prev`,
    transform: () => prevSnapshot,  // write PRE-overwrite snapshot; ignore new data
    ttl: CACHE_TTL * 2,
  }] : undefined,
});
