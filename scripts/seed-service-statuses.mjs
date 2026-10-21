#!/usr/bin/env node

/**
 * Warm-pings the Vercel RPC endpoint to populate the Redis cache.
 * The RPC handler (list-service-statuses.ts) does the actual fetching
 * and caching via cachedFetchJson. This script just triggers it.
 *
 * Standalone fallback — primary seeder is the AIS relay loop.
 */

import { loadEnvFile, CHROME_UA, getRedisCredentials, logSeedResult, extendExistingTtl } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const RPC_URL = 'https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses';
const CANONICAL_KEY = 'infra:service-statuses:v1';

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

async function warmPing() {
  const startMs = Date.now();
  console.log('=== infra:service-statuses Warm Ping ===');
  console.log(`  Key:     ${CANONICAL_KEY}`);
  console.log(`  Target:  ${RPC_URL}`);

  let data;
  try {
    const resp = await fetch(RPC_URL, {
      method: 'POST',
      headers: warmPingHeaders(),
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const keyNote = RELAY_API_KEY ? '' : ' (WORLDMONITOR_RELAY_KEY not set — Origin-only auth)';
      throw new Error(`RPC failed: HTTP ${resp.status}${keyNote}`);
    }
    data = await resp.json();
  } catch (err) {
    console.error(`  FETCH FAILED: ${err.message || err}`);
    await extendExistingTtl([CANONICAL_KEY, 'seed-meta:infra:service-statuses'], 7200);
    console.log(`\n=== Failed gracefully (${Math.round(Date.now() - startMs)}ms) ===`);
    process.exit(0);
  }

  const count = data?.statuses?.length || 0;
  console.log(`  Statuses: ${count}`);

  const { url, token } = getRedisCredentials();
  const verifyResp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const verifyData = await verifyResp.json();
  if (verifyData.result) {
    console.log('  Verified: data present in Redis');
  } else {
    throw new Error('Verification failed: Redis key empty after successful RPC');
  }

  const durationMs = Date.now() - startMs;
  logSeedResult('infra', count, durationMs, { mode: 'warm-ping' });
  console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
}

warmPing().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  process.exit(1);
});
