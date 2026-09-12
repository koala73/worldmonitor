// Reviewed widget data subset, not the full API registry. New entries require review.
const BOOTSTRAP_GROUPS = {
  "Market & Crypto": [
    "marketQuotes",
    "commodityQuotes",
    "cryptoQuotes",
    "gulfQuotes",
    "sectors",
    "etfFlows",
    "cryptoSectors",
    "defiTokens",
    "aiTokens",
    "otherTokens",
    "stablecoinMarkets",
    "fearGreedIndex"
  ],
  "Economic & Energy": [
    "macroSignals",
    "bisPolicy",
    "bisExchange",
    "bisCredit",
    "nationalDebt",
    "bigmac",
    "fuelPrices",
    "euGasStorage",
    "natGasStorage",
    "crudeInventories",
    "ecbFxRates",
    "euFsi",
    "groceryBasket",
    "eurostatCountryData",
    "progressData",
    "renewableEnergy",
    "spending",
    "correlationCards",
    "faoFoodPriceIndex"
  ],
  "Tech & Intelligence": [
    "techReadiness",
    "techEvents",
    "riskScores",
    "crossSourceSignals",
    "securityAdvisories",
    "gdeltIntel"
  ],
  "Conflict & Unrest": [
    "ucdpEvents",
    "unrestEvents",
    "theaterPosture"
  ],
  "Infrastructure & Environment": [
    "earthquakes",
    "wildfires",
    "naturalEvents",
    "thermalEscalation",
    "climateAnomalies",
    "radiationWatch",
    "weatherAlerts",
    "outages",
    "serviceStatuses",
    "ddosAttacks",
    "trafficAnomalies"
  ],
  "Supply Chain & Trade": [
    "shippingRates",
    "chokepoints",
    "minerals",
    "customsRevenue",
    "sanctionsPressure",
    "shippingStress"
  ],
  "Consumer Prices": [
    "consumerPricesOverview",
    "consumerPricesCategories",
    "consumerPricesMovers",
    "consumerPricesSpread"
  ],
  "Health & Social": [
    "diseaseOutbreaks",
    "socialVelocity"
  ],
  "Other": [
    "flightDelays",
    "cyberThreats",
    "positiveGeoEvents",
    "predictions",
    "forecasts",
    "giving",
    "insights"
  ]
};

const RPC_ROUTES = {
  "/api/economic/v1/list-world-bank-indicators": "(params: indicator_code, country_code)",
  "/api/economic/v1/get-fred-series": "(params: series_id e.g. UNRATE/CPIAUCSL/DGS10)",
  "/api/economic/v1/get-eurostat-country-data": "",
  "/api/trade/v1/get-trade-flows": "",
  "/api/trade/v1/get-trade-restrictions": "",
  "/api/trade/v1/get-tariff-trends": "",
  "/api/trade/v1/get-trade-barriers": "",
  "/api/trade/v1/list-comtrade-flows": "",
  "/api/aviation/v1/get-airport-ops-summary": "(params: airport_code)",
  "/api/aviation/v1/get-carrier-ops": "(params: carrier_code)",
  "/api/aviation/v1/list-aviation-news": "",
  "/api/intelligence/v1/get-country-facts": "(params: country_code)",
  "/api/intelligence/v1/get-social-velocity": "",
  "/api/health/v1/list-disease-outbreaks": "",
  "/api/supply-chain/v1/get-shipping-stress": "",
  "/api/supply-chain/v1/get-country-chokepoint-index": "(params: iso2 required, hs2 default '27'; PRO-gated — returns exposures[], vulnerabilityIndex 0-100, primaryChokepointId)",
  "/api/supply-chain/v1/get-bypass-options": "(params: chokepointId required, cargoType default 'container', closurePct default 100; PRO-gated — returns options[] sorted by liveScore asc, each with addedTransitDays/addedCostMultiplier/bypassWarRiskTier; also primaryChokepointWarRiskTier)",
  "/api/supply-chain/v1/get-country-cost-shock": "(params: iso2 required, chokepointId required, hs2 default '27'; PRO-gated — returns supplyDeficitPct 0-100%, coverageDays, warRiskPremiumBps, warRiskTier; hasEnergyModel=true only for HS 27 + Hormuz/Suez/Malacca/BEM)",
  "/api/conflict/v1/list-acled-events": "",
  "/api/conflict/v1/get-humanitarian-summary": "(params: country_code)",
  "/api/market/v1/get-country-stock-index": "(params: country_code)",
  "/api/market/v1/list-earnings-calendar": "",
  "/api/market/v1/get-cot-positioning": "",
  "/api/consumer-prices/v1/list-retailer-price-spreads": "",
  "/api/maritime/v1/list-navigational-warnings": "",
  "/api/news/v1/list-feed-digest": ""
};

const BOOTSTRAP_KEYS = new Set(Object.values(BOOTSTRAP_GROUPS).flat());
const API_ORIGIN = 'https://api.worldmonitor.app';

const WIDGET_DATA_CATALOG = `## Option 1 — Bootstrap (pre-seeded dashboard data)
Use: /api/bootstrap?keys=<key> — response shape: { data: { <key>: <array or object> } }
PREFER this over RPCs whenever a key matches the user's topic.
Supply one or more comma-separated approved keys. For an anonymous single-key read, append &public=1.
Only keys and the optional public=1 marker are allowed; the API may deny keys that are not public.

${Object.entries(BOOTSTRAP_GROUPS).map(([group, keys]) => `${group}:\n  ${keys.join(', ')}`).join('\n\n')}

## Option 2 — Data RPCs (use when no bootstrap key matches; supports custom GET params)
${Object.entries(RPC_ROUTES).map(([route, note]) => `${route}${note ? ` ${note}` : ''}`).join('\n')}
Downstream access checks still apply; widget tier does not grant API entitlement.
`;

function approvedBootstrapQuery(searchParams, requireKeys) {
  if ([...searchParams.keys()].some(key => key !== 'keys' && key !== 'public')) return false;
  const markers = searchParams.getAll('public');
  if (markers.length > 1 || (markers.length === 1 && markers[0] !== '1')) return false;
  const values = searchParams.getAll('keys');
  if (!values.length) return !requireKeys;
  return values.length === 1
    && (!markers.length || !values[0].includes(','))
    && values[0].split(',').every(key => BOOTSTRAP_KEYS.has(key));
}

// Validate both supplied queries and the final URL. Never let URL normalization
// turn a denied spelling into an approved path, or params hide a denied key.
function buildWidgetDataUrl(endpoint, params = {}) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/')
      || /[\\#\s\u0000-\u001f\u007f]/u.test(endpoint)
      || /%(?![0-9a-f]{2})/i.test(endpoint)
      || !params || typeof params !== 'object' || Array.isArray(params)) return null;
  const rawPath = endpoint.split('?')[0];
  if (rawPath !== '/api/bootstrap' && !Object.hasOwn(RPC_ROUTES, rawPath)) return null;
  const entries = Object.entries(params);
  if (entries.some(([, value]) => typeof value !== 'string')) return null;

  const url = new URL(endpoint, API_ORIGIN);
  if (url.origin !== API_ORIGIN || url.pathname !== rawPath || url.username || url.password || url.hash) return null;
  if (rawPath === '/api/bootstrap'
      && (!approvedBootstrapQuery(url.searchParams, false)
          || !approvedBootstrapQuery(new URLSearchParams(entries), false))) return null;
  for (const [key, value] of entries) url.searchParams.set(key, value);
  if (url.origin !== API_ORIGIN || url.pathname !== rawPath
      || (rawPath === '/api/bootstrap' && !approvedBootstrapQuery(url.searchParams, true))) return null;
  return url;
}

module.exports = { WIDGET_DATA_CATALOG, buildWidgetDataUrl };
