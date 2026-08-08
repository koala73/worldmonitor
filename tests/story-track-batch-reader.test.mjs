/**
 * Regression tests for scripts/lib/story-track-batch-reader.mjs.
 *
 * Two interlocking contracts under test:
 *
 *   1. Per-chunk index alignment: `trackResults[i]` must always pair
 *      with `hashes[i]` in the caller. A short / non-array chunk
 *      response that's blindly spread into the output would shift
 *      every later position onto the wrong hash → publish stories
 *      with wrong source-set / embedding-cache linkage.
 *
 *   2. All-or-nothing on failure: returning a partially-filled array
 *      (even one with placeholders) regresses the legacy semantic
 *      where a single-pipeline failure made buildDigest return null
 *      → cron skipped sending the digest for that user/variant. With
 *      a partial array, the cron would ship a digest built from the
 *      successful chunks AND mark `digest:last-sent:v1` as sent,
 *      suppressing retry on the next tick. So the helper returns
 *      null on any chunk failure; the caller must treat null as
 *      "skip this digest tick".
 *
 * Both contracts caught in PR #3428 review.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STORY_TRACK_HGETALL_BATCH,
  readStoryTracksChunked,
} from '../scripts/lib/story-track-batch-reader.mjs';

// Build N synthetic hashes that differ enough to be visible in failures.
function hashes(n) {
  return Array.from({ length: n }, (_, i) => `h${String(i).padStart(4, '0')}`);
}

// Stub pipelineFn that returns a deterministic per-command result.
function ok(commands) {
  return commands.map((cmd) => ({
    result: ['title', `t-${cmd[1]}`, 'severity', 'high'],
  }));
}

describe('readStoryTracksChunked', () => {
  describe('happy path', () => {
    it('returns one entry per hash when every chunk succeeds', async () => {
      const input = hashes(7);
      const out = await readStoryTracksChunked(input, ok, { batchSize: 3 });
      assert.equal(out.length, input.length);
      // Spot-check alignment: the synthetic title carries the cache
      // key, which carries the hash. trackResults[i] must pair with
      // hashes[i].
      for (let i = 0; i < input.length; i++) {
        assert.deepEqual(out[i], {
          result: ['title', `t-story:track:v1:${input[i]}`, 'severity', 'high'],
        });
      }
    });

    it('handles empty hash list without calling the pipeline', async () => {
      let callCount = 0;
      const counting = (cmds) => {
        callCount++;
        return ok(cmds);
      };
      const out = await readStoryTracksChunked([], counting, { batchSize: 3 });
      assert.deepEqual(out, []);
      assert.equal(callCount, 0);
    });

    it('handles a single full chunk in one call', async () => {
      let callCount = 0;
      const counting = (cmds) => {
        callCount++;
        return ok(cmds);
      };
      const out = await readStoryTracksChunked(hashes(3), counting, { batchSize: 3 });
      assert.equal(out.length, 3);
      assert.equal(callCount, 1);
    });
  });

  describe('partial failure — returns null (all-or-nothing)', () => {
    it('returns null and discards prior success when a middle chunk returns []', async () => {
      const input = hashes(7); // chunks: [0..2], [3..5], [6]
      const calls = [];
      const flaky = (cmds) => {
        calls.push(cmds.length);
        // Fail the SECOND chunk (commands for hashes h0003..h0005).
        if (cmds[0][1] === 'story:track:v1:h0003') return [];
        return ok(cmds);
      };
      const log = []; // capture warnings
      const out = await readStoryTracksChunked(input, flaky, {
        batchSize: 3,
        log: (line) => log.push(line),
      });

      // null signals "skip this digest tick" — caller must NOT ship a
      // digest built from chunk 0's results alone (would mark slot as
      // sent, suppress retry on next tick, and silently drop stories).
      assert.equal(out, null);

      // Pipeline was called exactly once for chunk 0 and once for the
      // failing chunk 1 — chunk 2 was skipped to preserve the dedup
      // wall-clock budget.
      assert.equal(calls.length, 2);
      assert.equal(calls[0], 3);
      assert.equal(calls[1], 3);

      // One warning, surfacing the failed chunk index + observed length.
      assert.equal(log.length, 1);
      assert.match(log[0], /chunk 1 returned 0 of 3 expected/);
      assert.match(log[0], /aborting and returning null/);
    });

    it('returns null when a non-array (null / undefined) pipeline result is observed', async () => {
      const input = hashes(5); // chunks: [0..2], [3..4]
      const flaky = (cmds) => (cmds[0][1] === 'story:track:v1:h0000' ? null : ok(cmds));
      const log = [];
      const out = await readStoryTracksChunked(input, flaky, {
        batchSize: 3,
        log: (line) => log.push(line),
      });
      assert.equal(out, null);
      assert.match(log[0], /returned non-array of 3 expected/);
    });

    it('returns null when a short array (partial response) is observed', async () => {
      const input = hashes(6); // chunks: [0..2], [3..5]
      const calls = [];
      const flaky = (cmds) => {
        calls.push(cmds.length);
        if (cmds[0][1] === 'story:track:v1:h0003') {
          // Upstream returned only 2 of 3 expected results.
          return ok(cmds.slice(0, 2));
        }
        return ok(cmds);
      };
      const log = [];
      const out = await readStoryTracksChunked(input, flaky, {
        batchSize: 3,
        log: (line) => log.push(line),
      });
      // Even though chunk 0 succeeded, the partial chunk 1 voids the
      // whole call — caller must skip the digest tick.
      assert.equal(out, null);
      assert.equal(calls.length, 2); // chunk 0 + failing chunk 1, no chunk 2 retry
      assert.match(log[0], /chunk 1 returned 2 of 3 expected/);
    });

    it('returns null and aborts after exactly one call when the first chunk fails', async () => {
      let callCount = 0;
      const counting = () => {
        callCount++;
        return [];
      };
      const out = await readStoryTracksChunked(hashes(10), counting, {
        batchSize: 3,
        log: () => {},
      });
      assert.equal(out, null);
      // Only one pipeline call — we did NOT keep retrying chunks 2/3/4.
      assert.equal(callCount, 1);
    });
  });

  describe('default batch size', () => {
    it('exports STORY_TRACK_HGETALL_BATCH=500 (load-bearing for 50MB request budget)', () => {
      // Documenting the constant in a test guards against an absent-
      // minded bump to e.g. 5000 that would re-introduce the 50MB body
      // problem on the largest accumulator.
      assert.equal(STORY_TRACK_HGETALL_BATCH, 500);
    });
  });
});
