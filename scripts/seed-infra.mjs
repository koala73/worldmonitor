#!/usr/bin/env node

/**
 * Seed infrastructure data via warm-ping pattern.
 *
 * These handlers have complex logic (30 status page parsers, NGA text analysis)
 * that is impractical to replicate in a standalone script. Instead, we call the
 * Vercel RPC endpoints from Railway to warm-populate the Redis cache.
 *
 * Seeded via warm-ping:
 * - list-service-statuses: pings 30 status pages, caches result
 * - get-cable-health: NGA warning analysis, caches cable health map
 *
 * NOT seeded (inherently on-demand):
 * - search-imagery: per-bbox/datetime STAC query (cache key is hash of params)
 * - get-giving-summary: uses hardcoded baselines, NO external fetches
 * - get-webcam-image: per-webcamId Windy API lookup
 */

import { loadEnvFile, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const API_BASE = 'https://api.worldmonitor.app';
const TIMEOUT = 30_000;

async function warmPing(name, path) {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA, Origin: 'https://worldmonitor.app' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) {
      console.warn(`  ${name}: HTTP ${resp.status}`);
      return false;
    }
    const data = await resp.json();
    const count = data.statuses?.length ?? (data.cables ? Object.keys(data.cables).length : 0);
    console.log(`  ${name}: OK (${count} items)`);
    return true;
  } catch (e) {
    console.warn(`  ${name}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('=== Infrastructure Warm-Ping Seed ===');
  const start = Date.now();

  const results = await Promise.allSettled([
    warmPing('Service Statuses', '/api/infrastructure/v1/list-service-statuses'),
    warmPing('Cable Health', '/api/infrastructure/v1/get-cable-health'),
  ]);

  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  const total = results.length;
  const duration = Date.now() - start;

  console.log(`\n=== Done: ${ok}/${total} warm-pings OK (${duration}ms) ===`);
  process.exit(ok > 0 ? 0 : 1);
}

main();
