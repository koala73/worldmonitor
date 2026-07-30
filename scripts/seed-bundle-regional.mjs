#!/usr/bin/env node
// @ts-check
/**
 * Regional Intelligence seed bundle.
 *
 * Single Railway cron entry point that runs:
 *   1. seed-regional-snapshots.mjs  — ALWAYS (6h snapshot compute)
 *   2. seed-regional-briefs.mjs     — WEEKLY (LLM weekly brief, skipped
 *      if the last brief seed-meta is younger than 6.5 days)
 *
 * Railway cron: every 6 hours (cron: 0 [star]/6 [star] [star] [star])
 * rootDirectory: scripts
 * startCommand: node seed-bundle-regional.mjs
 *   (Railway executes from rootDirectory, so NO scripts/ prefix)
 * watchPaths: scripts/seed-bundle-regional.mjs, scripts/seed-regional-*.mjs,
 *             scripts/regional-snapshot/**, scripts/shared/**
 *
 * NOTE: both sub-seeders are imported in-process (not child_process.execFile)
 * because they were explicitly refactored to throw on failure instead of
 * calling process.exit(1). If either script re-introduces process.exit()
 * inside main(), the bundle will die before the second seeder runs.
 *
 * Env vars needed (same as the individual scripts):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   GROQ_API_KEY and/or OPENROUTER_API_KEY (for narrative + brief LLM)
 */

import { pathToFileURL } from 'node:url';
import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { main as runSnapshots } from './seed-regional-snapshots.mjs';
import { main as runBriefs } from './seed-regional-briefs.mjs';
import { flushPendingLlmEvents } from './lib/llm-telemetry.cjs';

loadEnvFile(import.meta.url);

const BRIEF_COOLDOWN_MS = 6.5 * 24 * 60 * 60 * 1000; // 6.5 days
const BRIEF_META_KEY = 'seed-meta:intelligence:regional-briefs';

// Retry-budget cap on the coverage-fail bypass (#4896 item 2). Each failed
// attempt refreshes the meta's fetchedAt, so the bypass alone re-ran ALL
// region briefs on every 6h tick for as long as an outage lasted (~28 LLM
// calls/day, timed exactly to provider incidents). The budget allows the
// fast self-heal (#2989) for transients — first retry on the next tick,
// one more after that — then pauses until the rolling 24h window expires.
const BRIEF_RETRY_BUDGET_KEY = 'intelligence:brief-retry-budget:v1';
const BRIEF_RETRY_BUDGET_PER_DAY = 2;
const BRIEF_RETRY_BUDGET_WINDOW_SEC = 86_400;

/**
 * Consume one unit of the rolling 24h bypass budget. Fails OPEN (returns
 * true) on any Redis error so a telemetry hiccup can never block the
 * self-healing path — the cap only bites when Redis positively reports the
 * budget as exhausted.
 */
async function consumeBriefRetryBudget(url, token) {
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', BRIEF_RETRY_BUDGET_KEY],
        // NX: only stamp the TTL when INCR just created the key, so the
        // window doesn't slide forward on every attempt.
        ['EXPIRE', BRIEF_RETRY_BUDGET_KEY, String(BRIEF_RETRY_BUDGET_WINDOW_SEC), 'NX'],
      ]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return true;
    const json = await resp.json();
    const count = Number(json?.[0]?.result);
    if (!Number.isFinite(count)) return true;
    return count <= BRIEF_RETRY_BUDGET_PER_DAY;
  } catch {
    return true;
  }
}

/**
 * Check if the weekly brief seeder should run by reading its seed-meta.
 * Returns true when:
 *   - the last run was >6.5 days ago (normal weekly cadence), OR
 *   - the meta key doesn't exist (first run), OR
 *   - the LAST run FAILED coverage (recordCount === 0).
 *
 * The coverage-fail bypass is the self-healing path: seed-regional-briefs
 * deliberately writes recordCount=0 when fewer than (expectedRegions-1)
 * briefs generate (e.g. a transient OpenRouter-credits outage makes every
 * region return an empty brief → skipped, failed===0, recordCount=0) so
 * /api/health flips to EMPTY_DATA instead of hiding partial failure (PR
 * #2989). Without this bypass the cooldown would pin that crit for ~5 more
 * days even after credits are restored. recordCount lives in the bare-shape
 * seed-meta and is exactly the field that drives /api/health, so it is the
 * authoritative "last run failed coverage" signal.
 */
async function shouldRunBriefs() {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(BRIEF_META_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return true; // Redis error → run defensively
    const data = await resp.json();
    if (!data?.result) return true; // key missing → first run
    const meta = unwrapEnvelope(JSON.parse(data.result)).data;
    const lastRun = meta?.fetchedAt ?? 0;
    const age = Date.now() - lastRun;
    if (age >= BRIEF_COOLDOWN_MS) {
      console.log(`[bundle] briefs: last run ${(age / 86_400_000).toFixed(1)} days ago, running`);
      return true;
    }
    // Bypass the cooldown when the last run failed coverage so a transient
    // failure self-heals on the next 6h tick instead of staying a crit for
    // the remainder of the cooldown window — bounded by the rolling 24h
    // retry budget so a sustained outage can't burn the brief fleet on
    // every tick until it ends.
    if (Number(meta?.recordCount ?? 0) === 0) {
      if (!(await consumeBriefRetryBudget(url, token))) {
        console.log(`[bundle] briefs: last run failed coverage but the retry budget (${BRIEF_RETRY_BUDGET_PER_DAY}/24h) is exhausted, skipping until it resets`);
        return false;
      }
      console.log(`[bundle] briefs: last run ${(age / 86_400_000).toFixed(1)} days ago but failed coverage (recordCount=0), bypassing cooldown to retry`);
      return true;
    }
    console.log(`[bundle] briefs: last run ${(age / 86_400_000).toFixed(1)} days ago, skipping (cooldown ${(BRIEF_COOLDOWN_MS / 86_400_000).toFixed(1)}d)`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bundle] briefs: cooldown check failed (${msg}), running defensively`);
    return true;
  }
}

async function main() {
  const t0 = Date.now();
  console.log('[bundle] Regional Intelligence seed bundle starting');

  let snapshotFailed = false;

  // 1. Always run snapshots (6h cadence)
  console.log('[bundle] ── Running regional snapshots ──');
  try {
    await runSnapshots();
  } catch (err) {
    snapshotFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bundle] snapshots failed: ${msg}`);
    // Continue to briefs check — but skip briefs if snapshots failed
    // so we don't generate a weekly brief from stale data.
  }

  // 2. Conditionally run briefs (weekly). SKIP if snapshots failed this
  // cycle — the brief reads the :latest snapshot from Redis with no
  // freshness check, so running after a snapshot failure would produce a
  // brief summarizing stale state and write fresh seed-meta that hides
  // the staleness. PR #3001 review M2.
  if (!snapshotFailed && await shouldRunBriefs()) {
    console.log('[bundle] ── Running weekly briefs ──');
    try {
      await runBriefs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bundle] briefs failed: ${msg}`);
      // Don't exit yet — report failure below.
      snapshotFailed = true; // reuse flag for exit code
    }
  } else if (snapshotFailed) {
    console.log('[bundle] ── Skipping weekly briefs (snapshots failed this cycle) ──');
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Exit non-zero when any seeder failed so Railway cron monitoring can
  // detect broken runs. PR #3001 review H1.
  if (snapshotFailed) {
    console.error(`[bundle] Done in ${elapsed}s with ERRORS`);
    // process.exit does not drain in-flight promises — flush fire-and-forget
    // llm_call telemetry first (bounded by the 1.5s fetch timeout).
    await flushPendingLlmEvents();
    process.exit(1);
  }
  console.log(`[bundle] Done in ${elapsed}s`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(async (err) => {
    console.error('[bundle] Fatal:', err);
    await flushPendingLlmEvents();
    process.exit(1);
  });
}

export { shouldRunBriefs, BRIEF_COOLDOWN_MS, BRIEF_META_KEY };
