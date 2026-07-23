// Prediction-market bet templates (Phase 2 / #5238 U11).
//
// Source feed: prediction:markets-bootstrap:v1 (bootstrap categories: geopolitical/tech/finance)
// Resolution feed: prediction:markets-resolution:v1  ← dedicated settlement path (KTD2)
//
// Key design decisions (KTD2):
//   - Bootstrap feed only publishes OPEN markets (closed:'false', yesPrice clipped [10,90]).
//     A settled market (~0/100 price) NEVER appears in the bootstrap feed, so resolution
//     MUST use a separate feed queried with Gamma closed:true by slug — mirroring the
//     ACLED resolution precedent.
//   - Bets store the market slug in spec.marketSlug for the settlement loader.
//   - Bets PEND (not VOID) from endDate until settlement lands in
//     prediction:markets-resolution:v1. The resolver's at-endDate window handles this.
//   - The market's yesPrice (at generation time) is stored as calibration.marketPrice
//     so the scorecard's vsMarketSkill logic can use it (KTD5).
//   - Volume floor: MIN_VOLUME = 5000 (mirrors shouldInclude in _prediction-scoring.mjs).
//   - Horizon cap: endDate must be within 45 calendar days so bets resolve in one cycle.
//
// Pure: templates are declarative; generateBets() (in _bet-templates.mjs) drives them
// with an injected feed snapshot + nowMs.

export const MARKETS_BOOTSTRAP_FEED = 'prediction:markets-bootstrap:v1';
// Dedicated settlement feed written by the settlement seeder. The bootstrap feed
// never has closed prices — this is a separate key.
export const MARKETS_RESOLUTION_FEED = 'prediction:markets-resolution:v1';

const DAY_MS = 24 * 60 * 60 * 1000;
// Markets whose endDate is beyond 45d will not resolve before the bets history TTL.
const MAX_HORIZON_MS = 45 * DAY_MS;
// Mirror _prediction-scoring.mjs shouldInclude volume floor.
const MIN_VOLUME = 5000;
// Minimum market probability to generate a bet (mirrors shouldInclude[10,90] clip).
const MIN_YES_PRICE = 10;
const MAX_YES_PRICE = 90;
// Maximum bets to generate from the markets bootstrap feed per run.
// The seeder's top-K filter will further trim across all domains.
const MAX_MARKETS_BETS = 10;

/**
 * Extract candidate markets from all bootstrap categories.
 * Returns a flat, deduplicated list sorted by score desc.
 */
function extractCandidateMarkets(feed, nowMs) {
  const bootstrapData = feed?.data ?? feed;
  if (!bootstrapData || typeof bootstrapData !== 'object') return [];

  // Combine all categories into one pool and deduplicate by slug.
  const categories = ['geopolitical', 'tech', 'finance'];
  const seen = new Set();
  const candidates = [];

  for (const cat of categories) {
    const markets = Array.isArray(bootstrapData[cat]) ? bootstrapData[cat] : [];
    for (const m of markets) {
      const slug = resolveSlug(m);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      const yesPrice = Number(m.yesPrice);
      if (!Number.isFinite(yesPrice) || yesPrice < MIN_YES_PRICE || yesPrice > MAX_YES_PRICE) continue;

      const volume = Number(m.volume);
      if (!Number.isFinite(volume) || volume < MIN_VOLUME) continue;

      const endDate = m.endDate ?? m.end_date;
      if (!endDate) continue;
      const endMs = typeof endDate === 'number' ? endDate : Date.parse(endDate);
      if (!Number.isFinite(endMs) || endMs <= nowMs || endMs > nowMs + MAX_HORIZON_MS) continue;

      candidates.push({ m, slug, yesPrice, volume, endMs });
    }
  }

  // Sort by volume desc (conviction already baked into the bootstrap feed ordering,
  // volume is a stable secondary key).
  candidates.sort((a, b) => b.volume - a.volume);
  return candidates.slice(0, MAX_MARKETS_BETS);
}

/**
 * Resolve a stable slug for a market entry.
 * Polymarket uses event slug; Kalshi uses a ticker from the URL.
 */
function resolveSlug(m) {
  if (typeof m.url !== 'string') return null;
  // Polymarket: https://polymarket.com/event/<slug>
  const polyMatch = m.url.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (polyMatch) return `polymarket:${polyMatch[1]}`;
  // Kalshi: https://kalshi.com/markets/<ticker>
  const kalshiMatch = m.url.match(/kalshi\.com\/markets\/([^/?#]+)/);
  if (kalshiMatch) return `kalshi:${kalshiMatch[1]}`;
  return null;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build a bet template for one candidate market.
 * The template's extractMetric() receives the FULL BOOTSTRAP FEED and must
 * re-locate the specific market by slug — because generateBets() calls it once
 * per template with the current feed snapshot.
 */
function buildMarketTemplate(slug, initialMarket, initialEndMs) {
  return {
    id: `prediction-market:${slug}`,
    feedKey: MARKETS_BOOTSTRAP_FEED,
    domain: 'prediction_market',

    extractMetric(feed) {
      const now = Date.now(); // used for staleness check only
      const data = feed?.data ?? feed;
      if (!data || typeof data !== 'object') return null;

      // Re-locate the market by slug across all categories.
      const categories = ['geopolitical', 'tech', 'finance'];
      for (const cat of categories) {
        const markets = Array.isArray(data[cat]) ? data[cat] : [];
        for (const m of markets) {
          if (resolveSlug(m) !== slug) continue;
          const yesPrice = Number(m.yesPrice);
          if (!Number.isFinite(yesPrice)) return null;
          const volume = Number(m.volume);
          const endDate = m.endDate ?? m.end_date;
          const endMs = typeof endDate === 'number' ? endDate : Date.parse(endDate);
          if (!Number.isFinite(endMs)) return null;
          return {
            title: String(m.title || ''),
            slug,
            yesPrice,
            volume: Number.isFinite(volume) ? volume : 0,
            endMs,
            source: m.source || 'unknown',
          };
        }
      }
      return null;
    },

    horizonPolicy({ metric }) {
      // The deadline IS the market's own endDate — resolution follows market settlement.
      return metric.endMs;
    },

    buildResolutionSpec({ metric, deadlineMs }) {
      return {
        kind: 'hard',
        // The eval reads yesPrice(market==<slug>) from the resolution feed.
        // At settlement yesPrice will be ~0 or ~100; we resolve YES if >= 50.
        metricKey: `${MARKETS_RESOLUTION_FEED}|yesPrice(market==${metric.slug})`,
        operator: 'crosses',
        // Threshold = 50: YES if settled yesPrice >= 50.
        threshold: 50,
        baselineValue: metric.yesPrice,
        window: 'at-endDate',
        deadline: deadlineMs,
        sourceFeed: MARKETS_RESOLUTION_FEED,
        // Store slug so the settlement loader can query Gamma by slug.
        marketSlug: metric.slug,
        question: `Will the market "${metric.title}" resolve YES by ${isoDate(deadlineMs)}?`,
      };
    },

    buildQuestion({ spec }) {
      return spec.question;
    },

    buildTitle({ metric }) {
      return `Prediction market: ${metric.title}`;
    },

    // After generateBets(), seed-forecast-bets injects calibration.marketPrice (KTD5).
    // We surface yesPrice here so the seeder can attach it.
    buildCalibration({ metric }) {
      // marketPrice stored as a [0,1] fraction to match the scorecard's marketProbability().
      return { marketPrice: round2(metric.yesPrice / 100) };
    },

    userValueScore({ metric }) {
      // High-conviction markets (far from 50/50) are more interesting for calibration.
      const conviction = Math.abs(metric.yesPrice - 50) / 50;
      const volScore = Math.min(Math.log10(Math.max(metric.volume, 1)) / Math.log10(1_000_000), 1);
      return clamp01(conviction * 0.5 + volScore * 0.5);
    },
  };
}

/**
 * Generate prediction-market bet templates from the current bootstrap feed snapshot.
 * Called once per seeder run. Returns an array of template objects for generateBets().
 *
 * @param {unknown} feed  The raw prediction:markets-bootstrap:v1 payload.
 * @param {number}  nowMs Current timestamp.
 * @returns {object[]}    Bet templates.
 */
export function buildMarketTemplates(feed, nowMs) {
  const candidates = extractCandidateMarkets(feed, nowMs);
  return candidates.map(({ slug, m, endMs }) => buildMarketTemplate(slug, m, endMs));
}

// Convenience re-export for the seeder's BET_FEEDS list.
export { MARKETS_BOOTSTRAP_FEED as PREDICTION_MARKET_FEED };

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function round2(v) {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 100) / 100;
}
