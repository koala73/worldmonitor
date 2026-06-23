import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// ─── WORLDMONITOR-RE: symbol-search Sentry-capture policy ──────────────────
//
// PR #4233 made `api/symbol-search.ts` SKIP the `captureSilentError` call for
// upstream gateway transients (502/503/504) — Finnhub-side infra blips that
// were paging at `warning` on an unactionable transient — while STILL
// capturing genuinely actionable failures (401/403 auth, 429 quota, other
// 5xx like 500). This is the only behavioural change in the PR that wasn't
// pinned by a test; the sibling SQ/SP fixes both have boundary tests.
//
// `captureSilentError` no-ops unless `_sentry-common.js` parsed a DSN in its
// import-time `parseDsn()` IIFE (`if (!_envelopeUrl || !_key) return`), so we
// activate a throwaway DSN BEFORE the handler's module graph is loaded — hence
// the dynamic `import()` below, after the env writes. Each `*.test.mts` file
// runs in its own `tsx --test` subprocess, so this DSN never leaks into the
// statically-imported handler in `symbol-search.test.mts`.
//
// We observe the edge transport's envelope POST (the fire-and-forget delivery
// `deliver()` fires at `_envelopeUrl`). The 401/403/429/500 cases double as a
// POSITIVE CONTROL: if the DSN never activated, `envelopeHits` would be 0 and
// those assertions fail loudly — so a 0-hit on a 502/503/504 case can never be
// a silent false-pass.

const TEST_KEY = 'wm-test-enterprise-key';

// Set before the dynamic import so parseDsn() wires up the envelope transport.
process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';
process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
process.env.FINNHUB_API_KEY = 'test-key';
// Leave UPSTASH_* unset: both the cache helpers and the rate limiter guard on
// those vars and return early WITHOUT fetching, so Finnhub + the Sentry
// envelope are the only two URLs the handler ever hits.

// parseDsn() derives `${protocol}//${host}/api/${projectId}/envelope/` from the
// DSN above → this prefix.
const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';

const { default: handler } = await import('../api/symbol-search.ts');

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function makeReq(q = 'nvidia'): Request {
  return new Request(
    `https://worldmonitor.app/api/symbol-search?q=${encodeURIComponent(q)}`,
    { headers: { 'X-WorldMonitor-Key': TEST_KEY } },
  );
}

/**
 * Drive the handler against a mocked Finnhub status and report how many Sentry
 * envelope POSTs the edge transport fired, plus the client-facing status. A
 * `ctx.waitUntil` collector lets us await the fire-and-forget delivery before
 * asserting.
 */
async function runWithFinnhubStatus(finnhubStatus: number): Promise<{ envelopeHits: number; status: number }> {
  let envelopeHits = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(ENVELOPE_URL_PREFIX)) {
      envelopeHits++;
      return new Response('', { status: 200 });
    }
    if (url.includes('finnhub.io')) return new Response('upstream', { status: finnhubStatus });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const tasks: Array<Promise<unknown>> = [];
  const res = await handler(makeReq(), { waitUntil: (p: Promise<unknown>) => { tasks.push(p); } });
  await Promise.allSettled(tasks);
  return { envelopeHits, status: res.status };
}

describe('symbol-search Sentry-capture policy (WORLDMONITOR-RE)', () => {
  // ── Actionable failures STILL capture (also the DSN-activation control) ──
  for (const finnhubStatus of [401, 403, 500]) {
    it(`captures an actionable Finnhub ${finnhubStatus} and surfaces 502 to the client`, async () => {
      const { envelopeHits, status } = await runWithFinnhubStatus(finnhubStatus);
      assert.equal(envelopeHits, 1, `Finnhub ${finnhubStatus} (auth/server error) must reach Sentry`);
      assert.equal(status, 502);
    });
  }

  it('captures a Finnhub 429 (quota — actionable: bump the plan) and maps it to client 503', async () => {
    const { envelopeHits, status } = await runWithFinnhubStatus(429);
    assert.equal(envelopeHits, 1, 'quota exhaustion must reach Sentry');
    assert.equal(status, 503);
  });

  // ── The fix: upstream gateway transients are NOT captured ──
  for (const finnhubStatus of [502, 503, 504]) {
    it(`skips capture for upstream gateway transient ${finnhubStatus}`, async () => {
      const { envelopeHits, status } = await runWithFinnhubStatus(finnhubStatus);
      assert.equal(envelopeHits, 0, `gateway transient ${finnhubStatus} must NOT page Sentry (WORLDMONITOR-RE)`);
      assert.equal(status, 502, 'client still receives 502 so it backs off and uptime monitoring fires');
    });
  }

  it('skips capture for a malformed-query 422 (returns 400, user-input noise)', async () => {
    const { envelopeHits, status } = await runWithFinnhubStatus(422);
    assert.equal(envelopeHits, 0, '422 bad-query is user-input noise, not a Sentry-worthy upstream failure');
    assert.equal(status, 400);
  });
});
