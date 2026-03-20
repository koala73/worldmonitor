/**
 * Central seed catalog — defines all 42 seeders with their scheduling parameters.
 *
 * Fields:
 *   tier        — 'hot' | 'warm' | 'cold' | 'frozen'
 *   intervalMin — refresh interval in minutes (always < ttlSec / 60)
 *   ttlSec      — Redis TTL in seconds (how long data is valid)
 *   ttlSource   — 'source' = TTL from upstream API/script constant, 'inferred' = our estimate
 *   requiredKeys — env vars required for the seeder to run (excluding UPSTASH_REDIS_*)
 *   metaKey      — seed-meta key pattern (domain:resource) for freshness tracking.
 *                  Audited from runSeed(domain, resource) / writeFreshnessMetadata() calls.
 *                  null = seeder doesn't write seed-meta; orchestrator writes its own.
 */

export const TIER_ORDER = ['hot', 'warm', 'cold', 'frozen'];

export const TIER_CONCURRENCY = { hot: 3, warm: 5, cold: 3, frozen: 2 };

export const STEADY_STATE_CONCURRENCY = 5;

export const SEED_CATALOG = {
  // ── HOT (5-15 min) ─────────────────────────────────────────────────
  'weather-alerts':       { tier: 'hot',    intervalMin: 5,    ttlSec: 900,    ttlSource: 'source',   requiredKeys: [],                    metaKey: 'weather:alerts' },
  'correlation':          { tier: 'hot',    intervalMin: 5,    ttlSec: 1200,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'correlation:cards' },
  'prediction-markets':   { tier: 'hot',    intervalMin: 10,   ttlSec: 1800,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'prediction:markets' },
  'commodity-quotes':     { tier: 'hot',    intervalMin: 10,   ttlSec: 1800,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'market:commodities' },
  'market-quotes':        { tier: 'hot',    intervalMin: 10,   ttlSec: 1800,   ttlSource: 'source',   requiredKeys: ['FINNHUB_API_KEY'],   metaKey: 'market:quotes' },
  'insights':             { tier: 'hot',    intervalMin: 15,   ttlSec: 1800,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'news:insights' },
  'military-flights':     { tier: 'hot',    intervalMin: 5,    ttlSec: 600,    ttlSource: 'source',   requiredKeys: [],                    metaKey: 'military:flights' },
  'conflict-intel':       { tier: 'hot',    intervalMin: 10,   ttlSec: 900,    ttlSource: 'source',   requiredKeys: [],                    metaKey: 'conflict:acled-intel' }, // accepts ACLED_EMAIL+PASSWORD or ACLED_ACCESS_TOKEN

  // ── WARM (30-60 min) ───────────────────────────────────────────────
  'earthquakes':          { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'seismology:earthquakes' },
  'security-advisories':  { tier: 'warm',   intervalMin: 30,   ttlSec: 7200,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'intelligence:advisories' },
  'fire-detections':      { tier: 'warm',   intervalMin: 30,   ttlSec: 7200,   ttlSource: 'inferred', requiredKeys: ['NASA_FIRMS_API_KEY'], metaKey: 'wildfire:fires' },
  'natural-events':       { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'natural:events' },
  'radiation-watch':      { tier: 'warm',   intervalMin: 30,   ttlSec: 7200,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'radiation:observations' },
  'airport-delays':       { tier: 'warm',   intervalMin: 30,   ttlSec: 7200,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'aviation:faa' },
  'crypto-quotes':        { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'market:crypto' },
  'stablecoin-markets':   { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'market:stablecoins' },
  'gulf-quotes':          { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'market:gulf-quotes' },
  'etf-flows':            { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'market:etf-flows' },
  'economy':              { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: ['FRED_API_KEY'],      metaKey: 'economic:energy-prices' },
  'research':             { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'research:arxiv-hn-trending' },
  'unrest-events':        { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'unrest:events' },
  'usa-spending':         { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'economic:spending' },
  'supply-chain-trade':   { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'source',   requiredKeys: ['FRED_API_KEY'],      metaKey: 'supply_chain:shipping' },
  'aviation':             { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'inferred', requiredKeys: ['AVIATIONSTACK_API'], metaKey: 'aviation:ops-news' },
  'internet-outages':     { tier: 'warm',   intervalMin: 15,   ttlSec: 1800,   ttlSource: 'source',   requiredKeys: ['CLOUDFLARE_API_TOKEN'], metaKey: 'infra:outages' },
  'infra':                { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'inferred', requiredKeys: [],                    metaKey: null },
  'service-statuses':     { tier: 'warm',   intervalMin: 30,   ttlSec: 3600,   ttlSource: 'inferred', requiredKeys: [],                    metaKey: 'infra:service-statuses' },
  'military-maritime-news': { tier: 'warm', intervalMin: 30,   ttlSec: 3600,   ttlSource: 'inferred', requiredKeys: [],                    metaKey: null },
  'sanctions-pressure':   { tier: 'warm',   intervalMin: 30,   ttlSec: 43200,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'sanctions:pressure' },
  'forecasts':            { tier: 'warm',   intervalMin: 60,   ttlSec: 6300,   ttlSource: 'source',   requiredKeys: [],                    metaKey: 'forecast:predictions' },

  // ── COLD (2-6 hours) ───────────────────────────────────────────────
  'cyber-threats':        { tier: 'cold',   intervalMin: 120,  ttlSec: 10800,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'cyber:threats' },
  'climate-anomalies':    { tier: 'cold',   intervalMin: 120,  ttlSec: 10800,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'climate:anomalies' },
  'thermal-escalation':   { tier: 'cold',   intervalMin: 120,  ttlSec: 10800,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'thermal:escalation' },
  'gdelt-intel':          { tier: 'cold',   intervalMin: 120,  ttlSec: 86400,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'intelligence:gdelt-intel' },
  'webcams':              { tier: 'cold',   intervalMin: 360,  ttlSec: 86400,  ttlSource: 'inferred', requiredKeys: ['WINDY_API_KEY'],     metaKey: 'webcam:cameras:geo' },
  'iran-events':          { tier: 'cold',   intervalMin: 360,  ttlSec: 172800, ttlSource: 'source',   requiredKeys: [],                    metaKey: 'conflict:iran-events' },

  // ── FROZEN (12h-7d) ────────────────────────────────────────────────
  'bis-data':             { tier: 'frozen', intervalMin: 600,  ttlSec: 43200,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'economic:bis' },
  'displacement-summary': { tier: 'frozen', intervalMin: 720,  ttlSec: 86400,  ttlSource: 'source',   requiredKeys: [],                    metaKey: 'displacement:summary' },
  'submarine-cables':     { tier: 'frozen', intervalMin: 1440, ttlSec: 604800, ttlSource: 'source',   requiredKeys: [],                    metaKey: 'infrastructure:submarine-cables' },
  'military-bases':       { tier: 'frozen', intervalMin: 1440, ttlSec: 604800, ttlSource: 'inferred', requiredKeys: [],                    metaKey: null },
  'ucdp-events':          { tier: 'frozen', intervalMin: 720,  ttlSec: 86400,  ttlSource: 'inferred', requiredKeys: [],                    metaKey: 'conflict:ucdp-events' },
  'wb-indicators':        { tier: 'frozen', intervalMin: 720,  ttlSec: 86400,  ttlSource: 'inferred', requiredKeys: [],                    metaKey: null },
};
