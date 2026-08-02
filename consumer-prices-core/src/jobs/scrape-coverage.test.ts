import { describe, expect, it } from 'vitest';
import {
  classifyValidatorOutcome,
  createScrapeRunStatement,
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
