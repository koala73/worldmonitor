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
 * Railway cron: every 6 hours (0 */6 * * *)
 * startCommand: node scripts/seed-bundle-regional.mjs
 * rootDirectory: scripts
 * watchPaths: scripts/seed-bundle-regional.mjs, scripts/seed-regional-*.mjs,
 *             scripts/regional-snapshot/**, scripts/shared/**
 *
 * Env vars needed (same as the individual scripts):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   GROQ_API_KEY and/or OPENROUTER_API_KEY (for narrative + brief LLM)
 */

import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';
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
    const meta = JSON.parse(data.result);
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

  // 1. Always run snapshots (6h cadence)
  console.log('[bundle] ── Running regional snapshots ──');
  try {
    await runSnapshots();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bundle] snapshots failed: ${msg}`);
    // Continue to briefs check even if snapshots failed — they're independent.
  }

  // 2. Conditionally run briefs (weekly)
  if (await shouldRunBriefs()) {
    console.log('[bundle] ── Running weekly briefs ──');
    try {
      await runBriefs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bundle] briefs failed: ${msg}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[bundle] Done in ${elapsed}s`);
}

main().catch((err) => {
  console.error('[bundle] Fatal:', err);
  process.exit(1);
});
