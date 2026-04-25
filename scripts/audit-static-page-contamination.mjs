#!/usr/bin/env node
// Ops audit + cleanup for residual static-institutional-page contamination
// in story:track:v1:* (U6 of docs/plans/2026-04-26-001-fix-brief-static-
// page-contamination-plan.md).
//
// Usage:
//   node scripts/audit-static-page-contamination.mjs           # dry run, prints stats
//   node scripts/audit-static-page-contamination.mjs --apply   # also DELs matched keys
//
// Run AFTER PR-1 (ingest gates) and PR-2 (LLM cache prefix bump) reach
// production. The dry-run output drives whether U7's URL-classifier
// regex needs widening (separate follow-up PR) and confirms the upstream
// gates are catching new arrivals (matched count should fall over time).
//
// Pure-helper coverage lives in tests/url-classifier.test.mjs. The Redis
// scan is mechanical and exercised by manual dry runs — there is no unit
// test for the side-effecting --apply path (would require a Redis
// double; out of scope for this one-shot script).

import { isInstitutionalStaticPage } from './shared/url-classifier.js';
import { getRedisCredentials } from './_seed-utils.mjs';

const APPLY = process.argv.includes('--apply');
const SCAN_PATTERN = 'story:track:v1:*';
const SCAN_BATCH = 100;
const SCAN_TIMEOUT_MS = 15_000;
const HGETALL_BATCH = 25; // pipeline width

async function redisCommand(url, token, command) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis command failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function redisPipeline(url, token, commands) {
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Cursor-based SCAN. Yields batches of matching keys. The 'cursor === 0'
 * termination follows Redis SCAN semantics (returns to 0 when done).
 */
async function* scanKeys(url, token, pattern) {
  let cursor = '0';
  do {
    const resp = await redisCommand(url, token, [
      'SCAN', cursor, 'MATCH', pattern, 'COUNT', String(SCAN_BATCH),
    ]);
    const result = resp.result;
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error(`Unexpected SCAN response shape: ${JSON.stringify(resp)}`);
    }
    cursor = String(result[0]);
    const keys = Array.isArray(result[1]) ? result[1] : [];
    if (keys.length > 0) yield keys;
  } while (cursor !== '0');
}

/**
 * Pipelined HGETALL for a batch of keys. Returns an array aligned with
 * `keys`: each entry is the parsed hash (object) or null on miss.
 */
async function batchHgetAll(url, token, keys) {
  if (keys.length === 0) return [];
  const commands = keys.map((k) => ['HGETALL', k]);
  const responses = await redisPipeline(url, token, commands);
  return responses.map((r) => {
    const arr = r?.result;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // Upstash HGETALL returns ['k1', 'v1', 'k2', 'v2', ...] OR an object.
    // Normalize to object.
    if (typeof arr === 'object' && !Array.isArray(arr)) return arr;
    const obj = {};
    for (let i = 0; i < arr.length - 1; i += 2) {
      obj[arr[i]] = arr[i + 1];
    }
    return obj;
  });
}

async function batchDel(url, token, keys) {
  if (keys.length === 0) return 0;
  // SREM corresponding story:sources:v1:{hash} for each — the audit
  // deletes both halves of the contamination pair so a future
  // republish won't be blocked by an orphaned sources set.
  const commands = [];
  for (const k of keys) {
    commands.push(['DEL', k]);
    const hash = k.replace(/^story:track:v1:/, '');
    if (hash && hash !== k) {
      commands.push(['DEL', `story:sources:v1:${hash}`]);
    }
  }
  await redisPipeline(url, token, commands);
  return keys.length;
}

function summarizePerHostPath(matches) {
  const hostCounts = new Map();
  const pathPatternCounts = new Map();
  for (const m of matches) {
    try {
      const u = new URL(m.link);
      hostCounts.set(u.hostname, (hostCounts.get(u.hostname) ?? 0) + 1);
      // First two path segments give a useful pattern bucket without
      // exploding cardinality (e.g., '/About' vs '/About/Section-508').
      const segs = u.pathname.split('/').filter(Boolean);
      const bucket = '/' + segs.slice(0, 2).join('/');
      pathPatternCounts.set(bucket, (pathPatternCounts.get(bucket) ?? 0) + 1);
    } catch {
      // Already filtered by isInstitutionalStaticPage; reaching here
      // would be a regression in the classifier.
    }
  }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { byHost: fmt(hostCounts), byPathPattern: fmt(pathPatternCounts) };
}

async function main() {
  const { url, token } = getRedisCredentials();
  console.log(`[audit] mode=${APPLY ? 'APPLY (will DELETE)' : 'DRY RUN'}`);
  console.log(`[audit] scanning ${SCAN_PATTERN}…`);

  const matches = [];
  let scanned = 0;

  for await (const keyBatch of scanKeys(url, token, SCAN_PATTERN)) {
    scanned += keyBatch.length;
    for (let i = 0; i < keyBatch.length; i += HGETALL_BATCH) {
      const slice = keyBatch.slice(i, i + HGETALL_BATCH);
      const tracks = await batchHgetAll(url, token, slice);
      for (let j = 0; j < slice.length; j++) {
        const key = slice[j];
        const t = tracks[j];
        if (!t || typeof t !== 'object') continue;
        const link = t.link;
        if (typeof link !== 'string' || link.length === 0) continue;
        if (isInstitutionalStaticPage(link)) {
          matches.push({
            key,
            link,
            severity: t.severity ?? '?',
            source: t.source ?? '?',
            title: (t.title ?? '').slice(0, 80),
          });
        }
      }
    }
    process.stderr.write(`\r[audit] scanned=${scanned} matched=${matches.length}`);
  }
  process.stderr.write('\n');

  if (matches.length === 0) {
    console.log('[audit] zero contaminated entries — upstream gates working ✓');
    return;
  }

  console.log('');
  console.log(`[audit] matched ${matches.length} contaminated story:track:v1 entries:`);
  for (const m of matches) {
    console.log(
      `  [${m.key}] severity=${m.severity} source="${m.source}" url=${m.link}`,
    );
  }

  console.log('');
  const summary = summarizePerHostPath(matches);
  console.log('[audit] by host:');
  for (const [host, n] of summary.byHost) console.log(`  ${host.padEnd(40)} ${n}`);
  console.log('[audit] by path pattern:');
  for (const [pattern, n] of summary.byPathPattern) console.log(`  ${pattern.padEnd(40)} ${n}`);

  if (!APPLY) {
    console.log('');
    console.log('[audit] DRY RUN — pass --apply to delete these keys.');
    return;
  }

  console.log('');
  console.log(`[audit] APPLY: deleting ${matches.length} keys + their story:sources:v1 siblings…`);
  const keysToDelete = matches.map((m) => m.key);
  for (let i = 0; i < keysToDelete.length; i += HGETALL_BATCH) {
    const slice = keysToDelete.slice(i, i + HGETALL_BATCH);
    await batchDel(url, token, slice);
  }
  console.log(`[audit] deleted ${matches.length} contaminated entries.`);
}

main().catch((err) => {
  console.error('[audit] failed:', err);
  process.exit(1);
});
