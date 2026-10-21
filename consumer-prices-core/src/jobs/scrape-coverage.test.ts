import { describe, expect, it } from 'vitest';
import {
  classifyMatchAdmission,
  classifyValidatorOutcome,
  createScrapeRunStatement,
  DEFAULT_RUN_BUDGET_MS,
  FailureReasonTally,
  isMissingColumnError,
  isRunBudgetExhausted,
  legacyUpdateScrapeRunStatement,
  resolveRunBudgetMs,
  resolveRunStatus,
  terminalFailureReason,
  updateScrapeRunStatement,
} from './scrape-coverage.js';

describe('scrape coverage persistence and validator admission contracts', () => {
  it('uses one admission policy for legacy, auto, and candidate matches', () => {
    expect(classifyMatchAdmission(undefined)).toEqual({
      score: 1,
      status: 'auto',
      evidence: {},
    });

    const signals = {
      tokenOverlap: 1,
      negativeTokenHit: null,
      nonFoodIndicatorHit: null,
      sizeWindow: 'unverified' as const,
      extractedBaseQty: null,
      extractedBaseUnit: null,
    };
    expect(classifyMatchAdmission({ ok: true, score: 0.7, reasons: [], signals })).toEqual({
      score: 0.7,
      status: 'candidate',
      evidence: { validator: { reasons: [], signals } },
    });
    expect(classifyMatchAdmission({ ok: true, score: 0.9, reasons: [], signals })).toEqual({
      score: 0.9,
      status: 'auto',
      evidence: { validator: { reasons: [], signals } },
    });
    expect(classifyMatchAdmission({ ok: false, score: 0.95, reasons: ['title-mismatch'], signals })).toEqual({
      score: 0.95,
      status: 'candidate',
      evidence: { validator: { reasons: ['title-mismatch'], signals } },
    });
  });

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
      failureReasons: { 'missing-price': 3, 'provider-error': 1 },
    });
    expect(update.sql).toContain('rejected_count=$6');
    expect(update.sql).toContain('failure_reasons=$7');
    expect(update.params).toEqual([
      'run-1',
      'partial',
      12,
      8,
      4,
      3,
      JSON.stringify({ 'missing-price': 3, 'provider-error': 1 }),
    ]);
  });

  // The three consumer-price Railway services run scrape/aggregate/publish
  // directly — none of them runs `npm run migrate`, so migration 011 is applied
  // by hand and the new code CAN reach production first. Without a fallback the
  // UPDATE throws, updateScrapeRun never lands, and every run row is stranded
  // at status='running' — which the coverage query then skips entirely. That is
  // strictly worse than the missing diagnostic this change adds.
  it('falls back to the pre-011 column list when failure_reasons does not exist', () => {
    const legacy = legacyUpdateScrapeRunStatement({
      runId: 'run-3',
      status: 'partial',
      pagesAttempted: 12,
      pagesSucceeded: 8,
      errorsCount: 4,
      rejectedCount: 3,
      failureReasons: { 'missing-price': 4 },
    });
    expect(legacy.sql).not.toContain('failure_reasons');
    expect(legacy.params).toEqual(['run-3', 'partial', 12, 8, 4, 3]);
  });

  it('recognises only the undefined-column error as the fallback trigger', () => {
    expect(isMissingColumnError({ code: '42703' })).toBe(true);
    // A connection drop or a constraint violation must surface, not be
    // swallowed into a silent downgrade that hides a real database fault.
    expect(isMissingColumnError({ code: '23514' })).toBe(false);
    expect(isMissingColumnError(new Error('boom'))).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
  });

  // A run with nothing to explain must still write a value: leaving the column
  // at its previous contents would let a clean run inherit the last failing
  // run's reasons and report a recovery as still broken.
  it('writes an empty reason map when the run had no failures', () => {
    const update = updateScrapeRunStatement({
      runId: 'run-2',
      status: 'completed',
      pagesAttempted: 12,
      pagesSucceeded: 12,
      errorsCount: 0,
      rejectedCount: 0,
    });
    expect(update.params[6]).toBe('{}');
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

describe('terminal failure classification', () => {
  // A page burns several candidate URLs and each can fail differently, so the
  // page needs ONE terminal class or the tally stops summing to errorsCount.
  // The class reported is the furthest stage any candidate reached: that is
  // what tells an operator whether the page never loaded, never priced, or
  // priced and was then refused.
  it('reports the furthest pipeline stage any candidate reached', () => {
    expect(
      terminalFailureReason([
        { provider: 'firecrawl', reason: 'provider-error' },
        { provider: 'exa', reason: 'missing-price' },
      ]),
    ).toBe('missing-price');

    expect(
      terminalFailureReason([
        { provider: 'firecrawl', reason: 'validator-rejected' },
        { provider: 'exa', reason: 'provider-error' },
      ]),
    ).toBe('validator-rejected');

    expect(
      terminalFailureReason([
        { provider: 'firecrawl', reason: 'provider-cooldown' },
        { provider: 'exa', reason: 'provider-cooldown' },
      ]),
    ).toBe('provider-cooldown');

    // Evidence rejection (#6182) sits past missing-price (a price WAS read)
    // and before the semantic rejections (nothing was judged about the
    // product yet).
    expect(
      terminalFailureReason([
        { provider: 'firecrawl', reason: 'missing-price' },
        { provider: 'exa', reason: 'price-evidence-missing' },
      ]),
    ).toBe('price-evidence-missing');

    expect(
      terminalFailureReason([
        { provider: 'firecrawl', reason: 'price-evidence-missing' },
        { provider: 'exa', reason: 'title-mismatch' },
      ]),
    ).toBe('title-mismatch');
  });

  // An empty failure list is the "threw something that was not a
  // SearchTargetError" path. It must still land in the vocabulary, otherwise
  // the tally silently under-counts and errorsCount stops reconciling.
  it('falls back to unknown-error when no failure was attributed', () => {
    expect(terminalFailureReason([])).toBe('unknown-error');
  });
});

describe('failure reason tally', () => {
  it('counts one terminal reason per failed page and reconciles with errorsCount', () => {
    const tally = new FailureReasonTally();
    tally.recordPageFailure([
      { provider: 'firecrawl', reason: 'provider-error' },
      { provider: 'exa', reason: 'missing-price' },
    ]);
    tally.recordPageFailure([{ provider: 'firecrawl', reason: 'missing-price' }]);
    tally.recordPageFailure([{ provider: 'firecrawl', reason: 'title-mismatch' }]);
    tally.recordParsedZeroProducts();
    tally.recordPinValidatorRejection();
    tally.recordMatchAdmissionPersistenceFailure();

    expect(tally.toJSON()).toEqual({
      'missing-price': 2,
      'title-mismatch': 1,
      'parsed-zero-products': 1,
      'pin-validator-rejected': 1,
      'match-admission-persist-failed': 1,
    });
    // Every errorsCount++ site in scrape.ts has a matching record* call, so the
    // tally totals the run's errors exactly. A drift here means a new error
    // path shipped without attribution.
    expect(tally.total).toBe(6);
  });

  it('omits reasons that never fired rather than emitting zeros', () => {
    const tally = new FailureReasonTally();
    tally.recordPageFailure([{ provider: 'exa', reason: 'quantity-as-price' }]);
    expect(tally.toJSON()).toEqual({ 'quantity-as-price': 1 });
  });

  it('starts empty so a clean run publishes no reasons', () => {
    const tally = new FailureReasonTally();
    expect(tally.toJSON()).toEqual({});
    expect(tally.total).toBe(0);
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
