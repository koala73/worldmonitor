import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// ─── #7204: the relay fetch must never escape as an opaque platform 5xx ─────
//
// `api/widget-agent.ts` attaches `corsHeaders` to all fifteen of its other
// exits, but the relay call itself was unguarded and the handler had no outer
// `try`. A relay DNS failure, connection reset, or TLS error therefore threw
// straight out of the handler and became a Vercel platform 5xx *without* CORS
// headers — the browser saw a CORS error rather than a readable status, so the
// widget could not tell "relay is down" from "you are not allowed".
//
// These tests pin the sibling contract `api/chat-analyst.ts:99-121` already
// documents: capture server-side, and answer with a CORS-correct transient 503
// (never a 403 — a relay blip must never read as an entitlement denial).
//
// Sentry observation follows `tests/symbol-search-sentry-capture.test.mts`:
// `captureSilentError` no-ops unless `_sentry-common.js` parsed a DSN in its
// import-time `parseDsn()` IIFE, so we activate a throwaway DSN BEFORE the
// handler's module graph loads — hence the dynamic `import()` after the env
// writes. Each `*.test.mts` file runs in its own `tsx --test` subprocess, so
// this DSN never leaks into the statically-imported handler in
// `widget-agent-auth.test.mts`. The success-path case is the negative control:
// it must record ZERO envelope hits while the failure cases record one, so a
// hit count can never silently false-pass in either direction.

const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;

process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';
process.env.WIDGET_AGENT_KEY = 'server-widget-key';
process.env.PRO_WIDGET_KEY = 'server-pro-key';
process.env.WORLDMONITOR_VALID_KEYS = 'browser-test-key';
// Tight health budget so the unresponsive-relay case resolves in milliseconds.
// Only the GET path has a timeout; see the route for why POST cannot.
process.env.WIDGET_AGENT_HEALTH_TIMEOUT_MS = '50';

const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';
const RELAY_POST_URL = 'https://proxy.worldmonitor.app/widget-agent';
const RELAY_HEALTH_URL = 'https://proxy.worldmonitor.app/widget-agent/health';
const ORIGIN = 'https://www.worldmonitor.app';

const { default: handler } = await import('../api/widget-agent.ts');

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
});

type RelayBehaviour =
  | { kind: 'reject'; error: Error }
  /** Accepts the connection and then says nothing — only an abort can end it. */
  | { kind: 'unresponsive' }
  /**
   * Headers now, body later — the shape a real SSE relay has. A mock that
   * hands back a fully-buffered body cannot tell a passthrough apart from a
   * `await res.text()` that swallowed the stream, so the success-path test
   * would still pass if the route stopped streaming.
   */
  | { kind: 'stream'; chunks: string[] };

function installFetch(behaviour: RelayBehaviour): { envelopeHits: () => number } {
  let hits = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(ENVELOPE_URL_PREFIX)) {
      hits++;
      return new Response('', { status: 200 });
    }
    if (url === RELAY_POST_URL || url === RELAY_HEALTH_URL) {
      if (behaviour.kind === 'reject') throw behaviour.error;
      if (behaviour.kind === 'unresponsive') {
        // Settles only if the route wired an abort signal. If it did not, this
        // promise stays pending — hence the per-test timeout on the caller, so
        // a missing signal fails that one test loudly instead of hanging CI
        // (node:test's default timeout is Infinity).
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
        });
      }
      // Resolve with headers immediately, then emit each chunk on a later tick.
      // A route that buffered the body instead of forwarding `relayRes.body`
      // would still produce the right bytes, so the test also asserts the
      // chunks arrive as separate reads.
      const { chunks } = behaviour;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const enc = new TextEncoder();
          for (const chunk of chunks) {
            await new Promise((r) => setTimeout(r, 5));
            controller.enqueue(enc.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { envelopeHits: () => hits };
}

function postRequest(): Request {
  return new Request('https://www.worldmonitor.app/api/widget-agent', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': 'browser-test-key',
    },
    body: JSON.stringify({ prompt: 'Build a widget', mode: 'create', tier: 'basic' }),
  });
}

function getRequest(): Request {
  return new Request('https://www.worldmonitor.app/api/widget-agent', {
    method: 'GET',
    headers: { Origin: ORIGIN, 'X-WorldMonitor-Key': 'browser-test-key' },
  });
}

/** Drive the handler and await the fire-and-forget Sentry delivery. */
async function run(req: Request): Promise<Response> {
  const tasks: Array<Promise<unknown>> = [];
  const res = await handler(req, { waitUntil: (p: Promise<unknown>) => { tasks.push(p); } });
  await Promise.allSettled(tasks);
  return res;
}

describe('widget-agent relay failure boundary (#7204)', () => {
  it('answers a rejected relay POST with a CORS-correct 503, not an opaque throw', async () => {
    const { envelopeHits } = installFetch({
      kind: 'reject',
      error: Object.assign(new Error('getaddrinfo ENOTFOUND proxy.worldmonitor.app'), { name: 'TypeError' }),
    });

    const res = await run(postRequest());

    assert.equal(res.status, 503, 'a relay outage is transient — never 403 (entitlement) or 500');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      ORIGIN,
      'without ACAO the browser reports a CORS error instead of a readable status',
    );
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    const body = await res.json() as { error?: string; ok?: boolean };
    assert.equal(body.error, 'service_unavailable');
    assert.equal(body.ok, false);
    assert.equal(envelopeHits(), 1, 'the outage must produce a real Sentry trace, not just a browser console error');
  });

  it('answers a rejected relay health GET with a CORS-correct 503', async () => {
    const { envelopeHits } = installFetch({
      kind: 'reject',
      error: Object.assign(new Error('socket hang up'), { name: 'TypeError' }),
    });

    const res = await run(getRequest());

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(envelopeHits(), 1);
  });

  // The health check is the one relay call that still carries a timeout, and it
  // is the only place an abort signal is wired at all — so without this case
  // that budget ships with no coverage. The explicit per-test timeout is the
  // point: if the signal is ever dropped, the mock never settles, and this must
  // fail on its own rather than hanging the whole suite forever.
  it('answers an unresponsive relay health GET with a CORS-correct 503', { timeout: 5_000 }, async () => {
    const { envelopeHits } = installFetch({ kind: 'unresponsive' });

    const res = await run(getRequest());

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(envelopeHits(), 1, 'a health-check timeout is a real relay outage — it must reach Sentry');
  });

  it('streams the SSE success path through untouched (negative control: zero Sentry hits)', async () => {
    const chunks = [
      'data: {"type":"tool_call","endpoint":"markets"}\n\n',
      'data: {"type":"html_complete","html":"<div/>"}\n\n',
      'data: {"type":"done","title":"Oil"}\n\n',
    ];
    const { envelopeHits } = installFetch({ kind: 'stream', chunks });

    const res = await run(postRequest());

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/event-stream');
    assert.equal(res.headers.get('Cache-Control'), 'no-cache, no-store');
    assert.equal(res.headers.get('X-Accel-Buffering'), 'no');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.ok(res.body, 'the relay body must be forwarded as a stream, not buffered');

    // Read chunk-by-chunk. Body data is emitted only AFTER the handler has
    // already returned its Response, which is the property that matters: the
    // route must not await the stream before answering, or a long generation
    // would stall behind it.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const received: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(dec.decode(value, { stream: true }));
    }

    assert.deepEqual(received, chunks, 'each relay chunk must arrive as its own read, in order');
    assert.equal(envelopeHits(), 0, 'a healthy relay call must not page Sentry');
  });
});
