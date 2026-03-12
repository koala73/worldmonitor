#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, sleep, runSeed } from './_seed-utils.mjs';
import {
  isExcluded, isMemeCandidate, tagRegions, parseYesPrice,
  shouldInclude, scoreMarket, filterAndScore, isExpired,
} from './_prediction-scoring.mjs';

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

const FINANCE_TAGS = [
  'economy', 'fed', 'inflation', 'interest-rates', 'recession',
  'trade', 'tariffs', 'debt-ceiling',
];

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
  const allTags = [...new Set([...GEOPOLITICAL_TAGS, ...TECH_TAGS, ...FINANCE_TAGS])];
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

          const yesPrice = parseYesPrice(topMarket);
          if (yesPrice === null) continue;

          markets.push({
            title: topMarket.question || event.title,
            yesPrice,
            volume: eventVolume,
            url: `https://polymarket.com/event/${event.slug}`,
            endDate: topMarket.endDate ?? event.endDate ?? undefined,
            tags: (event.tags ?? []).map(t => t.slug),
          });
        } else {
          continue; // no markets = no price signal, skip
        }
      }
    } catch (err) {
      console.warn(`  [${tag}] error: ${err.message}`);
    }
    await sleep(TAG_DELAY_MS);
  }

  console.log(`  total raw markets: ${markets.length}`);

  const geopolitical = filterAndScore(markets, null);
  const tech = filterAndScore(markets, m => m.tags?.some(t => TECH_TAGS.includes(t)));
  const finance = filterAndScore(markets, m => m.tags?.some(t => FINANCE_TAGS.includes(t)));

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
