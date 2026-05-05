/**
 * Cron-driven GDELT refresh for the intel-news topic accumulators.
 *
 * # Why a cron handler
 *
 * GDELT enforces "1 request per 5 seconds per IP" (per their 429 response
 * body). Fan-out from a user request can't respect this without burning
 * the entire edge-function timeout budget. A scheduled cron runs
 * server-side, sequentially fetches all 10 topics with 5.5 s pacing
 * (~55 s total), and writes the results into the per-topic accumulator.
 *
 * # User-facing endpoint
 *
 * `/api/intel-news/v1/list-headlines` reads the accumulators directly —
 * no GDELT calls from user requests, sub-100 ms response times, and
 * GDELT's rate limit is fully insulated from traffic spikes.
 *
 * # Schedule
 *
 * Configured in `vercel.json`'s `crons` block. Default: every 15 minutes,
 * matching GDELT's own ~15-min update cadence.
 *
 * # Budget
 *
 * Vercel edge functions on Pro support `maxDuration: 60`. We allocate
 * 55 s of work and reserve 5 s for tail housekeeping. If GDELT is
 * unusually slow and we approach the budget, the loop short-circuits
 * — accumulator preserves prior data for those topics.
 */

import { INTEL_TOPICS } from './_topics';
import { fetchTopicArticlesPublic, mergeIntoAccumulator } from './list-headlines';

/** Time budget for the entire refresh run, in ms. Stay under
 *  edge `maxDuration: 60` (Pro plan) with a safety margin. */
const BUDGET_MS = 55_000;

/** Spacing between consecutive GDELT calls — must be ≥ 5 s per
 *  GDELT's fair-use policy. 5500 ms is a 10 % cushion. */
const PACE_MS = 5_500;

interface RefreshResult {
  succeeded: number;
  failed: number;
  skipped: number;        // topics not even attempted (budget exhausted)
  durationMs: number;
  perTopic: Array<{
    id: string;
    outcome: 'success' | 'failed' | 'skipped';
    items?: number;
    elapsedMs?: number;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function refreshAllTopics(): Promise<RefreshResult> {
  const runStartMs = Date.now();
  const result: RefreshResult = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    perTopic: [],
  };

  let lastRequestStartMs = 0;

  for (const topic of INTEL_TOPICS) {
    const elapsedSinceStart = Date.now() - runStartMs;

    // Budget gate — if there's not enough time to safely fetch this topic
    // (assume a 10 s slowest-case GDELT response), skip it. Accumulator
    // preserves prior data; next cron run picks it up.
    if (elapsedSinceStart > BUDGET_MS - 10_000) {
      console.log(`[intel-news:refresh] budget exhausted at ${elapsedSinceStart}ms, skipping ${topic.id}`);
      result.skipped++;
      result.perTopic.push({ id: topic.id, outcome: 'skipped' });
      continue;
    }

    // Pacing gate — wait until 5.5 s have elapsed since the previous
    // GDELT call started. If the last fetch was slow (>5.5 s), no wait
    // needed; otherwise we sleep the difference.
    if (lastRequestStartMs > 0) {
      const sinceLast = Date.now() - lastRequestStartMs;
      if (sinceLast < PACE_MS) {
        await sleep(PACE_MS - sinceLast);
      }
    }

    lastRequestStartMs = Date.now();
    const fetchStart = Date.now();

    try {
      const fresh = await fetchTopicArticlesPublic(topic);
      const fetchMs = Date.now() - fetchStart;

      if (fresh) {
        await mergeIntoAccumulator(topic.id, fresh.items);
        result.succeeded++;
        result.perTopic.push({ id: topic.id, outcome: 'success', items: fresh.items.length, elapsedMs: fetchMs });
        console.log(`[intel-news:refresh] ${topic.id}: ${fresh.items.length} items in ${fetchMs}ms ✓`);
      } else {
        result.failed++;
        result.perTopic.push({ id: topic.id, outcome: 'failed', elapsedMs: fetchMs });
        console.warn(`[intel-news:refresh] ${topic.id}: failed in ${fetchMs}ms ✗`);
      }
    } catch (err) {
      const fetchMs = Date.now() - fetchStart;
      result.failed++;
      result.perTopic.push({ id: topic.id, outcome: 'failed', elapsedMs: fetchMs });
      console.warn(`[intel-news:refresh] ${topic.id}: threw after ${fetchMs}ms — ${(err as Error).message}`);
    }
  }

  result.durationMs = Date.now() - runStartMs;
  console.log(
    `[intel-news:refresh] done in ${result.durationMs}ms · ` +
    `${result.succeeded} ok, ${result.failed} failed, ${result.skipped} skipped`,
  );
  return result;
}
