import { describe, expect, it } from 'vitest';
import {
  classifyValidatorOutcome,
  createScrapeRunStatement,
  DEFAULT_RUN_BUDGET_MS,
  isRunBudgetExhausted,
  resolveRunBudgetMs,
  resolveRunStatus,
  updateScrapeRunStatement,
} from './scrape-coverage.js';

describe('scrape coverage persistence and validator admission contracts', () => {
  it('persists rejection counts at run creation and completion', () => {
    const create = createScrapeRunStatement('retailer-1');
    expect(create.sql).toContain('rejected_count');
    expect(create.params).toEqual(['retailer-1']);

    const update = updateScrapeRunStatement({
      runId: 'run-1',
      status: 'partial',
      pagesAttempted: 12,
      pagesSucceeded: 8,
      errorsCount: 4,
      rejectedCount: 3,
    });
    expect(update.sql).toContain('rejected_count=$6');
    expect(update.params).toEqual(['run-1', 'partial', 12, 8, 4, 3]);
  });

  it('skips direct-pin validator rejects but preserves search candidates as non-admitted observations', () => {
    expect(classifyValidatorOutcome({ ok: false }, true)).toEqual({
      rejectedCount: 1,
      skipObservation: true,
      errorCount: 1,
    });
    expect(classifyValidatorOutcome({ ok: false }, false)).toEqual({
      rejectedCount: 1,
      skipObservation: false,
      errorCount: 0,
    });
    expect(classifyValidatorOutcome({ ok: true }, false)).toEqual({
      rejectedCount: 0,
      skipObservation: false,
      errorCount: 0,
    });
  });
});

describe('run budget', () => {
  it('defaults when unset and accepts an explicit override', () => {
    expect(resolveRunBudgetMs(undefined)).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs('')).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs('60000')).toBe(60_000);
  });

  // A typo'd env var must disable the ceiling, never truncate every run at
  // target zero — that would turn a config slip into total coverage loss.
  it('disables the ceiling on a non-numeric or non-positive value', () => {
    expect(resolveRunBudgetMs('twenty minutes')).toBe(Number.POSITIVE_INFINITY);
    expect(resolveRunBudgetMs('0')).toBe(Number.POSITIVE_INFINITY);
    expect(resolveRunBudgetMs('-5')).toBe(Number.POSITIVE_INFINITY);
    expect(isRunBudgetExhausted(0, 9_999_999, resolveRunBudgetMs('0'))).toBe(false);
  });

  it('fires only once elapsed time passes the budget', () => {
    expect(isRunBudgetExhausted(1_000, 1_000, 500)).toBe(false);
    expect(isRunBudgetExhausted(1_000, 1_500, 500)).toBe(false);
    expect(isRunBudgetExhausted(1_000, 1_501, 500)).toBe(true);
  });

  it('reports a budget-truncated run as partial even with zero errors', () => {
    expect(resolveRunStatus(0, 5, false)).toBe('completed');
    expect(resolveRunStatus(0, 5, true)).toBe('partial');
    expect(resolveRunStatus(3, 5, false)).toBe('partial');
    expect(resolveRunStatus(3, 0, false)).toBe('failed');
    expect(resolveRunStatus(0, 0, true)).toBe('failed');
  });
});
