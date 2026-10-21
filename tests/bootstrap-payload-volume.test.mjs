import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST,
  CAPTURED_KEY_DECODED_BYTES,
  FEATURE_GATED_UNCAPTURED_KEYS,
  FINAL_TIER_DECODED_BYTE_CEILINGS,
  evaluatePublishedBootstrapVolume,
  materialGrowthAllowanceBytes,
} from '../scripts/_bootstrap-payload-budget.mjs';

describe('published bootstrap volume evaluation', () => {
  it('is silent when a ledger matches the frozen capture', () => {
    const ledger = {
      totalBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.slow,
      keys: [
        { key: 'naturalEvents', valueBytes: CAPTURED_KEY_DECODED_BYTES.naturalEvents },
        { key: 'chinaMacro', valueBytes: CAPTURED_KEY_DECODED_BYTES.chinaMacro },
      ],
    };
    assert.deepEqual(evaluatePublishedBootstrapVolume('slow', ledger), {
      ceilingBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.slow,
      alerts: [],
    });
  });

  it('alerts on tier ceiling and per-key growth without throwing', () => {
    const budget = BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers.slow;
    const captured = CAPTURED_KEY_DECODED_BYTES.naturalEvents;
    const allowance = materialGrowthAllowanceBytes(captured, budget);
    const ledger = {
      totalBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.slow + 1,
      keys: [
        { key: 'naturalEvents', valueBytes: captured + allowance + 1 },
        { key: 'mysteryKey', valueBytes: 12 },
      ],
    };

    const result = evaluatePublishedBootstrapVolume('slow', ledger);
    assert.deepEqual(result.alerts.map((alert) => alert.kind), [
      'tier-ceiling',
      'key-growth',
      'unmeasured-key',
    ]);
    assert.equal(result.alerts[1].key, 'naturalEvents');
    assert.equal(result.alerts[1].allowanceBytes, allowance);
    assert.equal(result.alerts[2].key, 'mysteryKey');
  });

  it('does not alert on feature-gated keys omitted from the Iran-disabled capture', () => {
    const iranBytes = 12_345;
    const result = evaluatePublishedBootstrapVolume('fast', {
      totalBytes: iranBytes,
      keys: [
        { key: 'iranEvents', valueBytes: iranBytes },
        { key: 'mysteryKey', valueBytes: 12 },
      ],
    });
    assert.equal(FEATURE_GATED_UNCAPTURED_KEYS.iranEvents.tier, 'fast');
    assert.deepEqual(result.alerts, [
      { kind: 'unmeasured-key', tier: 'fast', key: 'mysteryKey', bytes: 12 },
    ]);
  });

  it('still treats a gated key on the wrong tier as unmeasured', () => {
    const result = evaluatePublishedBootstrapVolume('slow', {
      totalBytes: 99,
      keys: [{ key: 'iranEvents', valueBytes: 99 }],
    });
    assert.deepEqual(result.alerts, [
      { kind: 'unmeasured-key', tier: 'slow', key: 'iranEvents', bytes: 99 },
    ]);
  });

  it('ignores growth at or under the 5% / 2 KiB floor', () => {
    const budget = BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers.slow;
    const captured = CAPTURED_KEY_DECODED_BYTES.sanctionsPressure;
    const allowance = materialGrowthAllowanceBytes(captured, budget);
    const result = evaluatePublishedBootstrapVolume('slow', {
      totalBytes: budget.finalTargetBytes,
      keys: [{ key: 'sanctionsPressure', valueBytes: captured + allowance }],
    });
    assert.deepEqual(result.alerts, []);
  });
});
