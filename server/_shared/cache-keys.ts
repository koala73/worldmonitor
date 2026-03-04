/**
 * Static cache keys for the bootstrap endpoint.
 * Only keys with NO request-varying suffixes are included.
 */
export const BOOTSTRAP_CACHE_KEYS: Record<string, string> = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
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
};

export const BOOTSTRAP_TIERS: Record<string, 'slow' | 'fast'> = {
  bisPolicy: 'slow', bisExchange: 'slow', bisCredit: 'slow',
  minerals: 'slow', giving: 'slow', sectors: 'slow',
  etfFlows: 'slow', shippingRates: 'slow', wildfires: 'slow',
  climateAnomalies: 'slow',
  earthquakes: 'fast', outages: 'fast', serviceStatuses: 'fast',
  macroSignals: 'fast', chokepoints: 'fast',
};
