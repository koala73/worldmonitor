#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, sleep, runSeed } from './_seed-utils.mjs';
import {
  buildBootstrapPools,
  predictionPoolCounts,
  validateBootstrapPayload,
} from './_prediction-classify.mjs';
import {
  isExcluded, parseYesPrice, parseKalshiYesPrice, parsePredictionMarketVolume,
  selectPricedKalshiMarket, isExpired,
} from './_prediction-scoring.mjs';
import { countCountryMarkets, projectCountryMarketIndex } from './_prediction-country-index.mjs';
import {
  fetchKalshiEvents as fetchKalshiEventPages,
  fetchPolymarketEventsByTag,
} from './_prediction-upstream.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import predictionTags from './data/prediction-tags.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'prediction:markets-bootstrap:v1';
const COUNTRY_INDEX_KEY = 'prediction:markets-country-index:v1';
const COUNTRY_INDEX_META_KEY = 'seed-meta:prediction:markets-country-index';
const COUNTRY_INDEX_ACTIVATION_KEY = 'seed-activated:prediction:markets-country-index';
const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval (gold standard: survive 5 missed runs)

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT = 10_000;
const TAG_DELAY_MS = 300;

const GEOPOLITICAL_TAGS = predictionTags.geopolitical;
const TECH_TAGS = predictionTags.tech;
const FINANCE_TAGS = predictionTags.finance;

async function fetchKalshiEvents() {
  try {
    let complete = true;
    const events = await fetchKalshiEventPages({
      baseUrl: KALSHI_BASE,
      userAgent: CHROME_UA,
      timeoutMs: FETCH_TIMEOUT,
      onPageError: (err, page) => {
        complete = false;
        console.warn(`  [kalshi] page ${page} failed; using earlier pages: ${err.message}`);
      },
    });
    return { events, complete };
  } catch (err) {
    console.warn(`  [kalshi] error fetching events: ${err.message}`);
    return { events: [], complete: false };
  }
}

function kalshiTitle(marketTitle, eventTitle) {
  if (!marketTitle) return eventTitle || '';
  if (marketTitle.includes('?') || marketTitle.length > 60) return marketTitle;
  if (!eventTitle || marketTitle === eventTitle) return marketTitle;
  return `${eventTitle}: ${marketTitle}`;
}

async function fetchKalshiMarkets() {
  const { events, complete } = await fetchKalshiEvents();
  const featured = [];
  const countryCandidates = [];

  for (const event of events) {
    if (!Array.isArray(event.markets) || event.markets.length === 0) continue;
    if (isExcluded(event.title)) continue;

    const binaryActive = event.markets.filter(
      m => m.market_type === 'binary' && m.status === 'active',
    );
    if (binaryActive.length === 0) continue;

    const selected = selectPricedKalshiMarket(binaryActive);
    if (!selected) continue;
    const { market: topMarket, yesPrice } = selected;

    const eventKey = `kalshi:${event.event_ticker || event.ticker || event.id || event.title}`;
    for (const market of binaryActive) {
      const candidatePrice = parseKalshiYesPrice(market);
      if (candidatePrice === null) continue;
      const marketTitle = market.yes_sub_title || market.title || '';
      countryCandidates.push({
        title: kalshiTitle(marketTitle, event.title),
        yesPrice: candidatePrice,
        volume: parseFloat(market.volume_fp) || 0,
        url: `https://kalshi.com/markets/${market.ticker}`,
        endDate: market.close_time ?? undefined,
        tags: [],
        source: 'kalshi',
        eventKey,
      });
    }

    const volume = parseFloat(topMarket.volume_fp) || 0;
    if (volume <= 5000) continue;

    const marketTitle = topMarket.yes_sub_title || topMarket.title || '';
    const title = kalshiTitle(marketTitle, event.title);

    featured.push({
      title,
      yesPrice,
      volume,
      url: `https://kalshi.com/markets/${topMarket.ticker}`,
      endDate: topMarket.close_time ?? undefined,
      tags: [],
      source: 'kalshi',
    });
  }

  return { featured, countryCandidates, complete };
}

async function fetchAllPredictions() {
  const allTags = [...new Set([...GEOPOLITICAL_TAGS, ...TECH_TAGS, ...FINANCE_TAGS])];
  const seen = new Set();
  const markets = [];
  const countryCandidates = [];
  let countryProjectionComplete = true;

  // Start Kalshi fetch early so it overlaps with Polymarket tag iterations
  const kalshiPromise = fetchKalshiMarkets();

  for (const tag of allTags) {
    try {
      const events = await fetchPolymarketEventsByTag(tag, {
        baseUrl: GAMMA_BASE,
        userAgent: CHROME_UA,
        timeoutMs: FETCH_TIMEOUT,
      });
      console.log(`  [${tag}] ${events.length} events`);

      for (const event of events) {
        if (event.closed || seen.has(event.id)) continue;
        seen.add(event.id);
        if (isExcluded(event.title)) continue;

        const eventVolume = event.volume ?? 0;
        if (eventVolume < 1000) continue;

        if (event.markets?.length > 0) {
          const active = event.markets.filter(m => !m.closed && !isExpired(m.endDate));
          if (active.length === 0) continue;

          const topMarket = active.reduce((best, m) => {
            const vol = parsePredictionMarketVolume(m);
            const bestVol = parsePredictionMarketVolume(best);
            return vol > bestVol ? m : best;
          });

          const yesPrice = parseYesPrice(topMarket);
          if (yesPrice === null) continue;

          const eventKey = `polymarket:${event.id}`;
          markets.push({
            title: topMarket.question || event.title,
            yesPrice,
            volume: eventVolume,
            url: `https://polymarket.com/event/${event.slug}`,
            endDate: topMarket.endDate ?? event.endDate ?? undefined,
            tags: (event.tags ?? []).map(t => t.slug),
            source: 'polymarket',
          });

          for (const market of active) {
            const candidatePrice = parseYesPrice(market);
            if (candidatePrice === null) continue;
            countryCandidates.push({
              title: market.question || event.title,
              yesPrice: candidatePrice,
              volume: parsePredictionMarketVolume(market),
              url: `https://polymarket.com/event/${event.slug}`,
              endDate: market.endDate ?? event.endDate ?? undefined,
              tags: (event.tags ?? []).map(t => t.slug),
              source: 'polymarket',
              eventKey,
            });
          }
        }
      }
    } catch (err) {
      countryProjectionComplete = false;
      console.warn(`  [${tag}] error: ${err.message}`);
    }
    await sleep(TAG_DELAY_MS);
  }

  // Await the Kalshi fetch that was started in parallel with tag iterations
  const kalshiMarkets = await kalshiPromise;
  if (!kalshiMarkets.complete) countryProjectionComplete = false;
  console.log(`  [kalshi] ${kalshiMarkets.featured.length} featured markets`);
  markets.push(...kalshiMarkets.featured);
  countryCandidates.push(...kalshiMarkets.countryCandidates);

  console.log(`  total raw markets: ${markets.length}`);

  // #5733: assign each market ONE primary category, then rank WITHIN that pool.
  // The pools used to be three independent filters over `markets` — with
  // `geopolitical` taking no filter at all, so it was a copy of everything, and
  // tech/finance overlapping on the economy/crypto/business tags. Partitioning
  // first is what makes the published labels mean something and stops the same
  // record being published three times. The whole pool-building path lives in
  // _prediction-classify.mjs so the tests exercise THIS wiring, not a replica of
  // it (this module can never be imported by a test — runSeed runs at import).
  const { pools, classified, duplicatesDropped } = buildBootstrapPools(markets);
  const countryMarkets = projectCountryMarketIndex(countryCandidates, {
    complete: countryProjectionComplete,
  });

  if (duplicatesDropped > 0) {
    console.log(`  deduped ${duplicatesDropped} same-identity record(s) before classification`);
  }
  console.log(
    `  classified: geopolitical ${classified.geopolitical}, tech ${classified.tech}, finance ${classified.finance}`
    + ` → published: ${pools.geopolitical.length}/${pools.tech.length}/${pools.finance.length}`,
  );
  if (countryProjectionComplete) {
    console.log(`  country index: ${Object.keys(countryMarkets).length} countries`);
  } else {
    console.warn('  country index: incomplete source fetch; skipping publish to retain last-good');
  }

  return {
    ...pools,
    countryMarkets,
    fetchedAt: Date.now(),
  };
}

export function declareRecords(data) {
  return (data?.geopolitical?.length || 0) + (data?.tech?.length || 0) + (data?.finance?.length || 0);
}

async function markCountryIndexActivated(data) {
  if (countCountryMarkets(data?.countryMarkets) === 0) return;
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', COUNTRY_INDEX_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: country-index activation marker write failed: ${err?.message || err}`);
  }
}

await runSeed('prediction', 'markets', CANONICAL_KEY, fetchAllPredictions, {
  ttlSeconds: CACHE_TTL,
  lockTtlMs: 60_000,
  // Population requirement + #5733 category-integrity gate. Lives in
  // _prediction-classify.mjs so the gate is unit-testable (this module runs
  // runSeed at import time, so a test can never import it).
  validateFn: validateBootstrapPayload,

  declareRecords,
  publishTransform: ({ countryMarkets: _countryMarkets, ...bootstrap }) => bootstrap,
  extraKeys: [{
    key: COUNTRY_INDEX_KEY,
    transform: (data) => ({ countries: data.countryMarkets, fetchedAt: data.fetchedAt }),
    declareRecords: (data) => countCountryMarkets(data?.countries),
    skipWhenEmpty: true,
    metaKey: COUNTRY_INDEX_META_KEY,
    metaCritical: true,
  }],
  afterPublish: async (data) => {
    await markCountryIndexActivated(data);
    return {
      freshnessMetaPatch: {
        poolCounts: predictionPoolCounts(data),
      },
    };
  },
  schemaVersion: 1,
  maxStaleMin: 90,
  sourceVersion: 'prediction-markets-v1',
});
