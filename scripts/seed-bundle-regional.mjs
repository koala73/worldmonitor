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

import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { main as runSnapshots } from './seed-regional-snapshots.mjs';
import { main as runBriefs } from './seed-regional-briefs.mjs';

loadEnvFile(import.meta.url);

const BRIEF_COOLDOWN_MS = 6.5 * 24 * 60 * 60 * 1000; // 6.5 days
const BRIEF_META_KEY = 'seed-meta:intelligence:regional-briefs';

/**
 * Check if the weekly brief seeder should run by reading its seed-meta
 * timestamp. Returns true when the last run was >6.5 days ago or the
 * meta key doesn't exist (first run).
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
    process.exit(1);
  }
  console.log(`[bundle] Done in ${elapsed}s`);
}

main().catch((err) => {
  console.error('[bundle] Fatal:', err);
  process.exit(1);
});
