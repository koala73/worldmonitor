// Prediction-market bet templates (Phase 2 / #5525 — the market-anchored
// calibration slice).
//
// Generation reads `prediction:markets-bootstrap:v1` (shape: {geopolitical,
// tech, finance} arrays of {title, yesPrice, volume, url, endDate, source?}).
// Resolution CANNOT read that feed: its producer only publishes open markets
// and clips yesPrice to [10,90], so a settled ~0/100 price never appears there
// (KTD2). Bets therefore target `prediction:markets-resolution:v1` — a
// dedicated settlement feed the resolver populates by querying the venues for
// adjudicated outcomes of bet-referenced markets (see seed-forecast-resolutions
// updateMarketSettlements). Each bet carries the market's slug/ticker (derived
// from the feed's url) so the settlement loader knows what to track, and
// `calibration.marketPrice` (the current yesPrice) so vsMarketSkill can compare
// the ensemble against the crowd.
//
// The registry model is one-bet-per-template, so this module exposes a fixed
// slate of SLOT templates: slot i binds to the i-th eligible market (volume-
// sorted). Bet ids key on the market slug (stable across runs → the ledger's
// id@deadline dedup and the seeder's open-window skip work per-market).

import { isGeopoliticalMarket } from './_bet-templates-markets-classify.mjs';

export const MARKET_FEED = 'prediction:markets-bootstrap:v1';
export const MARKET_SETTLEMENT_FEED = 'prediction:markets-resolution:v1';

const DAY_MS = 24 * 60 * 60 * 1000;
// Liquidity floor above the feed's own 5k cut: thin markets are noise, and the
// calibration slice should grade against prices someone actually trades.
export const MARKET_MIN_VOLUME = 25_000;
// Horizon window: far enough out that the bet is a real forecast (not a
// last-minute copy of a converged price), near enough to accrue resolutions.
const MIN_LEAD_MS = 2 * DAY_MS;
const MAX_HORIZON_MS = 45 * DAY_MS;
// Slate size: at most this many market bets per run.
export const MARKET_SLOT_COUNT = 6;

// Derive the venue slug/ticker from the feed record's url:
//   https://polymarket.com/event/<slug>  → { source: 'polymarket', slug }
//   https://kalshi.com/markets/<ticker>  → { source: 'kalshi', slug: ticker }
export function marketSlugFromUrl(url) {
  const text = String(url || '');
  const poly = text.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (poly) return { source: 'polymarket', slug: poly[1] };
  const kalshi = text.match(/kalshi\.com\/markets\/([^/?#]+)/);
  if (kalshi) return { source: 'kalshi', slug: kalshi[1] };
  return null;
}

// Parse + validate one bootstrap-feed record into the normalized shape both
// market families consume, or null if it fails the shared gates (missing
// title/slug, non-finite price/volume/date, below the liquidity floor). Pure.
// Shared so the general and geo families cannot drift on record handling.
export function parseMarketRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const title = String(record.title || '').trim();
  const yesPrice = Number(record.yesPrice);
  const volume = Number(record.volume);
  const endDateMs = Date.parse(record.endDate ?? '');
  const slugInfo = marketSlugFromUrl(record.url);
  if (!title || !slugInfo) return null;
  if (!Number.isFinite(yesPrice)) return null;
  if (!Number.isFinite(volume) || volume < MARKET_MIN_VOLUME) return null;
  if (!Number.isFinite(endDateMs)) return null;
  return { title, yesPrice, volume, endDateMs, ...slugInfo };
}

// Eligible markets, volume-sorted, deduped by slug. Pure. GEOPOLITICAL markets
// are excluded here — they are owned by the dedicated long-horizon geo family
// (_bet-templates-markets-geo.mjs), an exhaustive, disjoint partition so no
// market is bet twice and the `market:<slug>` id namespace never collides.
export function eligibleMarkets(feed, nowMs) {
  const pools = [feed?.geopolitical, feed?.tech, feed?.finance].filter(Array.isArray);
  const seen = new Set();
  const out = [];
  for (const record of pools.flat()) {
    const market = parseMarketRecord(record);
    if (!market) continue;
    if (isGeopoliticalMarket(market.title)) continue;
    if (market.endDateMs < nowMs + MIN_LEAD_MS || market.endDateMs > nowMs + MAX_HORIZON_MS) continue;
    if (seen.has(market.slug)) continue;
    seen.add(market.slug);
    out.push(market);
  }
  return out.sort((a, b) => b.volume - a.volume);
}

function buildSlotTemplate(slot) {
  return {
    id: `market:slot${slot}`,
    feedKey: MARKET_FEED,
    domain: 'market',

    extractMetric(feed, ctx = {}) {
      // Eligibility time: the feed's own fetchedAt when present (it always is
      // in prod), else the registry-injected nowMs — never the wall clock
      // (registry purity contract). No finite time source → no bet (an
      // undated horizon check would fail open on the 2-45d window).
      const nowMs = Number(feed?.fetchedAt) || Number(ctx.nowMs);
      if (!Number.isFinite(nowMs)) return null;
      const market = eligibleMarkets(feed, nowMs)[slot];
      if (!market) return null;
      return {
        subject: market.title,
        value: market.yesPrice,
        endDateMs: market.endDateMs,
        slug: market.slug,
        source: market.source,
        volume: market.volume,
      };
    },

    horizonPolicy({ metric }) {
      return metric.endDateMs;
    },

    buildResolutionSpec({ metric, deadlineMs }) {
      return {
        kind: 'hard',
        // Resolution targets the SETTLEMENT feed (KTD2): the bootstrap feed can
        // never carry a settled price. `crosses` with fn yesPrice resolves
        // YES iff settled yesPrice >= threshold (existing eval semantics).
        // Identity is the venue SLUG end-to-end: titles are mutable and the
        // ledger title goes through normalizeQuestion (appends '?'), so a
        // title-keyed match would miss the loader-written record and VOID
        // after the settlement grace.
        metricKey: `${MARKET_SETTLEMENT_FEED}|yesPrice(slug==${metric.slug})`,
        operator: 'crosses',
        threshold: 50,
        baselineValue: round2(metric.value),
        window: 'at-deadline',
        deadline: deadlineMs,
        sourceFeed: MARKET_SETTLEMENT_FEED,
        question: normalizeQuestion(metric.subject),
      };
    },

    buildQuestion({ spec }) {
      return spec.question;
    },

    buildId({ metric }) {
      return `market:${metric.slug}`;
    },

    decorate({ metric }) {
      return {
        marketSlug: metric.slug,
        marketSource: metric.source,
        calibration: { marketPrice: round2(metric.value), source: metric.source },
      };
    },

    userValueScore() {
      return 0.8; // real-world questions are the headline user value
    },
  };
}

export const MARKET_BET_TEMPLATES = Array.from({ length: MARKET_SLOT_COUNT }, (_, i) => buildSlotTemplate(i));

function normalizeQuestion(title) {
  const text = String(title).trim();
  return /\?$/.test(text) ? text : `${text}?`;
}

function round2(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}
