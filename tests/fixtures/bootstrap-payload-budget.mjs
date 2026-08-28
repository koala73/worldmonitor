/**
 * Frozen bootstrap byte ledger for #7046 / PR #7049, plus representative
 * fixtures used only by the CI membership ratchet.
 *
 * The capture constants live in `scripts/_bootstrap-payload-budget.mjs` so the
 * Railway publisher can evaluate live volume without importing `tests/`.
 * Payload values are deliberately not checked in. Mutable production sizes
 * must not become CI pass/fail (#7045 KTD7, #7288).
 */
import {
  BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST,
  CAPTURED_BASE_TIER_KEYS,
  CAPTURED_KEY_DECODED_BYTES,
  FEATURE_GATED_UNCAPTURED_KEYS,
  FINAL_TIER_DECODED_BYTE_CEILINGS,
  PRODUCTION_CAPTURE,
  materialGrowthAllowanceBytes,
} from '../../scripts/_bootstrap-payload-budget.mjs';

export {
  BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST,
  CAPTURED_BASE_TIER_KEYS,
  CAPTURED_KEY_DECODED_BYTES,
  FEATURE_GATED_UNCAPTURED_KEYS,
  FINAL_TIER_DECODED_BYTE_CEILINGS,
  PRODUCTION_CAPTURE,
};

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
    const materialGrowth = materialGrowthAllowanceBytes(capturedBytes, budget);
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
