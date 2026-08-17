import type { ExtractionFailure, ExtractionFailureReason } from '../adapters/search.js';

export interface ValidatorOutcome {
  ok: boolean;
}

/**
 * Failure classes that are not extraction outcomes: the page parsed to nothing,
 * a direct pin was refused by the strict validator, or the target loop threw
 * something that carried no attribution. Every `errorsCount++` site in
 * scrape.ts maps to one of these or to an `ExtractionFailureReason`, which is
 * what lets the tally reconcile against `errorsCount`.
 */
export type NonExtractionFailureReason =
  | 'parsed-zero-products'
  | 'pin-validator-rejected'
  | 'unknown-error';

export type CoverageFailureReason = ExtractionFailureReason | NonExtractionFailureReason;

/**
 * How far down the pipeline a candidate URL got before failing, ascending.
 *
 * A failed page burns several candidate URLs and each can fail differently, so
 * the page has to collapse to ONE class or the tally stops summing to
 * `errorsCount`. Reporting the FURTHEST stage reached is the informative
 * choice: `provider-error` on every candidate means the pages never loaded,
 * while `validator-rejected` means a price was extracted and then refused —
 * opposite diagnoses that a first-failure or last-failure rule would blur.
 *
 * KNOWN LIMITATION, and the reason the two provider classes sit at the bottom:
 * a page where the primary extractor answered `missing-price` AND the fallback
 * provider errored is reported as `missing-price`, so a fallback-only outage is
 * masked whenever the primary still runs. That is deliberate — the page's own
 * outcome really was "never priced" — but it means this map is not a provider
 * health signal. Provider faults surface here only when they are the whole
 * story for a page; the `[search:provider-cooldown]` log line is what tells you
 * a provider died mid-scrape. (Exactly this masking hid the Exa /contents 400
 * repaired in #6270.)
 */
const EXTRACTION_STAGE_ORDER: readonly ExtractionFailureReason[] = [
  'provider-cooldown',
  'provider-error',
  'missing-price',
  // A price was extracted but its digits were absent from the rendered page —
  // the deterministic anti-fabrication gate (#6182). Further along than
  // missing-price (something was read), earlier than the semantic rejections
  // (nothing about the product was judged yet).
  'price-evidence-missing',
  'quantity-as-price',
  'currency-mismatch',
  'title-mismatch',
  'validator-rejected',
];

/** The closed vocabulary health echoes back to operators. */
export const COVERAGE_FAILURE_REASONS: readonly CoverageFailureReason[] = [
  ...EXTRACTION_STAGE_ORDER,
  'parsed-zero-products',
  'pin-validator-rejected',
  'unknown-error',
];

export function terminalFailureReason(
  failures: readonly ExtractionFailure[],
): CoverageFailureReason {
  let furthest = -1;
  for (const { reason } of failures) {
    const stage = EXTRACTION_STAGE_ORDER.indexOf(reason);
    if (stage > furthest) furthest = stage;
  }
  // No attributed failure at all — a non-SearchTargetError escaped the target
  // loop. Naming it keeps the tally reconciling instead of silently short.
  return furthest === -1 ? 'unknown-error' : EXTRACTION_STAGE_ORDER[furthest];
}

/**
 * Per-run breakdown of WHY coverage was lost.
 *
 * #6182 asks for the exact failure class of every failed page. The adapter
 * already computes that vocabulary and `scrape.ts` threw it away one line
 * before persistence, so every diagnosis needed Railway log archaeology.
 * This accumulates it into a bounded record that rides along to seed metadata
 * and health next to the counts it explains.
 *
 * One bump per counted error, which is what makes `total` usable as the run's
 * `errorsCount`. That is per PAGE for a failed target and for a page that
 * parsed nothing, but per PRODUCT for a direct-pin validator rejection — a
 * page carrying several rejected pinned products counts each one, matching
 * the accounting `scrape.ts` has always used.
 */
export class FailureReasonTally {
  private readonly counts = new Map<CoverageFailureReason, number>();

  private bump(reason: CoverageFailureReason): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  recordPageFailure(failures: readonly ExtractionFailure[]): void {
    this.bump(terminalFailureReason(failures));
  }

  recordParsedZeroProducts(): void {
    this.bump('parsed-zero-products');
  }

  recordPinValidatorRejection(): void {
    this.bump('pin-validator-rejected');
  }

  get total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  /** Reasons that never fired are omitted, so a clean run publishes `{}`. */
  toJSON(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

export interface ScrapeRunUpdate {
  runId: string;
  status: string;
  pagesAttempted: number;
  pagesSucceeded: number;
  errorsCount: number;
  rejectedCount: number;
  failureReasons?: Record<string, number>;
}

export function createScrapeRunStatement(retailerId: string) {
  return {
    sql: `INSERT INTO scrape_runs (retailer_id, started_at, status, trigger_type, pages_attempted, pages_succeeded, errors_count, rejected_count, config_version)
     VALUES ($1, NOW(), 'running', 'scheduled', 0, 0, 0, 0, '1') RETURNING id`,
    params: [retailerId],
  };
}

export function updateScrapeRunStatement(update: ScrapeRunUpdate) {
  return {
    sql: `UPDATE scrape_runs SET status=$2, finished_at=NOW(), pages_attempted=$3, pages_succeeded=$4, errors_count=$5, rejected_count=$6, failure_reasons=$7 WHERE id=$1`,
    params: [
      update.runId,
      update.status,
      update.pagesAttempted,
      update.pagesSucceeded,
      update.errorsCount,
      update.rejectedCount,
      // Always written, never left untouched: a recovered run that skipped the
      // column would keep serving the previous run's reasons and read as
      // still-broken.
      JSON.stringify(update.failureReasons ?? {}),
    ],
  };
}

/**
 * Pre-migration-011 column list.
 *
 * None of the three consumer-price Railway services runs the migration
 * runner, so `migrations/011_scrape_run_failure_reasons.sql` is applied by
 * hand and this code can reach production first. Losing the whole
 * `updateScrapeRun` to an undefined column would strand every run row at
 * status='running' — and buildCoverageSnapshot only reads terminal runs, so
 * the market's coverage would silently freeze at the previous day's numbers.
 * Dropping one diagnostic field is the correct degradation; losing the run
 * accounting is not.
 */
export function legacyUpdateScrapeRunStatement(update: ScrapeRunUpdate) {
  return {
    sql: `UPDATE scrape_runs SET status=$2, finished_at=NOW(), pages_attempted=$3, pages_succeeded=$4, errors_count=$5, rejected_count=$6 WHERE id=$1`,
    params: [
      update.runId,
      update.status,
      update.pagesAttempted,
      update.pagesSucceeded,
      update.errorsCount,
      update.rejectedCount,
    ],
  };
}

/**
 * Postgres `undefined_column` (42703) — the ONLY error the legacy retry may
 * swallow. Widening this to any failure would turn a connection drop or a
 * violated constraint into a silent downgrade.
 */
export function isMissingColumnError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '42703'
  );
}

export function classifyValidatorOutcome(
  validator: ValidatorOutcome | undefined,
  wasDirectHit: boolean,
) {
  if (!validator || validator.ok) {
    return { rejectedCount: 0, skipObservation: false, errorCount: 0 };
  }
  // Direct pins are admitted only when the strict validator passes. Search
  // discoveries remain observable as candidates for the existing recovery and
  // review workflow; their validator rejection is counted without promoting
  // the candidate into aggregates (scrape.ts keeps matchStatus=candidate).
  return {
    rejectedCount: 1,
    skipObservation: wasDirectHit,
    errorCount: wasDirectHit ? 1 : 0,
  };
}

/** Default wall-clock ceiling for one retailer's target loop. */
export const DEFAULT_RUN_BUDGET_MS = 20 * 60_000;

/**
 * Resolve the run budget from config. A non-numeric or non-positive value
 * disables the ceiling rather than truncating every run instantly — a typo'd
 * env var must not silently gut coverage.
 */
export function resolveRunBudgetMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_RUN_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return Number.POSITIVE_INFINITY;
  return parsed;
}

/** True once the target loop has spent its wall-clock budget. */
export function isRunBudgetExhausted(startedAt: number, now: number, budgetMs: number): boolean {
  if (!Number.isFinite(budgetMs)) return false;
  return now - startedAt > budgetMs;
}

/**
 * Terminal run status. A budget-truncated run is 'partial' even with zero
 * errors: it never attempted every target, and reporting 'completed' would
 * refresh the freshness marker while part of the basket was skipped.
 */
export function resolveRunStatus(
  errorsCount: number,
  pagesSucceeded: number,
  budgetExhausted: boolean,
): 'completed' | 'partial' | 'failed' {
  if (errorsCount === 0 && !budgetExhausted) return 'completed';
  return pagesSucceeded > 0 ? 'partial' : 'failed';
}
