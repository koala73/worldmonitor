import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTimeoutEnv } from '../server/_shared/redis';

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
//   - parseTimeoutEnv (the actual helper redis.ts uses to compute the
//     module-level constants) honors defaults on missing / empty / non-numeric
//     input AND on NON-POSITIVE numeric input. The non-positive case matters
//     because AbortSignal.timeout(0) aborts instantly and
//     AbortSignal.timeout(-1) throws TypeError — both turn a typo'd env var
//     into a production-wide outage instead of falling back safely.
//   - The exported function is the same one the production constants compute
//     against (covered by the import above — if redis.ts later renames or
//     restructures, this test fails at module-load instead of silently
//     drifting from production behaviour).

describe('parseTimeoutEnv (redis.ts env-knob helper)', () => {
  it('returns default when env var is undefined', () => {
    assert.equal(parseTimeoutEnv(undefined, 1500), 1500);
  });

  it('returns default when env var is empty string', () => {
    assert.equal(parseTimeoutEnv('', 1500), 1500);
  });

  it('parses a positive numeric override', () => {
    assert.equal(parseTimeoutEnv('10000', 1500), 10000);
  });

  it('parses a leading-digit string (parseInt semantics)', () => {
    assert.equal(parseTimeoutEnv('30000ms', 1500), 30000);
  });

  it('falls back to default on non-numeric input', () => {
    assert.equal(parseTimeoutEnv('abc', 1500), 1500);
  });

  it('falls back to default on zero (AbortSignal.timeout(0) aborts instantly)', () => {
    assert.equal(parseTimeoutEnv('0', 1500), 1500);
  });

  it('falls back to default on negative numbers (AbortSignal.timeout(-N) throws TypeError)', () => {
    // Without this guard, REDIS_OP_TIMEOUT_MS=-1 would propagate to
    // AbortSignal.timeout(-1) which throws synchronously per the WHATWG
    // spec. Functions without try/catch (e.g. getRawJson) leak the
    // TypeError to callers; guarded functions swallow it as a generic
    // Redis failure with no [REDIS-TIMEOUT] structured log, making the
    // misconfig invisible.
    assert.equal(parseTimeoutEnv('-1', 1500), 1500);
    assert.equal(parseTimeoutEnv('-1000', 1500), 1500);
  });

  it('falls back to default on whitespace-only input', () => {
    assert.equal(parseTimeoutEnv('   ', 1500), 1500);
  });
});
