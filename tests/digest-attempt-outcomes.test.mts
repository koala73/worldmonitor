import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

type AttemptsModule = {
  FEED_ATTEMPT_OUTCOMES: readonly string[];
  classifyFeedAttempt: (
    started: boolean,
    attempt: { source: string; failure: string | null; negativeCache: boolean },
    counters: { parsedTotal: number; keptItems: number; droppedUndated: number },
  ) => string;
  interleaveByCategory: <T extends { category: string }>(entries: readonly T[]) => T[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let attempts: AttemptsModule;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './server/worldmonitor/news/v1/_attempts.ts';",
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'digest-attempts-test-entry.ts',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the attempts harness');
  attempts = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as AttemptsModule;
});

const healthy = { source: 'direct', failure: null, negativeCache: false };

describe('digest attempt vocabulary (#7083)', () => {
  it('defines a closed set with the not-started and failure states from the issue', () => {
    for (const outcome of [
      'completed', 'empty', 'all-undated', 'partial-undated',
      'direct-timeout', 'relay-failure', 'aborted-by-deadline',
      'other-fetch-failure', 'negative-cache', 'not-started',
    ]) {
      assert.ok(attempts.FEED_ATTEMPT_OUTCOMES.includes(outcome), `vocabulary must contain ${outcome}`);
    }
  });
});

describe('classifyFeedAttempt (#7083)', () => {
  it('reports a feed that never started as not-started, never as timeout', () => {
    assert.equal(
      attempts.classifyFeedAttempt(false, healthy, { parsedTotal: 0, keptItems: 0, droppedUndated: 0 }),
      'not-started',
    );
  });

  it('distinguishes direct timeout, deadline abort, and relay failure', () => {
    const zero = { parsedTotal: 0, keptItems: 0, droppedUndated: 0 };
    assert.equal(
      attempts.classifyFeedAttempt(true, { source: 'direct', failure: 'per-feed-timeout', negativeCache: false }, zero),
      'direct-timeout',
    );
    assert.equal(
      attempts.classifyFeedAttempt(true, { source: 'direct', failure: 'deadline-abort', negativeCache: false }, zero),
      'aborted-by-deadline',
    );
    assert.equal(
      attempts.classifyFeedAttempt(true, { source: 'direct', failure: 'relay-error', negativeCache: false }, zero),
      'relay-failure',
    );
    assert.equal(
      attempts.classifyFeedAttempt(true, { source: 'direct', failure: 'direct-error', negativeCache: false }, zero),
      'relay-failure',
    );
  });

  it('names a served negative-cache entry instead of calling it empty', () => {
    assert.equal(
      attempts.classifyFeedAttempt(true, { source: 'cache', failure: null, negativeCache: true }, {
        parsedTotal: 0, keptItems: 0, droppedUndated: 0,
      }),
      'negative-cache',
    );
  });

  it('keeps the historical undated and empty semantics for completed fetches', () => {
    assert.equal(
      attempts.classifyFeedAttempt(true, healthy, { parsedTotal: 5, keptItems: 5, droppedUndated: 0 }),
      'completed',
    );
    assert.equal(
      attempts.classifyFeedAttempt(true, healthy, { parsedTotal: 5, keptItems: 4, droppedUndated: 1 }),
      'partial-undated',
    );
    assert.equal(
      attempts.classifyFeedAttempt(true, healthy, { parsedTotal: 5, keptItems: 0, droppedUndated: 5 }),
      'all-undated',
    );
    assert.equal(
      attempts.classifyFeedAttempt(true, healthy, { parsedTotal: 0, keptItems: 0, droppedUndated: 0 }),
      'empty',
    );
  });
});

describe('interleaveByCategory (#7083)', () => {
  it('gives every category a slot in the first scheduling wave', () => {
    const ordered = attempts.interleaveByCategory([
      { category: 'a', id: 1 }, { category: 'a', id: 2 }, { category: 'a', id: 3 },
      { category: 'b', id: 4 }, { category: 'b', id: 5 },
      { category: 'c', id: 6 },
    ]);
    const firstWave = ordered.slice(0, 3).map((e) => e.category).sort();
    assert.deepEqual(firstWave, ['a', 'b', 'c'], 'first wave must contain every category');
  });

  it('preserves relative order inside each category (strategic priorities intact)', () => {
    const ordered = attempts.interleaveByCategory([
      { category: 'a', id: 1 }, { category: 'a', id: 2 }, { category: 'a', id: 3 },
      { category: 'b', id: 4 }, { category: 'b', id: 5 },
    ]);
    assert.deepEqual(
      ordered.filter((e) => e.category === 'a').map((e) => e.id),
      [1, 2, 3],
    );
    assert.deepEqual(
      ordered.filter((e) => e.category === 'b').map((e) => e.id),
      [4, 5],
    );
  });

  it('is deterministic for the same input', () => {
    const entries = [
      { category: 'x', id: 1 }, { category: 'y', id: 2 }, { category: 'x', id: 3 },
    ];
    assert.deepEqual(attempts.interleaveByCategory(entries), attempts.interleaveByCategory(entries));
  });
});

describe('list-feed-digest wiring (#7083)', () => {
  let digestSource: string;

  before(async () => {
    digestSource = await readFile(resolve(root, 'server/worldmonitor/news/v1/list-feed-digest.ts'), 'utf8');
  });

  it('batches from the priority head plus category-interleaved ordering', () => {
    // The China coverage trio's deadlinePriority promise stays absolute —
    // pinned before the interleave — while every other category round-robins
    // so no single slow category can starve the rest behind the deadline.
    assert.match(digestSource, /priorityHead/);
    assert.match(digestSource, /interleaveByCategory\(/);
    assert.match(digestSource, /deadlinePriority \?\? 0\) > 0/);
  });

  it('records started feeds before awaiting and labels the rest not-started', () => {
    assert.match(digestSource, /startedFeeds\.add\(feed\.name\)/);
    // The precise 'not-started' verdict is internal (attemptOutcomes +
    // telemetry); the public map keeps the coarse 'timeout' contract.
    assert.match(digestSource, /attemptOutcomes\.set\(entry\.feed\.name, 'not-started'\)/);
    assert.match(digestSource, /feedStatuses\[entry\.feed\.name\] = 'timeout'/);
  });

  it('classifies every started feed through the closed vocabulary', () => {
    assert.match(digestSource, /classifyFeedAttempt\(/);
  });

  it('emits the per-build attempt telemetry line', () => {
    assert.match(digestSource, /\[digest-attempts\]/);
    assert.match(digestSource, /by_outcome=/);
    assert.match(digestSource, /headroom_ms=/);
  });

  it('keeps healthy completed feeds out of the public status map', () => {
    // The public map only ever assigns the coarse states for non-healthy
    // outcomes ('all-undated'/'empty'/'partial-undated'); a healthy parse
    // leaves the feed absent, and fine-grained outcomes stay internal.
    assert.match(digestSource, /feedStatuses\[feed\.name\] = 'empty'/);
    assert.doesNotMatch(digestSource, /feedStatuses\[feed\.name\] = outcome/);
  });
});
