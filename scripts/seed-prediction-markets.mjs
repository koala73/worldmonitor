#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, sleep, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'prediction:markets-bootstrap:v1';
const CACHE_TTL = 900; // 15 min — matches client poll interval

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT = 10_000;
const TAG_DELAY_MS = 300;

const GEOPOLITICAL_TAGS = [
  'politics', 'geopolitics', 'elections', 'world',
  'ukraine', 'china', 'middle-east', 'europe',
  'economy', 'fed', 'inflation',
];

const TECH_TAGS = [
  'ai', 'tech', 'crypto', 'science',
  'elon-musk', 'business', 'economy',
];

const EXCLUDE_KEYWORDS = [
  'nba', 'nfl', 'mlb', 'nhl', 'fifa', 'world cup', 'super bowl', 'championship',
  'playoffs', 'oscar', 'grammy', 'emmy', 'box office', 'movie', 'album', 'song',
  'streamer', 'influencer', 'celebrity', 'kardashian',
  'bachelor', 'reality tv', 'mvp', 'touchdown', 'home run', 'goal scorer',
  'academy award', 'bafta', 'golden globe', 'cannes', 'sundance',
  'documentary', 'feature film', 'tv series', 'season finale',
];

function isExcluded(title) {
  const lower = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
}

function parseYesPrice(market) {
  try {
    const prices = JSON.parse(market.outcomePrices || '[]');
    if (prices.length >= 1) {
      const p = parseFloat(prices[0]);
      if (!isNaN(p)) return +(p * 100).toFixed(1);
    }
  } catch {}
  return 50;
}

function isExpired(endDate) {
  if (!endDate) return false;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) && ms < Date.now();
}

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

async function fetchAllPredictions() {
  const allTags = [...new Set([...GEOPOLITICAL_TAGS, ...TECH_TAGS])];
  const seen = new Set();
  const markets = [];

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

          markets.push({
            title: topMarket.question || event.title,
            yesPrice: parseYesPrice(topMarket),
            volume: eventVolume,
            url: `https://polymarket.com/event/${event.slug}`,
            endDate: topMarket.endDate ?? event.endDate ?? undefined,
            tags: (event.tags ?? []).map(t => t.slug),
          });
        } else {
          markets.push({
            title: event.title,
            yesPrice: 50,
            volume: eventVolume,
            url: `https://polymarket.com/event/${event.slug}`,
            endDate: event.endDate ?? undefined,
            tags: (event.tags ?? []).map(t => t.slug),
          });
        }
      }
    } catch (err) {
      console.warn(`  [${tag}] error: ${err.message}`);
    }
    await sleep(TAG_DELAY_MS);
  }

  const geopolitical = markets
    .filter(m => !isExpired(m.endDate))
    .filter(m => {
      const discrepancy = Math.abs(m.yesPrice - 50);
      return discrepancy > 5 || (m.volume > 50000);
    })
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 25);

  const tech = markets
    .filter(m => !isExpired(m.endDate))
    .filter(m => m.tags?.some(t => TECH_TAGS.includes(t)))
    .filter(m => {
      const discrepancy = Math.abs(m.yesPrice - 50);
      return discrepancy > 5 || (m.volume > 50000);
    })
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 25);

  return {
    geopolitical,
    tech,
    fetchedAt: Date.now(),
  };
}

await runSeed('prediction', 'markets', CANONICAL_KEY, fetchAllPredictions, {
  ttlSeconds: CACHE_TTL,
  lockTtlMs: 60_000,
  validateFn: (data) => (data?.geopolitical?.length > 0 || data?.tech?.length > 0),
});
