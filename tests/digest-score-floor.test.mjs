/**
 * Regression tests for the DIGEST_SCORE_MIN floor applied after the
 * dedup step in scripts/seed-digest-notifications.mjs.
 *
 * Matches the repo's existing pattern for digest-mode regression
 * tests (read the source, assert structural invariants) — the cron
 * has a top-level env-exit block that makes importing it at test
 * time fragile, so we guard on shape instead.
 *
 * Run: node --test tests/digest-score-floor.test.mjs
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

describe('DIGEST_SCORE_MIN env floor', () => {
  it('reads DIGEST_SCORE_MIN from process.env at call time', () => {
    // Function-based read — not a module-level constant — so Railway
    // env flips take effect on the next cron tick without a redeploy.
    assert.match(src, /function\s+getDigestScoreMin\s*\(\)\s*\{/);
    assert.match(src, /process\.env\.DIGEST_SCORE_MIN/);
  });

  it('default is 0 (no-op) so this PR is a behaviour-neutral ship', () => {
    assert.match(src, /process\.env\.DIGEST_SCORE_MIN\s*\?\?\s*['"]0['"]/);
  });

  it('rejects non-integer / negative values', () => {
    // The parser returns 0 on NaN / negative so a misconfigured env
    // value degrades to "no floor" rather than blowing up the cron.
    assert.match(src, /Number\.isInteger\(raw\)\s*&&\s*raw\s*>=\s*0\s*\?\s*raw\s*:\s*0/);
  });

  it('filter runs AFTER deduplicateStories (score is the rep cluster score)', () => {
    // The representative's currentScore is the max within its cluster
    // (materializeCluster sorts by currentScore DESC and takes items[0]),
    // so filtering after dedup only drops clusters whose HIGHEST-scoring
    // member is below the floor.
    const dedupIdx = src.indexOf('await deduplicateStories(stories)');
    const filterIdx = src.indexOf('dedupedAll.filter');
    const sliceIdx = src.indexOf('DIGEST_MAX_ITEMS');
    assert.ok(dedupIdx > 0, 'deduplicateStories call must exist');
    assert.ok(filterIdx > 0, 'score-floor filter must exist');
    assert.ok(dedupIdx < filterIdx, 'filter must run after dedup');
    assert.ok(
      filterIdx < src.indexOf('.slice(0, DIGEST_MAX_ITEMS)'),
      'filter must run before the top-30 slice',
    );
    void sliceIdx;
  });

  it('short-circuits when floor is 0 (no wasted filter pass)', () => {
    assert.match(
      src,
      /scoreFloor\s*>\s*0\s*\n?\s*\?\s*dedupedAll\.filter/,
    );
  });

  it('logs a "dropped N of M clusters" line when the floor fires', () => {
    // Operators need to know how aggressive the floor is. Silent
    // filtering on a per-tick basis would make it impossible to
    // notice that the floor is dropping too much. The log spans
    // two template fragments (concatenated with +) so we assert on
    // the fragments independently rather than a cross-line regex.
    assert.ok(
      src.includes('score floor dropped'),
      'log fragment "score floor dropped" must be present',
    );
    assert.ok(
      src.includes('clusters (DIGEST_SCORE_MIN=${scoreFloor})'),
      'log fragment with the scoreFloor value must be present',
    );
  });

  it('returns null when floor drains every cluster (caller skips cleanly)', () => {
    // Greptile P2 regression: if buildDigest returned [] rather than
    // null when the floor emptied the list, the caller's `if (!stories)`
    // guard (which checks falsiness, so [] slips through) would stop
    // logging the canonical "No stories in window" line, and the
    // only skip-signal would be a swallowed formatDigest=>null at the
    // `!storyListPlain` check. Contract is: empty-after-floor returns
    // null so the caller takes the same path as pre-dedup-empty.
    assert.match(src, /if\s*\(\s*deduped\.length\s*===\s*0\s*\)\s*\{/);
    // A distinct log line fires BEFORE the return so operators can
    // tell "floor too high" apart from "no news today".
    assert.ok(
      src.includes('score floor dropped ALL'),
      'distinct "dropped ALL" log line must fire when the floor drains everything',
    );
    assert.ok(
      src.includes('skipping user'),
      'log line must mention the user is being skipped',
    );
  });
});
