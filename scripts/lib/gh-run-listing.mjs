// Successful GitHub listings can be stale index snapshots (#8613, #8617).
// Compare independent reads; transport retries alone cannot detect that case.
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

// Creation time alone ties on reruns: resolve by id, attempt, then settled state.
export function supersedesRun(candidate, incumbent) {
  const candidateMs = Date.parse(candidate.created_at ?? candidate.updated_at);
  const incumbentMs = Date.parse(incumbent.created_at ?? incumbent.updated_at);
  if (candidateMs !== incumbentMs) return candidateMs > incumbentMs;
  if (candidate.id !== incumbent.id) return Number(candidate.id) > Number(incumbent.id);
  const attempt = Number(candidate.run_attempt ?? 1);
  const previousAttempt = Number(incumbent.run_attempt ?? 1);
  if (attempt !== previousAttempt) return attempt > previousAttempt;
  return ACTIVE_RUN_STATUSES.has(incumbent.status) && !ACTIVE_RUN_STATUSES.has(candidate.status);
}

export function corroborateRunListings({
  read, samples = 3, alarmQuorum = 2, sampleBudgetMs = 90_000,
  clock = Date.now, workflowFile = 'workflow',
}) {
  const startedAt = clock();
  const answered = [];
  let failure;
  for (let sample = 0; sample < samples; sample += 1) {
    try {
      answered.push(read());
    } catch (error) {
      failure ??= error;
    }
    // Each caller also bounds a single gh call. Stop even if no read answered.
    if (clock() - startedAt >= sampleBudgetMs) break;
  }
  if (!answered.length) throw failure ?? new Error(`the run listing for ${workflowFile} produced no samples`);
  const totals = answered.map(sample => sample.totalCount).filter(Number.isInteger);
  const widest = totals.length ? Math.max(...totals) : null;
  // Counts are comparable only across the same query during this short window.
  // A narrower count (absent deletions), or an empty sibling beside runs, is
  // an older view. A missing count is unknown, not zero.
  const hasRuns = answered.some(sample => sample.runs.length);
  const survivors = answered.filter(sample =>
    !(widest !== null && Number.isInteger(sample.totalCount) && sample.totalCount < widest)
    && !(sample.totalCount > 0 && !sample.runs.length)
    && !(hasRuns && !sample.runs.length));
  if (survivors.length < alarmQuorum) {
    const error = new Error(`the run listing for ${workflowFile} could not be corroborated: ${survivors.length} of ${samples} sample(s) agreed, ${alarmQuorum} required`);
    error.githubRecordUncorroborated = true;
    error.githubReadSource = 'github-api';
    throw error;
  }
  return survivors;
}

// Keep every run in a window, replacing an older attempt with the newer one.
export function reduceRunListings(listings) {
  const byId = new Map();
  for (const { runs } of listings) {
    for (const run of runs) {
      const previous = byId.get(String(run.id));
      if (!previous || supersedesRun(run, previous)) byId.set(String(run.id), run);
    }
  }
  return [...byId.values()].sort((a, b) => supersedesRun(a, b) ? -1 : supersedesRun(b, a) ? 1 : 0);
}
