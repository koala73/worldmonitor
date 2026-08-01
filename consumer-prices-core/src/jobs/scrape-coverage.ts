export interface ValidatorOutcome {
  ok: boolean;
}

export interface ScrapeRunUpdate {
  runId: string;
  status: string;
  pagesAttempted: number;
  pagesSucceeded: number;
  errorsCount: number;
  rejectedCount: number;
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
