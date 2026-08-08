import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBootstrapR2RumSample,
  selectBootstrapR2RumTier,
} from '../src/bootstrap/bootstrap-r2-rum.ts';

function headers(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'server-timing': 'wm_bootstrap_redis;dur=125.5',
    'x-vercel-cache': 'MISS',
    'cf-cache-status': 'DYNAMIC',
    age: '0',
    ...overrides,
  });
}

describe('bootstrap R2 client RUM', () => {
  it('accepts the platform-safe Redis duration header when Vercel strips Server-Timing', () => {
    const result = buildBootstrapR2RumSample(
      'fast',
      'success',
      300.25,
      headers({
        'server-timing': '',
        'x-worldmonitor-bootstrap-redis-duration': '125.5',
      }),
      'mobile',
    );

    assert.equal(result.accepted, true);
    assert.equal(result.accepted && result.sample.redis_duration_ms, 125.5);
  });

  it('accepts only a same-response origin MISS and derives exact overhead', () => {
    const result = buildBootstrapR2RumSample('fast', 'success', 300.25, headers(), 'mobile');

    assert.deepEqual(result, {
      accepted: true,
      sample: {
        bootstrap_tier: 'fast',
        device_class: 'mobile',
        total_duration_ms: 300.25,
        redis_duration_ms: 125.5,
        non_r2_overhead_ms: 174.75,
        outcome: 'success',
      },
    });
    assert.deepEqual(Object.keys(result.sample).sort(), [
      'bootstrap_tier',
      'device_class',
      'non_r2_overhead_ms',
      'outcome',
      'redis_duration_ms',
      'total_duration_ms',
    ].sort());
  });

  it('keeps an abort only when the response carried the same origin timing', () => {
    const accepted = buildBootstrapR2RumSample('slow', 'abort', 2_999, headers(), 'desktop');
    const rejected = buildBootstrapR2RumSample(
      'slow',
      'abort',
      2_999,
      headers({ 'server-timing': '' }),
      'desktop',
    );

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.accepted && accepted.sample.outcome, 'abort');
    assert.deepEqual(rejected, { accepted: false, reason: 'missing-server-timing' });
  });

  for (const [label, override, reason] of [
    ['following Vercel HIT', { 'x-vercel-cache': 'HIT' }, 'vercel-not-miss'],
    ['Vercel STALE', { 'x-vercel-cache': 'STALE' }, 'vercel-not-miss'],
    ['missing Vercel state', { 'x-vercel-cache': '' }, 'missing-vercel-cache-status'],
    ['conflicting Cloudflare HIT', { 'cf-cache-status': 'HIT' }, 'cloudflare-cache-hit'],
    ['positive cached age', { age: '3' }, 'cached-age'],
    ['negative cache age', { age: '-1' }, 'cached-age'],
    ['non-decimal zero cache age', { age: '0x0' }, 'cached-age'],
    ['fractional zero cache age', { age: '0.0' }, 'cached-age'],
    ['unknown cache age', { age: 'unknown' }, 'cached-age'],
    [
      'malformed platform-safe Redis timing',
      { 'x-worldmonitor-bootstrap-redis-duration': 'nope' },
      'invalid-server-timing',
    ],
    ['malformed Redis timing', { 'server-timing': 'wm_bootstrap_redis;dur=nope' }, 'invalid-server-timing'],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.deepEqual(
        buildBootstrapR2RumSample('fast', 'success', 300, headers(override), 'mobile'),
        { accepted: false, reason },
      );
    });
  }

  it('selects exactly one tier per page from an injectable 50/50 gate', () => {
    assert.equal(selectBootstrapR2RumTier(() => 0), 'fast');
    assert.equal(selectBootstrapR2RumTier(() => 0.4999), 'fast');
    assert.equal(selectBootstrapR2RumTier(() => 0.5), 'slow');
    assert.equal(selectBootstrapR2RumTier(() => 0.9999), 'slow');
  });

  it('rejects an impossible negative overhead instead of silently clamping it', () => {
    assert.deepEqual(
      buildBootstrapR2RumSample('fast', 'success', 100, headers(), 'mobile'),
      { accepted: false, reason: 'invalid-duration' },
    );
  });
});
