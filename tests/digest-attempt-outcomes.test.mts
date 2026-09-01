import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { __testing__ as digestTesting } from '../server/worldmonitor/news/v1/list-feed-digest';

type AttemptsModule = {
  FEED_ATTEMPT_OUTCOMES: readonly string[];
  classifyFeedAttempt: (
    started: boolean,
    attempt: { source: string; failure: string | null; negativeCache: boolean },
    counters: { parsedTotal: number; keptItems: number; droppedUndated: number },
  ) => string;
  resolveTerminalFetchFailure: (
    input: { directFailure: string | null; relayFailure: string | null; relayAttempted: boolean; deadlineAborted: boolean },
  ) => string | null;
  cachedAttemptFrom: (prior: { source: string; failure: string | null; negativeCache: boolean } | undefined) => {
    source: string; failure: string | null; negativeCache: boolean;
  };
  runFeedAttemptBatches: <T>(
    allEntries: readonly { attemptId: string; category: string }[],
    batches: readonly (readonly { attemptId: string; category: string }[])[],
    signal: AbortSignal,
    execute: (entry: { attemptId: string; category: string }) => Promise<{ value: T; outcome: string }>,
    now?: () => number,
  ) => Promise<{
    fulfilled: Array<{ entry: { attemptId: string; category: string }; value: T }>;
    startedAttemptIds: Set<string>;
    attemptCategories: Map<string, string>;
    attemptOutcomes: Map<string, string>;
    firstStartMs: number | null;
    firstCompletionMs: number | null;
    finalCompletionMs: number | null;
  }>;
  summarizeFeedAttempts: (
    attemptCategories: ReadonlyMap<string, string>,
    attemptOutcomes: ReadonlyMap<string, string>,
    overallDeadlineMs: number,
    elapsedMs: number,
  ) => {
    byOutcome: Record<string, number>;
    byCategory: Record<string, Record<string, number>>;
    headroomMs: number;
  };
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

  it('distinguishes direct timeout, deadline abort, relay failure, and other fetch failure', () => {
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
      'other-fetch-failure',
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

describe('fetch attempt helpers (#7083)', () => {
  it('uses deadline precedence, then the final relay leg, then direct failure', () => {
    assert.equal(attempts.resolveTerminalFetchFailure({ directFailure: 'per-feed-timeout', relayFailure: 'relay-error', relayAttempted: true, deadlineAborted: false }), 'relay-error');
    assert.equal(attempts.resolveTerminalFetchFailure({ directFailure: 'direct-error', relayFailure: 'per-feed-timeout', relayAttempted: true, deadlineAborted: false }), 'relay-error');
    assert.equal(attempts.resolveTerminalFetchFailure({ directFailure: 'direct-error', relayFailure: 'relay-error', relayAttempted: true, deadlineAborted: true }), 'deadline-abort');
    assert.equal(attempts.resolveTerminalFetchFailure({ directFailure: 'direct-error', relayFailure: null, relayAttempted: false, deadlineAborted: false }), 'direct-error');
  });

  it('keeps successful empty cache hits empty and marks cached failures negative', () => {
    const successfulEmpty = attempts.cachedAttemptFrom({ source: 'direct', failure: null, negativeCache: false });
    assert.deepEqual(successfulEmpty, { source: 'cache', failure: null, negativeCache: false });
    assert.equal(attempts.classifyFeedAttempt(true, successfulEmpty, { parsedTotal: 0, keptItems: 0, droppedUndated: 0 }), 'empty');

    const failed = attempts.cachedAttemptFrom({ source: 'relay', failure: 'relay-error', negativeCache: false });
    assert.deepEqual(failed, { source: 'cache', failure: 'relay-error', negativeCache: true });
    assert.equal(attempts.classifyFeedAttempt(true, failed, { parsedTotal: 0, keptItems: 0, droppedUndated: 0 }), 'negative-cache');
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

describe('runFeedAttemptBatches (#7083)', () => {
  it('uses distinct attempt IDs for duplicate display names in the real digest inventory', () => {
    const { allEntries, batches } = digestTesting.buildDigestFeedBatches('full', 'en');
    const ids = allEntries.map((entry) => entry.attemptId);
    assert.equal(new Set(ids).size, ids.length, 'each inventory entry must have a unique attempt ID');
    assert.ok(allEntries.length > digestTesting.BATCH_CONCURRENCY, 'fixture must require more than one real scheduling wave');
    assert.ok(batches.length > 1, 'full inventory must be split into multiple scheduling waves');
    assert.equal(batches[0]?.length, digestTesting.BATCH_CONCURRENCY);
    const allCategories = new Set(allEntries.map((entry) => entry.category));
    const firstWaveCategories = new Set(batches[0]?.map((entry) => entry.category));
    assert.deepEqual(
      [...allCategories].filter((category) => !firstWaveCategories.has(category)),
      [],
      'the first real scheduling wave must cover every eligible category',
    );

    const byName = new Map<string, typeof allEntries>();
    for (const entry of allEntries) {
      const entries = byName.get(entry.feed.name) ?? [];
      entries.push(entry);
      byName.set(entry.feed.name, entries);
    }
    const duplicate = [...byName.values()].find((entries) => entries.length > 1);
    assert.ok(duplicate, 'the full inventory must contain a duplicate display name regression fixture');
    assert.equal(new Set(duplicate.map((entry) => entry.attemptId)).size, duplicate.length);
  });

  it('keeps duplicate display names distinct by attempt ID across more than one wave', async () => {
    const calls: string[] = [];
    const entries = [{ attemptId: 'slow:1', category: 'slow' }, { attemptId: 'fast:1', category: 'fast' }, { attemptId: 'slow:2', category: 'slow' }];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolveSlow) => { releaseSlow = resolveSlow; });
    const running = attempts.runFeedAttemptBatches(
      entries,
      [[entries[0], entries[1]], [entries[2]]],
      new AbortController().signal,
      async (entry) => {
        calls.push(entry.attemptId);
        if (entry.attemptId === 'slow:1') await slow;
        return { value: entry.attemptId, outcome: 'completed' };
      },
      (() => { let tick = 0; return () => tick++ * 10; })(),
    );
    await Promise.resolve();
    assert.deepEqual(calls, ['slow:1', 'fast:1'], 'the slow first-wave entry must not prevent fast-category start');
    releaseSlow();
    const result = await running;
    assert.deepEqual(calls, ['slow:1', 'fast:1', 'slow:2']);
    assert.deepEqual(result.fulfilled.map(({ value }) => value), ['slow:1', 'fast:1', 'slow:2']);
    assert.equal(result.attemptCategories.get('slow:1'), 'slow');
    assert.equal(result.attemptCategories.get('slow:2'), 'slow');
    assert.equal(result.attemptOutcomes.size, 3);
    assert.notEqual(result.firstCompletionMs, null);
    assert.notEqual(result.finalCompletionMs, null);
  });

  it('does not start later waves after global abort and labels them not-started', async () => {
    const controller = new AbortController();
    const entries = [{ attemptId: 'started', category: 'slow' }, { attemptId: 'later', category: 'fast' }];
    const result = await attempts.runFeedAttemptBatches(
      entries,
      [[entries[0]], [entries[1]]],
      controller.signal,
      async (entry) => {
        controller.abort();
        return { value: entry.attemptId, outcome: 'completed' };
      },
    );
    assert.deepEqual([...result.startedAttemptIds], ['started']);
    assert.equal(result.attemptOutcomes.get('later'), 'not-started');
    assert.equal(result.attemptCategories.get('later'), 'fast');
  });

  it('records rejected executors as other fetch failures', async () => {
    const result = await attempts.runFeedAttemptBatches(
      [{ attemptId: 'broken', category: 'slow' }],
      [[{ attemptId: 'broken', category: 'slow' }]],
      new AbortController().signal,
      async () => { throw new Error('network failure'); },
    );
    assert.deepEqual(result.fulfilled, []);
    assert.equal(result.attemptOutcomes.get('broken'), 'other-fetch-failure');
  });

  it('summarizes every unique attempt by outcome/category and computes deadline headroom', () => {
    const summary = attempts.summarizeFeedAttempts(
      new Map([['shared:1', 'tech'], ['shared:2', 'intel'], ['later:3', 'intel']]),
      new Map([['shared:1', 'completed'], ['shared:2', 'relay-failure'], ['later:3', 'not-started']]),
      10_000,
      8_250,
    );
    assert.deepEqual(summary.byOutcome, { completed: 1, 'relay-failure': 1, 'not-started': 1 });
    assert.deepEqual(summary.byCategory, {
      tech: { completed: 1 },
      intel: { 'relay-failure': 1, 'not-started': 1 },
    });
    assert.equal(summary.headroomMs, 1_750);
  });
});
