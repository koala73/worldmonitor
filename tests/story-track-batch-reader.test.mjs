/**
 * Regression tests for scripts/lib/story-track-batch-reader.mjs.
 *
 * The contract under test: when the upstream pipeline returns a short,
 * non-array, or empty result for any chunk, the helper MUST preserve
 * index alignment between the input `hashes` array and the returned
 * `trackResults` array. The downstream caller in seed-digest-
 * notifications.mjs::buildDigest pairs `trackResults[i]` with
 * `hashes[i]` (line `stories.push({ hash: hashes[i], ... })`), so a
 * shifted result would publish stories with the wrong source-set /
 * embedding-cache linkage. Caught in PR #3428 review.
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

  describe('partial failure — index alignment', () => {
    it('pads remaining positions with null-result placeholders when a middle chunk returns []', async () => {
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

      // Length MUST equal input.length so trackResults[i] ↔ hashes[i]
      // remains valid in the caller.
      assert.equal(out.length, input.length);

      // First chunk's three positions hold real results.
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(out[i], {
          result: ['title', `t-story:track:v1:${input[i]}`, 'severity', 'high'],
        });
      }
      // Failed chunk's three positions are null-result placeholders.
      for (let i = 3; i < 6; i++) {
        assert.deepEqual(out[i], { result: null });
      }
      // The trailing chunk MUST also be padded (we abort, not skip-and-
      // continue) — otherwise a later success would re-introduce drift
      // by shifting one entry into position 6.
      assert.deepEqual(out[6], { result: null });

      // Pipeline was called exactly once for chunk 0 and once for the
      // failing chunk 1 — chunk 2 was skipped to preserve the dedup
      // wall-clock budget.
      assert.equal(calls.length, 2);
      assert.equal(calls[0], 3);
      assert.equal(calls[1], 3);

      // One warning, surfacing the failed chunk index + observed length.
      assert.equal(log.length, 1);
      assert.match(log[0], /chunk 1 returned 0 of 3 expected/);
      assert.match(log[0], /padding remaining 4 entries/);
    });

    it('treats a non-array (null / undefined) pipeline result as failure', async () => {
      const input = hashes(5); // chunks: [0..2], [3..4]
      const flaky = (cmds) => (cmds[0][1] === 'story:track:v1:h0000' ? null : ok(cmds));
      const log = [];
      const out = await readStoryTracksChunked(input, flaky, {
        batchSize: 3,
        log: (line) => log.push(line),
      });
      assert.equal(out.length, input.length);
      // Every position is a placeholder — first chunk failed, so we
      // abort before reaching the second chunk.
      for (const cell of out) assert.deepEqual(cell, { result: null });
      assert.match(log[0], /returned non-array of 3 expected/);
    });

    it('treats a short array (partial response) as failure', async () => {
      const input = hashes(6); // chunks: [0..2], [3..5]
      const flaky = (cmds) => {
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
      assert.equal(out.length, input.length);
      // First chunk OK, rest padded.
      assert.deepEqual(out[0].result.slice(0, 2), ['title', 't-story:track:v1:h0000']);
      for (let i = 3; i < 6; i++) assert.deepEqual(out[i], { result: null });
      assert.match(log[0], /chunk 1 returned 2 of 3 expected/);
    });

    it('aborts on the FIRST chunk failure when the very first chunk fails', async () => {
      let callCount = 0;
      const counting = () => {
        callCount++;
        return [];
      };
      const out = await readStoryTracksChunked(hashes(10), counting, {
        batchSize: 3,
        log: () => {},
      });
      assert.equal(out.length, 10);
      for (const cell of out) assert.deepEqual(cell, { result: null });
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
