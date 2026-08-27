import assert from 'node:assert/strict';
import { after, afterEach, describe, it, mock } from 'node:test';

const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
const previousSentryDsn = process.env.VITE_SENTRY_DSN;
const previousConvexUrl = process.env.CONVEX_URL;
delete process.env.NODE_TEST_CONTEXT;

// Set before the dynamic import so _sentry-common.js enables its envelope
// transport. The ordinary drift cases below are positive controls for this
// setup: they must each emit exactly one envelope.
process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';

const { default: handler, __setUserPrefsDepsForTests } = await import('../api/user-prefs.ts');

/**
 * Regression coverage for #7140: `session.acceptedWithinClockTolerance` skips
 * the Sentry drift capture on both the GET and POST UNAUTHENTICATED paths in
 * api/user-prefs.ts (documented as an invariant in CONCEPTS.md by #7097).
 * Neither branch had a dedicated test, so deleting either `if` silently
 * breaks the documented "only a token past `exp` _and_ past that tolerance
 * is refused at the edge" boundary without failing any test.
 */

const TEST_USER_ID = 'user_clock_tolerance_test';
const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';
const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
  if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  if (previousSentryDsn === undefined) delete process.env.VITE_SENTRY_DSN;
  else process.env.VITE_SENTRY_DSN = previousSentryDsn;
  if (previousConvexUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = previousConvexUrl;
});

afterEach(() => {
  __setUserPrefsDepsForTests(null);
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

interface SentryEvent {
  level?: string;
  tags?: Record<string, unknown>;
}

function makeGet(): Request {
  return new Request('https://worldmonitor.app/api/user-prefs?variant=full', {
    method: 'GET',
    headers: { Origin: 'https://worldmonitor.app', Authorization: 'Bearer test-token' },
  });
}

function makePost(): Request {
  return new Request('https://worldmonitor.app/api/user-prefs', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ variant: 'full', data: { theme: 'dark' }, expectedSyncVersion: 1 }),
  });
}

function installDeps(session: { valid: true; userId: string; acceptedWithinClockTolerance?: true }) {
  process.env.CONVEX_URL = 'https://convex.test';
  __setUserPrefsDepsForTests({
    validateBearerToken: async () => session,
    checkScopedRateLimit: async (_scope, limit) => ({ allowed: true, limit, reset: 0, degraded: false }),
    createConvexClient: () => ({
      setAuth(): void {},
      async query(): Promise<unknown> {
        const err = new Error('ConvexError: UNAUTHENTICATED') as Error & { data?: Record<string, unknown> };
        err.data = { kind: 'UNAUTHENTICATED' };
        throw err;
      },
      async mutation(): Promise<unknown> {
        const err = new Error('ConvexError: UNAUTHENTICATED') as Error & { data?: Record<string, unknown> };
        err.data = { kind: 'UNAUTHENTICATED' };
        throw err;
      },
    }),
  });
}

async function runRequest(method: 'GET' | 'POST', acceptedWithinClockTolerance: boolean): Promise<{
  response: Response;
  sentryEvents: SentryEvent[];
}> {
  const envelopeBodies: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(ENVELOPE_URL_PREFIX)) throw new Error(`unexpected fetch: ${url}`);
    envelopeBodies.push(init?.body);
    return new Response('', { status: 200 });
  }) as typeof fetch;

  installDeps({
    valid: true,
    userId: TEST_USER_ID,
    ...(acceptedWithinClockTolerance ? { acceptedWithinClockTolerance: true } : {}),
  });

  const tasks: Array<Promise<unknown>> = [];
  const response = await handler(method === 'GET' ? makeGet() : makePost(), {
    waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); },
  });
  await Promise.allSettled(tasks);

  const sentryEvents = envelopeBodies.map((body) => {
    assert.equal(typeof body, 'string', 'Sentry envelope body must be serialized text');
    const payload = body.trim().split('\n')[2];
    assert.ok(payload, 'Sentry envelope must contain an event payload');
    return JSON.parse(payload) as SentryEvent;
  });
  return { response, sentryEvents };
}

function assertSingleDriftCapture(events: SentryEvent[], method: 'GET' | 'POST'): void {
  assert.equal(events.length, 1, `${method} auth drift must emit exactly one Sentry envelope`);
  assert.equal(events[0]?.level, 'warning');
  assert.equal(events[0]?.tags?.error_shape, 'convex_auth_drift');
  assert.equal(events[0]?.tags?.method, method);
}

describe('user-prefs acceptedWithinClockTolerance skip (#7140)', () => {
  it('GET: tolerance-accepted token skips drift capture', async () => {
    const warnMock = mock.method(console, 'warn', () => {});

    const { response: res, sentryEvents } = await runRequest('GET', true);

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(sentryEvents.length, 0, 'tolerance-accepted GET must not emit a Sentry envelope');
    assert.equal(warnMock.mock.calls.length, 1, 'only the tolerance-skip warning should fire');
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /expected near-expiry, not drift/);
  });

  it('GET: ordinary UNAUTHENTICATED (no tolerance flag) still captures as drift', async () => {
    const warnMock = mock.method(console, 'warn', () => {});

    const { response: res, sentryEvents } = await runRequest('GET', false);

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assertSingleDriftCapture(sentryEvents, 'GET');
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /convex auth drift/);
  });

  it('POST: tolerance-accepted token skips drift capture', async () => {
    const warnMock = mock.method(console, 'warn', () => {});

    const { response: res, sentryEvents } = await runRequest('POST', true);

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(sentryEvents.length, 0, 'tolerance-accepted POST must not emit a Sentry envelope');
    assert.equal(warnMock.mock.calls.length, 1, 'only the tolerance-skip warning should fire');
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /expected near-expiry, not drift/);
  });

  it('POST: ordinary UNAUTHENTICATED (no tolerance flag) still captures as drift', async () => {
    const warnMock = mock.method(console, 'warn', () => {});

    const { response: res, sentryEvents } = await runRequest('POST', false);

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assertSingleDriftCapture(sentryEvents, 'POST');
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /convex auth drift/);
  });
});
