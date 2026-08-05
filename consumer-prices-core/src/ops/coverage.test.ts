import { describe, expect, it } from 'vitest';
import {
  COVERAGE_ACTIVATION_SCHEMA_VERSION,
  coverageActivationKey,
  isActivatingCoverage,
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

  it('marks a market partial when one retailer is incomplete', () => {
    const snapshot = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [
      retailer(),
      retailer({ slug: 'retailer-b', name: 'Retailer B', pagesSucceeded: 8, errorsCount: 4, runStatus: 'partial' }),
    ]);

    expect(snapshot.status).toBe('partial');
    expect(snapshot.attemptedPages).toBe(24);
    expect(snapshot.completedPages).toBe(20);
    expect(snapshot.failedPages).toBe(4);
    expect(snapshot.rejectedCount).toBe(0);
    expect(snapshot.retailers).toHaveLength(2);
  });

  it('recovers to healthy only after every observed retailer completes', () => {
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

  it('does not call an in-progress scrape healthy before it finishes', () => {
    const snapshot = summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', [
      retailer({ pagesSucceeded: 12, runStatus: 'running' }),
    ]);

    expect(snapshot.status).toBe('partial');
    expect(snapshot.retailers[0].coverageStatus).toBe('partial');
  });
});

// #6059 — the marker that permanently revokes WorldMonitor health's bounded
// deploy-before-cron softening for a market. It is irreversible, so the bar is
// "this market really published coverage", not "the publisher ran".
describe('coverage schema activation handshake', () => {
  const marketWith = (overrides: Partial<Parameters<typeof summarizeRetailerCoverage>[0]>[]) =>
    summarizeMarketCoverage('ae', '2026-08-01T00:00:00.000Z', overrides.map((o) => retailer(o)));

  it('pins the versioned key shape WorldMonitor health probes with EXISTS', () => {
    expect(COVERAGE_ACTIVATION_SCHEMA_VERSION).toBe(1);
    expect(coverageActivationKey('us')).toBe('seed-activated:consumer-prices:coverage:v1:us');
    // The version lives IN the key so a future coverage shape cannot inherit
    // activation earned by v1 — it opens its own reviewed rollout window.
    expect(coverageActivationKey('ae')).toMatch(/^seed-activated:consumer-prices:coverage:v\d+:[a-z]{2}$/);
  });

  it('activates on real coverage, including a truthful report of a failing scrape', () => {
    expect(isActivatingCoverage(marketWith([{}]))).toBe(true);
    expect(
      isActivatingCoverage(marketWith([{ pagesSucceeded: 0, errorsCount: 12, runStatus: 'failed' }])),
    ).toBe(true);
  });

  it('withholds activation when no page was ever attempted for the market', () => {
    const neverRan = marketWith([{ pagesAttempted: 0, pagesSucceeded: 0, runStatus: null }]);
    // Publishing this is correct and truthful — but it proves the publisher ran,
    // not that the market's coverage pipeline works, and activation is one-way.
    expect(neverRan.status).toBe('degraded');
    expect(isActivatingCoverage(neverRan)).toBe(false);
  });

  it('withholds activation for a market with no active retailers', () => {
    expect(isActivatingCoverage(summarizeMarketCoverage('ch', '2026-08-01T00:00:00.000Z', []))).toBe(false);
    expect(isActivatingCoverage(null)).toBe(false);
    expect(isActivatingCoverage(undefined)).toBe(false);
  });
});
