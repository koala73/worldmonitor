// Tests for GDELT GEO 2.0 API params in scripts/seed-unrest-events.mjs.
// Verifies that fetchGdeltEvents:
//   1. Uses api.v2/geo/geo endpoint (not deprecated api.v1)
//   2. Sends query in UPPERCASE (v2 requires uppercase, v1 accepted lowercase)
//   3. Includes sourcecountry=WORLD for global coverage (v1 defaulted to US only)
//   4. Includes format=json

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { fetchGdeltEvents } = await import('../scripts/seed-unrest-events.mjs');

const PROXY_AUTH = 'user:pass@gate.decodo.com:7000';

function jsonBuffer(obj) {
  return { buffer: Buffer.from(JSON.stringify(obj), 'utf8') };
}

const noSleep = async () => {};
const noJitter = () => 0;

// ─── 1. fetchGdeltEvents: v2 API params ────────────────────────────────

test('fetchGdeltEvents constructs v2 URL with uppercase query and sourcecountry=WORLD', async () => {
  let capturedUrl = '';
  const _proxyFetcher = async (url) => {
    capturedUrl = url;
    return { buffer: Buffer.from(JSON.stringify({ features: [] }), 'utf8') };
  };
  await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
  });
  // Must use api.v2/geo/geo endpoint
  assert.match(capturedUrl, /api\/v2\/geo\/geo/);
  // Query must be UPPERCASE (v2 requires uppercase)
  assert.match(capturedUrl, /query=[A-Z]/);
  // Must include sourcecountry=WORLD for global coverage (v1 defaulted to US)
  assert.match(capturedUrl, /sourcecountry=WORLD/);
  // Must include format=json
  assert.match(capturedUrl, /format=json/);
});
