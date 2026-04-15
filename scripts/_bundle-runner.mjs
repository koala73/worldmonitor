#!/usr/bin/env node
/**
 * Bundle orchestrator: spawns multiple seed scripts sequentially
 * via child_process.execFile, with freshness-gated skipping.
 *
 * Pattern matches ais-relay.cjs:5645-5695 (ClimateNews/ChokepointFlows spawns).
 *
 * Usage from a bundle script:
 *   import { runBundle } from './_bundle-runner.mjs';
 *   await runBundle('ecb-eu', [ { label, script, seedMetaKey, intervalMs, timeoutMs } ]);
 *
 * Budget (opt-in): Railway cron services SIGKILL the container at 10min. If
 * the sum of timeoutMs for sections that happen to be due exceeds ~9min, we
 * risk losing the in-flight section's logs AND marking the job as crashed.
 * Callers on Railway cron can pass `{ maxBundleMs }` to enforce a wall-time
 * budget — sections whose worst-case timeout wouldn't fit in the remaining
 * budget are deferred to the next tick. Default is Infinity (no budget) so
 * existing bundles whose individual sections already exceed 9min (e.g.
 * 600_000-1 timeouts in imf-extended, energy-sources) are not silently
 * broken by adopting the runner.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 604_800_000;

loadEnvFile(import.meta.url);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function readRedisKey(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    return body.result ? JSON.parse(body.result) : null;
  } catch {
    return null;
  }
}

/**
 * Read section freshness for the interval gate.
 *
 * Returns `{ fetchedAt }` or null. Prefers envelope-form data when the section
 * declares `canonicalKey` (PR 2+); falls back to the legacy `seed-meta:<key>`
 * read used by every bundle file today. PR 1 keeps legacy as the ONLY live
 * path — `unwrapEnvelope` here is behavior-preserving because legacy seed-meta
 * values have no `_seed` field and pass through as `data` unchanged. When PR 2
 * migrates bundles to `canonicalKey`, this function starts reading envelopes.
 */
async function readSectionFreshness(section) {
  // Try the envelope path first when a canonicalKey is declared. If the canonical
  // key isn't yet written as an envelope (PR 2 writer migration lagging reader
  // migration, or a legacy payload still present), fall through to the legacy
  // seed-meta read so the bundle doesn't over-run during the transition.
  if (section.canonicalKey) {
    const raw = await readRedisKey(section.canonicalKey);
    const { _seed } = unwrapEnvelope(raw);
    if (_seed?.fetchedAt) return { fetchedAt: _seed.fetchedAt };
  }
  if (section.seedMetaKey) {
    const raw = await readRedisKey(`seed-meta:${section.seedMetaKey}`);
    // Legacy seed-meta is `{ fetchedAt, recordCount, sourceVersion }` at top
    // level. It has no `_seed` wrapper so unwrapEnvelope returns it as data.
    const meta = unwrapEnvelope(raw).data;
    if (meta?.fetchedAt) return { fetchedAt: meta.fetchedAt };
  }
  return null;
}

function spawnSeed(scriptPath, { timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    execFile(process.execPath, [scriptPath], {
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (stdout) {
        for (const line of String(stdout).trim().split('\n')) {
          if (line) console.log(`  [${label}] ${line}`);
        }
      }
      if (stderr) {
        for (const line of String(stderr).trim().split('\n')) {
          if (line) console.warn(`  [${label}] ${line}`);
        }
      }
      if (err) {
        const reason = err.killed ? 'timeout' : (err.code || err.message);
        reject(new Error(`${label} failed after ${elapsed}s: ${reason}`));
      } else {
        resolve({ elapsed });
      }
    });
  });
}

/**
 * @param {string} label - Bundle name for logging
 * @param {Array<{
 *   label: string,
 *   script: string,
 *   seedMetaKey?: string,    // legacy (pre-contract); reads `seed-meta:<key>`
 *   canonicalKey?: string,   // PR 2+: reads envelope from the canonical data key
 *   intervalMs: number,
 *   timeoutMs?: number,
 * }>} sections
 * @param {{ maxBundleMs?: number }} [opts]
 */
export async function runBundle(label, sections, opts = {}) {
  const t0 = Date.now();
  const maxBundleMs = opts.maxBundleMs ?? Infinity;
  const budgetLabel = Number.isFinite(maxBundleMs) ? `, budget ${Math.round(maxBundleMs / 1000)}s` : '';
  console.log(`[Bundle:${label}] Starting (${sections.length} sections${budgetLabel})`);

  let ran = 0, skipped = 0, deferred = 0, failed = 0;

  for (const section of sections) {
    const scriptPath = join(__dirname, section.script);
    const timeout = section.timeoutMs || 300_000;

    const freshness = await readSectionFreshness(section);
    if (freshness?.fetchedAt) {
      const elapsed = Date.now() - freshness.fetchedAt;
      if (elapsed < section.intervalMs * 0.8) {
        const agoMin = Math.round(elapsed / 60_000);
        const intervalMin = Math.round(section.intervalMs / 60_000);
        console.log(`  [${section.label}] Skipped, last seeded ${agoMin}min ago (interval: ${intervalMin}min)`);
        skipped++;
        continue;
      }
    }

    const elapsedBundle = Date.now() - t0;
    if (elapsedBundle + timeout > maxBundleMs) {
      const remainingSec = Math.max(0, Math.round((maxBundleMs - elapsedBundle) / 1000));
      const timeoutSec = Math.round(timeout / 1000);
      console.log(`  [${section.label}] Deferred, needs ${timeoutSec}s but only ${remainingSec}s left in bundle budget`);
      deferred++;
      continue;
    }

    try {
      const result = await spawnSeed(scriptPath, { timeoutMs: timeout, label: section.label });
      console.log(`  [${section.label}] Done (${result.elapsed}s)`);
      ran++;
    } catch (err) {
      console.error(`  [${section.label}] ${err.message}`);
      failed++;
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Bundle:${label}] Finished in ${totalSec}s, ran:${ran} skipped:${skipped} deferred:${deferred} failed:${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}
