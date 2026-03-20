#!/usr/bin/env node

/**
 * Seed orchestrator — ties together the catalog, runner, freshness checks,
 * tiered cold start, and recurring scheduling with graceful shutdown.
 *
 * Exports `classifySeeders` and `buildStartupSummary` for testing (pure functions).
 * Redis and all side-effects are deferred to `main()`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './seed-utils/logger.mjs';
import { parseFreshness, isFresh, buildMeta } from './seed-utils/meta.mjs';
import { forkSeeder } from './seed-utils/runner.mjs';
import {
  SEED_CATALOG,
  TIER_ORDER,
  TIER_CONCURRENCY,
  STEADY_STATE_CONCURRENCY,
} from './seed-config.mjs';
import { getRedisCredentials } from './_seed-utils.mjs';

/**
 * Dry-run mock seeder — simulates a seeder with random sleep and 10% failure rate.
 * Used when SEED_TURBO=dry.
 */
async function dryRunSeeder(name) {
  const sleepMs = 100 + Math.random() * 400;
  await new Promise((r) => setTimeout(r, sleepMs));
  const fail = Math.random() < 0.1;
  return {
    name,
    exitCode: fail ? 1 : 0,
    status: fail ? 'error' : 'ok',
    durationMs: Math.round(sleepMs),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Thin Redis helpers — use the same REST API as _seed-utils.mjs's private
// redisGet/redisSet but scoped to orchestrator needs. We reuse
// getRedisCredentials() (deferred to main()) rather than duplicating env reads.
// ────────────────────────────────────────────────────────────────────────────

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(url, token, key, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  const cmd = ttlSeconds
    ? ['SET', key, payload, 'EX', ttlSeconds]
    : ['SET', key, payload];
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis SET failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('orchestrator');

let RETRY_DELAY_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const REDIS_PING_INTERVAL_MS = 3_000;
const REDIS_PING_MAX_ATTEMPTS = 20;

// ────────────────────────────────────────────────────────────────────────────
// Pure, testable functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify seeders into active (runnable) and skipped (missing env vars).
 * @param {Record<string, object>} catalog
 * @param {Record<string, string>} env — process.env or a subset
 * @returns {{ active: Array<{ name: string, tier: string, intervalMin: number, ttlSec: number, metaKey: string|null }>, skipped: Array<{ name: string, reason: string }> }}
 */
export function classifySeeders(catalog, env = process.env) {
  const active = [];
  const skipped = [];

  for (const [name, cfg] of Object.entries(catalog)) {
    const missing = cfg.requiredKeys.filter((k) => !env[k]);
    if (missing.length > 0) {
      skipped.push({ name, reason: `missing ${missing.join(', ')}` });
    } else {
      active.push({
        name,
        tier: cfg.tier,
        intervalMin: cfg.intervalMin,
        ttlSec: cfg.ttlSec,
        metaKey: cfg.metaKey,
      });
    }
  }

  return { active, skipped };
}

/**
 * Build a human-readable startup summary.
 * @param {Array<{ name: string, tier: string }>} active
 * @param {Array<{ name: string, reason: string }>} skipped
 * @param {number} freshCount — number of seeders with fresh data
 * @returns {string}
 */
export function buildStartupSummary(active, skipped, freshCount) {
  const lines = [];
  lines.push('');
  lines.push('=== Seed Orchestrator Startup ===');
  lines.push('');
  lines.push(`  ACTIVE (${active.length})`);
  for (const tier of TIER_ORDER) {
    const inTier = active.filter((s) => s.tier === tier);
    if (inTier.length > 0) {
      lines.push(`    ${tier}: ${inTier.map((s) => s.name).join(', ')}`);
    }
  }
  lines.push('');
  lines.push(`  SKIPPED (${skipped.length})`);
  for (const s of skipped) {
    lines.push(`    ${s.name}: ${s.reason}`);
  }
  lines.push('');
  lines.push(`  ${freshCount}/${active.length} seeders have fresh data`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Compute effective interval with turbo mode and failure demotion.
 * @param {number} intervalMin — base interval from catalog
 * @param {number} failureCount — consecutive failures for this seeder
 * @param {string|undefined} turboMode — 'real', 'dry', or undefined
 * @returns {number} — interval in milliseconds
 */
export function getEffectiveInterval(intervalMin, failureCount, turboMode) {
  const div = turboMode ? 20 : 1;
  let min = Math.max(1, Math.round(intervalMin / div));
  if (failureCount >= MAX_CONSECUTIVE_FAILURES) min *= 2;
  return min * 60_000;
}

/**
 * Check if a seeder should skip this cycle (overlap protection).
 * @param {string} name
 * @param {Set<string>} inFlight
 * @returns {boolean}
 */
export function shouldSkipCycle(name, inFlight) {
  return inFlight.has(name);
}

/**
 * Compute turbo-adjusted interval in minutes.
 * @param {number} intervalMin
 * @param {string|undefined} turboMode
 * @returns {number}
 */
export function computeTurboInterval(intervalMin, turboMode) {
  if (!turboMode) return intervalMin;
  return Math.max(1, Math.round(intervalMin / 20));
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator runtime (only used when executed directly)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wait for the Redis REST proxy to become reachable.
 */
async function waitForRedis(url, token) {
  for (let i = 0; i < REDIS_PING_MAX_ATTEMPTS; i++) {
    try {
      const resp = await fetch(`${url}/ping`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (resp.ok) {
        log.info('Redis is reachable');
        return;
      }
    } catch {
      // retry
    }
    if (i < REDIS_PING_MAX_ATTEMPTS - 1) {
      log.info(`Waiting for Redis... (attempt ${i + 1}/${REDIS_PING_MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, REDIS_PING_INTERVAL_MS));
    }
  }
  throw new Error(`Redis not reachable after ${REDIS_PING_MAX_ATTEMPTS} attempts`);
}

/**
 * Fetch freshness metadata for all active seeders.
 */
async function fetchFreshnessMap(activeSeeders, url, token) {
  const map = new Map();
  await Promise.all(
    activeSeeders.map(async (s) => {
      const key = s.metaKey ? `seed-meta:${s.metaKey}` : `seed-meta:orchestrator:${s.name}`;
      try {
        const raw = await redisGet(url, token, key);
        const meta = parseFreshness(raw);
        if (meta) map.set(s.name, meta);
      } catch {
        // missing/error — treat as stale
      }
    }),
  );
  return map;
}

/**
 * Resolve the meta key to check/write for a given seeder.
 */
function resolveMetaKey(seeder) {
  return seeder.metaKey ? `seed-meta:${seeder.metaKey}` : `seed-meta:orchestrator:${seeder.name}`;
}

/**
 * Execute a single seeder: fork the child process, handle meta writing.
 */
async function executeSeed(seeder, url, token, turboMode) {
  const scriptPath = join(__dirname, `seed-${seeder.name}.mjs`);
  log.info(`Running ${seeder.name}...`);

  // Read meta before fork so we can detect if the seeder updated it
  let metaBefore = null;
  const metaKey = resolveMetaKey(seeder);
  if (turboMode !== 'dry') {
    try {
      metaBefore = await redisGet(url, token, metaKey);
    } catch {
      // ignore
    }
  }

  const timeoutMs = turboMode === 'dry' ? 30_000 : 120_000;
  const result = turboMode === 'dry'
    ? await dryRunSeeder(seeder.name)
    : await forkSeeder(seeder.name, {
        scriptPath: process.execPath,
        args: [scriptPath],
        timeoutMs,
      });

  log.info(`${seeder.name} finished: ${result.status} (${result.durationMs}ms)`);

  // Meta writing logic (skip in dry mode)
  if (turboMode !== 'dry') {
    if (result.status === 'ok') {
      if (seeder.metaKey) {
        // Check if the seeder already updated its own meta
        try {
          const metaAfter = await redisGet(url, token, metaKey);
          const parsed = parseFreshness(metaAfter);
          const parsedBefore = parseFreshness(metaBefore);
          const alreadyUpdated =
            parsed &&
            parsedBefore &&
            parsed.fetchedAt > parsedBefore.fetchedAt;
          const freshlyWritten = parsed && !parsedBefore;
          if (!alreadyUpdated && !freshlyWritten) {
            // Seeder didn't update meta — write it ourselves
            const meta = buildMeta(result.durationMs, 'ok');
            await redisSet(url, token, metaKey, meta, 86400 * 7);
          }
        } catch {
          // Best effort
        }
      } else {
        // metaKey is null — always write orchestrator meta
        const meta = buildMeta(result.durationMs, 'ok');
        await redisSet(url, token, metaKey, meta, 86400 * 7);
      }
    } else {
      // Write error meta for null-metaKey seeders
      if (!seeder.metaKey) {
        const meta = buildMeta(result.durationMs, 'error', `exit ${result.exitCode ?? result.status}`);
        await redisSet(url, token, metaKey, meta, 86400 * 7);
      }
    }
  }

  return result;
}

/**
 * Run a batch of seeders with concurrency control.
 */
async function runBatch(seeders, concurrency, executeFn) {
  const results = [];
  for (let i = 0; i < seeders.length; i += concurrency) {
    const batch = seeders.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(executeFn));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Run tiered cold start: process tiers in order with tier-specific concurrency.
 * Skip seeders that already have fresh data.
 */
async function tieredColdStart(activeSeeders, freshnessMap, url, token, turboMode) {
  log.info('Starting tiered cold start...');

  for (const tier of TIER_ORDER) {
    const tierSeeders = activeSeeders.filter((s) => s.tier === tier);
    // Filter out fresh seeders
    const stale = tierSeeders.filter((s) => {
      const meta = freshnessMap.get(s.name);
      return !isFresh(meta, s.intervalMin);
    });

    if (stale.length === 0) {
      log.info(`Tier ${tier}: all ${tierSeeders.length} seeders fresh, skipping`);
      continue;
    }

    const concurrency = TIER_CONCURRENCY[tier];
    log.info(`Tier ${tier}: running ${stale.length} stale seeders (concurrency ${concurrency})`);

    await runBatch(stale, concurrency, (s) => executeSeed(s, url, token, turboMode));
  }

  log.info('Tiered cold start complete');
}

/**
 * Steady-state scheduler: recurring timers with overlap protection, retry,
 * consecutive failure demotion, and global concurrency queue.
 */
function scheduleSeeders(activeSeeders, url, token, state) {
  const { timers, inFlight, failureCounts, queue } = state;

  function getInterval(seeder) {
    const failures = failureCounts.get(seeder.name) || 0;
    return getEffectiveInterval(seeder.intervalMin, failures, state.turboMode);
  }

  function drainQueue() {
    while (queue.length > 0 && inFlight.size < STEADY_STATE_CONCURRENCY) {
      const next = queue.shift();
      runScheduled(next);
    }
  }

  async function runScheduled(seeder) {
    inFlight.add(seeder.name);
    try {
      const result = await executeSeed(seeder, url, token, state.turboMode);

      if (result.status === 'ok') {
        failureCounts.set(seeder.name, 0);
      } else {
        const prev = failureCounts.get(seeder.name) || 0;
        const newCount = prev + 1;
        failureCounts.set(seeder.name, newCount);

        if (newCount < 2) {
          // First failure — retry after 60s
          log.warn(`${seeder.name} failed, scheduling retry in ${RETRY_DELAY_MS / 1000}s`);
          const retryTimer = setTimeout(async () => {
            if (state.shuttingDown) return;
            if (inFlight.has(seeder.name)) return; // overlap protection on retry too
            inFlight.add(seeder.name);
            try {
              const retryResult = await executeSeed(seeder, url, token, state.turboMode);
              if (retryResult.status === 'ok') {
                failureCounts.set(seeder.name, 0);
              } else {
                failureCounts.set(seeder.name, (failureCounts.get(seeder.name) || 0) + 1);
                log.warn(`${seeder.name} retry failed — waiting for next cycle`);
              }
            } finally {
              inFlight.delete(seeder.name);
              drainQueue();
            }
          }, RETRY_DELAY_MS);
          timers.push(retryTimer);
        } else {
          if (newCount === MAX_CONSECUTIVE_FAILURES) {
            log.warn(`${seeder.name}: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — doubling interval`);
          }
        }
      }
    } finally {
      inFlight.delete(seeder.name);
      drainQueue();
    }
  }

  for (const seeder of activeSeeders) {
    const schedule = () => {
      if (state.shuttingDown) return;

      const interval = getInterval(seeder);
      const timer = setTimeout(() => {
        if (state.shuttingDown) return;

        // Overlap protection
        if (inFlight.has(seeder.name)) {
          log.warn(`${seeder.name} still running, skipping this cycle`);
          schedule(); // re-schedule for next interval
          return;
        }

        // Global concurrency check — queue if at limit
        if (inFlight.size >= STEADY_STATE_CONCURRENCY) {
          log.info(`${seeder.name} queued (concurrency limit)`);
          queue.push(seeder);
          schedule();
          return;
        }

        runScheduled(seeder).then(() => {
          schedule();
        });
      }, interval);

      timers.push(timer);
    };

    schedule();
  }
}

/**
 * Graceful shutdown: clear timers, wait for in-flight, exit.
 */
function setupShutdown(state) {
  const handler = async (signal) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);

    // Clear all scheduled timers
    for (const t of state.timers) {
      clearTimeout(t);
    }
    state.timers.length = 0;
    state.queue.length = 0;

    // Wait for in-flight seeders
    if (state.inFlight.size > 0) {
      log.info(`Waiting for ${state.inFlight.size} in-flight seeder(s)...`);
      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while (state.inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (state.inFlight.size > 0) {
        log.warn(`${state.inFlight.size} seeder(s) still running after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
      }
    }

    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const { url, token } = getRedisCredentials();

  // Turbo mode
  const turboMode = process.env.SEED_TURBO || undefined;
  if (turboMode && turboMode !== 'real' && turboMode !== 'dry') {
    log.error(`Invalid SEED_TURBO value: ${turboMode} (expected: real, dry)`);
    process.exit(1);
  }
  if (turboMode) {
    log.info(`⚡ TURBO MODE: ${turboMode} (intervals ÷20${turboMode === 'dry' ? ', no real seeders' : ''})`);
    RETRY_DELAY_MS = 3_000;
  }

  // Wait for Redis to be reachable
  await waitForRedis(url, token);

  // Classify seeders
  const { active, skipped } = classifySeeders(SEED_CATALOG);

  // Apply turbo interval compression
  if (turboMode) {
    for (const s of active) {
      s.intervalMin = computeTurboInterval(s.intervalMin, turboMode);
    }
  }

  // Fetch freshness for all active seeders
  const freshnessMap = await fetchFreshnessMap(active, url, token);
  const freshCount = active.filter((s) => {
    const meta = freshnessMap.get(s.name);
    return isFresh(meta, s.intervalMin);
  }).length;

  // Log startup summary
  const summary = buildStartupSummary(active, skipped, freshCount);
  log.info(summary);

  // Tiered cold start
  await tieredColdStart(active, freshnessMap, url, token, turboMode);

  // Set up recurring scheduling
  const state = {
    timers: [],
    inFlight: new Set(),
    failureCounts: new Map(),
    queue: [],
    shuttingDown: false,
    turboMode,
  };

  setupShutdown(state);
  scheduleSeeders(active, url, token, state);

  log.info('Steady-state scheduling active');
}

// Only run main() when executed directly (not imported for testing)
const isDirectExecution =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  main().catch((err) => {
    log.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
