import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeCrossSourceSignalsPayload } from '../src/services/cross-source-signals.ts';

describe('sanitizeCrossSourceSignalsPayload (bootstrap hydrate)', () => {
  it('skips null, primitive, and array rows while preserving valid neighbors and fallback IDs', () => {
    const payload = {
      signals: [null, false, 42, 'broken', [], {
        type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
        theater: 'Global Markets',
        summary: 'Volatility increased',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
        severityScore: 70,
        detectedAt: 123,
        signalCount: 2,
        contributingTypes: ['VIX_SPIKE'],
      }],
      evaluatedAt: 456,
      compositeCount: 1,
    };

    assert.deepEqual(sanitizeCrossSourceSignalsPayload(payload), {
      signals: [{
        id: 'signal:5',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
        theater: 'Global Markets',
        summary: 'Volatility increased',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
        severityScore: 70,
        detectedAt: 123,
        signalCount: 2,
        contributingTypes: ['VIX_SPIKE'],
      }],
      evaluatedAt: 456,
      compositeCount: 1,
    });
  });

  it('coerces non-finite numerics to zero for panel-safe hydration', () => {
    const sanitized = sanitizeCrossSourceSignalsPayload({
      signals: [{ severityScore: Number.POSITIVE_INFINITY, detectedAt: Number.NaN, signalCount: Number.POSITIVE_INFINITY }],
      evaluatedAt: Number.POSITIVE_INFINITY,
      compositeCount: Number.NEGATIVE_INFINITY,
    });

    assert.deepEqual(sanitized, {
      signals: [{
        id: 'signal:0',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_UNSPECIFIED',
        theater: 'Global',
        summary: '',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_UNSPECIFIED',
        severityScore: 0,
        detectedAt: 0,
        contributingTypes: [],
        signalCount: 0,
      }],
      evaluatedAt: 0,
      compositeCount: 0,
    });
  });

  it('normalizes unknown enum strings like the RPC reader', () => {
    for (const value of ['invalid', '__proto__', 'constructor', '']) {
      const result = sanitizeCrossSourceSignalsPayload({ signals: [{ type: value, severity: value }] });
      assert.equal(result?.signals[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_UNSPECIFIED');
      assert.equal(result?.signals[0].severity, 'CROSS_SOURCE_SIGNAL_SEVERITY_UNSPECIFIED');
    }
  });

  it('returns null for non-object payloads so fetch falls through to RPC', () => {
    assert.equal(sanitizeCrossSourceSignalsPayload(null), null);
    assert.equal(sanitizeCrossSourceSignalsPayload(undefined), null);
    assert.equal(sanitizeCrossSourceSignalsPayload([]), null);
  });
});
