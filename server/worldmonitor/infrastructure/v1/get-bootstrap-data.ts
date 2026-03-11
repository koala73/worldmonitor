import type {
  InfrastructureServiceHandler,
  ServerContext,
  GetBootstrapDataRequest,
  GetBootstrapDataResponse,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';

const BOOTSTRAP_KEYS_MAP: Record<string, string> = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
  marketQuotes:     'market:stocks-bootstrap:v1',
  commodityQuotes:  'market:commodities-bootstrap:v1',
  sectors:          'market:sectors:v1',
  etfFlows:         'market:etf-flows:v1',
  macroSignals:     'economic:macro-signals:v1',
  bisPolicy:        'economic:bis:policy:v1',
  bisExchange:      'economic:bis:eer:v1',
  bisCredit:        'economic:bis:credit:v1',
  shippingRates:    'supply_chain:shipping:v2',
  chokepoints:      'supply_chain:chokepoints:v2',
  minerals:         'supply_chain:minerals:v2',
  giving:           'giving:summary:v1',
  climateAnomalies: 'climate:anomalies:v1',
  wildfires:        'wildfire:fires:v1',
  cyberThreats:     'cyber:threats-bootstrap:v2',
  techReadiness:    'economic:worldbank-techreadiness:v1',
  progressData:     'economic:worldbank-progress:v1',
  renewableEnergy:  'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive-events:geo-bootstrap:v1',
  theaterPosture: 'theater-posture:sebuf:stale:v1',
  riskScores: 'risk:scores:sebuf:stale:v1',
  naturalEvents: 'natural:events:v1',
  flightDelays: 'aviation:delays-bootstrap:v1',
  insights: 'news:insights:v1',
  predictions: 'prediction:markets-bootstrap:v1',
  cryptoQuotes: 'market:crypto:v1',
  gulfQuotes: 'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents: 'unrest:events:v1',
  iranEvents: 'conflict:iran-events:v1',
  ucdpEvents: 'conflict:ucdp-events:v1',
  temporalAnomalies: 'temporal:anomalies:v1',
  weatherAlerts:     'weather:alerts:v1',
  spending:          'economic:spending:v1',
};

const SLOW_KEYS = new Set([
  'bisPolicy', 'bisExchange', 'bisCredit', 'minerals', 'giving',
  'sectors', 'etfFlows', 'shippingRates', 'wildfires', 'climateAnomalies',
  'cyberThreats', 'techReadiness', 'progressData', 'renewableEnergy',
  'naturalEvents',
  'cryptoQuotes', 'gulfQuotes', 'stablecoinMarkets', 'unrestEvents', 'ucdpEvents',
]);
const FAST_KEYS = new Set([
  'earthquakes', 'outages', 'serviceStatuses', 'macroSignals', 'chokepoints',
  'marketQuotes', 'commodityQuotes', 'positiveGeoEvents', 'riskScores', 'flightDelays','insights', 'predictions',
  'iranEvents', 'temporalAnomalies', 'weatherAlerts', 'spending', 'theaterPosture',
]);

/**
 * GetBootstrapData performs bulk Redis key retrieval for initial app state.
 */
export const getBootstrapData: InfrastructureServiceHandler['getBootstrapData'] = async (
  _ctx: ServerContext,
  req: GetBootstrapDataRequest,
): Promise<GetBootstrapDataResponse> => {
  const { tier, keys: requestedKeys } = req;
  
  let registry: Record<string, string>;
  if (tier === 'slow' || tier === 'fast') {
    const tierSet = tier === 'slow' ? SLOW_KEYS : FAST_KEYS;
    registry = Object.fromEntries(Object.entries(BOOTSTRAP_KEYS_MAP).filter(([k]) => tierSet.has(k)));
  } else if (requestedKeys && requestedKeys.length > 0) {
    registry = Object.fromEntries(Object.entries(BOOTSTRAP_KEYS_MAP).filter(([k]) => requestedKeys.includes(k)));
  } else {
    registry = BOOTSTRAP_KEYS_MAP;
  }

  const names = Object.keys(registry);
  const cacheKeys = Object.values(registry);

  try {
    const cached = await getCachedJsonBatch(cacheKeys);
    const data: Record<string, string> = {};
    const missing: string[] = [];

    for (let i = 0; i < names.length; i++) {
       const val = cached.get(cacheKeys[i]!);
       if (val !== undefined) {
         data[names[i]!] = JSON.stringify(val);
       } else {
         missing.push(names[i]!);
       }
    }

    return { data, missing };
  } catch (err) {
    return { data: {}, missing: names };
  }
};
