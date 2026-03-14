#!/usr/bin/env node

/**
 * Seed military and maritime data via warm-ping pattern.
 *
 * These handlers have complex parsers (USNI HTML parsing with vessel/CSG extraction,
 * NGA warning parsing with coordinate extraction) that are impractical to replicate
 * in a standalone script without risking data shape mismatches. Instead, we call the
 * Vercel RPC endpoints from Railway to warm-populate the Redis cache.
 *
 * Seeded via warm-ping:
 * - getUSNIFleetReport: USNI WordPress scrape + complex HTML parsing
 * - listNavigationalWarnings: NGA broadcast API + date/coordinate parsing
 *
 * NOT seeded (inherently on-demand):
 * - getAircraftDetails / batch: per-icao24 Wingbits lookup
 * - listMilitaryFlights: bounding-box query (quantized grid)
 * - getVesselSnapshot: in-memory cache, reads from relay /ais-snapshot
 * - listFeedDigest: per-feed URL RSS caching (hundreds of feeds)
 * - summarizeArticle: per-article LLM summarization
 */

import { loadEnvFile, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const API_BASE = 'https://api.worldmonitor.app';
const TIMEOUT = 30_000;

async function warmPing(name, path, body = {}) {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) {
      console.warn(`  ${name}: HTTP ${resp.status}`);
      return false;
    }
    const data = await resp.json();
    const count = data.report?.vessels?.length ?? data.warnings?.length ?? 0;
    console.log(`  ${name}: OK (${count} items)`);
    return true;
  } catch (e) {
    console.warn(`  ${name}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('=== Military/Maritime Warm-Ping Seed ===');
  const start = Date.now();

  const results = await Promise.allSettled([
    warmPing('USNI Fleet Report', '/api/military/v1/get-usni-fleet-report'),
    warmPing('Nav Warnings', '/api/maritime/v1/list-navigational-warnings'),
  ]);

  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  const total = results.length;
  const duration = Date.now() - start;

  console.log(`\n=== Done: ${ok}/${total} warm-pings OK (${duration}ms) ===`);
  process.exit(ok > 0 ? 0 : 1);
}

main();
