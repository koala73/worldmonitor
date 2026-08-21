import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';
import { buildBootstrapPayloadByteLedger } from '../scripts/publish-bootstrap-tiers.mjs';
import {
  BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST,
  CAPTURED_BASE_TIER_KEYS,
  CAPTURED_KEY_DECODED_BYTES,
  DEMOTED_FAST_KEYS,
  ENERGY_ON_DEMAND_KEYS,
  FAST_FIRST_PAINT_JUSTIFICATION,
  FINAL_TIER_DECODED_BYTE_CEILINGS,
  PRODUCTION_CAPTURE,
  REPRESENTATIVE_FIXTURE_CONTRACTS,
  REPRESENTATIVE_PAYLOAD_BYTE_BASELINES,
  REPRESENTATIVE_BOOTSTRAP_PAYLOADS,
  assertRepresentativeBootstrapFixtures,
  buildBootstrapPayloadBudgetCandidate,
  bootstrapPayloadBudgetViolations,
  tierPayloadBytesFromLedger,
} from './fixtures/bootstrap-payload-budget.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_REDUCTION = Object.freeze({ fast: 0.20, slow: 0.25 });
const PINNED_REPRESENTATIVE_FIXTURE_CONTRACTS = Object.freeze({
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

test('frozen production ledger is complete and cannot shrink silently', () => {
  assert.equal(PRODUCTION_CAPTURE.capturedAt, '2026-08-21T14:51:50Z');
  assert.equal(PRODUCTION_CAPTURE.origin, 'https://worldmonitor.app');
  assert.match(PRODUCTION_CAPTURE.completeness, /missing: \[\]/);
  assert.match(PRODUCTION_CAPTURE.limitation, /not the full daily #7047 U1\/RUM baseline/);

  const capturedKeys = [...CAPTURED_BASE_TIER_KEYS.fast, ...CAPTURED_BASE_TIER_KEYS.slow];
  assert.equal(new Set(capturedKeys).size, capturedKeys.length, 'captured tiers must not overlap');
  assert.deepEqual(
    Object.keys(CAPTURED_KEY_DECODED_BYTES).sort(),
    [...capturedKeys].sort(),
    'every captured key needs evidence and unowned byte rows are forbidden',
  );
  for (const [key, bytes] of Object.entries(CAPTURED_KEY_DECODED_BYTES)) {
    assert.ok(Number.isInteger(bytes) && bytes > 0, `${key} has invalid byte evidence: ${bytes}`);
  }

  assert.equal(
    tierPayloadBytesFromLedger(CAPTURED_BASE_TIER_KEYS.fast),
    PRODUCTION_CAPTURE.tiers.fast.decodedBytes,
    `FAST ledger no longer reconstructs captured body ${PRODUCTION_CAPTURE.tiers.fast.sha256}`,
  );
  assert.equal(
    tierPayloadBytesFromLedger(CAPTURED_BASE_TIER_KEYS.slow),
    PRODUCTION_CAPTURE.tiers.slow.decodedBytes,
    `SLOW ledger no longer reconstructs captured body ${PRODUCTION_CAPTURE.tiers.slow.sha256}`,
  );
});

test('representative fixtures hard-pin independent record counts and required fields', () => {
  assert.deepEqual(REPRESENTATIVE_FIXTURE_CONTRACTS, PINNED_REPRESENTATIVE_FIXTURE_CONTRACTS);
  assert.doesNotThrow(() => assertRepresentativeBootstrapFixtures());

  for (const [tier, contracts] of Object.entries(PINNED_REPRESENTATIVE_FIXTURE_CONTRACTS)) {
    for (const [key, contract] of Object.entries(contracts)) {
      const records = REPRESENTATIVE_BOOTSTRAP_PAYLOADS[tier].data[key][contract.collection];
      assert.equal(records.length, contract.minimumRecords, `${tier}.${key} count changed`);
      assert.deepEqual(Object.keys(records[0]).sort(), [...contract.requiredFields].sort());

      const tooSmall = structuredClone(REPRESENTATIVE_BOOTSTRAP_PAYLOADS);
      tooSmall[tier].data[key][contract.collection].pop();
      assert.throws(
        () => assertRepresentativeBootstrapFixtures(tooSmall),
        new RegExp(`${key}\\.${contract.collection} has ${contract.minimumRecords - 1} records`),
      );

      const missingField = structuredClone(REPRESENTATIVE_BOOTSTRAP_PAYLOADS);
      delete missingField[tier].data[key][contract.collection][0][contract.requiredFields[0]];
      assert.throws(
        () => assertRepresentativeBootstrapFixtures(missingField),
        new RegExp(`${key}\\.${contract.collection}\\[0\\] is missing ${contract.requiredFields[0]}`),
      );
    }
  }
});

test('real publisher ledger measures the frozen representative payload baseline', () => {
  for (const tier of ['fast', 'slow']) {
    const ledger = buildBootstrapPayloadByteLedger(REPRESENTATIVE_BOOTSTRAP_PAYLOADS[tier]);
    assert.equal(ledger.totalBytes, REPRESENTATIVE_PAYLOAD_BYTE_BASELINES[tier].totalBytes);
    assert.deepEqual(
      Object.fromEntries(ledger.keys.map(({ key, bytes }) => [key, bytes])),
      REPRESENTATIVE_PAYLOAD_BYTE_BASELINES[tier].keyBytes,
    );
  }
});

test('budget manifest records pre-change ceilings, final targets, and reviewed exception rationale', () => {
  for (const tier of ['fast', 'slow']) {
    const budget = BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers[tier];
    assert.equal(budget.preChangeCeilingBytes, PRODUCTION_CAPTURE.tiers[tier].decodedBytes);
    assert.equal(budget.finalTargetBytes, FINAL_TIER_DECODED_BYTE_CEILINGS[tier]);
    assert.equal(budget.minimumCapturedKeyCount, CAPTURED_BASE_TIER_KEYS[tier].length);
    for (const exception of Object.values(budget.reviewedExceptions)) {
      assert.ok(exception.rationale.trim().length > 0);
      assert.ok(Number.isInteger(exception.ceilingBytes) && exception.ceilingBytes > 0);
    }
  }
});

test('all demotions are represented in their actual destination tier', () => {
  const fast = new Set(bootstrapTierKeyNames('fast'));
  const slow = new Set(bootstrapTierKeyNames('slow'));
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));

  for (const key of [...ENERGY_ON_DEMAND_KEYS, ...DEMOTED_FAST_KEYS]) {
    assert.equal(fast.has(key), false, `${key} must not ride FAST`);
    assert.equal(slow.has(key), false, `${key} must not ride SLOW`);
    assert.equal(onDemand.has(key), true, `${key} must be represented in ON_DEMAND`);
    assert.ok(CAPTURED_KEY_DECODED_BYTES[key] > 0, `${key} needs production byte evidence`);
  }
});

test('actual head memberships meet net reductions and absolute decoded ceilings', () => {
  // Iran was disabled in the captured production response. Excluding it from
  // the head comparison avoids fabricating bytes for an absent key.
  const headKeys = {
    fast: bootstrapTierKeyNames('fast', { iranEventsEnabled: false }),
    slow: bootstrapTierKeyNames('slow', { iranEventsEnabled: false }),
  };

  for (const tier of ['fast', 'slow']) {
    const baseBytes = PRODUCTION_CAPTURE.tiers[tier].decodedBytes;
    const headBytes = tierPayloadBytesFromLedger(headKeys[tier]);
    const reduction = 1 - (headBytes / baseBytes);
    assert.ok(
      reduction >= REQUIRED_REDUCTION[tier],
      `${tier.toUpperCase()} head ${headBytes} B reduces captured ${baseBytes} B by `
      + `${(reduction * 100).toFixed(2)}%, below required ${REQUIRED_REDUCTION[tier] * 100}%`,
    );
    assert.ok(
      headBytes <= FINAL_TIER_DECODED_BYTE_CEILINGS[tier],
      `${tier.toUpperCase()} head ${headBytes} B exceeds absolute ceiling `
      + `${FINAL_TIER_DECODED_BYTE_CEILINGS[tier]} B`,
    );
    const representativeLedger = buildBootstrapPayloadByteLedger(REPRESENTATIVE_BOOTSTRAP_PAYLOADS[tier]);
    const candidate = buildBootstrapPayloadBudgetCandidate(
      tier,
      headKeys[tier],
      representativeLedger,
    );
    assert.equal(candidate.totalBytes, headBytes, 'frozen representative fixture must add no growth');
    assert.deepEqual(bootstrapPayloadBudgetViolations(tier, candidate), []);
  }
});

test('budget fails aggregate and per-key growth measured from representative payloads', () => {
  const headKeys = bootstrapTierKeyNames('fast', { iranEventsEnabled: false });

  const aggregateGrowth = structuredClone(REPRESENTATIVE_BOOTSTRAP_PAYLOADS.fast);
  const bytesToOverflow = Math.max(
    1,
    FINAL_TIER_DECODED_BYTE_CEILINGS.fast - tierPayloadBytesFromLedger(headKeys) + 1,
  );
  aggregateGrowth.data.marketQuotes.quotes[0].symbol += 'G'.repeat(bytesToOverflow);
  const aggregateCandidate = buildBootstrapPayloadBudgetCandidate(
    'fast',
    headKeys,
    buildBootstrapPayloadByteLedger(aggregateGrowth),
  );
  assert.ok(aggregateCandidate.totalBytes > FINAL_TIER_DECODED_BYTE_CEILINGS.fast);
  assert.match(
    bootstrapPayloadBudgetViolations('fast', aggregateCandidate).join('\n'),
    /aggregate .* exceeds final target/,
  );

  const perKeyGrowth = structuredClone(REPRESENTATIVE_BOOTSTRAP_PAYLOADS.fast);
  const materialGrowth = Math.max(
    2_048,
    Math.ceil(CAPTURED_KEY_DECODED_BYTES.marketQuotes * 0.05),
  );
  perKeyGrowth.data.marketQuotes.quotes[0].symbol += 'G'.repeat(materialGrowth + 1);
  const perKeyCandidate = buildBootstrapPayloadBudgetCandidate(
    'fast',
    headKeys,
    buildBootstrapPayloadByteLedger(perKeyGrowth),
  );
  assert.match(
    bootstrapPayloadBudgetViolations('fast', perKeyCandidate).join('\n'),
    /marketQuotes .* without a reviewed exception/,
  );
});

test('every remaining fast key has a first-paint justification', () => {
  const fast = bootstrapTierKeyNames('fast');
  for (const key of fast) {
    assert.ok(
      FAST_FIRST_PAINT_JUSTIFICATION[key],
      `${key} is still in FAST without a first-paint justification`,
    );
  }
  assert.deepEqual([...fast].sort(), Object.keys(FAST_FIRST_PAINT_JUSTIFICATION).sort());
});

test('web and desktop bootstrap deadlines stay unchanged', () => {
  const src = readFileSync(join(root, 'src/services/bootstrap.ts'), 'utf8');
  assert.match(src, /web:\s*\{\s*fast:\s*1_200,\s*slow:\s*3_000\s*\}/);
  assert.match(src, /desktop:\s*\{\s*fast:\s*5_000,\s*slow:\s*8_000\s*\}/);
});
