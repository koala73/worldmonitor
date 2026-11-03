import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// ─── WORLDMONITOR-ZR: api/rss-proxy needs an explicit Sentry fingerprint ─────
//
// Both `api/rss-proxy` capture sites run inside the minified edge bundle, whose
// frames are all anonymous `(vc/edge/function` with no source map and
// `in_app=false`. Sentry's default grouping keys on that stack, so every
// capture sharing it collapses together — the pathology
// `api/mcp/error-fingerprint.ts` was written to close for `api/mcp`, and which
// `tests/mcp-pro-token-fingerprint.test.mts` already pins for the Pro-token
// gate.
//
// api/rss-proxy never got the same treatment. Observed 2026-09-20: a
// `Feed body too large` capture from this route landed in WORLDMONITOR-ZR, the
// legacy catch-all that had been holding six `Pro MCP token validation
// temporarily unavailable` events from a completely different subsystem. The
// MCP events left ZR when `24af1ac35` fingerprinted them on 2026-09-11; this
// route, still unfingerprinted, fell straight into the group they vacated.
// The issue then displayed only the newest message, so ZR read as an RSS
// problem while six MCP events sat invisible underneath it, and its
// `regressed` substatus was manufactured by an unrelated subsystem.
//
// The fingerprint is keyed on the error CLASS, never the feed URL: the RSS
// allowlist carries 428 hosts, and a URL-keyed fingerprint would mint 428
// issues for one outage.

const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;

const TEST_KEY = 'rss-proxy-fingerprint-key';
process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';
process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.RSS_RELAY_URL;

const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';
const FEED_URL = 'https://techcrunch.com/feed';

const { default: handler } = await import('../api/rss-proxy.js');

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
});

/**
 * Drive the proxy against a feed fetch that fails the given way and return
 * every Sentry event it delivered. `captureSilentError` routes through
 * `ctx.waitUntil`, so the collected promises are awaited before asserting —
 * without that the event array is still empty when the handler resolves.
 */
async function captureEvents(
  onFeedFetch: () => Promise<Response>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const pending: Array<Promise<unknown>> = [];

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
    if (url.startsWith(ENVELOPE_URL_PREFIX)) {
      // Envelope format: header line, item header line, item payload line.
      const lines = String(init?.body ?? '').trim().split('\n');
      events.push(JSON.parse(lines[lines.length - 1]));
      return new Response('{}', { status: 200 });
    }
    return onFeedFetch();
  }) as typeof globalThis.fetch;

  const request = new Request(
    `https://api.worldmonitor.app/api/rss-proxy?url=${encodeURIComponent(FEED_URL)}`,
    { headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY } },
  );
  await handler(request, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
  await Promise.all(pending);
  return events;
}

describe('api/rss-proxy — Sentry grouping fingerprint', () => {
  it('fingerprints the fetch arm so it cannot merge into the edge catch-all', async () => {
    const events = await captureEvents(async () => { throw new Error('upstream exploded'); });

    assert.equal(events.length, 1, 'the failed fetch captures exactly one event');
    const [event] = events;
    assert.equal(
      (event.exception as { values: Array<{ value: string }> }).values[0].value,
      'upstream exploded',
      'positive control — the DSN activated and this is the fetch-arm capture',
    );
    assert.deepEqual(
      event.fingerprint,
      ['rss-proxy', 'fetch', 'Error'],
      'without an explicit fingerprint Sentry groups on the anonymous edge stack',
    );
  });

  it('separates error classes so one upstream fault cannot mask another', async () => {
    const events = await captureEvents(async () => { throw new TypeError('bad header shape'); });

    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0].fingerprint,
      ['rss-proxy', 'fetch', 'TypeError'],
      'a distinct error class must land in its own group',
    );
  });

  it('keys the fingerprint on the error class, not the feed URL', async () => {
    const events = await captureEvents(async () => { throw new Error('upstream exploded'); });

    const fingerprint = events[0].fingerprint as string[];
    assert.ok(
      !fingerprint.some((part) => part.includes('techcrunch')),
      `the 428-host allowlist must not mint one issue per host, got ${JSON.stringify(fingerprint)}`,
    );
  });
});
