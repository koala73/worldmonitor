/**
 * How each panel follows a tab's focus (#10453). Issue rule: a panel never
 * silently ignores the focus. Either it filters to the focused countries, or
 * its header says "Not filtered".
 *
 *   filters      shows only the focused countries (and their neighbours).
 *                Phase 1 covers the regional news panels, security advisories,
 *                UCDP conflict events and aviation; phase 2 adds instability,
 *                outbreaks, outages, radiation, fuel, energy, displacement
 *                and the four correlation panels. A panel declared here that
 *                does not yet override `Panel.applyScope` is labelled "Not
 *                filtered" at runtime, so a declaration can never get ahead
 *                of the code (see `PanelLayoutManager.applyScopeToPanel`).
 *   global       global by nature (markets, prices, indices, crypto, macro,
 *                funding): unchanged and labelled "Not filtered".
 *   unsupported  could follow a country but does not yet: unchanged and
 *                labelled "Not filtered".
 *
 * tests/panel-scope-registry.test.mts fails when a key of ALL_PANELS has no
 * entry or an entry names no panel. Custom widgets (`cw-*`), MCP panels
 * (`mcp-*`) and anything else not listed are 'unsupported'.
 */

export type PanelScopeBehaviour = 'filters' | 'global' | 'unsupported';

export const PANEL_SCOPE_BEHAVIOUR: Readonly<Record<string, PanelScopeBehaviour>> = Object.freeze({
  // Filters by country (Phase 1). News panels attribute a headline by the
  // country names it contains (shared/country-mention.js), advisories by their
  // ISO code, UCDP events by their country name, aviation by airport.
  'airline-intel': 'filters', // Airline Intelligence
  intel: 'filters', // Intel Feed
  politics: 'filters', // World News
  us: 'filters', // United States
  europe: 'filters', // Europe
  middleeast: 'filters', // Middle East
  africa: 'filters', // Africa
  latam: 'filters', // Latin America
  asia: 'filters', // Asia-Pacific
  'ucdp-events': 'filters', // UCDP Conflict Events
  'security-advisories': 'filters', // Security Advisories
  // Global by nature.
  progress: 'global', // Human Progress
  counters: 'global', // Live Counters
  renewable: 'global', // Renewable Energy
  giving: 'global', // Global Giving
  'liquidity-shifts': 'global', // Liquidity Shifts
  'news-market-correlation': 'global', // News ↔ Markets
  'positioning-247': 'global', // 24/7 Positioning
  'gold-silver': 'global', // Gold & Silver
  'critical-minerals': 'global', // Critical Minerals
  'base-metals': 'global', // Base Metals
  'mining-companies': 'global', // Mining Companies
  markets: 'global', // Markets
  commodities: 'global', // Metals & Materials
  'energy-complex': 'global', // Energy Complex
  'oil-inventories': 'global', // Oil Inventories
  'gold-intelligence': 'global', // Gold Intelligence
  heatmap: 'global', // Sector Heatmap
  'macro-signals': 'global', // Market Regime
  economic: 'global', // Macro Stress
  polymarket: 'global', // Predictions
  'world-clock': 'global', // World Clock
  startups: 'global', // Startups & VC
  vcblogs: 'global', // VC Insights & Essays
  unicorns: 'global', // Unicorn Tracker
  accelerators: 'global', // Accelerators & Demo Days
  crypto: 'global', // Crypto
  github: 'global', // GitHub Trending
  ipo: 'global', // IPOs, Earnings & M&A
  funding: 'global', // Funding & VC
  producthunt: 'global', // Product Hunt
  events: 'global', // Tech Events
  'service-status': 'global', // Service Status
  'etf-flows': 'global', // BTC ETF Tracker
  stablecoins: 'global', // Stablecoins
  'stock-analysis': 'global', // Stock Analysis
  'stock-backtest': 'global', // Backtesting
  'daily-market-brief': 'global', // Daily Market Brief
  fx: 'global', // FX Rates
  bonds: 'global', // Fixed Income
  'crypto-heatmap': 'global', // Crypto Sectors
  'defi-tokens': 'global', // DeFi Tokens
  'ai-tokens': 'global', // AI Tokens
  'other-tokens': 'global', // Alt Tokens
  'macro-tiles': 'global', // Macro Indicators
  'fear-greed': 'global', // Fear & Greed
  'aaii-sentiment': 'global', // AAII Sentiment
  'market-breadth': 'global', // Market Breadth
  fsi: 'global', // Financial Stress
  'yield-curve': 'global', // Yield Curve
  'earnings-calendar': 'global', // Earnings Calendar
  'material-events': 'global', // SEC Material Events
  'economic-calendar': 'global', // Economic Calendar
  'cot-positioning': 'global', // COT Positioning
  derivatives: 'global', // Derivatives & Options
  'wsb-ticker-scanner': 'global', // WSB Ticker Scanner
  'nq-pulse': 'global', // NQ Pulse
  'nq-catalysts': 'global', // NQ Catalysts
  'fao-food-price-index': 'global', // FAO Food Price Index
  'market-implications': 'global', // AI Market Implications
  // Not supported yet. The map follows the focus itself (fit and outline) and is not a Panel.
  map: 'unsupported', // Global Map
  // Climate anomalies are regional zones ("Europe", "Sahel", "Coral
  // Triangle"), not countries: a zone centroid would attribute "Europe" to
  // Germany. Weather alerts, natural events and unrest have no panel; they are map
  // layers.
  climate: 'unsupported', // Climate Anomalies
  'reservoir-levels': 'filters', // Host or listed riparian country; neighbours optional
  'population-exposure': 'filters', // Source events filtered before location limits
  'positive-feed': 'unsupported', // Good News Feed
  spotlight: 'unsupported', // Today's Hero
  breakthroughs: 'unsupported', // Breakthroughs
  digest: 'unsupported', // 5 Good Things
  species: 'unsupported', // Conservation Wins
  'live-news': 'unsupported', // Live News
  insights: 'unsupported', // AI Insights
  'commodity-news': 'unsupported', // Commodity News
  energy: 'unsupported', // Energy & Resources
  'mining-news': 'unsupported', // Mining News
  'supply-chain': 'unsupported', // Supply Chain
  'china-corridors': 'unsupported', // China Logistics Corridors
  'china-activity-nowcast': 'unsupported', // China Activity Nowcast
  'commodity-regulation': 'unsupported', // Regulation & Policy
  'pipeline-status': 'unsupported', // Oil & Gas Pipeline Status
  'trade-policy': 'unsupported', // Trade Policy
  'sanctions-pressure': 'unsupported', // Sanctions Pressure
  'gulf-economies': 'unsupported', // Gulf Economies
  'gcc-investments': 'unsupported', // GCC Investments
  'consumer-prices': 'unsupported', // Consumer Prices
  monitors: 'unsupported', // My Monitors
  'latest-brief': 'unsupported', // Latest Brief
  'energy-risk-overview': 'unsupported', // Global Energy Risk Overview
  'chokepoint-strip': 'unsupported', // Chokepoint Status
  'storage-facility-map': 'unsupported', // Strategic Storage Atlas
  'fuel-shortages': 'filters', // Global Fuel Shortage Registry
  'energy-disruptions': 'filters', // Energy Disruptions Log
  'hormuz-tracker': 'unsupported', // Hormuz Trade Tracker
  'energy-crisis': 'unsupported', // Energy Crisis Tracker
  'fuel-prices': 'unsupported', // Fuel Prices
  'live-webcams': 'unsupported', // Live Webcams
  'windy-webcams': 'unsupported', // Windy Live Webcam
  ai: 'unsupported', // AI/ML
  tech: 'unsupported', // Technology
  regionalStartups: 'unsupported', // Global Startup News
  security: 'unsupported', // Cybersecurity
  policy: 'unsupported', // AI Policy & Regulation
  layoffs: 'unsupported', // Layoffs Tracker
  finance: 'unsupported', // Financial
  hardware: 'unsupported', // Semiconductors & Hardware
  cloud: 'unsupported', // Cloud & Infrastructure
  dev: 'unsupported', // Developer Community
  'internet-disruptions': 'filters', // Internet Disruptions
  'global-procurement': 'unsupported', // Global Procurement
  'tech-readiness': 'unsupported', // Tech Readiness Index
  'tech-hubs': 'unsupported', // Hot Tech Hubs
  'ai-regulation': 'unsupported', // AI Regulation Dashboard
  'markets-news': 'unsupported', // Markets News
  forex: 'unsupported', // Forex & Currencies
  'commodities-news': 'unsupported', // Commodities News
  'crypto-news': 'unsupported', // Crypto News
  centralbanks: 'unsupported', // Central Bank Watch
  'economic-news': 'unsupported', // Economic News
  fintech: 'unsupported', // Fintech & Trading Tech
  'fin-regulation': 'unsupported', // Financial Regulation
  institutional: 'unsupported', // Hedge Funds & PE
  analysis: 'unsupported', // Market Analysis
  gccNews: 'unsupported', // GCC Business News
  'nq-news': 'unsupported', // NQ News
  'threat-timeline': 'unsupported', // Threat Timeline
  'strategic-posture': 'unsupported', // AI Strategic Posture
  forecast: 'unsupported', // AI Forecasts
  cii: 'filters', // Country Instability
  'strategic-risk': 'unsupported', // Strategic Risk Overview
  'gdelt-intel': 'unsupported', // Live Intelligence
  cascade: 'unsupported', // Infrastructure Cascade
  'military-correlation': 'filters', // Force Posture
  'escalation-correlation': 'filters', // Escalation Monitor
  'economic-correlation': 'filters', // Economic Warfare
  'disaster-correlation': 'filters', // Disaster Cascade
  gov: 'unsupported', // Government
  thinktanks: 'unsupported', // Think Tanks
  'chat-analyst': 'unsupported', // WM Analyst
  science: 'unsupported', // Science
  'satellite-fires': 'unsupported', // Fires
  'grocery-basket': 'unsupported', // Grocery Index
  bigmac: 'unsupported', // Big Mac Index
  'disease-outbreaks': 'filters', // Disease Outbreaks
  'social-velocity': 'unsupported', // Social Velocity
  displacement: 'filters', // UNHCR Displacement
  'ukmto-incidents': 'unsupported', // UKMTO Incidents
  'climate-news': 'unsupported', // Climate News
  'defense-patents': 'unsupported', // R&D Signal
  'toronto-safety': 'unsupported', // Toronto Safety
  'radiation-watch': 'filters', // Radiation Watch
  'thermal-escalation': 'unsupported', // Thermal Escalation
  'oref-sirens': 'unsupported', // Israel Sirens
  'telegram-intel': 'unsupported', // Telegram Intel
  'x-intel': 'unsupported', // X News Accounts
  'national-debt': 'unsupported', // Global Debt Clock
  'cross-source-signals': 'unsupported', // Cross-Source Signals
  'regional-intelligence': 'unsupported', // Regional Intelligence
  deduction: 'unsupported', // Deduct Situation
  'geo-hubs': 'unsupported', // Geopolitical Hubs
});

/**
 * Why a panel that shows country-specific data is still 'unsupported' (#10453
 * phase 2 inventory). A panel is listed here only if its items could carry a
 * country; global, news-category and tech panels are not. tests/
 * panel-scope-registry.test.mts keeps every key here 'unsupported' and a real
 * panel, so a reason cannot outlive the panel it explains or the day the
 * panel starts filtering.
 */
export const PANEL_SCOPE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'thermal-escalation': 'The service keeps the 12 largest clusters worldwide before the panel sees them; filtering that slice would call a focused country quiet. Needs a larger fetch when focused.',
  'sanctions-pressure': 'The seed keeps the top 12 countries and 25 entries; filtering that slice would call a focused country quiet. Needs a per-country query.',
  'geo-hubs': 'The panel keeps only the first 10 hubs when it receives them.',
  'threat-timeline': 'Server top stories are cut before the panel; items carry a headline and coordinates, not a country.',
  'satellite-fires': 'Covers 9 fixed countries only: for any other focus an empty list would read as "no fires" when the feed does not look there.',
  'oref-sirens': 'Covers Israel only: filtering by country adds nothing, and an empty list for another focus would read as quiet.',
  'ukmto-incidents': 'Incidents sit in sea areas (Red Sea, Gulf of Aden) that belong to no single country; needs a sea-area to countries table.',
  'trade-policy': 'Six data sets of mixed shape; tariffs and customs revenue are US-only.',
  'regional-intelligence': 'Boards are macro regions, not countries: needs a region chosen from the focus, not a filter.',
  forecast: 'Forecasts name a country or a theatre in free text and several are global; the region pill travels with the tab instead.',
  'live-webcams': 'Feeds belong to five regions, some to none ("Space"); the region pill travels with the tab instead.',
  'windy-webcams': 'At most 4 pinned cameras the user chose: filtering them hides the user\'s own pins.',
  'cross-source-signals': 'Signals name a theatre, not a country.',
  'strategic-risk': 'A composite overview already cut to the top 5 countries and zones.',
  cascade: 'Driven by the infrastructure node the user picks, not by country.',
  'gdelt-intel': 'Fetched per topic; a country filter would need a new query.',
  'telegram-intel': 'Posts name a country only in free text, and many are untranslated.',
  'x-intel': 'Posts name a country only in free text.',
  monitors: 'Matches keywords the user chose to watch: a focus must not hide what the user asked for.',
  'live-news': 'Video channels have no subject country; geoAvailability says where a channel can be watched, not what it covers.',
  climate: 'Anomalies are regional zones, not countries; a zone-to-country rule is needed before filtering. A zone centroid does not represent every affected country.',
});

/** A panel's declared behaviour; 'unsupported' for dynamic and unknown keys. */
export function getPanelScopeBehaviour(key: string): PanelScopeBehaviour {
  return Object.prototype.hasOwnProperty.call(PANEL_SCOPE_BEHAVIOUR, key)
    ? PANEL_SCOPE_BEHAVIOUR[key]!
    : 'unsupported';
}
