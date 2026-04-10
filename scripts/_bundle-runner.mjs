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
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 604_800_000;

loadEnvFile(import.meta.url);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function readSeedMeta(seedMetaKey) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(`seed-meta:${seedMetaKey}`)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
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
 *   seedMetaKey: string,
 *   intervalMs: number,
 *   timeoutMs?: number,
 * }>} sections
 */
export async function runBundle(label, sections) {
  const t0 = Date.now();
  console.log(`[Bundle:${label}] Starting (${sections.length} sections)`);

  let ran = 0, skipped = 0, failed = 0;

  for (const section of sections) {
    const scriptPath = join(__dirname, section.script);
    const timeout = section.timeoutMs || 300_000;

    const meta = await readSeedMeta(section.seedMetaKey);
    if (meta?.fetchedAt) {
      const elapsed = Date.now() - meta.fetchedAt;
      if (elapsed < section.intervalMs * 0.8) {
        const agoMin = Math.round(elapsed / 60_000);
        const intervalMin = Math.round(section.intervalMs / 60_000);
        console.log(`  [${section.label}] Skipped, last seeded ${agoMin}min ago (interval: ${intervalMin}min)`);
        skipped++;
        continue;
      }
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
  console.log(`[Bundle:${label}] Finished in ${totalSec}s, ran:${ran} skipped:${skipped} failed:${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}
