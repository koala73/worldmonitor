/**
 * Operational scrape coverage summaries.
 *
 * This module reports what each retailer run attempted, completed, rejected,
 * and failed. It deliberately does not change validator admission rules: a
 * rejected observation remains rejected, and the count exists so partial
 * publication is visible. Source parsing/provider recovery remain tracked by
 * #5445 and #5811; this is the coordination/health layer only.
 */

export const MIN_MARKET_COMPLETION_RATIO = 0.5;

/**
 * Coverage-schema activation handshake (#6059).
 *
 * WorldMonitor's Edge health registry (api/health.js) ships the moment a PR
 * merges, but these coverage keys only exist after the next daily
 * scrape→aggregate→publish window. Health softens that gap to a bounded
 * `ROLLOUT_PENDING` warn and revokes the softening permanently the instant this
 * marker appears, so the marker is a ONE-WAY, DURABLE (no TTL) claim: "market
 * <code> has published real coverage under schema v<N> at least once."
 *
 * Keep `COVERAGE_ACTIVATION_SCHEMA_VERSION` and the key shape in lockstep with:
 *   - api/health.js  (`consumerPriceCoverageActivationKey`)
 *   - scripts/seed-consumer-prices.mjs  (manual fallback publisher)
 * tests/consumer-prices-coverage-rollout.test.mjs pins all three together.
 */
export const COVERAGE_ACTIVATION_SCHEMA_VERSION = 1;

export function coverageActivationKey(marketCode: string): string {
  return `seed-activated:consumer-prices:coverage:v${COVERAGE_ACTIVATION_SCHEMA_VERSION}:${marketCode}`;
}

/**
 * True only when the snapshot is REAL per-market coverage — at least one active
 * retailer and at least one page actually attempted for this market.
 *
 * Deliberately not satisfied by a truthful-but-empty snapshot (no retailers, or
 * retailers configured but zero runs recorded): publishing "nothing has ever
 * been scraped here" proves the publisher ran, not that the market's coverage
 * pipeline works, and activation is irreversible. A `degraded` snapshot with
 * attempted pages DOES activate — it is a real, correct coverage report of a
 * failing scrape, and health must be strict about that market from then on.
 */
export function isActivatingCoverage(
  snapshot: Pick<MarketCoverageSnapshot, 'attemptedPages' | 'retailers'> | null | undefined,
): boolean {
  if (!snapshot || !Array.isArray(snapshot.retailers) || snapshot.retailers.length === 0) return false;
  return Number(snapshot.attemptedPages) > 0;
}

export type RetailerCoverageStatus = 'healthy' | 'partial' | 'failed' | 'unknown';
export type MarketCoverageStatus = 'healthy' | 'partial' | 'degraded' | 'unknown';

export interface RetailerCoverageInput {
  slug: string;
  name: string;
  lastRunAt: string | null;
  runStatus: string | null;
  pagesAttempted: number;
  pagesSucceeded: number;
  errorsCount: number;
  rejectedCount: number;
  activeRun?: ActiveScrapeRun | null;
}

export interface ActiveScrapeRun {
  startedAt: string;
  pagesAttempted: number;
  pagesSucceeded: number;
  errorsCount: number;
  rejectedCount: number;
}

export interface RetailerCoverage extends RetailerCoverageInput {
  failedPages: number;
  completionRatio: number | null;
  coverageStatus: RetailerCoverageStatus;
}

export interface MarketCoverageSnapshot {
  marketCode: string;
  asOf: string;
  attemptedPages: number;
  completedPages: number;
  failedPages: number;
  completionRatio: number | null;
  rejectedCount: number;
  status: MarketCoverageStatus;
  minimumCompletionRatio: number;
  retailers: RetailerCoverage[];
  upstreamUnavailable: false;
}

function nonNegativeInt(value: number | null | undefined): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

export function summarizeRetailerCoverage(input: RetailerCoverageInput): RetailerCoverage {
  const pagesAttempted = nonNegativeInt(input.pagesAttempted);
  const pagesSucceeded = Math.min(pagesAttempted, nonNegativeInt(input.pagesSucceeded));
  const failedPages = Math.max(0, pagesAttempted - pagesSucceeded);
  const errorsCount = nonNegativeInt(input.errorsCount);
  const rejectedCount = nonNegativeInt(input.rejectedCount);
  const completionRatio = pagesAttempted > 0
    ? Number((pagesSucceeded / pagesAttempted).toFixed(4))
    : null;

  let coverageStatus: RetailerCoverageStatus = 'unknown';
  if (pagesAttempted > 0 && pagesSucceeded === 0) coverageStatus = 'failed';
  else if (
    pagesAttempted > 0 &&
    (input.runStatus !== 'completed' || failedPages > 0 || errorsCount > 0 || rejectedCount > 0)
  ) coverageStatus = 'partial';
  else if (pagesAttempted > 0) coverageStatus = 'healthy';

  return {
    ...input,
    pagesAttempted,
    pagesSucceeded,
    errorsCount,
    rejectedCount,
    failedPages,
    completionRatio,
    coverageStatus,
  };
}

export function summarizeMarketCoverage(
  marketCode: string,
  asOf: string,
  inputs: RetailerCoverageInput[],
): MarketCoverageSnapshot {
  const retailers = inputs.map(summarizeRetailerCoverage);
  const attemptedPages = retailers.reduce((sum, retailer) => sum + retailer.pagesAttempted, 0);
  const completedPages = retailers.reduce((sum, retailer) => sum + retailer.pagesSucceeded, 0);
  const failedPages = retailers.reduce((sum, retailer) => sum + retailer.failedPages, 0);
  const rejectedCount = retailers.reduce((sum, retailer) => sum + retailer.rejectedCount, 0);
  const completionRatio = attemptedPages > 0
    ? Number((completedPages / attemptedPages).toFixed(4))
    : null;
  const hasSuccessfulRetailer = retailers.some((retailer) => retailer.pagesSucceeded > 0);
  const hasUnknownRetailer = retailers.some((retailer) => retailer.coverageStatus === 'unknown');
  const hasPartialRetailer = retailers.some((retailer) => retailer.coverageStatus === 'partial');
  const hasFailedRetailer = retailers.some((retailer) => retailer.coverageStatus === 'failed');

  let status: MarketCoverageStatus = 'unknown';
  if (retailers.length > 0 && hasSuccessfulRetailer && completionRatio != null && completionRatio < MIN_MARKET_COMPLETION_RATIO) {
    status = 'degraded';
  } else if (retailers.length > 0 && hasSuccessfulRetailer && (hasUnknownRetailer || hasPartialRetailer || hasFailedRetailer || completionRatio !== 1)) {
    status = 'partial';
  } else if (retailers.length > 0 && hasSuccessfulRetailer && completionRatio === 1 && !hasUnknownRetailer) {
    status = 'healthy';
  } else if (retailers.length > 0 && !hasSuccessfulRetailer) {
    status = 'degraded';
  }

  return {
    marketCode,
    asOf,
    attemptedPages,
    completedPages,
    failedPages,
    completionRatio,
    rejectedCount,
    status,
    minimumCompletionRatio: MIN_MARKET_COMPLETION_RATIO,
    retailers,
    upstreamUnavailable: false,
  };
}
