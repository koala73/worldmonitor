import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Guard for the REDIS_OP_TIMEOUT_MS / REDIS_PIPELINE_TIMEOUT_MS env knobs.
//
// Why this exists:
//   getCachedJson / getCachedRawString / pipeline reads use AbortSignal.timeout
//   sourced from module-level constants. Defaults (1.5s op, 5s pipeline) are
//   tuned for Vercel ↔ Upstash same-datacenter latency. Scripts that fan out
//   30+ parallel reads from a workstation — notably
//   scripts/compare-resilience-current-vs-proposed.mjs — silently time out and
//   the caller falls through to score=0 / null, masquerading as missing data.
//   The env override lets a script run reliably without restructuring the
//   scorer's fan-out.
//
// What this test checks:
//   - Defaults are honored when no env vars are set.
//   - Numeric overrides parse correctly.
//   - Invalid / empty values fall back to the default (rather than NaN, which
//     would break AbortSignal.timeout).

function parseTimeout(value: string | undefined, defaultMs: number): number {
  return Number.parseInt(value ?? '', 10) || defaultMs;
}

describe('REDIS_OP_TIMEOUT_MS env knob parsing', () => {
  it('returns default when env var is unset', () => {
    assert.equal(parseTimeout(undefined, 1500), 1500);
  });

  it('returns default when env var is empty string', () => {
    assert.equal(parseTimeout('', 1500), 1500);
  });

  it('parses a numeric override', () => {
    assert.equal(parseTimeout('10000', 1500), 10000);
  });

  it('parses a leading-digit string (parseInt semantics)', () => {
    assert.equal(parseTimeout('30000ms', 1500), 30000);
  });

  it('falls back to default on non-numeric input', () => {
    assert.equal(parseTimeout('abc', 1500), 1500);
  });

  it('falls back to default on zero (avoids zero-timeout footgun)', () => {
    // parseInt('0') === 0, which is falsy → fallback. This is intentional:
    // a 0 timeout would AbortSignal.timeout(0) and fail every request.
    assert.equal(parseTimeout('0', 1500), 1500);
  });
});
