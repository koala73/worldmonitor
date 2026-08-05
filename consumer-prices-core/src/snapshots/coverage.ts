import { query } from '../db/client.js';
import {
  summarizeMarketCoverage,
  type MarketCoverageSnapshot,
  type RetailerCoverageInput,
} from '../ops/coverage.js';

interface LatestScrapeRunRow {
  slug: string;
  name: string;
  last_run_at: Date | string | null;
  run_status: string | null;
  pages_attempted: number | string | null;
  pages_succeeded: number | string | null;
  errors_count: number | string | null;
  rejected_count: number | string | null;
  active_started_at: Date | string | null;
  active_pages_attempted: number | string | null;
  active_pages_succeeded: number | string | null;
  active_errors_count: number | string | null;
  active_rejected_count: number | string | null;
}

function asCount(value: number | string | null): number {
  return Math.max(0, Number(value) || 0);
}

function asIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function buildCoverageSnapshot(marketCode: string): Promise<MarketCoverageSnapshot> {
  const result = await query<LatestScrapeRunRow>(
    `SELECT
       r.slug,
       r.name,
       latest.started_at AS last_run_at,
       latest.status AS run_status,
       COALESCE(latest.pages_attempted, 0) AS pages_attempted,
       COALESCE(latest.pages_succeeded, 0) AS pages_succeeded,
       COALESCE(latest.errors_count, 0) AS errors_count,
       COALESCE(latest.rejected_count, 0) AS rejected_count,
       active.started_at AS active_started_at,
       COALESCE(active.pages_attempted, 0) AS active_pages_attempted,
       COALESCE(active.pages_succeeded, 0) AS active_pages_succeeded,
       COALESCE(active.errors_count, 0) AS active_errors_count,
       COALESCE(active.rejected_count, 0) AS active_rejected_count
     FROM retailers r
     LEFT JOIN LATERAL (
       SELECT started_at, status, pages_attempted, pages_succeeded, errors_count, rejected_count
       FROM scrape_runs
       WHERE retailer_id = r.id AND status IN ('completed', 'partial', 'failed')
       ORDER BY started_at DESC
       LIMIT 1
     ) latest ON TRUE
     LEFT JOIN LATERAL (
       SELECT started_at, pages_attempted, pages_succeeded, errors_count, rejected_count
       FROM scrape_runs
       WHERE retailer_id = r.id AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1
     ) active ON TRUE
     WHERE r.market_code = $1 AND r.active = true
     ORDER BY r.slug`,
    [marketCode],
  );

  const inputs: RetailerCoverageInput[] = result.rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    lastRunAt: asIso(row.last_run_at),
    runStatus: row.run_status,
    pagesAttempted: asCount(row.pages_attempted),
    pagesSucceeded: asCount(row.pages_succeeded),
    errorsCount: asCount(row.errors_count),
    rejectedCount: asCount(row.rejected_count),
    activeRun: row.active_started_at ? {
      startedAt: asIso(row.active_started_at)!,
      pagesAttempted: asCount(row.active_pages_attempted),
      pagesSucceeded: asCount(row.active_pages_succeeded),
      errorsCount: asCount(row.active_errors_count),
      rejectedCount: asCount(row.active_rejected_count),
    } : null,
  }));

  return summarizeMarketCoverage(marketCode, String(Date.now()), inputs);
}
