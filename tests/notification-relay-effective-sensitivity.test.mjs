/**
 * Regression test: scripts/notification-relay.cjs's shouldNotify must coerce
 * (effective realtime + non-critical) → 'critical' BEFORE consulting sensitivity
 * in either branch. Both reads (the legacy matchesSensitivity call AND the
 * importance-score threshold lookup) must use the SAME effective value.
 *
 * Tightened rule (2026-04-27): under the new policy, realtime is reserved for
 * `critical`-tier events only. Both `(realtime, all)` and `(realtime, high)`
 * are forbidden, so the relay collapses both to `'critical'`.
 *
 * Why source-grep: notification-relay.cjs is a runtime script with no exports;
 * shouldNotify is only callable in-process via the queue loop. This test
 * encodes the contract by reading the source.
 *
 * See plans/forbid-realtime-all-events.md §3.
 *
 * Run: node --test tests/notification-relay-effective-sensitivity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);

describe('notification-relay shouldNotify effective-sensitivity coercion', () => {
  it('declares effectiveSensitivity at function entry, derived from rule.digestMode + rule.sensitivity', () => {
    // The form must use `?? 'realtime'` so the silent third case
    // (rule.digestMode === undefined) is treated identically to 'realtime'.
    assert.match(
      relaySrc,
      /effectiveDigestMode\s*=\s*rule\.digestMode\s*\?\?\s*['"]realtime['"]/,
      'effectiveDigestMode must default rule.digestMode to "realtime" via ??',
    );
    assert.match(
      relaySrc,
      /effectiveSensitivity\s*=\s*[\s\S]*?effectiveDigestMode\s*===\s*['"]realtime['"][\s\S]*?\(rule\.sensitivity\s*===\s*['"]all['"][\s\S]*?rule\.sensitivity\s*===\s*['"]high['"]\)[\s\S]*?\?\s*['"]critical['"]\s*:\s*rule\.sensitivity/,
      'effectiveSensitivity must coerce (realtime+non-critical) → critical (both \'all\' and \'high\' collapse); otherwise pass rule.sensitivity through',
    );
  });

  it('uses effectiveSensitivity in the legacy matchesSensitivity call (NOT rule.sensitivity)', () => {
    // The legacy match must consult the coerced value.
    assert.match(
      relaySrc,
      /matchesSensitivity\(\s*effectiveSensitivity/,
      'matchesSensitivity(...) must be called with effectiveSensitivity',
    );
    // And conversely, no bare rule.sensitivity should be passed to matchesSensitivity.
    assert.doesNotMatch(
      relaySrc,
      /matchesSensitivity\(\s*rule\.sensitivity/,
      'matchesSensitivity must not be called with rule.sensitivity directly — that bypasses the coercion',
    );
  });

  it('uses effectiveSensitivity in the importance-threshold lookup (NOT rule.sensitivity)', () => {
    // Both threshold tiers — 'critical' and 'high' — must compare against the
    // coerced value. If we only fixed matchesSensitivity, the threshold path
    // would silently fall through to IMPORTANCE_SCORE_MIN for (realtime, all).
    assert.match(
      relaySrc,
      /threshold\s*=\s*effectiveSensitivity\s*===\s*['"]critical['"][\s\S]*?effectiveSensitivity\s*===\s*['"]high['"]/,
      'importance-threshold lookup must compare effectiveSensitivity (both tiers)',
    );
    // And the threshold ladder must NOT compare bare rule.sensitivity.
    assert.doesNotMatch(
      relaySrc,
      /threshold\s*=\s*rule\.sensitivity\s*===/,
      'threshold ladder must not compare rule.sensitivity directly — that bypasses the coercion',
    );
  });
});
