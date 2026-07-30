// Resolved `seed-meta:*` thresholds for standalone CRI inputs. Most values
// mirror api/health.js SEED_META; a few direct scorer inputs are not health
// probes yet and are explicitly locked in tests. This intentionally uses
// seeder health cadence, not INDICATOR_REGISTRY source-data cadence: an annual
// source can still have a monthly/daily seeder whose missed runs should
// surface in operational health.
export const STANDALONE_SOURCE_META_MAX_STALE_MIN: Readonly<Record<string, number>> = {
  'seed-meta:economic:imf-macro': 100800,
  'seed-meta:economic:national-debt': 86400,
  'seed-meta:economic:imf-labor': 100800,
  'seed-meta:economic:bis': 10080,
  'seed-meta:economic:bis-dsr': 2160,
  'seed-meta:trade:restrictions:v1:tariff-overview:50': 480,
  'seed-meta:trade:barriers:v1:tariff-gap:50': 480,
  'seed-meta:economic:wb-external-debt': 100800,
  'seed-meta:economic:bis-lbs': 14400,
  'seed-meta:economic:fatf-listing': 60480,
  'seed-meta:cyber:threats': 240,
  'seed-meta:infra:outages': 30,
  'seed-meta:intelligence:gpsjam': 1440,
  'seed-meta:supply_chain:shipping_stress': 45,
  'seed-meta:supply_chain:transit-summaries': 30,
  'seed-meta:economic:owid-energy-mix': 50400,
  'seed-meta:energy:gas-storage-countries': 2880,
  'seed-meta:economic:energy-prices': 150,
  'seed-meta:resilience:fossil-electricity-share': 11520,
  'seed-meta:resilience:low-carbon-generation': 11520,
  'seed-meta:resilience:power-losses': 11520,
  'seed-meta:displacement:summary': 720,
  'seed-meta:unrest:events': 120,
  'seed-meta:conflict:ucdp-events': 420,
  'seed-meta:intelligence:social-reddit': 540, // mirrors api/health.js maxStaleMin (3h relay cadence × 3). NOTE: the sibling seed-meta:intelligence:wsb-tickers is intentionally NOT here — WSB tickers is a finance signal, not a resilience (CRI) source, so it has no standalone-source entry despite sharing the same relay + health budget.
  'seed-meta:news:threat-summary': 60,
  'seed-meta:resilience:recovery:fiscal-space': 129600,
  'seed-meta:resilience:recovery:reserve-adequacy': 86400,
  'seed-meta:resilience:recovery:reexport-share': 86400,
  'seed-meta:resilience:recovery:sovereign-wealth': 86400,
  'seed-meta:resilience:recovery:external-debt': 86400,
  'seed-meta:resilience:recovery:import-hhi': 50400,
};
