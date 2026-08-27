/**
 * Frozen bootstrap byte ledger for #7046 / PR #7049.
 *
 * Provenance: one complete, credential-free production response per tier,
 * captured with `Origin: https://worldmonitor.app` on 2026-08-21. Both bodies
 * parsed as `{ data, missing: [] }`. The response bytes and SHA-256 hashes are
 * recorded below; payload values are deliberately not checked in.
 *
 * This is a single auditable pre-change snapshot. It is not the full daily
 * U1/RUM baseline required by #7047 and proves no transfer-time distribution.
 * It does prove the decoded byte effect of membership-only changes at this
 * complete production shape. Any unmeasured key or ledger shrinkage fails the
 * tests instead of being replaced by a generic stub.
 */

export const ENERGY_ON_DEMAND_KEYS = Object.freeze([
  'pipelinesGas',
  'pipelinesOil',
  'storageFacilities',
]);

export const DEMOTED_FAST_KEYS = Object.freeze([
  'forecasts',
  'correlationCards',
  'flightDelays',
  'wsbTickers',
]);

export const FAST_FIRST_PAINT_JUSTIFICATION = Object.freeze({
  earthquakes: 'Default-on natural map layer; consumed by loadNatural after the slow checkpoint but needed for the first map fill.',
  outages: 'Default-on outages map layer and internet-disruptions status.',
  serviceStatuses: 'Paired with the outages first-wave status strip.',
  ddosAttacks: 'Loaded with the default-on outages wave.',
  trafficAnomalies: 'Loaded with the default-on outages wave.',
  marketQuotes: 'Default markets panel data; retained once the 20% target is met to avoid a new startup request.',
  commodityQuotes: 'Default commodities and energy tapes; retained once the 20% target is met to avoid a new startup request.',
  macroSignals: 'Immediate macro tiles on finance/full first paint.',
  chokepoints: 'Chokepoint strip and default supply-chain map markers.',
  positiveGeoEvents: 'Happy/full positive-events first wave.',
  riskScores: 'CII / strategic-risk first-wave scores.',
  insights: 'Insights / threat-timeline first-wave cards.',
  predictions: 'Polymarket first-wave when the panel is in view.',
  iranEvents: 'Iran-attacks layer when the sunset gate is on.',
  temporalAnomalies: 'Consumed into the signal aggregator at startup.',
  weatherAlerts: 'Default-on weather map layer on full desktop and mobile.',
  spending: 'Economic panel first-wave when the layer/panel is in view.',
  theaterPosture: 'Strategic-posture first-wave.',
  gdeltIntel: 'GDELT intel first-wave.',
  canadaAlerts: 'Default-on Canada alerts layer on full desktop.',
  shippingRates: 'Supply-chain first-wave rates.',
  shippingStress: 'Supply-chain first-wave stress.',
  socialVelocity: 'Retained once the 20% target is met to avoid another default dashboard request.',
});

export const PRODUCTION_CAPTURE = Object.freeze({
  capturedAt: '2026-08-21T14:51:50Z',
  origin: 'https://worldmonitor.app',
  requestShape: 'GET https://api.worldmonitor.app/api/bootstrap?tier=<tier>&public=1',
  completeness: 'Both responses were HTTP 200, parsed successfully, and declared missing: [].',
  limitation: 'Single complete public capture; not the full daily #7047 U1/RUM baseline.',
  tiers: Object.freeze({
    fast: Object.freeze({
      decodedBytes: 921_832,
      sha256: '9723bf77e7a88323e58e747977c64d8ba1bcee77b72b9db06fe5d37c2773d3de',
    }),
    slow: Object.freeze({
      decodedBytes: 1_977_154,
      sha256: '0d4caebf63182d1f816ec41bfc47b0f5e30efc378722b0cab785ebd70d85bcdb',
    }),
  }),
});

export const CAPTURED_BASE_TIER_KEYS = Object.freeze({
  fast: Object.freeze([
    'earthquakes', 'outages', 'serviceStatuses', 'ddosAttacks', 'trafficAnomalies',
    'marketQuotes', 'commodityQuotes', 'macroSignals', 'shippingRates', 'chokepoints',
    'positiveGeoEvents', 'theaterPosture', 'riskScores', 'flightDelays', 'insights',
    'predictions', 'temporalAnomalies', 'weatherAlerts', 'canadaAlerts', 'spending',
    'gdeltIntel', 'correlationCards', 'forecasts', 'shippingStress', 'socialVelocity',
    'wsbTickers',
  ]),
  slow: Object.freeze([
    'sectors', 'etfFlows', 'bisPolicy', 'bisExchange', 'bisCredit', 'chinaMacro',
    'chinaReleaseCalendar', 'chinaCorporateDisclosures', 'minerals', 'giving',
    'climateAnomalies', 'climateDisasters', 'co2Monitoring', 'oceanIce', 'climateNews',
    'radiationWatch', 'thermalEscalation', 'crossSourceSignals', 'wildfires',
    'techReadiness', 'progressData', 'renewableEnergy', 'naturalEvents', 'cryptoQuotes',
    'cryptoSectors', 'defiTokens', 'aiTokens', 'otherTokens', 'gulfQuotes',
    'stablecoinMarkets', 'unrestEvents', 'ucdpEvents', 'techEvents',
    'crossStraitActivity', 'securityAdvisories', 'customsRevenue', 'sanctionsPressure',
    'consumerPricesOverview', 'consumerPricesCategories', 'consumerPricesMovers',
    'consumerPricesSpread', 'groceryBasket', 'bigmac', 'fuelPrices', 'faoFoodPriceIndex',
    'nationalDebt', 'euGasStorage', 'eurostatCountryData', 'marketImplications',
    'fearGreedIndex', 'hyperliquidFlow', 'crudeInventories', 'natGasStorage',
    'ecbFxRates', 'euFsi', 'pizzint', 'diseaseOutbreaks', 'economicStress',
    'oilStocksAnalysis', 'lngVulnerability', 'pipelinesGas', 'pipelinesOil',
    'storageFacilities', 'fuelShortages', 'energyCrisisPolicies', 'aaiiSentiment',
    'breadthHistory',
  ]),
});

/** Exact UTF-8 bytes of JSON.stringify(data[key]) from the frozen responses. */
export const CAPTURED_KEY_DECODED_BYTES = Object.freeze({
  earthquakes: 48_361,
  outages: 3_702,
  serviceStatuses: 6_583,
  ddosAttacks: 744,
  trafficAnomalies: 3_045,
  marketQuotes: 296_547,
  commodityQuotes: 116_985,
  macroSignals: 3_112,
  shippingRates: 8_180,
  chokepoints: 13_837,
  positiveGeoEvents: 25_682,
  theaterPosture: 1_302,
  riskScores: 10_352,
  flightDelays: 57_826,
  insights: 10_115,
  predictions: 24_493,
  temporalAnomalies: 98,
  weatherAlerts: 52_633,
  canadaAlerts: 61_389,
  spending: 4_762,
  gdeltIntel: 24_612,
  correlationCards: 87_842,
  forecasts: 40_048,
  shippingStress: 4_288,
  socialVelocity: 10_574,
  wsbTickers: 4_275,
  sectors: 4_086,
  etfFlows: 1_848,
  bisPolicy: 1_395,
  bisExchange: 1_354,
  bisCredit: 1_310,
  chinaMacro: 44_014,
  chinaReleaseCalendar: 58_122,
  chinaCorporateDisclosures: 18_932,
  minerals: 2_132,
  giving: 12_544,
  climateAnomalies: 5_031,
  climateDisasters: 21_205,
  co2Monitoring: 822,
  oceanIce: 970,
  climateNews: 51_058,
  radiationWatch: 5_727,
  thermalEscalation: 18_616,
  crossSourceSignals: 9_057,
  wildfires: 165_622,
  techReadiness: 45_451,
  progressData: 6_791,
  renewableEnergy: 1_893,
  naturalEvents: 200_792,
  cryptoQuotes: 9_713,
  cryptoSectors: 414,
  defiTokens: 831,
  aiTokens: 885,
  otherTokens: 848,
  gulfQuotes: 47_557,
  stablecoinMarkets: 1_550,
  unrestEvents: 85_902,
  ucdpEvents: 130_821,
  techEvents: 34_580,
  crossStraitActivity: 13_601,
  securityAdvisories: 70_091,
  customsRevenue: 6_124,
  sanctionsPressure: 17_603,
  consumerPricesOverview: 1_216,
  consumerPricesCategories: 1_074,
  consumerPricesMovers: 892,
  consumerPricesSpread: 825,
  groceryBasket: 52_344,
  bigmac: 9_506,
  fuelPrices: 11_592,
  faoFoodPriceIndex: 1_285,
  nationalDebt: 45_401,
  euGasStorage: 452,
  eurostatCountryData: 2_197,
  marketImplications: 5_963,
  fearGreedIndex: 2_557,
  hyperliquidFlow: 55_977,
  crudeInventories: 558,
  natGasStorage: 519,
  ecbFxRates: 514,
  euFsi: 13_146,
  pizzint: 3_495,
  diseaseOutbreaks: 68_863,
  economicStress: 620,
  oilStocksAnalysis: 4_057,
  lngVulnerability: 2_501,
  pipelinesGas: 193_403,
  pipelinesOil: 221_043,
  storageFacilities: 113_540,
  fuelShortages: 22_020,
  energyCrisisPolicies: 28_423,
  aaiiSentiment: 4_623,
  breadthHistory: 8_059,
});

// Absolute final ceilings are the required reductions applied to the complete
// capture, not to a hand-picked subset: FAST <= 80%, SLOW <= 75% of base.
export const FINAL_TIER_DECODED_BYTE_CEILINGS = Object.freeze({
  fast: 737_465,
  slow: 1_482_865,
});

export const BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST = Object.freeze({
  version: 1,
  capturedAt: PRODUCTION_CAPTURE.capturedAt,
  tiers: Object.freeze({
    fast: Object.freeze({
      preChangeCeilingBytes: PRODUCTION_CAPTURE.tiers.fast.decodedBytes,
      finalTargetBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.fast,
      minimumCapturedKeyCount: CAPTURED_BASE_TIER_KEYS.fast.length,
      materialGrowthRatio: 0.05,
      materialGrowthFloorBytes: 2_048,
      reviewedExceptions: Object.freeze({}),
    }),
    slow: Object.freeze({
      preChangeCeilingBytes: PRODUCTION_CAPTURE.tiers.slow.decodedBytes,
      finalTargetBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.slow,
      minimumCapturedKeyCount: CAPTURED_BASE_TIER_KEYS.slow.length,
      materialGrowthRatio: 0.05,
      materialGrowthFloorBytes: 2_048,
      reviewedExceptions: Object.freeze({}),
    }),
  }),
});

export const REPRESENTATIVE_FIXTURE_CONTRACTS = Object.freeze({
  fast: Object.freeze({
    marketQuotes: Object.freeze({
      collection: 'quotes',
      minimumRecords: 93,
      requiredFields: Object.freeze(['symbol', 'name', 'price', 'change']),
    }),
    weatherAlerts: Object.freeze({
      collection: 'alerts',
      minimumRecords: 50,
      requiredFields: Object.freeze(['id', 'event', 'severity']),
    }),
  }),
  slow: Object.freeze({
    wildfires: Object.freeze({
      collection: 'fireDetections',
      minimumRecords: 500,
      requiredFields: Object.freeze(['brightness', 'detectedAt']),
    }),
    ucdpEvents: Object.freeze({
      collection: 'events',
      minimumRecords: 150,
      requiredFields: Object.freeze(['id', 'country', 'dateStart', 'violenceType']),
    }),
  }),
});

// These row builders are deliberately separate from
// REPRESENTATIVE_FIXTURE_CONTRACTS. Do not make them accept a contract, count,
// collection name, or required-field list: then weakening a validator cannot
// regenerate a smaller or less complete payload that it will also accept.
const representativeMarketQuotes = Object.freeze(Array.from({ length: 93 }, (_, index) => Object.freeze({
  symbol: `WM${String(index).padStart(3, '0')}`,
  name: `WorldMonitor Representative Equity ${index}`,
  price: 1000 + (index * 1.25),
  change: ((index % 9) - 4) / 10,
})));

const representativeWeatherAlerts = Object.freeze(Array.from({ length: 50 }, (_, index) => Object.freeze({
  id: `weather-${String(index).padStart(3, '0')}`,
  event: index % 2 === 0 ? 'Severe Thunderstorm Warning' : 'Flood Watch',
  severity: index % 3 === 0 ? 'Severe' : 'Moderate',
})));

const representativeWildfires = Object.freeze(Array.from({ length: 500 }, (_, index) => Object.freeze({
  brightness: 300 + (index / 10),
  detectedAt: `2026-08-21T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
})));

const representativeUcdpEvents = Object.freeze(Array.from({ length: 150 }, (_, index) => Object.freeze({
  id: `ucdp-${String(index).padStart(3, '0')}`,
  country: index % 2 === 0 ? 'Exampleland' : 'Sample Republic',
  dateStart: `2026-08-${String((index % 28) + 1).padStart(2, '0')}`,
  violenceType: index % 3 === 0 ? 'state-based' : 'one-sided',
})));

/**
 * Small, deterministic shape fixtures for the largest mutable collections in
 * each tier. Production values are not checked in; cardinality and the fields
 * the dashboard consumes are. The frozen byte ledger above owns size evidence.
 */
export const REPRESENTATIVE_BOOTSTRAP_PAYLOADS = Object.freeze({
  fast: Object.freeze({
    data: Object.freeze({
      marketQuotes: Object.freeze({ quotes: representativeMarketQuotes }),
      weatherAlerts: Object.freeze({ alerts: representativeWeatherAlerts }),
    }),
    missing: Object.freeze([]),
  }),
  slow: Object.freeze({
    data: Object.freeze({
      wildfires: Object.freeze({ fireDetections: representativeWildfires }),
      ucdpEvents: Object.freeze({ events: representativeUcdpEvents }),
    }),
    missing: Object.freeze([]),
  }),
});

// Exact byte measurements from buildBootstrapPayloadByteLedger for the fixed
// representative payloads above. These are a second frozen baseline alongside
// the production capture: candidate budgets count only newly measured growth,
// rather than treating the production capture as a proxy for current shape.
// Values are intentionally literal so changing fixture data cannot update the
// baseline at the same time.
export const REPRESENTATIVE_PAYLOAD_BYTE_BASELINES = Object.freeze({
  fast: Object.freeze({
    totalBytes: 12_449,
    keyBytes: Object.freeze({ marketQuotes: 8_780, weatherAlerts: 3_644 }),
  }),
  slow: Object.freeze({
    totalBytes: 42_982,
    keyBytes: Object.freeze({ wildfires: 28_432, ucdpEvents: 14_525 }),
  }),
});

export function assertRepresentativeBootstrapFixtures(fixtures = REPRESENTATIVE_BOOTSTRAP_PAYLOADS) {
  for (const tier of ['fast', 'slow']) {
    const payload = fixtures[tier];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`${tier} representative payload is missing`);
    }
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw new Error(`${tier} representative payload data is malformed`);
    }
    if (!Array.isArray(payload.missing)) {
      throw new Error(`${tier} representative payload missing list is malformed`);
    }

    for (const [key, contract] of Object.entries(REPRESENTATIVE_FIXTURE_CONTRACTS[tier])) {
      const records = payload.data[key]?.[contract.collection];
      if (!Array.isArray(records) || records.length < contract.minimumRecords) {
        throw new Error(
          `${tier}.${key}.${contract.collection} has ${records?.length ?? 0} records; `
          + `expected at least ${contract.minimumRecords}`,
        );
      }
      for (const [index, record] of records.entries()) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error(`${tier}.${key}.${contract.collection}[${index}] is malformed`);
        }
        for (const field of contract.requiredFields) {
          if (!Object.hasOwn(record, field)) {
            throw new Error(`${tier}.${key}.${contract.collection}[${index}] is missing ${field}`);
          }
        }
      }
    }
  }
}

export function bootstrapPayloadBudgetViolations(tier, ledger) {
  const budget = BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers[tier];
  if (!budget) throw new TypeError(`Unknown bootstrap budget tier: ${tier}`);
  const violations = [];
  if (ledger.totalBytes > budget.finalTargetBytes) {
    violations.push(
      `${tier} aggregate ${ledger.totalBytes} B exceeds final target ${budget.finalTargetBytes} B`,
    );
  }

  for (const [key, bytes] of Object.entries(ledger.keyBytes)) {
    const capturedBytes = CAPTURED_KEY_DECODED_BYTES[key];
    if (!Number.isInteger(capturedBytes)) continue;
    const materialGrowth = Math.max(
      budget.materialGrowthFloorBytes,
      Math.ceil(capturedBytes * budget.materialGrowthRatio),
    );
    if (bytes <= capturedBytes + materialGrowth) continue;

    const exception = budget.reviewedExceptions[key];
    if (
      exception
      && typeof exception.rationale === 'string'
      && exception.rationale.trim().length > 0
      && Number.isInteger(exception.ceilingBytes)
      && bytes <= exception.ceilingBytes
    ) {
      continue;
    }
    violations.push(
      `${tier}.${key} ${bytes} B exceeds captured ${capturedBytes} B by material threshold ${materialGrowth} B without a reviewed exception`,
    );
  }
  return violations;
}

/**
 * Adds current representative-payload growth to the captured membership
 * candidate. The real publisher ledger is supplied by the caller so the
 * budget uses the same UTF-8 accounting as a published public payload.
 */
export function buildBootstrapPayloadBudgetCandidate(tier, keys, representativeLedger) {
  const baseline = REPRESENTATIVE_PAYLOAD_BYTE_BASELINES[tier];
  if (!baseline) throw new TypeError(`Unknown bootstrap budget tier: ${tier}`);
  if (!representativeLedger || !Number.isInteger(representativeLedger.totalBytes)
    || !Array.isArray(representativeLedger.keys)) {
    throw new TypeError('Bootstrap budget candidate requires a byte ledger');
  }

  const measuredKeyBytes = Object.fromEntries(representativeLedger.keys.map(({ key, bytes }) => [key, bytes]));
  for (const key of Object.keys(baseline.keyBytes)) {
    if (!Number.isInteger(measuredKeyBytes[key])) {
      throw new Error(`${tier} representative ledger is missing frozen key: ${key}`);
    }
  }

  const keyBytes = Object.fromEntries(keys.map((key) => [key, CAPTURED_KEY_DECODED_BYTES[key]]));
  for (const [key, baselineBytes] of Object.entries(baseline.keyBytes)) {
    if (!Object.hasOwn(keyBytes, key)) continue;
    keyBytes[key] += Math.max(0, measuredKeyBytes[key] - baselineBytes);
  }

  return {
    totalBytes: tierPayloadBytesFromLedger(keys)
      + Math.max(0, representativeLedger.totalBytes - baseline.totalBytes),
    keyBytes,
  };
}

export function tierPayloadBytesFromLedger(keys) {
  let bytes = Buffer.byteLength('{"data":{', 'utf8');
  keys.forEach((key, index) => {
    const valueBytes = CAPTURED_KEY_DECODED_BYTES[key];
    if (!Number.isInteger(valueBytes) || valueBytes < 0) {
      throw new Error(`No production byte evidence for bootstrap key: ${key}`);
    }
    if (index > 0) bytes += 1;
    bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + valueBytes;
  });
  return bytes + Buffer.byteLength('},"missing":[]}', 'utf8');
}
