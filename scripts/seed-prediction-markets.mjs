#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, sleep, runSeed } from './_seed-utils.mjs';
import {
  isExcluded, isMemeCandidate, tagRegions, parseYesPrice,
  shouldInclude, scoreMarket, filterAndScore, isExpired,
} from './_prediction-scoring.mjs';
import predictionTags from './data/prediction-tags.json' with { type: 'json' };

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'prediction:markets-bootstrap:v1';
const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval (gold standard: survive 5 missed runs)

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT = 10_000;
const TAG_DELAY_MS = 300;

const GEOPOLITICAL_TAGS = predictionTags.geopolitical;
const TECH_TAGS = predictionTags.tech;
const FINANCE_TAGS = predictionTags.finance;

async function fetchEventsByTag(tag, limit = 20) {
  const params = new URLSearchParams({
    tag_slug: tag,
    closed: 'false',
    active: 'true',
    archived: 'false',
    end_date_min: new Date().toISOString(),
    order: 'volume',
    ascending: 'false',
    limit: String(limit),
  });

  const resp = await fetch(`${GAMMA_BASE}/events?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!resp.ok) {
    console.warn(`  [${tag}] HTTP ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

async function fetchKalshiEvents() {
  try {
    const params = new URLSearchParams({
      status: 'open',
      with_nested_markets: 'true',
      limit: '100',
    });
    const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
    const resp = await fetch(`${KALSHI_BASE}/events?${params}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      console.warn(`  [kalshi] HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data?.events) ? data.events : [];
  } catch (err) {
    console.warn(`  [kalshi] error fetching events: ${err.message}`);
    return [];
  }
}

function kalshiTitle(marketTitle, eventTitle) {
  if (!marketTitle) return eventTitle || '';
  if (marketTitle.includes('?') || marketTitle.length > 60) return marketTitle;
  if (!eventTitle || marketTitle === eventTitle) return marketTitle;
  return `${eventTitle}: ${marketTitle}`;
}

async function fetchKalshiMarkets() {
  const events = await fetchKalshiEvents();
  const results = [];

  for (const event of events) {
    if (!Array.isArray(event.markets) || event.markets.length === 0) continue;
    if (isExcluded(event.title)) continue;

    const binaryActive = event.markets.filter(
      m => m.market_type === 'binary' && m.status === 'active',
    );
    if (binaryActive.length === 0) continue;

    const topMarket = binaryActive.reduce((best, m) => {
      const vol = parseFloat(m.volume_fp) || 0;
      const bestVol = parseFloat(best.volume_fp) || 0;
      return vol > bestVol ? m : best;
    });

    const volume = parseFloat(topMarket.volume_fp) || 0;
    if (volume <= 5000) continue;

    const rawPrice = parseFloat(topMarket.last_price_dollars);
    const yesPrice = Number.isFinite(rawPrice) ? +(rawPrice * 100).toFixed(1) : 50;

    const marketTitle = topMarket.yes_sub_title || topMarket.title || '';
    const title = kalshiTitle(marketTitle, event.title);

    results.push({
      title,
      yesPrice,
      volume,
      url: `https://kalshi.com/markets/${topMarket.ticker}`,
      endDate: topMarket.close_time ?? undefined,
      tags: [],
      source: 'kalshi',
    });
  }

  return results;
}

async function fetchAllPredictions() {
  const allTags = [...new Set([...GEOPOLITICAL_TAGS, ...TECH_TAGS, ...FINANCE_TAGS])];
  const seen = new Set();
  const markets = [];

  // Start Kalshi fetch early so it overlaps with Polymarket tag iterations
  const kalshiPromise = fetchKalshiMarkets();

  for (const tag of allTags) {
    try {
      const events = await fetchEventsByTag(tag, 20);
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
            const vol = m.volumeNum ?? (m.volume ? parseFloat(m.volume) : 0);
            const bestVol = best.volumeNum ?? (best.volume ? parseFloat(best.volume) : 0);
            return vol > bestVol ? m : best;
          });

          const yesPrice = parseYesPrice(topMarket);
          if (yesPrice === null) continue;

          markets.push({
            title: topMarket.question || event.title,
            yesPrice,
            volume: eventVolume,
            url: `https://polymarket.com/event/${event.slug}`,
            endDate: topMarket.endDate ?? event.endDate ?? undefined,
            tags: (event.tags ?? []).map(t => t.slug),
            source: 'polymarket',
          });
        }
      }
    } catch (err) {
      console.warn(`  [${tag}] error: ${err.message}`);
    }
    await sleep(TAG_DELAY_MS);
  }

  // Await the Kalshi fetch that was started in parallel with tag iterations
  const kalshiMarkets = await kalshiPromise;
  console.log(`  [kalshi] ${kalshiMarkets.length} markets`);
  markets.push(...kalshiMarkets);

  console.log(`  total raw markets: ${markets.length}`);

  const geopolitical = filterAndScore(markets, null);
  const tech = filterAndScore(markets, m => m.tags?.some(t => TECH_TAGS.includes(t)));
  const finance = filterAndScore(markets, m => m.source === 'kalshi' || m.tags?.some(t => FINANCE_TAGS.includes(t)));

  console.log(`  geopolitical: ${geopolitical.length}, tech: ${tech.length}, finance: ${finance.length}`);

  return {
    geopolitical,
    tech,
    finance,
    fetchedAt: Date.now(),
  };
}

await runSeed('prediction', 'markets', CANONICAL_KEY, fetchAllPredictions, {
  ttlSeconds: CACHE_TTL,
  lockTtlMs: 60_000,
  validateFn: (data) => (data?.geopolitical?.length > 0 || data?.tech?.length > 0) && data?.finance?.length > 0,
});
