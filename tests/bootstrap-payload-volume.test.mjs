import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST,
  CAPTURED_KEY_DECODED_BYTES,
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
