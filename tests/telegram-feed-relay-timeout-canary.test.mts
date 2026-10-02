import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// ─── api/telegram-feed relay-failure capture policy ────────────────────────
//
// PR #7438 made the outer catch SKIP `captureSilentError` on AbortError, which
// deleted the only signal for telegram relay degradation — nothing in
// `scripts/` or `.github/workflows/` watches it. The replacement is a
// warning-level canary: still queryable, but out of error totals and off
// on-call. The tag that makes it triageable is `mode`, because the three
// budgets differ (feed 15s, resolve 20s, channel 22s) and a capture without it
// cannot tell a 15s feed stall from a 22s channel stall.
//
// The two #7438 tests in `telegram-feed-contract.test.mjs` assert only the
// 504/502 mapping — they pass on pre-#7438 code, because `captureSilentError`
// no-ops unless `_sentry-common.js` parsed a DSN in its import-time
// `parseDsn()` IIFE (`if (process.env.NODE_TEST_CONTEXT) return`). So this file
// activates a throwaway DSN BEFORE the handler's module graph loads — hence the
// dynamic `import()` below, after the env writes. Each `*.test.mts` runs in its
// own `tsx --test` subprocess, so the DSN never leaks into the statically
// imported handler in the contract suite.
//
// We observe the edge transport's envelope POST and parse its payload. The
// non-timeout case doubles as the DSN-ACTIVATION CONTROL: if the DSN never
// wired up, its hit count would be 0 and it fails loudly — so a 1-hit
// warning-level assertion can never be a silent false-pass.

const SESSION_SECRET = 'x'.repeat(48);

const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;

// UPSTASH_* must be UNSET, not merely assumed unset. `getRatelimit` reads both
// on every call, so an inherited pair (a shell that sourced .env.local, a job
// that exports the secrets) sends checkRateLimit down the real Redis path —
// and with NODE_TEST_CONTEXT cleared above, REDIS_TEST_RETRY_OPTS no longer
// suppresses its retries. The stub then rejects the Upstash URL, the fail-open
// catch in `logRateLimitDegraded` fires a SECOND envelope, and every
// `events.length === 1` assertion fails ~4.3s late. Restored in `after()`.
const previousUpstash = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Set before the dynamic import so parseDsn() wires up the envelope transport.
process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';
process.env.WS_RELAY_URL = 'https://relay.example.com';
process.env.RELAY_SHARED_SECRET = 'test-secret';
process.env.WM_SESSION_SECRET = SESSION_SECRET;

// parseDsn() derives `${protocol}//${host}/api/${projectId}/envelope/` from the
// DSN above → this prefix.
const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';
const RELAY_URL_PREFIX = 'https://relay.example.com';

const { default: handler, relayFailureLevel } = await import('../api/telegram-feed.js');
const { issueSessionToken } = await import('../api/_session.js');

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  if (previousUpstash.url !== undefined) process.env.UPSTASH_REDIS_REST_URL = previousUpstash.url;
  if (previousUpstash.token !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = previousUpstash.token;
});

interface SentryEvent {
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  exception?: { values?: Array<{ type?: string; value?: string }> };
}

/** Envelope wire format: header line, item header line, item payload line. */
function parseEnvelope(body: string): SentryEvent {
  const lines = body.split('\n');
  assert.equal(JSON.parse(lines[1]).type, 'event', 'envelope item must be an event');
  return JSON.parse(lines[2]) as SentryEvent;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Drive the handler with the relay fetch rejecting, and report every Sentry
 * event the edge transport dispatched alongside the client-facing response.
 */
async function runWithRelayFailure(path: string, relayError: Error): Promise<{
  events: SentryEvent[];
  status: number;
  body: unknown;
}> {
  const envelopes: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(ENVELOPE_URL_PREFIX)) {
      envelopes.push(String(init?.body ?? ''));
      return new Response('', { status: 200 });
    }
    if (url.startsWith(RELAY_URL_PREFIX)) throw relayError;
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const { token } = await issueSessionToken();
  const res = await handler(new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  }));
  const body = await res.json();
  // The handler takes no `ctx`, so delivery is fire-and-forget on `keepalive`;
  // yield a macrotask so the transport's fetch has run before we read it.
  await new Promise((resolve) => { setImmediate(resolve); });
  return { events: envelopes.map(parseEnvelope), status: res.status, body };
}

describe('api/telegram-feed relay timeout canary', () => {
  // Two modes, because a single-mode fixture cannot prove the tag VARIES — a
  // hardcoded `mode: 'feed'` would satisfy it.
  for (const { mode, path, timeoutMs } of [
    { mode: 'feed', path: '/api/telegram-feed?limit=50', timeoutMs: 15_000 },
    { mode: 'channel', path: '/api/telegram-feed?mode=channel&username=warintel', timeoutMs: 22_000 },
  ]) {
    it(`captures a ${mode} relay timeout at warning level with its own budget`, async () => {
      const { events, status, body } = await runWithRelayFailure(path, abortError());

      assert.equal(events.length, 1, `a ${mode} relay timeout must stay queryable in Sentry`);
      const [event] = events;
      assert.equal(event.level, 'warning', 'routine relay latency must not count toward error totals');
      assert.equal(event.tags?.route, 'api/telegram-feed');
      assert.equal(event.tags?.step, 'relay-fetch');
      assert.equal(event.tags?.mode, mode, 'the mode tag is what makes the capture triageable');
      assert.equal(event.exception?.values?.[0]?.type, 'AbortError');
      assert.equal(
        event.extra?.timeout_ms,
        timeoutMs,
        'without the budget a 15s feed stall and a 22s channel stall are indistinguishable',
      );

      assert.equal(status, 504);
      assert.deepEqual(body, { error: 'Relay timeout' });
    });
  }

  // Positive control AND the DSN-activation control: a 0-hit here would mean
  // the transport never wired up, making every assertion above vacuous.
  it('keeps a non-timeout relay failure at error level, tagged but without a budget', async () => {
    const { events, status, body } = await runWithRelayFailure(
      '/api/telegram-feed?limit=50',
      new Error('relay ECONNREFUSED'),
    );

    assert.equal(events.length, 1, 'a real relay failure must still reach Sentry');
    const [event] = events;
    assert.equal(event.level, 'error', 'a transport failure is a defect, not routine latency');
    assert.equal(event.tags?.step, 'relay-fetch');
    assert.equal(event.tags?.mode, 'feed');
    assert.equal(event.exception?.values?.[0]?.type, 'Error');
    assert.ok(
      !('timeout_ms' in (event.extra ?? {})),
      'timeout_ms describes an abort deadline that this failure never reached',
    );

    assert.equal(status, 502);
    assert.deepEqual(body, { error: 'Relay request failed' });
  });

  // WORLDMONITOR-R1. The edge runtime drops an established upstream connection
  // under ordinary operation and rejects with this exact message. It is the
  // same class of routine transport churn as our own abort budget, so it must
  // not page — but the ECONNREFUSED control above must stay at `error`, which
  // is why "not an AbortError" is the wrong discriminator.
  it('keeps a dropped upstream connection at warning level', async () => {
    const { events, status, body } = await runWithRelayFailure(
      '/api/telegram-feed?limit=50',
      new Error('Network connection lost.'),
    );

    assert.equal(events.length, 1, 'a dropped relay connection must stay queryable in Sentry');
    const [event] = events;
    assert.equal(event.level, 'warning', 'an edge transport drop is not a WorldMonitor defect');
    assert.equal(event.tags?.step, 'relay-fetch');
    assert.equal(event.tags?.mode, 'feed');
    assert.ok(
      !('timeout_ms' in (event.extra ?? {})),
      'timeout_ms describes an abort deadline that this failure never reached',
    );

    assert.equal(status, 502, 'severity is orthogonal to the client-facing status');
    assert.deepEqual(body, { error: 'Relay request failed' });
  });

  it('keeps an unresolvable relay host at error level', async () => {
    const { events } = await runWithRelayFailure(
      '/api/telegram-feed?limit=50',
      new Error('getaddrinfo ENOTFOUND relay.example.com'),
    );

    assert.equal(events[0]?.level, 'error', 'a relay that never answers is a deploy defect');
  });
});

describe('relayFailureLevel (WORLDMONITOR-R1)', () => {
  // A connection that was established and then dropped is transport churn. A
  // connection that could never be established is a defect. The predicate
  // encodes that boundary; these cases pin both sides of it.
  for (const msg of [
    'Network connection lost.',
    'read ECONNRESET',
    'socket hang up',
    'terminated',
  ]) {
    it(`treats "${msg}" as routine transport churn`, () => {
      assert.equal(relayFailureLevel(new Error(msg)), 'warning');
    });
  }

  for (const msg of [
    'connect ECONNREFUSED 10.0.0.1:443',
    'getaddrinfo ENOTFOUND relay.example.com',
    'Unexpected token < in JSON at position 0',
    // A connection that expired mid-handshake was never established, so it is
    // an unreachable relay, not a drop. Keeping it at `warning` would hide a
    // persistent routing or firewall outage from on-call.
    'connect ETIMEDOUT 10.0.0.1:443',
  ]) {
    it(`treats "${msg}" as a defect`, () => {
      assert.equal(relayFailureLevel(new Error(msg)), 'error');
    });
  }

  // `code` is structured and immune to message text, so it outranks any
  // phrasing when the runtime supplies it.
  it('prefers a structured code over the message', () => {
    const reset = Object.assign(new Error('write failed'), { code: 'ECONNRESET' });
    assert.equal(relayFailureLevel(reset), 'warning');

    const refused = Object.assign(new Error('Network connection lost.'), { code: 'ECONNREFUSED' });
    assert.equal(relayFailureLevel(refused), 'error', 'a structured code outranks a drop phrasing');
  });

  it('does not match a drop phrasing quoted inside a longer message', () => {
    assert.equal(
      relayFailureLevel(new Error('relay responded 500: upstream reported ECONNRESET to its peer')),
      'error',
      'diagnostic prose that mentions a drop code is not itself a drop',
    );
  });

  it('classifies our own abort budget as routine, whatever its message', () => {
    assert.equal(relayFailureLevel(abortError()), 'warning');
  });

  it('does not let a transient phrase inside a larger defect message win', () => {
    // `fetch failed` is undici's generic wrapper and hides ECONNREFUSED, so it
    // must not be a transient phrasing on its own.
    assert.equal(relayFailureLevel(new Error('fetch failed')), 'error');
  });
});
