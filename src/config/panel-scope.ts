/**
 * How each panel follows a tab's focus (#10453). Issue rule: a panel never
 * silently ignores the focus. Either it filters to the focused countries, or
 * its header says "Not filtered".
 *
 *   filters      shows only the focused countries (and their neighbours).
 *                Phase 1 covers the regional news panels, security advisories,
 *                UCDP conflict events and aviation. A panel declared here that
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
  // Germany. Weather alerts and natural events have no panel; they are map
  // layers.
  climate: 'unsupported', // Climate Anomalies
  'reservoir-levels': 'unsupported', // Strategic Water Levels
  // Exposure keeps the 10 largest events per source worldwide before it
  // reaches the panel, so filtering that slice would call a focused country
  // quiet when its events were simply cut. Needs filtering before the cut.
  'population-exposure': 'unsupported', // Population Exposure
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
  'fuel-shortages': 'unsupported', // Global Fuel Shortage Registry
  'energy-disruptions': 'unsupported', // Energy Disruptions Log
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
  'internet-disruptions': 'unsupported', // Internet Disruptions
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
  cii: 'unsupported', // Country Instability
  'strategic-risk': 'unsupported', // Strategic Risk Overview
  'gdelt-intel': 'unsupported', // Live Intelligence
  cascade: 'unsupported', // Infrastructure Cascade
  'military-correlation': 'unsupported', // Force Posture
  'escalation-correlation': 'unsupported', // Escalation Monitor
  'economic-correlation': 'unsupported', // Economic Warfare
  'disaster-correlation': 'unsupported', // Disaster Cascade
  gov: 'unsupported', // Government
  thinktanks: 'unsupported', // Think Tanks
  'chat-analyst': 'unsupported', // WM Analyst
  science: 'unsupported', // Science
  'satellite-fires': 'unsupported', // Fires
  'grocery-basket': 'unsupported', // Grocery Index
  bigmac: 'unsupported', // Big Mac Index
  'disease-outbreaks': 'unsupported', // Disease Outbreaks
  'social-velocity': 'unsupported', // Social Velocity
  displacement: 'unsupported', // UNHCR Displacement
  'ukmto-incidents': 'unsupported', // UKMTO Incidents
  'climate-news': 'unsupported', // Climate News
  'defense-patents': 'unsupported', // R&D Signal
  'toronto-safety': 'unsupported', // Toronto Safety
  'radiation-watch': 'unsupported', // Radiation Watch
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

/** A panel's declared behaviour; 'unsupported' for dynamic and unknown keys. */
export function getPanelScopeBehaviour(key: string): PanelScopeBehaviour {
  return Object.prototype.hasOwnProperty.call(PANEL_SCOPE_BEHAVIOUR, key)
    ? PANEL_SCOPE_BEHAVIOUR[key]!
    : 'unsupported';
}
