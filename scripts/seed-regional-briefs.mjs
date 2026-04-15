#!/usr/bin/env node
// @ts-check
/**
 * Weekly Regional Intelligence brief seeder. Phase 3 PR2.
 *
 * Reads the latest snapshot + regime history per region, calls the LLM to
 * synthesize a weekly brief, and writes to Redis. Designed to run on a
 * weekly Railway cron (e.g. Sunday 00:00 UTC) or manually via:
 *
 *   node scripts/seed-regional-briefs.mjs
 *
 * Does NOT run as part of the 6h derived-signals bundle — briefs are
 * weekly, not per-snapshot.
 */

import { pathToFileURL } from 'node:url';

import { loadEnvFile, getRedisCredentials, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { REGIONS } from './shared/geography.js';
import { generateWeeklyBrief } from './regional-snapshot/weekly-brief.mjs';

loadEnvFile(import.meta.url);

const BRIEF_KEY_PREFIX = 'intelligence:regional-briefs:v1:weekly:';
const BRIEF_TTL = 15 * 24 * 60 * 60; // 15 days — survives one full missed weekly cycle within the 14-day health budget
const SEED_META_KEY = 'intelligence:regional-briefs';
const REGIME_HISTORY_KEY_PREFIX = 'intelligence:regime-history:v1:';
const SNAPSHOT_LATEST_KEY_PREFIX = 'intelligence:snapshot:v1:';
const SNAPSHOT_BY_ID_KEY_PREFIX = 'intelligence:snapshot-by-id:v1:';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read the latest snapshot for a region from Redis.
 * @param {string} url
 * @param {string} token
 * @param {string} regionId
 * @returns {Promise<object | null>}
 */
async function readLatestSnapshot(url, token, regionId) {
  try {
    const latestKey = `${SNAPSHOT_LATEST_KEY_PREFIX}${regionId}:latest`;
    const latestResp = await fetch(`${url}/get/${encodeURIComponent(latestKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!latestResp.ok) return null;
    const latestData = await latestResp.json();
    let snapshotId = latestData?.result;
    if (!snapshotId) return null;
    if (typeof snapshotId === 'string') {
      try { snapshotId = JSON.parse(snapshotId); } catch { /* bare string is fine */ }
    }
    if (typeof snapshotId === 'object' && snapshotId?.snapshot_id) {
      snapshotId = snapshotId.snapshot_id;
    }
    if (typeof snapshotId !== 'string') return null;

    const snapKey = `${SNAPSHOT_BY_ID_KEY_PREFIX}${snapshotId}`;
    const snapResp = await fetch(`${url}/get/${encodeURIComponent(snapKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!snapResp.ok) return null;
    const snapData = await snapResp.json();
    return snapData?.result ? unwrapEnvelope(JSON.parse(snapData.result)).data : null;
  } catch {
    return null;
  }
}

/**
 * Read the regime history for a region (last 7 days).
 * Returns null on Redis/network failure so the caller can distinguish a
 * genuinely quiet week (empty array) from a broken upstream (null).
 * PR #2989 review: collapsing failure to [] would fabricate a false
 * "no transitions" history for the LLM prompt.
 *
 * @param {string} url
 * @param {string} token
 * @param {string} regionId
 * @returns {Promise<object[] | null>} null = upstream failure, [] = genuinely no transitions
 */
async function readRecentTransitions(url, token, regionId) {
  try {
    const key = `${REGIME_HISTORY_KEY_PREFIX}${regionId}`;
    const resp = await fetch(`${url}/lrange/${encodeURIComponent(key)}/0/49`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.result)) return null;
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    return data.result
      .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
      .filter((t) => t && typeof t === 'object' && (t.transitioned_at ?? 0) >= cutoff);
  } catch {
    return null;
  }
}

/**
 * Write a brief to Redis.
 * @param {string} url
 * @param {string} token
 * @param {string} regionId
 * @param {object} brief
 * @returns {Promise<boolean>}
 */
async function writeBrief(url, token, regionId, brief) {
  const key = `${BRIEF_KEY_PREFIX}${regionId}`;
  const payload = JSON.stringify(brief);
  try {
    // TTL via path segment, NOT query string. Upstash REST ignores query
    // params for SET options — ?EX=N would silently produce keys that
    // never expire. Greptile P1 on PR #2989.
    const resp = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(payload)}/EX/${BRIEF_TTL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function main() {
  const t0 = Date.now();
  const { url, token } = getRedisCredentials();
  console.log(`[regional-briefs] Starting weekly brief generation for ${REGIONS.length} regions`);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const region of REGIONS) {
    if (region.id === 'global') {
      skipped += 1;
      console.log(`[${region.id}] skipped (global)`);
      continue;
    }

    try {
      const snapshot = await readLatestSnapshot(url, token, region.id);
      if (!snapshot) {
        skipped += 1;
        console.log(`[${region.id}] skipped (no snapshot available)`);
        continue;
      }

      const transitions = await readRecentTransitions(url, token, region.id);
      if (transitions === null) {
        skipped += 1;
        console.log(`[${region.id}] skipped (regime-history Redis unavailable — cannot produce reliable brief)`);
        continue;
      }
      const brief = await generateWeeklyBrief(region, snapshot, transitions);

      if (!brief.situation_recap) {
        skipped += 1;
        console.log(`[${region.id}] skipped (LLM returned empty brief)`);
        continue;
      }

      const ok = await writeBrief(url, token, region.id, brief);
      if (ok) {
        generated += 1;
        console.log(`[${region.id}] brief written (${brief.key_developments?.length ?? 0} developments, provider=${brief.provider})`);
      } else {
        failed += 1;
        console.warn(`[${region.id}] Redis write failed`);
      }
    } catch (err) {
      failed += 1;
      const msg = /** @type {any} */ (err)?.message ?? err;
      console.error(`[${region.id}] FAILED: ${msg}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  // Total non-global regions expected to generate. If generated is well
  // below this, writing seed-meta with a positive count would hide broad
  // coverage loss from /api/health (which treats any positive recordCount
  // as healthy). PR #2989 review P2.
  const expectedRegions = REGIONS.filter((r) => r.id !== 'global').length;
  const coverageOk = generated >= expectedRegions - 1; // at most 1 region can fail silently

  // Always write seed-meta when failed===0 so health confirms the seeder
  // ran. But set recordCount to 0 when coverage is below threshold — that
  // makes /api/health report EMPTY_DATA instead of hiding partial failure.
  if (failed === 0) {
    const recordCount = coverageOk ? generated : 0;
    await writeExtraKeyWithMeta(
      `intelligence:regional-briefs:summary:v1`,
      { generatedAt: Date.now(), regionsGenerated: generated, regionsSkipped: skipped, coverageOk },
      BRIEF_TTL,
      recordCount,
      `seed-meta:${SEED_META_KEY}`,
      BRIEF_TTL,
    );
  }

  console.log(`[regional-briefs] Done in ${elapsed}s: generated=${generated} skipped=${skipped} failed=${failed}`);
  if (failed > 0) throw new Error(`regional-briefs: ${failed} region(s) failed`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });

export { main, readLatestSnapshot, readRecentTransitions };
