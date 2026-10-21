// Geopolitical prediction-market bet templates (Phase 2 / #5525, #5733 — the
// flagship geopolitical calibration slice).
//
// WHY A SEPARATE FAMILY. The general market family (_bet-templates-markets.mjs)
// caps the horizon at 45 days so bets resolve fast and feed Gate-2 quickly. But
// the liquid GEOPOLITICAL prediction markets — Iran enriched-uranium ($28M),
// Iran leadership change ($21M), coup/ceasefire lines — almost all resolve on
// multi-month horizons (Dec-31 and beyond). A 45-day cap therefore excludes
// exactly the domain WorldMonitor is a reference in, leaving geo coverage to
// the luck of a rare short-dated line. This family lifts the horizon to 210
// days so the persistent geo bench is captured, and ranks it ABOVE every other
// family (userValueScore 0.9) so its bets win the top-K ensemble slots.
//
// PARTITION. Identity is the venue slug (same settlement path as the general
// family, KTD2). To avoid double-betting a market, the split is exhaustive and
// disjoint: this family owns every geopolitical market (per isGeopoliticalMarket)
// across the 2-210d window; the general family excludes them. Disjoint slug
// sets mean the `market:<slug>` id namespace never collides.
//
// The resolution/settlement contract is byte-identical to the general family
// (crosses/yesPrice against prediction:markets-resolution:v1, slug-keyed), so
// the resolver's updateMarketSettlements loader tracks these with no change.

import { MARKET_FEED, MARKET_SETTLEMENT_FEED, parseMarketRecord } from './_bet-templates-markets.mjs';
import { isGeopoliticalMarket } from './_bet-templates-markets-classify.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LEAD_MS = 2 * DAY_MS;
// Long horizon: the geo bench clusters at Dec-31 (~156d out) and into Q1 of the
// next year. 210 days captures that cluster while still excluding multi-year
// lottery lines (2028+/2040/2099 markets in the feed) whose prices carry no
// forecastable near-term signal.
const MAX_HORIZON_MS = 210 * DAY_MS;
// Dedicated geo slate size — as much room as the general family.
export const MARKET_GEO_SLOT_COUNT = 6;

// Eligible GEOPOLITICAL markets, volume-sorted, deduped by slug. Pure. Shares
// parseMarketRecord with the general family (identical record/liquidity gates,
// no drift) and differs only in the geo predicate and the long horizon.
export function eligibleGeoMarkets(feed, nowMs) {
  const pools = [feed?.geopolitical, feed?.tech, feed?.finance].filter(Array.isArray);
  const seen = new Set();
  const out = [];
  for (const record of pools.flat()) {
    const market = parseMarketRecord(record);
    if (!market) continue;
    if (!isGeopoliticalMarket(market.title)) continue;
    if (market.endDateMs < nowMs + MIN_LEAD_MS || market.endDateMs > nowMs + MAX_HORIZON_MS) continue;
    if (seen.has(market.slug)) continue;
    seen.add(market.slug);
    out.push(market);
  }
  return out.sort((a, b) => b.volume - a.volume);
}

function buildSlotTemplate(slot) {
  return {
    id: `market-geo:slot${slot}`,
    feedKey: MARKET_FEED,
    domain: 'geopolitical',

    extractMetric(feed, ctx = {}) {
      const nowMs = Number(feed?.fetchedAt) || Number(ctx.nowMs);
      if (!Number.isFinite(nowMs)) return null;
      const market = eligibleGeoMarkets(feed, nowMs)[slot];
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
        // Slug-keyed against the settlement feed — identical to the general
        // family (KTD2): titles are mutable, only the venue slug is stable.
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
      // Same slug namespace as the general family; the disjoint partition
      // guarantees no collision, and slug identity keeps settlement lookups
      // uniform across both families.
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
      // Flagship domain: rank above every other family so geo bets claim the
      // top-K ensemble slots (seed-forecast-bets raises TOP_K so this does not
      // starve the fast-resolving general/commodity Gate-2 bets).
      return 0.9;
    },
  };
}

export const MARKET_GEO_BET_TEMPLATES = Array.from({ length: MARKET_GEO_SLOT_COUNT }, (_, i) => buildSlotTemplate(i));

function normalizeQuestion(title) {
  const text = String(title).trim();
  return /\?$/.test(text) ? text : `${text}?`;
}

function round2(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 100) / 100;
}
