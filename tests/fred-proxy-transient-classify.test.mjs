import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHROME_UA, fredFetchJson, isTransientProxyError } from '../scripts/_seed-utils.mjs';

// fredFetchJson retries the (IP-rotating) Decodo proxy only when the error is
// classified transient; otherwise it breaks to a direct FRED fetch, which a
// datacenter IP gets rate-limited/blocked on → the whole seed-economy batch
// fails and fredBatch/economicStress/macroSignals go stale. The TLS-handshake
// tear signatures below are the EXACT strings seen in the failing-run logs and
// MUST be retried — they did not match the original 5xx/timeout-only regex.
//
// Run: node --test tests/fred-proxy-transient-classify.test.mjs

const originalFetch = globalThis.fetch;

test('fredFetchJson direct FRED fallback sends a User-Agent header', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let seenHeaders = null;
  globalThis.fetch = async (_url, init = {}) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({ observations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=GDP');

  assert.equal(seenHeaders?.['User-Agent'], CHROME_UA);
  assert.equal(seenHeaders?.Accept, 'application/json');
});

test('fredFetchJson proxy fallback direct path sends a User-Agent header', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  let seenHeaders = null;
  globalThis.fetch = async (_url, init = {}) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({ observations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await fredFetchJson('https://api.stlouisfed.org/fred/series/observations?series_id=GDP', 'invalid-proxy-auth');

  assert.equal(seenHeaders?.['User-Agent'], CHROME_UA);
  assert.equal(seenHeaders?.Accept, 'application/json');
});

test('TLS-handshake tear signatures (from the real failing logs) are transient', () => {
  const tlsTears = [
    '80D38646D17F0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:ssl/record/methods/tls_common.c:662:',
    'Client network socket disconnected before secure TLS connection was established',
  ];
  for (const msg of tlsTears) {
    assert.equal(isTransientProxyError(msg), true, `should retry: ${msg}`);
  }
});

test('classic transient signatures still classify transient (no regression)', () => {
  for (const msg of [
    'HTTP 522', 'HTTP 503', 'proxy fetch timeout',
    'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'socket hang up',
  ]) {
    assert.equal(isTransientProxyError(msg), true, `should retry: ${msg}`);
  }
});

test('genuinely non-transient errors are NOT retried (fall straight to direct)', () => {
  for (const msg of ['HTTP 401', 'HTTP 403', 'HTTP 404', 'Missing FRED_API_KEY', '']) {
    assert.equal(isTransientProxyError(msg), false, `should NOT retry: "${msg}"`);
  }
  assert.equal(isTransientProxyError(undefined), false);
  assert.equal(isTransientProxyError(null), false);
});
