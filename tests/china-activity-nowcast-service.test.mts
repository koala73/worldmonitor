import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY,
  fetchChinaActivityNowcast,
  parseChinaActivityNowcastResponse,
} from '../src/services/economic/china-activity-nowcast';
import {
  evaluateChinaActivityNowcast,
} from '../shared/china-activity-nowcast';

const EVALUATED_AT = '2026-07-25T12:00:00.000Z';

function payload() {
  return evaluateChinaActivityNowcast({
    evaluatedAt: EVALUATED_AT,
    officialObservations: [],
    proxyObservations: [],
  });
}

describe('China activity nowcast client service (#5579)', () => {
  it('validates wrapper fields against the canonical payload', () => {
    const response = payload();
    assert.deepEqual(parseChinaActivityNowcastResponse({
      generatedAt: response.evaluatedAt,
      methodVersion: response.methodVersion,
      comparisonState: response.state,
      upstreamUnavailable: true,
      payloadJson: JSON.stringify(response),
    }), response);

    assert.throws(() => parseChinaActivityNowcastResponse({
      generatedAt: response.evaluatedAt,
      methodVersion: response.methodVersion,
      comparisonState: 'agreement',
      upstreamUnavailable: true,
      payloadJson: JSON.stringify(response),
    }), /Invalid China activity nowcast response/);
  });

  it('returns a current fail-closed response instead of a client-side last-good cache', async () => {
    assert.deepEqual(CHINA_ACTIVITY_NOWCAST_BREAKER_CACHE_POLICY, {
      cacheTtlMs: 0,
      maxCacheEntries: 0,
    });
    const calls: string[] = [];
    const response = await fetchChinaActivityNowcast({
      now: () => new Date(EVALUATED_AT),
      getResponse: async () => {
        calls.push('rpc');
        throw new Error('transport unavailable');
      },
      execute: async (operation, fallback) => {
        try {
          return await operation();
        } catch {
          return fallback;
        }
      },
    });

    assert.deepEqual(calls, ['rpc']);
    assert.equal(response.state, 'insufficient_data');
    assert.equal(response.evaluatedAt, EVALUATED_AT);
    assert.equal(response.confidence.level, 'insufficient');
  });
});
