#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep, readSeedSnapshot, writeExtraKey, bulkReadLearnedRoutes, bulkWriteLearnedRoutes, isAllowedRouteHost, processItemRoute, getSharedFxRates, SHARED_FX_FALLBACKS, allSettledWithConcurrency } from './_seed-utils.mjs';

const config = loadSharedConfig('grocery-basket.json');
export const COUNTRIES = config.countries;

// Countries processed at once (each runs its 10 items concurrently, so up to 40
// Firecrawl/EXA calls in flight; the Firecrawl plan allows 100). See fetchGroceryBasketPrices.
export const COUNTRY_CONCURRENCY = 4;

const CANONICAL_KEY = 'economic:grocery-basket:v1';
const CACHE_TTL = 864000; // 10 days — weekly seed with 3-day cron-drift buffer
// Bump when basket composition changes materially — invalidates WoW until a new baseline runs.
const BASKET_VERSION = 3; // v3: verified offers normalized to basket quantities

const FIRECRAWL_DELAY_MS = 500;

const FX_FALLBACKS = SHARED_FX_FALLBACKS;


const UNIT_FACTORS = {
  g: ['mass', 1], kg: ['mass', 1000], lb: ['mass', 453.59237], oz: ['mass', 28.349523125],
  ml: ['volume', 1], l: ['volume', 1000], us_fl_oz: ['volume', 29.5735295625], us_qt: ['volume', 946.352946],
  pc: ['count', 1],
};

const STAPLES = {
  sugar: 'plain white granulated sugar',
  salt: 'fine table or cooking salt',
  rice: 'plain dry white rice, excluding glutinous or prepared rice',
  pasta: 'plain dry spaghetti',
  potatoes: 'fresh raw potatoes, excluding sweet potatoes and processed potato products',
  oil: 'pure canola or rapeseed oil, excluding blended oils',
  flour: 'plain all-purpose wheat flour',
  eggs: 'fresh whole chicken eggs in the shell',
  milk: 'plain whole or full-cream dairy milk, excluding powdered and flavored milk',
  bread: 'plain white bread sold as a loaf',
};

const OFFER_SCHEMA = {
  type: 'object',
  properties: {
    offerEvidence: { type: 'string', description: 'Briefly identify the main product, what the price covers, and whether the page offers it for sale.' },
    productName: { type: 'string' },
    price: { type: 'number' },
    currency: { type: 'string' },
    quantity: { type: 'number' },
    unit: { type: 'string', enum: Object.keys(UNIT_FACTORS) },
    matchesStaple: { type: 'boolean', description: 'True when the main product is the requested staple and has a price and quantity for the same available offer.' },
  },
  required: ['offerEvidence', 'productName', 'price', 'currency', 'quantity', 'unit', 'matchesStaple'],
};

function offerPrompt(item, currency) {
  return `Extract the main product's available retail offer for ${STAPLES[item.id]}.
Use offerEvidence to explain which price and quantity belong to the main product.
Set matchesStaple to true when this is a product page and the main product matches the staple,
is offered for sale, and displays both its price and quantity. A shelf price beside an Add to
cart or Add to trolley control is an offer, even if the page also shows a reference unit price.
Copy the main productName, the shelf price for the entire pack and its ISO currency code
(expected ${currency}). Use the retailer's displayed country to interpret local currency symbols.
Return the total quantity covered by that exact price, including all pieces in a multipack.
Use pc for the number of eggs. For loose fresh potatoes, a price quoted per kg or lb is valid.
Set matchesStaple to false on category, search and review pages, for a different or unavailable
product, or when only a member price, reference price or related product's price is shown.
Only use units in the schema. Never guess a quantity or combine details from different offers.`;
}

function offerNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return Number(value);
  return NaN;
}

function normalizeOffer(offer, item, currency, fxRate) {
  if (offer?.matchesStaple !== true || typeof offer.productName !== 'string' || !offer.productName.trim()) return null;
  if (typeof offer.offerEvidence !== 'string' || !offer.offerEvidence.trim()) return null;
  if (typeof offer.currency !== 'string' || offer.currency.trim().toUpperCase() !== currency) return null;
  const packPrice = offerNumber(offer.price);
  const packQuantity = offerNumber(offer.quantity);
  if (!Number.isFinite(packPrice) || packPrice <= 0 || !Number.isFinite(packQuantity) || packQuantity <= 0) return null;
  const offerUnit = typeof offer.unit === 'string' ? offer.unit.trim().toLowerCase() : '';
  const source = Object.hasOwn(UNIT_FACTORS, offerUnit) ? UNIT_FACTORS[offerUnit] : null;
  const [, quantity, unit] = /^(\d+)([a-z]+)$/i.exec(item.unit);
  const [dimension, factor] = UNIT_FACTORS[unit.toLowerCase()];
  if (source?.[0] !== dimension || (dimension === 'count' && !Number.isInteger(packQuantity))) return null;
  const basketUnits = packQuantity * source[1] / (Number(quantity) * factor);
  if (basketUnits > MAX_OFFER_BASKET_UNITS) return null;
  const price = packPrice / basketUnits;
  if (!Number.isFinite(price) || price <= (CURRENCY_MIN[currency] ?? 0)) return null;
  const usdPrice = price * fxRate;
  if (fxRate && (usdPrice < MIN_ITEM_USD_PRICE || usdPrice > ITEM_USD_MAX[item.id])) return null;
  return price;
}

async function searchExa(item, country) {
  const apiKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
  if (!apiKey) throw new Error('EXA_API_KEYS or EXA_API_KEY not set');

  const body = {
    query: `${item.query} price`,
    numResults: 5,
    type: 'auto',
    // Restrict to known local supermarket/retailer domains per country — prevents EXA
    // neural search from returning USD-priced global comparison pages (Numbeo, Tridge, etc.)
    includeDomains: country.sites,
    // Bias results toward the target country's web
    userLocation: country.code,
    contents: {
      summary: { query: offerPrompt(item, country.currency), schema: OFFER_SCHEMA },
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
async function scrapeFirecrawl(url, item, currency, fxRate) {
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
        extract: { prompt: offerPrompt(item, currency), schema: OFFER_SCHEMA },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(`    [Firecrawl] ${resp.status}: ${txt.slice(0, 80)}`);
      return null;
    }
    const data = await resp.json();
    const price = normalizeOffer(data?.data?.extract, item, currency, fxRate);
    return price === null ? null : { price, source: url };
  } catch (err) {
    console.warn(`    [Firecrawl] error: ${err.message}`);
    return null;
  }
}

// Minimum plausible local price per currency — prevents matching product codes / IDs
// e.g. IDR 4 = $0.0003 (nonsense), NGN 20 = $0.01 (nonsense), KRW 5 = $0.004 (nonsense)
// JPY: grocery items in Japan cost 100+ yen; under 50 = product code or sub-unit price.
// TRY: Turkish supermarket shelf prices ≥ 10 TRY; under 10 = per-100g sub-unit match.
// EGP: Egyptian supermarket prices ≥ 5 EGP; under 5 = subsidised/fractional unit.
// INR: Indian supermarket prices ≥ 12 INR; under 12 = product code or stale clearance.
const CURRENCY_MIN = { NGN: 50, IDR: 500, ARS: 50, KRW: 1000, ZAR: 2, PKR: 20, LBP: 1000, JPY: 50, TRY: 10, EGP: 5, INR: 12 };

// Bound retail pack sizes in basket units across all supported source units.
const MAX_OFFER_BASKET_UNITS = 100;
const MIN_ITEM_USD_PRICE = 0.01;

// Maximum plausible USD price per item — catches bulk/wholesale/specialty products.
// Set to ~2× the most expensive legitimate retail price globally for each item.
// Previous caps were too loose (e.g. sugar: 8 allowed 5.99 EUR organic sugar from carrefour.fr).
const ITEM_USD_MAX = { sugar: 3.5, salt: 2.5, rice: 6, pasta: 3.5, potatoes: 6, oil: 10, flour: 4.5, eggs: 12, milk: 5, bread: 6 };

// Prices one country's basket. Items run concurrently; learned-route updates and
// evictions are recorded into the shared maps (keys are per-country, so concurrent
// countries never collide).
export async function fetchCountryItems(country, { fxRate, learnedRoutes, routeUpdates, routeDeletes, processItemRouteFn = processItemRoute }) {
  console.log(`\n  Processing ${country.flag} ${country.name} (${country.currency})...`);
  const allowedHosts = country.sites.map(s => s.replace(/^www\./, '').split('/')[0]);

  // Process all items concurrently — 100ms stagger to respect EXA/Firecrawl rate limits
  const settled = await Promise.allSettled(config.items.map(async (item, idx) => {
    await sleep(idx * 200); // stagger starts — 200ms prevents EXA rate limit with 10 concurrent

    const routeKey = `${country.code}:${item.id}`;
    const learned = learnedRoutes.get(routeKey);

    // --- Learned route fast path + EXA fallback ---
    const { localPrice, sourceSite, routeUpdate, routeDelete } = await processItemRouteFn({
      learned,
      allowedHosts,
      currency: country.currency,
      itemId: item.id,
      fxRate,
      itemUsdMax: ITEM_USD_MAX[item.id] || null,
      // A raw HTML price has no reliable association with an offer or quantity.
      tryDirectFetch: async () => null,
      scrapeFirecrawl: (url) => scrapeFirecrawl(url, item, country.currency, fxRate),
      fetchViaExa: async () => {
        const urls = [];
        try {
          const result = await searchExa(item, country);
          for (const entry of result?.results ?? []) {
            if (!isAllowedRouteHost(entry.url, allowedHosts)) continue;
            urls.push(entry.url);
            let offer;
            try { offer = JSON.parse(entry.summary); } catch { continue; }
            const price = normalizeOffer(offer, item, country.currency, fxRate);
            if (price !== null) return { localPrice: price, sourceSite: entry.url };
          }
        } catch (err) {
          console.warn(`    [${country.code}/${item.id}] EXA error: ${err.message}`);
        }
        for (const url of urls.slice(0, 2)) {
          const offer = await scrapeFirecrawl(url, item, country.currency, fxRate);
          if (offer) return { localPrice: offer.price, sourceSite: offer.source };
        }
        return null;
      },
      sleep,
      firecrawlDelayMs: FIRECRAWL_DELAY_MS,
    });

    if (routeDelete) routeDeletes.add(routeKey);
    if (routeUpdate) routeUpdates.set(routeKey, routeUpdate);

    const usdPrice = localPrice !== null && fxRate ? +(localPrice * fxRate).toFixed(4) : null;
    const status = localPrice !== null ? `${localPrice} ${country.currency} = $${usdPrice}` : 'N/A';
    // Country-prefixed: countries run concurrently, so their item lines interleave.
    console.log(`    [${country.code}] ${item.id}: ${status}`);

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

  // allSettled, not all: a throwing item must not release this country's
  // concurrency slot while its siblings are still calling Firecrawl/EXA and
  // recording route changes. Only the throwing item degrades.
  return settled.map((s, idx) => {
    if (s.status === 'fulfilled') return s.value;
    const item = config.items[idx];
    console.warn(`    [${country.code}] ${item.id}: failed: ${s.reason?.message || s.reason}`);
    return unavailableItem(item, country);
  });
}

function unavailableItem(item, country) {
  return {
    itemId: item.id,
    itemName: item.name,
    unit: item.unit,
    localPrice: null,
    usdPrice: null,
    currency: country.currency,
    sourceSite: '',
    available: false,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// The six-hourly cron runs at fixed clock times, so a basket from exactly a week ago normally exists.
// The slack keeps a comparison when a run near that time failed.
const BASELINE_TOLERANCE_MS = DAY_MS / 2;
const HISTORY_RETENTION_MS = WEEK_MS + 2 * DAY_MS;

export function recordBaseline(entries, snapshot) {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const totals = Object.fromEntries(snapshot.countries
    .filter(country => hasFullBasket(country.items))
    .map(country => [country.code, basketTotal(country.items)]));
  return [
    ...entries.filter(entry => {
      const at = Date.parse(entry.fetchedAt);
      return at !== fetchedAt && fetchedAt - at <= HISTORY_RETENTION_MS;
    }),
    { fetchedAt: snapshot.fetchedAt, basketVersion: snapshot.basketVersion, totals },
  ].sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
}

export function selectWeekAgo(entries, now) {
  const target = now.getTime() - WEEK_MS;
  const distance = entry => Math.abs(Date.parse(entry.fetchedAt) - target);
  return entries
    .filter(entry => entry.basketVersion === BASKET_VERSION && distance(entry) <= BASELINE_TOLERANCE_MS)
    .sort((a, b) => distance(a) - distance(b))[0];
}

function hasFullBasket(items) {
  return items?.length === config.items.length && config.items.every(({ id, unit }) =>
    items.some(item => item.itemId === id && item.unit === unit && item.available &&
      Number.isFinite(item.usdPrice) && item.usdPrice > 0)
  );
}

function basketTotal(items) {
  // Sum displayed cents so the country total agrees with the individual prices.
  return items.reduce((total, item) =>
    total + (item.available && item.usdPrice > 0 ? Math.round(Number(item.usdPrice.toFixed(2)) * 100) : 0), 0
  ) / 100;
}

export async function fetchGroceryBasketPrices(baseline, {
  now = new Date(),
  fetchCountryItemsFn = fetchCountryItems,
  getFxRatesFn = getSharedFxRates,
  routes = { read: bulkReadLearnedRoutes, write: bulkWriteLearnedRoutes },
  concurrency = COUNTRY_CONCURRENCY,
} = {}) {
  const fxRates = await getFxRatesFn(config.fxSymbols, FX_FALLBACKS);

  // Load all learned routes in one pipeline request before the country loop.
  // Include sentinel keys for one-time migrations so each eviction only fires once.
  const OIL_MIGRATION_KEY = '_migration:canola-oil-v1';
  const BAD_PRICES_KEY    = '_migration:bad-prices-v1'; // JP/TR/EG/IN sub-unit scrapes + JP site change
  const routeKeys = [...config.countries.flatMap(c => config.items.map(i => `${c.code}:${i.id}`)), OIL_MIGRATION_KEY, BAD_PRICES_KEY];
  const learnedRoutes = await routes.read('grocery-basket', routeKeys).catch((err) => {
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
      await routes.write('grocery-basket', new Map(), oilEvictions).catch(err =>
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
      await routes.write('grocery-basket', new Map(), knownBad).catch(err =>
        console.warn(`  [routes] bad-prices eviction failed (non-fatal): ${err.message}`)
      );
      for (const k of knownBad) learnedRoutes.delete(k);
    }
    routeUpdates.set(BAD_PRICES_KEY, 'done');
  }

  // Countries run with BOUNDED CONCURRENCY. Serially, 24 countries at ~42s each
  // (learned-route Firecrawl scrapes, 30s timeouts) took ~1000s and tripped the
  // 840s fetch-phase deadline at country 21 — a weekly exit-75 "Deploy Crashed!".
  // At 4 in flight the worst case is ⌈24/4⌉ = 6 waves × ~115s per-country
  // critical path (30s Firecrawl + 15s EXA + 2×30s Firecrawl) ≈ 630s.
  const settled = await allSettledWithConcurrency(config.countries, concurrency, (country) => {
    const fxRate = fxRates[country.currency] || FX_FALLBACKS[country.currency] || null;
    return fetchCountryItemsFn(country, { fxRate, learnedRoutes, routeUpdates, routeDeletes });
  });

  const countriesResult = config.countries.map((country, i) => {
    const fxRate = fxRates[country.currency] || FX_FALLBACKS[country.currency] || null;
    let itemPrices = settled[i].status === 'fulfilled' ? settled[i].value : null;
    if (!itemPrices) {
      console.warn(`    [${country.code}] processing failed: ${settled[i].reason?.message || settled[i].reason}`);
      itemPrices = config.items.map(item => unavailableItem(item, country));
    }

    return {
      code: country.code,
      name: country.name,
      currency: country.currency,
      flag: country.flag,
      totalUsd: 0,
      wowPct: null,
      fxRate: fxRate || 0,
      items: itemPrices,
    };
  });

  // Persist learned routes for next run (non-fatal)
  await routes.write('grocery-basket', routeUpdates, routeDeletes).catch(err =>
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
    await routes.write('grocery-basket', new Map(), outlierEvictions).catch(err =>
      console.warn(`  [routes] outlier eviction write failed (non-fatal): ${err.message}`)
    );
  }
  const rankable = [];
  for (const country of countriesResult) {
    country.totalUsd = basketTotal(country.items);
    if (!hasFullBasket(country.items)) continue;
    rankable.push(country);
    const priorTotal = baseline?.totals[country.code];
    if (priorTotal > 0) {
      country.wowPct = +((country.totalUsd - priorTotal) / priorTotal * 100).toFixed(2);
    }
  }
  rankable.sort((a, b) => a.totalUsd - b.totalUsd);
  const wowCountries = rankable.filter(country => country.wowPct !== null);
  const wowAvailable = wowCountries.length > 0;
  const wowAvgPct = wowCountries.length > 0
    ? +(wowCountries.reduce((s, c) => s + c.wowPct, 0) / wowCountries.length).toFixed(2)
    : 0;

  return {
    countries: countriesResult,
    fetchedAt: now.toISOString(),
    cheapestCountry: rankable[0]?.code ?? '',
    mostExpensiveCountry: rankable.at(-1)?.code ?? '',
    wowAvgPct,
    wowAvailable,
    prevFetchedAt: wowAvailable ? baseline.fetchedAt : '',
    basketVersion: BASKET_VERSION,
  };
}

export function declareRecords(data) {
  return Array.isArray(data?.countries) ? data.countries.length : 0;
}

// Only run the seed when invoked directly (`node seed-grocery-basket.mjs`), not when
// imported by a test — matches the repo-wide seeder main-guard idiom.
const isMain = process.argv[1]?.endsWith('seed-grocery-basket.mjs');
if (isMain) {
  loadEnvFile(import.meta.url);
  const historyKey = `${CANONICAL_KEY}:history`;
  let history;

  await runSeed('economic', 'grocery-basket', CANONICAL_KEY, async () => {
    const stored = await readSeedSnapshot(historyKey, { strict: true });
    history = Array.isArray(stored?.entries) ? stored.entries : [];
    const now = new Date();
    return fetchGroceryBasketPrices(selectWeekAgo(history, now), { now });
  }, {
    ttlSeconds: CACHE_TTL,
    // Countries run COUNTRY_CONCURRENCY at a time (items within a country run
    // concurrently). Every fetch is individually bounded (15/30s AbortSignal.timeout),
    // so the worst case is ~630s (see fetchGroceryBasketPrices) — over the default
    // 240s fetch-phase deadline (lockTtlMs 120s + 120s margin, issue #4864). Size
    // lockTtlMs to that worst case so the deadline (lockTtlMs + 120s = 14min) is a
    // genuine-hang backstop and the lock outlives the run.
    lockTtlMs: 720_000, // 12min

    validateFn: (data) => {
      if (!data?.countries?.length) return false;
      const minItems = Math.ceil(config.items.length * 0.4); // 40% item coverage per country
      const covered = data.countries.filter(c => c.items.filter(i => i.available).length >= minItems);
      if (covered.length < 5) { console.warn(`  [validate] only ${covered.length} countries with ≥40% item coverage — rejecting`); return false; }
      return true;
    },
    recordCount: (data) => data?.countries?.length || 0,
    beforePublish: async (data, { lockFence }) => {
      await writeExtraKey(historyKey, { entries: recordBaseline(history, data) }, CACHE_TTL, undefined, { lockFence });
    },

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 10080,
    sourceVersion: 'grocery-basket-v1',
  });
}
