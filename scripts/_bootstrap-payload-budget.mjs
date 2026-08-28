/**
 * Frozen bootstrap byte ledger and operational volume evaluation (#7288).
 *
 * The checked-in capture is a membership ratchet for CI, not a live production
 * pass/fail. `evaluatePublishedBootstrapVolume()` compares a publisher ledger
 * against the same ceilings and 5% key-growth rule, but it only returns alerts.
 * The publisher logs those alerts; it must not fail a write because Redis
 * contents moved.
 *
 * This module lives under `scripts/` so `Dockerfile.publish-bootstrap-tiers`
 * can import it. Do not move it under `tests/`.
 */

export const PRODUCTION_CAPTURE = Object.freeze({
  capturedAt: '2026-08-21T14:51:50Z',
  origin: 'https://worldmonitor.app',
  requestShape: 'GET [REDACTED]/api/bootstrap?tier=<tier>&public=1',
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

/**
 * Supported keys that are legal in a published ledger but absent from the
 * Iran-disabled 2026-08-21 capture. Turning `IRAN_EVENTS_ENABLED` on must not
 * generate a recurring `unmeasured-key` warning every publish cycle. These
 * keys still have no frozen size, so they must not become CI pass/fail.
 */
export const FEATURE_GATED_UNCAPTURED_KEYS = Object.freeze({
  iranEvents: Object.freeze({
    tier: 'fast',
    gate: 'IRAN_EVENTS_ENABLED',
    rationale: 'Iran-attacks layer; omitted from the 2026-08-21 public capture because the sunset gate was off.',
  }),
});

function isFeatureGatedUncapturedKey(tier, key) {
  return FEATURE_GATED_UNCAPTURED_KEYS[key]?.tier === tier;
}

export function materialGrowthAllowanceBytes(capturedBytes, budget) {
  return Math.max(
    budget.materialGrowthFloorBytes,
    Math.ceil(capturedBytes * budget.materialGrowthRatio),
  );
}

function reviewedExceptionCovers(budget, key, valueBytes) {
  const exception = budget.reviewedExceptions[key];
  return Boolean(
    exception
    && typeof exception.rationale === 'string'
    && exception.rationale.trim().length > 0
    && Number.isInteger(exception.ceilingBytes)
    && valueBytes <= exception.ceilingBytes,
  );
}

/**
 * Compare a published `{ data, missing }` ledger with the frozen capture.
 * Returns alerts for operators; never throws on production volume drift.
 */
export function evaluatePublishedBootstrapVolume(tier, ledger) {
  const budget = BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers[tier];
  if (!budget) throw new TypeError(`Unknown bootstrap budget tier: ${tier}`);
  if (
    !ledger
    || !Number.isInteger(ledger.totalBytes)
    || !Array.isArray(ledger.keys)
  ) {
    throw new TypeError('Published volume evaluation requires a byte ledger');
  }

  const alerts = [];
  if (ledger.totalBytes > budget.finalTargetBytes) {
    alerts.push({
      kind: 'tier-ceiling',
      tier,
      bytes: ledger.totalBytes,
      limitBytes: budget.finalTargetBytes,
    });
  }

  for (const entry of ledger.keys) {
    const key = entry?.key;
    const valueBytes = entry?.valueBytes;
    if (typeof key !== 'string' || !Number.isInteger(valueBytes)) {
      throw new TypeError('Published volume evaluation requires integer valueBytes per key');
    }

    const capturedBytes = CAPTURED_KEY_DECODED_BYTES[key];
    if (!Number.isInteger(capturedBytes)) {
      if (!isFeatureGatedUncapturedKey(tier, key)) {
        alerts.push({ kind: 'unmeasured-key', tier, key, bytes: valueBytes });
      }
      continue;
    }

    const allowanceBytes = materialGrowthAllowanceBytes(capturedBytes, budget);
    if (valueBytes <= capturedBytes + allowanceBytes) continue;
    if (reviewedExceptionCovers(budget, key, valueBytes)) continue;

    alerts.push({
      kind: 'key-growth',
      tier,
      key,
      bytes: valueBytes,
      capturedBytes,
      allowanceBytes,
    });
  }

  return {
    ceilingBytes: budget.finalTargetBytes,
    alerts,
  };
}
