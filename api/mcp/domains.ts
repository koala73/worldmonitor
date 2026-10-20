/**
 * MCP tool domains: the one source for which domain each registry tool
 * belongs to and for the domain list that discovery surfaces quote.
 *
 * Consumed at build time only, by scripts/generate-public-product-facts.mjs,
 * which renders the categories, tags, and per-tool category onto the server
 * card and splices MCP_DOMAIN_SUMMARY into the generated spans of the
 * markdown and JSON discovery files. The live `tools/list` wire shape does
 * not read this module. tests/mcp-domains.test.mjs fails when a registry tool
 * has no category here.
 */

export type McpToolCategoryId =
  | 'markets-economy'
  | 'energy'
  | 'geopolitical-security'
  | 'movement-infrastructure'
  | 'environment-science'
  | 'health'
  | 'humanitarian-displacement'
  | 'ai-intelligence'
  | 'trade-tariffs'
  | 'meta';

export interface McpToolCategory {
  id: McpToolCategoryId;
  /** Noun phrase quoted in MCP_DOMAIN_SUMMARY. Omitted for server utilities. */
  summaryPhrase?: string;
}

/** Ordered as the server card's `toolCategories` and the domain summary list them. */
export const MCP_TOOL_CATEGORIES: readonly McpToolCategory[] = [
  { id: 'markets-economy', summaryPhrase: 'markets, commodities and macro' },
  { id: 'energy', summaryPhrase: 'energy' },
  { id: 'geopolitical-security', summaryPhrase: 'conflicts, country risk, sanctions, cyber threats and chokepoints' },
  { id: 'movement-infrastructure', summaryPhrase: 'maritime, aviation and supply chains' },
  { id: 'environment-science', summaryPhrase: 'climate and natural disasters' },
  { id: 'health', summaryPhrase: 'health signals' },
  { id: 'humanitarian-displacement', summaryPhrase: 'displacement and humanitarian crises' },
  { id: 'ai-intelligence', summaryPhrase: 'AI briefs, forecasts and intel history' },
  { id: 'trade-tariffs', summaryPhrase: 'tariffs and trade policy' },
  { id: 'meta' },
];

export const TOOL_CATEGORY_BY_NAME: Readonly<Record<string, McpToolCategoryId>> = {
  // Markets & economy
  get_market_data: 'markets-economy',
  get_economic_data: 'markets-economy',
  get_procurement_opportunities: 'markets-economy',
  get_company_intelligence: 'markets-economy',
  get_country_macro: 'markets-economy',
  get_eu_housing_cycle: 'markets-economy',
  get_eu_quarterly_gov_debt: 'markets-economy',
  get_eu_industrial_production: 'markets-economy',
  get_consumer_prices: 'markets-economy',
  get_food_stocks: 'markets-economy',
  get_demographics_capability: 'markets-economy',
  get_five_factor_scorecard: 'markets-economy',
  list_five_factor_scorecards: 'markets-economy',
  get_resilience_indicators: 'markets-economy',
  get_mineral_production: 'markets-economy',
  get_commodity_geo: 'markets-economy',
  get_prediction_markets: 'markets-economy',
  get_stock_research: 'markets-economy',
  get_gold_intelligence: 'markets-economy',
  get_macro_history: 'markets-economy',
  get_price_and_debt_indicators: 'markets-economy',
  get_capital_flows: 'markets-economy',
  // Trade & tariffs
  get_wto_trade_flows: 'trade-tariffs',
  get_tariff_averages: 'trade-tariffs',
  get_bilateral_tariff: 'trade-tariffs',
  get_us_import_duty: 'trade-tariffs',
  // Energy
  compute_energy_shock: 'energy',
  get_supply_chain_cost_shock: 'energy',
  get_energy_intelligence: 'energy',
  get_oil_trade_series: 'energy',
  // Geopolitical & security
  get_conflict_events: 'geopolitical-security',
  get_toronto_reported_occurrences: 'geopolitical-security',
  get_toronto_calls_attended: 'geopolitical-security',
  get_country_risk: 'geopolitical-security',
  get_country_history: 'geopolitical-security',
  get_country_coverage: 'geopolitical-security',
  list_x_feed: 'geopolitical-security',
  get_defense_industrial_base: 'geopolitical-security',
  open_country_brief: 'geopolitical-security',
  get_country_brief_section: 'geopolitical-security',
  get_country_brief: 'geopolitical-security',
  get_news_intelligence: 'geopolitical-security',
  get_cyber_threats: 'geopolitical-security',
  get_sanctions_data: 'geopolitical-security',
  get_social_velocity: 'geopolitical-security',
  get_temporal_anomalies: 'geopolitical-security',
  get_test_site_seismicity: 'geopolitical-security',
  get_signal_convergence: 'geopolitical-security',
  get_focal_points: 'geopolitical-security',
  simulate_infrastructure_cascade: 'geopolitical-security',
  get_military_surge: 'geopolitical-security',
  get_population_exposure: 'geopolitical-security',
  get_alert_digest: 'geopolitical-security',
  get_hotspot_escalation: 'geopolitical-security',
  get_china_decision_signals: 'geopolitical-security',
  get_military_posture: 'geopolitical-security',
  get_chokepoint_status: 'geopolitical-security',
  get_supply_vulnerabilities: 'geopolitical-security',
  get_chokepoint_dependencies: 'geopolitical-security',
  get_positive_events: 'geopolitical-security',
  // Movement & infrastructure
  get_aviation_status: 'movement-infrastructure',
  get_airspace: 'movement-infrastructure',
  get_maritime_activity: 'movement-infrastructure',
  get_supply_chain_data: 'movement-infrastructure',
  get_infrastructure_status: 'movement-infrastructure',
  search_flights: 'movement-infrastructure',
  search_flight_prices_by_date: 'movement-infrastructure',
  // Environment & science
  get_climate_data: 'environment-science',
  get_imd_cyclone_marine: 'environment-science',
  get_natural_disasters: 'environment-science',
  get_radiation_data: 'environment-science',
  get_research_signals: 'environment-science',
  // Health
  get_health_signals: 'health',
  // Humanitarian & displacement
  get_cross_border_arrivals: 'humanitarian-displacement',
  get_displacement_data: 'humanitarian-displacement',
  // AI intelligence, including historical intelligence
  get_world_brief: 'ai-intelligence',
  analyze_situation: 'ai-intelligence',
  get_forecast_predictions: 'ai-intelligence',
  get_forecast_case: 'ai-intelligence',
  get_forecast_theaters: 'ai-intelligence',
  get_forecast_scorecard: 'ai-intelligence',
  search_intel_history: 'ai-intelligence',
  get_intel_timeline: 'ai-intelligence',
  get_similar_events: 'ai-intelligence',
  // Meta: server utilities and NLP helpers, never quoted as a data domain
  get_sources: 'meta',
  get_mcp_allowance: 'meta',
  start_upgrade: 'meta',
  describe_tool: 'meta',
  open_news_dashboard: 'meta',
  analyze_news_headlines: 'meta',
  classify_event: 'meta',
  extract_entities: 'meta',
  get_news_clusters: 'meta',
  get_keyword_spikes: 'meta',
  verify_claim: 'meta',
};

export const MCP_TAGS: readonly string[] = [
  'geopolitical-intelligence',
  'live-data',
  'global',
  'macroeconomic',
  'real-time',
  'markets',
  'conflict',
  'energy',
  'climate',
  'supply-chain',
  'trade',
  'tariffs',
];

/** Semicolon list of the data domains (phrases carry commas), rendered into every generated discovery span. */
export const MCP_DOMAIN_SUMMARY: string = MCP_TOOL_CATEGORIES
  .flatMap((category) => (category.summaryPhrase ? [category.summaryPhrase] : []))
  .join('; ');
