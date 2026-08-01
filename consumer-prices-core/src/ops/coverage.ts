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
