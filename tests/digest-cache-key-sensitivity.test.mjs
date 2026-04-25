/**
 * Regression test for the `digestFor` memoization key in
 * scripts/seed-digest-notifications.mjs.
 *
 * buildDigest filters by rule.sensitivity BEFORE dedup (line 392).
 * The digestFor cache used to key by (variant, lang, windowStart),
 * which meant stricter-sensitivity users in a shared bucket inherited
 * the looser populator's pool — producing the wrong story set AND
 * defeating the topic-grouping adjacency intent once post-group
 * sensitivity re-filtering kicked in.
 *
 * Guard on the cache-key string itself: if a future refactor drops
 * sensitivity from the key, this test fails.
 *
 * Follows the same static-shape pattern as
 * tests/digest-score-floor.test.mjs — the cron script has a top-level
 * env-exit block that makes runtime imports fragile.
 *
 * Run: node --test tests/digest-cache-key-sensitivity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '../scripts/seed-digest-notifications.mjs'),
  'utf-8',
);

describe('digestFor cache key includes sensitivity', () => {
  it('memoization key interpolates cand.rule.sensitivity', () => {
    // The key must include sensitivity alongside variant+lang+windowStart
    // so stricter users do not inherit a looser populator's pool.
    // Post-canonical-window-fix: digestFor receives the annotated candidate
    // (`cand`) instead of just the rule, and reaches sensitivity via
    // cand.rule.sensitivity.
    assert.match(
      src,
      /const\s+key\s*=\s*`\$\{cand\.rule\.variant[^`]*?\$\{cand\.rule\.sensitivity[^`]*?\$\{windowStart\}`/,
      'digestFor cache key must interpolate cand.rule.sensitivity',
    );
  });

  it('defaults missing sensitivity to "high" (matches buildDigest default)', () => {
    // buildDigest uses `rule.sensitivity ?? 'high'` at line 392.
    // The cache key must use the same default or a stricter-populator
    // (explicit 'critical') would collide with a default-populator
    // (undefined → buildDigest treats as 'high', cache would treat as
    // something else).
    //
    // Anchor the match to the cache-key template-literal context so it
    // cannot be satisfied by an unrelated `cand.rule.sensitivity ?? 'high'`
    // elsewhere in the file (e.g. the new operator log line).
    assert.match(
      src,
      /\$\{cand\.rule\.sensitivity\s*\?\?\s*'high'\}\s*:\s*\$\{windowStart\}/,
      'cache key default for sensitivity must be "high" to align with buildDigest default, anchored inside the cache-key template literal',
    );
  });

  it('key construction lives inside digestFor closure', () => {
    // Sanity: ensure the key construction is not pulled out into a
    // separate helper whose shape this test can no longer see.
    const digestForBlock = src.match(
      /async\s+function\s+digestFor\s*\(cand\)\s*\{[\s\S]*?\n\s*\}/,
    );
    assert.ok(digestForBlock, 'digestFor function block should exist');
    assert.match(
      digestForBlock[0],
      /cand\.rule\.sensitivity/,
      'sensitivity must be referenced inside digestFor',
    );
  });
});
