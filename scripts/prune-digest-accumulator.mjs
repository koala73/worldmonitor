#!/usr/bin/env node
/**
 * Bounded cleanup tool for the digest accumulator (#7082 plan §4).
 *
 * Normal publication now prunes members older than the 48-hour digest
 * contract inline (see writeStoryTracking), so this tool exists for the
 * ONE-TIME sweep of indexes that predate that prune — and for operator
 * inspection. It enumerates exact keys, reports cardinality and the
 * oldest/newest member score BEFORE any mutation, and defaults to dry-run:
 * mutating requires --apply.
 *
 * Run the sweep only after the forecast cutover is deployed and verified
 * (the archive must carry the evidence the accumulator is about to lose).
 */
import { readFileSync } from 'node:fs';

const DRY_RUN = !process.argv.includes('--apply');
const RETENTION_MS = 48 * 60 * 60 * 1000;

function usage() {
  console.log('Usage: node scripts/prune-digest-accumulator.mjs [--apply]');
  console.log('');
  console.log('  Dry run (default): enumerate keys and report what would be pruned.');
  console.log('  --apply: perform the ZREMRANGEBYSCORE prune on every listed key.');
}

function redisConfigFromEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
    process.exit(1);
  }
  return { url, token };
}

async function redis(config, command) {
  const resp = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis ${command[0]} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  return payload?.result;
}

async function main() {
  const config = redisConfigFromEnv();
  const nowMs = Date.now();
  const cutoff = nowMs - RETENTION_MS;

  console.log(`[prune-digest-accumulator] mode=${DRY_RUN ? 'DRY-RUN' : 'APPLY'} cutoff=${new Date(cutoff).toISOString()}`);

  const keys = await redis(config, ['KEYS', 'digest:accumulator:v1:*']);
  if (!Array.isArray(keys) || keys.length === 0) {
    console.log('[prune-digest-accumulator] no accumulator keys found; nothing to do.');
    return;
  }
  keys.sort();

  for (const key of keys) {
    const [cardinality, oldest] = await Promise.all([
      redis(config, ['ZCARD', key]),
      redis(config, ['ZRANGE', key, '0', '0', 'WITHSCORES']),
    ]);
    const newest = await redis(config, ['ZRANGE', key, '-1', '-1', 'WITHSCORES']);
    const oldestScore = oldest?.[1] !== undefined ? Number(oldest[1]) : null;
    const newestScore = newest?.[1] !== undefined ? Number(newest[1]) : null;
    const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'n/a');
    console.log(
      `  ${key}: cardinality=${cardinality} oldest=${fmt(oldestScore)} newest=${fmt(newestScore)}`,
    );
    if (!DRY_RUN) {
      const removed = await redis(config, ['ZREMRANGEBYSCORE', key, '-inf', String(cutoff)]);
      console.log(`    pruned ${removed} member(s) older than ${fmt(cutoff)}`);
    } else {
      const wouldRemove = await redis(config, ['ZCOUNT', key, '-inf', String(cutoff)]);
      console.log(`    dry-run: would prune ${wouldRemove} member(s) older than ${fmt(cutoff)}`);
    }
  }

  if (DRY_RUN) {
    console.log('[prune-digest-accumulator] dry-run complete; re-run with --apply to mutate.');
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

// Cheap import guard so `readFileSync` stays referenced for future config
// loading without triggering unused-import lint churn in the meantime.
void readFileSync;

main().catch((err) => {
  console.error(`[prune-digest-accumulator] failed: ${err?.message || err}`);
  process.exit(1);
});
