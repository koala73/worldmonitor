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

// Defense-in-depth auth — see seed-infra.mjs for the same pattern + rationale.
// Set WORLDMONITOR_RELAY_KEY on the Railway service to a value already
// present in Vercel's WORLDMONITOR_VALID_KEYS.
const RELAY_API_KEY = process.env.WORLDMONITOR_RELAY_KEY || '';

function warmPingHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': CHROME_UA,
    Origin: 'https://worldmonitor.app',
  };
  if (RELAY_API_KEY) h['X-WorldMonitor-Key'] = RELAY_API_KEY;
  return h;
}

async function warmPing(name, path, body = {}) {
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: warmPingHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!resp.ok) {
      const keyNote = RELAY_API_KEY ? '' : ' (WORLDMONITOR_RELAY_KEY not set — Origin-only auth)';
      console.warn(`  ${name}: HTTP ${resp.status}${keyNote}`);
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

  for (const r of results) { if (r.status === 'rejected') console.warn(`  Warm-ping failed: ${r.reason?.message || r.reason}`); }

  const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
  const total = results.length;
  const duration = Date.now() - start;

  console.log(`\n=== Done: ${ok}/${total} warm-pings OK (${duration}ms) ===`);
  if (ok === 0) {
    // Distinct, grep-able marker so persistent auth/gateway breakage stays
    // visible in Railway logs even though we exit 0. Set up a Railway log
    // alert on this string instead of relying on container exit codes.
    console.log('WARN: all warm-pings failed — cache is cold (check WORLDMONITOR_RELAY_KEY and gateway auth)');
  }
  // Best-effort cache warmer: a missed warm-ping is not a failure worth paging on.
  // Upstream timeouts and transient 5xx happen routinely; exiting non-zero turned
  // every blip into a Railway "Deploy crashed" email. Logs above still surface
  // partial failures for investigation.
  process.exit(0);
}

main();
