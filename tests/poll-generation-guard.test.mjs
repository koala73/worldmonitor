import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPollGenerationGuard } = require('../scripts/lib/poll-generation-guard.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe('poll generation guard', () => {
  it('aborts a stuck generation and fences its late completion from the replacement', async () => {
    let nowMs = 1000;
    let generation = 0;
    const polls = [];
    const guard = createPollGenerationGuard({
      poll: (context) => {
        const completion = deferred();
        polls.push({ ...context, completion });
        return completion.promise;
      },
      getGeneration: () => generation,
      setGeneration: (value) => { generation = value; },
      stuckAfterMs: 100,
      now: () => nowMs,
    });

    assert.equal(guard.run(), true);
    assert.equal(polls[0].generation, 1);
    nowMs = 1200;
    assert.equal(guard.run(), true);
    assert.equal(polls[0].signal.aborted, true);
    assert.equal(polls[1].generation, 2);
    assert.equal(polls[1].retryAfterLeaseConflict, true);

    polls[0].completion.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(guard.isInFlight(), true);
    assert.equal(guard.run(), false);

    polls[1].completion.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(guard.isInFlight(), false);
    assert.equal(guard.run(), true);
    assert.equal(polls[2].generation, 3);
    polls[2].completion.resolve();
  });
});
