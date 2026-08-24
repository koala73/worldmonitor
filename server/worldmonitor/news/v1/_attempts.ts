/**
 * Closed attempt vocabulary and pure classifiers for digest feed execution
 * (#7083).
 *
 * Previously every feed that did not complete a digest build was labeled
 * `timeout`, including feeds whose batch never started before the global
 * deadline, and fetch failures were swallowed into `empty` (the fetch path
 * resolves with a zero-item ParseResult instead of rejecting). This module
 * gives every terminal attempt state one stable name so scheduling
 * starvation is distinguishable from upstream failure in tests, logs, and
 * the feed status map.
 *
 * Kept import-free so the digest test suite can bundle it directly.
 */

export const FEED_ATTEMPT_OUTCOMES = [
  // The fetch completed and produced at least one kept item.
  'completed',
  // The fetch completed with zero parsed items.
  'empty',
  // Parsed items existed but every one was dropped for missing/unparseable dates.
  'all-undated',
  // Some items were kept and some dropped for missing/unparseable dates.
  'partial-undated',
  // The per-feed timeout fired during the direct fetch.
  'direct-timeout',
  // Direct fetch failed for another reason and the relay fallback also failed.
  'relay-failure',
  // The global digest deadline aborted an in-flight fetch.
  'aborted-by-deadline',
  // A bounded fetch failure that is none of the above (network error etc.).
  'other-fetch-failure',
  // A zero-item negative-cache entry from a previous failed attempt was served.
  'negative-cache',
  // The feed's batch never started before the global deadline.
  'not-started',
] as const;

export type FeedAttemptOutcome = (typeof FEED_ATTEMPT_OUTCOMES)[number];

/** What the fetch path reports about how a single feed attempt ended. */
export interface FeedFetchAttempt {
  /** Where the text came from, when the attempt produced text. */
  source: 'direct' | 'relay' | 'cache';
  /**
   * Why the attempt ended without text, when it did. `null` when the fetch
   * produced text or served a healthy cache entry.
   */
  failure:
    | null
    | 'per-feed-timeout'
    | 'deadline-abort'
    | 'direct-error'
    | 'relay-error';
  /** True when a zero-item negative-cache entry was served. */
  negativeCache: boolean;
}

/** Item-level counts used to pick between the undated outcomes. */
export interface FeedItemCounters {
  parsedTotal: number;
  keptItems: number;
  droppedUndated: number;
}

export type FeedFetchFailure = Exclude<FeedFetchAttempt['failure'], null>;

export interface TerminalFetchFailureInput {
  directFailure: FeedFetchAttempt['failure'];
  relayFailure: FeedFetchAttempt['failure'];
  relayAttempted: boolean;
  deadlineAborted: boolean;
}

/**
 * Choose the terminal fetch failure without losing which leg ended last.
 * A global deadline always wins because it invalidates both fetch legs.
 */
export function resolveTerminalFetchFailure({
  directFailure,
  relayFailure,
  relayAttempted,
  deadlineAborted,
}: TerminalFetchFailureInput,
): FeedFetchFailure {
  if (deadlineAborted || directFailure === 'deadline-abort' || relayFailure === 'deadline-abort') {
    return 'deadline-abort';
  }
  // The closed vocabulary has one relay terminal state. Do not let a relay
  // leg's own timeout inherit the direct leg's `direct-timeout` label.
  if (relayAttempted) return 'relay-error';
  return directFailure ?? 'direct-error';
}

/**
 * Describe a cached zero-item result without changing successful empties
 * into failures.  A cached prior failure is explicitly a negative-cache hit.
 */
export function cachedAttemptFrom(prior: FeedFetchAttempt | undefined): FeedFetchAttempt {
  const failure = prior?.failure ?? null;
  return {
    source: 'cache',
    failure,
    negativeCache: prior?.negativeCache === true || failure !== null,
  };
}

/**
 * Classify one feed attempt into the closed vocabulary. Pure: same inputs,
 * same output, no clock or signal access — the caller supplies the fetch
 * path's verdict and whether the feed ever started.
 */
export function classifyFeedAttempt(
  started: boolean,
  attempt: FeedFetchAttempt,
  counters: FeedItemCounters,
): FeedAttemptOutcome {
  if (!started) {
    return 'not-started';
  }

  const kept = counters.keptItems;
  const droppedUndated = counters.droppedUndated;
  const parsedTotal = counters.parsedTotal;

  if (kept > 0) {
    return droppedUndated > 0 ? 'partial-undated' : 'completed';
  }

  // Zero kept items: distinguish why.
  if (attempt.negativeCache) {
    return 'negative-cache';
  }

  if (attempt.failure === 'per-feed-timeout') {
    return 'direct-timeout';
  }

  if (attempt.failure === 'deadline-abort') {
    return 'aborted-by-deadline';
  }

  if (attempt.failure === 'relay-error') {
    return 'relay-failure';
  }

  if (attempt.failure === 'direct-error') {
    return 'other-fetch-failure';
  }

  if (parsedTotal > 0 && droppedUndated > 0) {
    return 'all-undated';
  }

  return 'empty';
}

export interface FeedAttemptBatchEntry {
  attemptId: string;
  category: string;
}

export interface FeedAttemptExecution<T> {
  value: T;
  outcome: FeedAttemptOutcome;
}

export interface FeedAttemptBatchResult<E extends FeedAttemptBatchEntry, T> {
  fulfilled: Array<{ entry: E; value: T }>;
  startedAttemptIds: Set<string>;
  attemptCategories: Map<string, string>;
  attemptOutcomes: Map<string, FeedAttemptOutcome>;
  firstStartMs: number | null;
  firstCompletionMs: number | null;
  finalCompletionMs: number | null;
}

export interface FeedAttemptTelemetrySummary {
  byOutcome: Record<string, number>;
  byCategory: Record<string, Record<string, number>>;
  headroomMs: number;
}

/** Build the structured per-attempt counters emitted by the digest runner. */
export function summarizeFeedAttempts(
  attemptCategories: ReadonlyMap<string, string>,
  attemptOutcomes: ReadonlyMap<string, FeedAttemptOutcome>,
  overallDeadlineMs: number,
  elapsedMs: number,
): FeedAttemptTelemetrySummary {
  const byOutcome: Record<string, number> = {};
  for (const outcome of attemptOutcomes.values()) {
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }

  const byCategory: Record<string, Record<string, number>> = {};
  for (const [attemptId, category] of attemptCategories) {
    const outcome = attemptOutcomes.get(attemptId) ?? 'unknown';
    const categoryOutcomes = (byCategory[category] ??= {});
    categoryOutcomes[outcome] = (categoryOutcomes[outcome] ?? 0) + 1;
  }

  return {
    byOutcome,
    byCategory,
    headroomMs: Math.max(0, overallDeadlineMs - elapsedMs),
  };
}

/**
 * Execute feed batches while retaining an attempt ledger keyed by a stable,
 * unique ID.  The executor owns successful classification; a rejected
 * execution is always an otherwise-unclassified bounded fetch failure.
 */
export async function runFeedAttemptBatches<E extends FeedAttemptBatchEntry, T>(
  allEntries: readonly E[],
  batches: readonly (readonly E[])[],
  signal: AbortSignal,
  execute: (entry: E) => Promise<FeedAttemptExecution<T>>,
  now: () => number = Date.now,
): Promise<FeedAttemptBatchResult<E, T>> {
  const fulfilled: Array<{ entry: E; value: T }> = [];
  const startedAttemptIds = new Set<string>();
  const attemptCategories = new Map<string, string>();
  const attemptOutcomes = new Map<string, FeedAttemptOutcome>();
  const startedAt = now();
  let firstStartMs: number | null = null;
  let firstCompletionMs: number | null = null;
  let finalCompletionMs: number | null = null;

  for (const batch of batches) {
    if (signal.aborted) break;
    const settled = await Promise.allSettled(batch.map(async (entry) => {
      startedAttemptIds.add(entry.attemptId);
      attemptCategories.set(entry.attemptId, entry.category);
      if (firstStartMs === null) firstStartMs = now() - startedAt;
      try {
        const execution = await execute(entry);
        attemptOutcomes.set(entry.attemptId, execution.outcome);
        return { entry, value: execution.value };
      } catch (error) {
        attemptOutcomes.set(entry.attemptId, 'other-fetch-failure');
        throw error;
      } finally {
        const completionMs = now() - startedAt;
        if (firstCompletionMs === null) firstCompletionMs = completionMs;
        finalCompletionMs = completionMs;
      }
    }));

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        fulfilled.push(result.value);
      }
    }
  }

  for (const entry of allEntries) {
    if (startedAttemptIds.has(entry.attemptId)) continue;
    attemptCategories.set(entry.attemptId, entry.category);
    attemptOutcomes.set(entry.attemptId, 'not-started');
  }

  return { fulfilled, startedAttemptIds, attemptCategories, attemptOutcomes, firstStartMs, firstCompletionMs, finalCompletionMs };
}

/**
 * Interleave feed entries by category so every eligible category gets an
 * early scheduling opportunity (#7083): the first N entries contain the
 * head of every category, and a slow category cannot push all later
 * categories behind the global deadline.
 *
 * Deterministic: categories keep their first-appearance order, and feeds
 * keep their relative order inside their category. Strategic priorities
 * are applied by the caller's ordering BEFORE interleaving, so
 * `deadlinePriority` still decides who goes first within a category.
 */
export function interleaveByCategory<T extends { category: string }>(
  entries: readonly T[],
): T[] {
  const byCategory = new Map<string, T[]>();
  for (const entry of entries) {
    const bucket = byCategory.get(entry.category);
    if (bucket) {
      bucket.push(entry);
    } else {
      byCategory.set(entry.category, [entry]);
    }
  }

  const queues = [...byCategory.values()];
  const ordered: T[] = [];
  let remaining = entries.length;
  while (remaining > 0) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined) {
        ordered.push(next);
        remaining -= 1;
      }
    }
  }
  return ordered;
}
