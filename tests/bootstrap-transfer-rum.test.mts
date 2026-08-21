import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBootstrapTransferRumSample,
  readBootstrapEncodedBodySize,
  selectBootstrapTransferRumTier,
  utf8TextBytes,
} from '../src/bootstrap/bootstrap-transfer-rum.ts';

describe('bootstrap transfer RUM', () => {
  it('builds the exact complete metric and tag payload without an identifier', () => {
    const result = buildBootstrapTransferRumSample({
      tier: 'fast',
      outcome: 'complete',
      durationMs: 300.25,
      decodedBytes: 766_645,
      encodedBytes: 149_122,
      deviceClass: 'mobile',
    });

    assert.deepEqual(result, {
      accepted: true,
      sample: {
        tier: 'fast',
        outcome: 'complete',
        duration_ms: 300.25,
        decoded_bytes: 766_645,
        encoded_bytes: 149_122,
        device_class: 'mobile',
      },
    });
    assert.deepEqual(Object.keys(result.accepted && result.sample).sort(), [
      'decoded_bytes',
      'device_class',
      'duration_ms',
      'encoded_bytes',
      'outcome',
      'tier',
    ].sort());
    assert.doesNotMatch(JSON.stringify(result), /request|user|session|identifier/i);
  });

  for (const outcome of [
    'abort',
    'http-error',
    'network-error',
    'parse-error',
    'cached-fallback',
  ] as const) {
    it(`${outcome} is closed without claiming completed bytes`, () => {
      assert.deepEqual(buildBootstrapTransferRumSample({
        tier: 'slow',
        outcome,
        durationMs: 2_999,
        decodedBytes: -1,
        encodedBytes: -1,
        deviceClass: 'desktop',
      }), {
        accepted: true,
        sample: {
          tier: 'slow',
          outcome,
          duration_ms: 2_999,
          decoded_bytes: -1,
          encoded_bytes: -1,
          device_class: 'desktop',
        },
      });
    });
  }

  it('rejects bytes on an incomplete outcome and invalid durations', () => {
    assert.deepEqual(buildBootstrapTransferRumSample({
      tier: 'fast',
      outcome: 'abort',
      durationMs: 10,
      decodedBytes: 12,
      encodedBytes: -1,
      deviceClass: 'mobile',
    }), { accepted: false, reason: 'bytes-on-incomplete' });

    assert.deepEqual(buildBootstrapTransferRumSample({
      tier: 'fast',
      outcome: 'network-error',
      durationMs: Number.NaN,
      decodedBytes: -1,
      encodedBytes: -1,
      deviceClass: 'mobile',
    }), { accepted: false, reason: 'invalid-duration' });
  });

  it('measures decoded text as UTF-8 rather than JavaScript code units', () => {
    const text = JSON.stringify({ label: 'é🌍' });
    assert.equal(utf8TextBytes(text), Buffer.byteLength(text, 'utf8'));
    assert.ok(utf8TextBytes(text) > text.length);
  });

  it('uses the latest exposed encodedBodySize and otherwise reports -1', () => {
    const timing = {
      getEntriesByName: () => [
        { encodedBodySize: 100 },
        { encodedBodySize: 149_122 },
      ],
    };

    assert.equal(readBootstrapEncodedBodySize('https://api.test/bootstrap', 10, timing), 149_122);
    assert.equal(readBootstrapEncodedBodySize('https://api.test/bootstrap', 10, {
      getEntriesByName: () => [{ encodedBodySize: 0 }],
    }), -1);
    assert.equal(readBootstrapEncodedBodySize('https://api.test/bootstrap', 0, {
      getEntriesByName: () => [{ encodedBodySize: 0 }],
    }), 0);
  });

  it('selects exactly one tier per page from an injectable 50/50 gate', () => {
    assert.equal(selectBootstrapTransferRumTier(() => 0), 'fast');
    assert.equal(selectBootstrapTransferRumTier(() => 0.4999), 'fast');
    assert.equal(selectBootstrapTransferRumTier(() => 0.5), 'slow');
    assert.equal(selectBootstrapTransferRumTier(() => 0.9999), 'slow');
  });
});
