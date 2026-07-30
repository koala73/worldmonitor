#!/usr/bin/env node
/**
 * Operator one-shot: purge the shared tech-events cache key after the
 * #5427 fix reaches production.
 *
 * WHY THIS EXISTS
 *
 * #5427 let the cold-start fallback write a REQUEST-NARROWED payload under
 * the shared, request-independent `research:tech-events:v1` key, so whichever
 * request warmed a cold cache decided what every client saw. The fix stops
 * new poisoning, but it does not clear an entry that was already poisoned
 * before the deploy — that entry keeps being served until it expires on its
 * own TTL (the fallback writes 6h) or the relay's next cycle overwrites it
 * (`TECH_EVENTS_SEED_INTERVAL_MS` is 6h in scripts/ais-relay.cjs). So the
 * symptom can outlive the fix by up to ~6h and look like the fix did not
 * work. One DEL makes recovery immediate: the next read repopulates from the
 * seeder, or from the now-widest cold-start fallback.
 *
 * ORDERING — run this AFTER the fix is live in production. Purging while a
 * pre-fix isolate is still serving just lets it re-poison the key. This is
 * the same "wait for the writer to be current before purging" ordering as
 * docs/solutions/workflow-issues/purging-the-live-product-catalog-three-layer-cache.md.
 *
 * SCOPE — deliberately ONE key. `research:tech-events-bootstrap:v1` is NOT
 * purged: only the seeders ever write it (scripts/ais-relay.cjs writes both
 * keys from the same full event list), and the cold-start fallback never
 * touches it, so it was never poisoned by #5427. Purging it would force a
 * needless re-seed of a correct value.
 *
 * This targets the unprefixed production key. Preview deployments read a
 * `preview:<sha>:`-prefixed key (server/_shared/redis.ts getKeyPrefix), which
 * is per-deployment and expires on its own; it is not worth purging.
 *
 * USAGE
 *
 *   node scripts/purge-tech-events-cache.mjs [--dry-run]
 *
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the env.
 *
 * RETURN CODES
 *
 *   0 — completed. Covers both "deleted" and "already absent": the goal is
 *       the key not holding a pre-fix payload, and an expired key satisfies
 *       that. Distinguished in the log line, not the exit code.
 *   1 — argument or missing-credential failure.
 *   2 — Upstash transport failure. Means RETRY — explicitly not "nothing to
 *       purge", so an operator never reads a dead connection as success.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultRedisPipeline } from './lib/_upstash-pipeline.mjs';

export const TECH_EVENTS_CACHE_KEY = 'research:tech-events:v1';

const EXIT_OK = 0;
const EXIT_ARG = 1;
const EXIT_TRANSPORT = 2;

/**
 * Flag parser. Only `--dry-run` is accepted; anything else is rejected loudly
 * so a typo cannot silently degrade into "did nothing and exited 0".
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ kind: 'ok', dryRun: boolean } | { kind: 'err', message: string }}
 */
export function parseArgs(argv) {
  let dryRun = false;
  for (const flag of argv) {
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    return { kind: 'err', message: `unknown flag: ${JSON.stringify(flag)} (allowed: --dry-run)` };
  }
  return { kind: 'ok', dryRun };
}

/**
 * Orchestration split out from `main` so tests can drive it without
 * process.exit and without a live Upstash.
 *
 * @param {object} args
 * @param {boolean} args.dryRun
 * @param {object} [args.deps]
 * @param {typeof defaultRedisPipeline} [args.deps.redisPipeline]
 * @param {(line: string) => void} [args.deps.log]
 * @param {(line: string) => void} [args.deps.warn]
 * @returns {Promise<{ code: number, deleted: boolean }>}
 */
export async function runPurge({ dryRun, deps } = {}) {
  const log = deps?.log ?? ((line) => console.log(line));
  const warn = deps?.warn ?? ((line) => console.warn(line));
  const pipeline = deps?.redisPipeline ?? defaultRedisPipeline;

  if (dryRun) {
    log(`[purge-tech-events-cache] DRY RUN — would DEL key=${TECH_EVENTS_CACHE_KEY}`);
    return { code: EXIT_OK, deleted: false };
  }

  const result = await pipeline([['DEL', TECH_EVENTS_CACHE_KEY]]);
  // null is the helper's single failure channel (missing creds, non-2xx,
  // timeout, throw). Callers check creds first, so here it means transport.
  if (result == null || !Array.isArray(result)) {
    warn('[purge-tech-events-cache] DEL pipeline returned null — Upstash transport failure; key NOT purged, retry');
    return { code: EXIT_TRANSPORT, deleted: false };
  }

  const cell = result[0];
  if (cell && typeof cell === 'object' && 'error' in cell) {
    warn(`[purge-tech-events-cache] DEL key=${TECH_EVENTS_CACHE_KEY} → upstream error: ${cell.error}`);
    return { code: EXIT_TRANSPORT, deleted: false };
  }

  const at = new Date().toISOString();
  // DEL returns 1 when the key existed, 0 when it had already expired or was
  // purged by someone else. Both leave the key free of a pre-fix payload.
  if (Number(cell?.result ?? 0) >= 1) {
    log(`[purge-tech-events-cache] DELETED key=${TECH_EVENTS_CACHE_KEY} at=${at} — next read repopulates from the seeder or the widest fallback`);
    return { code: EXIT_OK, deleted: true };
  }
  log(`[purge-tech-events-cache] key=${TECH_EVENTS_CACHE_KEY} already absent at=${at} (expired or previously purged) — nothing to do`);
  return { code: EXIT_OK, deleted: false };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'err') {
    console.error(`[purge-tech-events-cache] ARG ERROR: ${parsed.message}`);
    console.error('Usage: node scripts/purge-tech-events-cache.mjs [--dry-run]');
    process.exit(EXIT_ARG);
  }
  if (!parsed.dryRun && (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)) {
    console.error('[purge-tech-events-cache] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN must be set in env');
    process.exit(EXIT_ARG);
  }
  const { code } = await runPurge({ dryRun: parsed.dryRun });
  process.exit(code);
}

/**
 * True only when this file is the process entrypoint.
 *
 * Both sides are realpath'd before comparison: Node sets `import.meta.url` to
 * the resolved real path while `process.argv[1]` keeps whatever symlinked path
 * the caller typed (e.g. macOS `/tmp` -> `/private/tmp`). Comparing them raw —
 * or via a bare `file://${process.argv[1]}` template, which also breaks on
 * paths containing spaces — makes the script silently exit 0 without purging,
 * which for a purge tool is indistinguishable from success.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    console.error('[purge-tech-events-cache] FATAL:', err);
    process.exit(EXIT_TRANSPORT);
  });
}
