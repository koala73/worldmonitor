import { describe, expect, it } from 'vitest';
import {
  summarizeMarketCoverage,
  summarizeRetailerCoverage,
} from './coverage.js';

const retailer = (overrides: Partial<Parameters<typeof summarizeRetailerCoverage>[0]> = {}) => ({
  slug: 'retailer-a',
  name: 'Retailer A',
  lastRunAt: '2026-08-01T00:00:00.000Z',
  runStatus: 'completed',
  pagesAttempted: 12,
  pagesSucceeded: 12,
  errorsCount: 0,
  rejectedCount: 0,
  ...overrides,
});

describe('consumer-price coverage summaries', () => {
  it('reports partial retailer coverage and preserves validator rejection counts', () => {
    const summary = summarizeRetailerCoverage(retailer({
      pagesSucceeded: 8,
      errorsCount: 4,
      rejectedCount: 3,
      runStatus: 'partial',
    }));

    expect(summary.failedPages).toBe(4);
    expect(summary.completionRatio).toBe(0.6667);
    expect(summary.rejectedCount).toBe(3);
    expect(summary.coverageStatus).toBe('partial');
  });

  it('keeps a roster-complete market healthy when dirty retailer runs stay above the market floor', () => {
    const snapshot = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [
      retailer(),
      retailer({ slug: 'retailer-b', name: 'Retailer B', pagesSucceeded: 8, errorsCount: 4, runStatus: 'partial' }),
    ]);

    expect(snapshot.status).toBe('healthy');
    expect(snapshot.attemptedPages).toBe(24);
    expect(snapshot.completedPages).toBe(20);
    expect(snapshot.failedPages).toBe(4);
    expect(snapshot.rejectedCount).toBe(0);
    expect(snapshot.retailers).toHaveLength(2);
    expect(snapshot.retailers[1].coverageStatus).toBe('partial');
  });

  it('keeps an error-free budget-truncated run partial when every attempted page succeeded', () => {
    const snapshot = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [
      retailer({ pagesAttempted: 5, pagesSucceeded: 5, runStatus: 'partial' }),
    ]);

    expect(snapshot.completionRatio).toBe(1);
    expect(snapshot.status).toBe('partial');
    expect(snapshot.retailers[0].coverageStatus).toBe('partial');
  });

  it('uses the market floor as the bounded tolerance while preserving a failed retailer diagnostic', () => {
    const snapshot = summarizeMarketCoverage('gb', '2026-08-01T00:00:00.000Z', [
      retailer({ slug: 'ocado-gb', name: 'Ocado UK' }),
      retailer({
        slug: 'tesco-gb',
        name: 'Tesco UK',
        pagesSucceeded: 0,
        errorsCount: 12,
        runStatus: 'failed',
      }),
    ]);

    expect(snapshot.completionRatio).toBe(0.5);
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.retailers[1].coverageStatus).toBe('failed');
  });

  it('reports perfect coverage when every observed retailer completes', () => {
    const recovered = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [
      retailer(),
      retailer({ slug: 'retailer-b', name: 'Retailer B' }),
    ]);

    expect(recovered.status).toBe('healthy');
    expect(recovered.completionRatio).toBe(1);
    expect(recovered.failedPages).toBe(0);
  });

  it('fails closed when no retailer produced a successful page', () => {
    const snapshot = summarizeMarketCoverage('ke', '2026-08-01T00:00:00.000Z', [
      retailer({ pagesSucceeded: 0, errorsCount: 12, runStatus: 'failed' }),
    ]);

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.completionRatio).toBe(0);
  });

  it('degrades below the market completion floor even when one page succeeds', () => {
    const snapshot = summarizeMarketCoverage('ke', '2026-08-01T00:00:00.000Z', [
      retailer({ pagesAttempted: 10, pagesSucceeded: 4, errorsCount: 6, runStatus: 'partial' }),
    ]);

    expect(snapshot.completionRatio).toBe(0.4);
    expect(snapshot.minimumCompletionRatio).toBe(0.5);
    expect(snapshot.status).toBe('degraded');
  });

  it('keeps mixed retailer states and an empty market explicit', () => {
    const mixed = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [
      retailer(),
      retailer({ slug: 'retailer-b', pagesAttempted: 0, pagesSucceeded: 0, runStatus: null }),
      retailer({ slug: 'retailer-c', pagesAttempted: 4, pagesSucceeded: 0, errorsCount: 4, runStatus: 'failed' }),
    ]);

    expect(mixed.status).toBe('partial');
    expect(mixed.retailers.map((entry) => entry.coverageStatus)).toEqual(['healthy', 'unknown', 'failed']);

    const empty = summarizeMarketCoverage('ch', '2026-08-01T00:00:00.000Z', []);
    expect(empty.status).toBe('unknown');
    expect(empty.completionRatio).toBeNull();
    expect(empty.retailers).toEqual([]);
  });

  // #6182: COVERAGE_PARTIAL on its own cannot distinguish "the pages never
  // loaded" from "a price was extracted and the validator refused it" — the
  // two need opposite fixes. The reason map is what separates them.
  it('carries per-retailer failure reasons and rolls them up per market', () => {
    const snapshot = summarizeMarketCoverage('sa', '2026-08-01T00:00:00.000Z', [
      retailer({
        slug: 'carrefour_sa',
        pagesSucceeded: 5,
        errorsCount: 7,
        runStatus: 'partial',
        failureReasons: { 'missing-price': 6, 'provider-error': 1 },
      }),
      retailer({
        slug: 'noon_sa',
        pagesSucceeded: 7,
        errorsCount: 5,
        runStatus: 'partial',
        failureReasons: { 'missing-price': 2, 'title-mismatch': 3 },
      }),
    ]);

    expect(snapshot.retailers[0].failureReasons).toEqual({ 'missing-price': 6, 'provider-error': 1 });
    expect(snapshot.failureReasons).toEqual({
      'missing-price': 8,
      'provider-error': 1,
      'title-mismatch': 3,
    });
  });

  // The vocabulary is closed. A code the reader does not know would be echoed
  // to operators through health as an uninterpretable diagnostic, and a
  // negative or fractional count would corrupt the market rollup.
  it('drops reasons outside the closed vocabulary and non-positive counts', () => {
    const summary = summarizeRetailerCoverage(retailer({
      pagesSucceeded: 10,
      errorsCount: 2,
      runStatus: 'partial',
      failureReasons: {
        'missing-price': 2,
        'not-a-real-reason': 5,
        'provider-error': 0,
        'title-mismatch': -3,
        'validator-rejected': 1.5,
      } as Record<string, number>,
    }));

    expect(summary.failureReasons).toEqual({ 'missing-price': 2 });
  });

  it('reports an empty reason map when the producer wrote none', () => {
    const summary = summarizeRetailerCoverage(retailer());
    expect(summary.failureReasons).toEqual({});

    const snapshot = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [retailer()]);
    expect(snapshot.failureReasons).toEqual({});
  });

});
