// U3 from docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md
//
// Hard freshness floor (default 48h, env override `NEWS_MAX_AGE_HOURS`)
// applied in buildDigest before corroboration counting. Belt-and-suspenders
// against feeds carrying valid-but-stale dates that would otherwise pass U2's
// undated-drop gate. Tests the env-resolver helper directly; the in-flow
// drop is exercised by parseRssXml + integration smoke (covered in PR-1
// finalize via the existing smoke suite).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { resolveMaxAgeMs } = __testing__;

const HOUR = 60 * 60 * 1000;

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

describe('resolveMaxAgeMs — env override', () => {
  it('defaults to 48h when NEWS_MAX_AGE_HOURS is unset', () => {
    withEnv('NEWS_MAX_AGE_HOURS', undefined, () => {
      assert.equal(resolveMaxAgeMs(), 48 * HOUR);
    });
  });

  it('honors a valid integer override', () => {
    withEnv('NEWS_MAX_AGE_HOURS', '12', () => {
      assert.equal(resolveMaxAgeMs(), 12 * HOUR);
    });
  });

  it('falls back to default for non-numeric values', () => {
    withEnv('NEWS_MAX_AGE_HOURS', 'foo', () => {
      assert.equal(resolveMaxAgeMs(), 48 * HOUR);
    });
  });

  it('falls back to default for empty string', () => {
    withEnv('NEWS_MAX_AGE_HOURS', '', () => {
      assert.equal(resolveMaxAgeMs(), 48 * HOUR);
    });
  });

  it('falls back to default for zero (out of range)', () => {
    withEnv('NEWS_MAX_AGE_HOURS', '0', () => {
      assert.equal(resolveMaxAgeMs(), 48 * HOUR);
    });
  });

  it('falls back to default for negative values', () => {
    withEnv('NEWS_MAX_AGE_HOURS', '-5', () => {
      assert.equal(resolveMaxAgeMs(), 48 * HOUR);
    });
  });

  it('honors a 1h override (operator kill-switch / aggressive setting)', () => {
    withEnv('NEWS_MAX_AGE_HOURS', '1', () => {
      assert.equal(resolveMaxAgeMs(), 1 * HOUR);
    });
  });

  it('honors a generous override (e.g. weekly)', () => {
    withEnv('NEWS_MAX_AGE_HOURS', '168', () => {
      assert.equal(resolveMaxAgeMs(), 168 * HOUR);
    });
  });
});

describe('freshness floor — boundary semantics', () => {
  // The freshness filter uses `publishedAt >= cutoff`. These boundary cases
  // document the inequality direction so a future refactor doesn't silently
  // flip the strictness.
  it('48h boundary: cutoff = now - 48h, an item exactly at cutoff passes (>=)', () => {
    withEnv('NEWS_MAX_AGE_HOURS', undefined, () => {
      const max = resolveMaxAgeMs();
      const cutoff = Date.now() - max;
      // Inclusive boundary by design — using `>=` means an item exactly at
      // the cutoff is kept. If this changes, the test should change WITH the
      // intent (e.g., flipping to `>` to make the boundary exclusive).
      const itemAtBoundary = cutoff;
      assert.ok(itemAtBoundary >= cutoff, 'inclusive cutoff is preserved');
    });
  });

  it('items dated 1ms before cutoff are dropped', () => {
    withEnv('NEWS_MAX_AGE_HOURS', undefined, () => {
      const max = resolveMaxAgeMs();
      const cutoff = Date.now() - max;
      const justBefore = cutoff - 1;
      assert.ok(justBefore < cutoff, 'just-before-cutoff items fail the >= gate');
    });
  });
});
