import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_DECISION_SIGNAL_HYDRATION_MAX_AGE_MS,
  isCurrentChinaDecisionSignalSnapshot,
} from '../src/services/china-decision-signals';
import { CHINA_DECISION_SIGNAL_GROUP_IDS } from '../shared/china-decision-signals';

function snapshot(generatedAt: string) {
  return {
    schemaVersion: 1,
    generatedAt,
    groups: CHINA_DECISION_SIGNAL_GROUP_IDS.map((id) => ({
      id,
      state: 'unavailable',
      reason: 'No reviewed source observation is available.',
      items: [],
      metadata: {},
    })),
    access: {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    },
  };
}

describe('China decision-signal hydration freshness (#5580)', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');

  it('uses a valid hydration inside the one-hour health budget', () => {
    const generatedAt = new Date(
      now - CHINA_DECISION_SIGNAL_HYDRATION_MAX_AGE_MS + 1,
    ).toISOString();
    assert.equal(isCurrentChinaDecisionSignalSnapshot(snapshot(generatedAt), now), true);
  });

  it('forces RPC fallback for an over-age or malformed hydration', () => {
    const staleAt = new Date(
      now - CHINA_DECISION_SIGNAL_HYDRATION_MAX_AGE_MS - 1,
    ).toISOString();
    assert.equal(isCurrentChinaDecisionSignalSnapshot(snapshot(staleAt), now), false);
    assert.equal(isCurrentChinaDecisionSignalSnapshot(snapshot('not-a-date'), now), false);
  });
});
