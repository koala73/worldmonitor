import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * #6947 — WORLDMONITOR-YD (`queue-overflow`) survived the #6288 latch fix at
 * its pre-fix rate: 28 post-fix events across 18 builds, 100% with a
 * writeCount BELOW the 50-deep queue bound, 54% reporting a single write in
 * the whole 60 s window. A window recording one write cannot have filled the
 * queue — it was full when the window opened and never drained.
 *
 * The residual mechanism is none of the deadline candidates: it is the
 * #6968 visibility hold. `drainCollectorRequestQueue` returns while the page
 * is inactive, so a page that is hidden from install (session restore,
 * prerender, a background-opened tab) NEVER dispatches anything — the
 * consent-flush burst fills the queue with nothing in flight, and every
 * later throttled-timer write rejects as queue-overflow until the tab is
 * focused or unloaded. #6288's module-owned deadline releases a parked
 * TRANSPORT; here no transport ever ran, so the fix could not move this
 * population — exactly the flat pre/post rate the issue measured.
 *
 * That hold is deliberate (#6968: WebKit freezes hidden fetches), so the fix
 * follows the `raced` precedent: mark overflow rejections that happen while
 * the page is inactive with `hiddenHold`, give them their own Sentry
 * fingerprint, and keep today's signature for a genuinely parked visible
 * page — the incident WORLDMONITOR-YD exists to page on.
 */

const UMAMI_SEND_URL = 'https://abacus.worldmonitor.app/api/send';

type WindowLifecycleHandler = (event?: { persisted?: boolean }) => void;

const windowListeners: Record<string, WindowLifecycleHandler[]> = {};
const documentListeners: Record<string, Array<() => void>> = {};
let visibilityState: DocumentVisibilityState = 'visible';
let underlyingFetch: typeof fetch = () => Promise.reject(new TypeError('no fetch stub installed'));

before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => underlyingFetch(input, init),
      addEventListener: (type: string, handler: WindowLifecycleHandler) => {
        (windowListeners[type] ??= []).push(handler);
      },
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return visibilityState; },
      addEventListener: (type: string, handler: () => void) => {
        (documentListeners[type] ??= []).push(handler);
      },
      removeEventListener: () => {},
    },
  });
});

const {
  COLLECTOR_QUEUE_LIMIT,
  configureCollectorTransport,
  installCollectorFetchGate,
  resetCollectorTransportForTesting,
  _setCollectorOutcomeObserverForTesting,
  _setCollectorSentryEnqueueForTesting,
  _setCollectorHealthReporterForTesting,
} = await import('../src/services/analytics-collector-transport.ts');

type CapturedSentryEvent = { message: string; context: Record<string, unknown> };

function collectorEventInit(): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({ type: 'event', payload: { name: 'search-open' } }),
  };
}

function collectorResponse(): Response {
  const body = JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' });
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => body,
    clone: () => collectorResponse(),
  } as Response;
}

function setUpTransport(initialVisibility: DocumentVisibilityState): {
  outcomes: Array<{ kind: string; hiddenHold: boolean | undefined }>;
  sentryEvents: CapturedSentryEvent[];
  dispatches: number[];
} {
  visibilityState = initialVisibility;
  const outcomes: Array<{ kind: string; hiddenHold: boolean | undefined }> = [];
  const sentryEvents: CapturedSentryEvent[] = [];
  const dispatches: number[] = [];

  configureCollectorTransport({
    endpoint: UMAMI_SEND_URL,
    isCriticalEvent: () => false,
    onOutcome: (outcome) => {
      if (outcome.failure) {
        outcomes.push({
          kind: outcome.failure.kind,
          hiddenHold: (outcome.failure as { hiddenHold?: boolean }).hiddenHold,
        });
      }
    },
  });
  _setCollectorOutcomeObserverForTesting(null);
  _setCollectorHealthReporterForTesting(() => {});
  _setCollectorSentryEnqueueForTesting((enqueue) => {
    enqueue({
      captureMessage: (message: string, context: Record<string, unknown>) => {
        sentryEvents.push({ message, context });
      },
    } as never);
  });
  underlyingFetch = (() => {
    dispatches.push(Date.now());
    return Promise.resolve(collectorResponse());
  }) as typeof fetch;
  assert.ok(installCollectorFetchGate(), 'gate must install against the stub window');
  return { outcomes, sentryEvents, dispatches };
}

/** Enqueue one collector write through the gate, consuming its rejections. */
function issueWrite(): Promise<Response> {
  const transport = (globalThis.window as { fetch: typeof fetch }).fetch(
    UMAMI_SEND_URL,
    collectorEventInit(),
  ) as Promise<Response>;
  transport.catch(() => {});
  return transport;
}

function fireVisibilityChange(): void {
  for (const handler of documentListeners.visibilitychange ?? []) handler();
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('queue-overflow on an inactive page carries the hiddenHold marker (#6947)', { concurrency: false }, () => {
  beforeEach(() => {
    resetCollectorTransportForTesting();
    for (const key of Object.keys(windowListeners)) delete windowListeners[key];
    for (const key of Object.keys(documentListeners)) delete documentListeners[key];
  });

  afterEach(() => {
    resetCollectorTransportForTesting();
  });

  it('a page hidden from install fills the queue with NOTHING in flight, and its overflows are marked hiddenHold', async () => {
    const { outcomes, sentryEvents, dispatches } = setUpTransport('hidden');

    // The consent-flush burst: fill the queue, then keep writing — the shape
    // the issue measured (writeCount==1 windows are the later throttled
    // timer writes, each rejected at a queue that was full before the
    // window opened).
    for (let i = 0; i < COLLECTOR_QUEUE_LIMIT + 3; i++) issueWrite();
    await drainMicrotasks();

    assert.equal(
      dispatches.length, 0,
      'nothing may dispatch while the page is hidden (#6968) — which is why no deadline fix can drain this queue',
    );
    const overflows = outcomes.filter((o) => o.kind === 'queue-overflow');
    assert.equal(overflows.length, 3, 'each write beyond the bound rejects exactly one entry');
    for (const overflow of overflows) {
      assert.equal(
        overflow.hiddenHold, true,
        'an overflow while the page is inactive is the designed visibility hold, not a parked transport, and must say so',
      );
    }

    assert.ok(sentryEvents.length >= 1, 'the overflow population stays observable');
    for (const event of sentryEvents) {
      const fingerprint = (event.context.fingerprint ?? []) as string[];
      const tags = (event.context.tags ?? {}) as Record<string, string>;
      assert.ok(
        fingerprint.includes('hidden-hold'),
        `hidden-hold overflow must group apart from the parked-latch incident; fingerprint=${JSON.stringify(fingerprint)}`,
      );
      assert.equal(tags.hiddenHold, 'true');
      assert.equal(tags.pageVisibility, 'hidden');
    }
  });

  it('becoming visible drains the held queue — the recovery door stays open', async () => {
    const { dispatches } = setUpTransport('hidden');
    for (let i = 0; i < 5; i++) issueWrite();
    await drainMicrotasks();
    assert.equal(dispatches.length, 0);

    visibilityState = 'visible';
    fireVisibilityChange();
    await drainMicrotasks();

    assert.ok(
      dispatches.length >= 1,
      'the first visibilitychange to visible must start pumping the held queue',
    );
  });

  it('a genuinely parked VISIBLE page keeps the unmarked signature WORLDMONITOR-YD pages on', async () => {
    const { outcomes, sentryEvents, dispatches } = setUpTransport('visible');
    // The first dispatch parks forever — the true #6288-class incident.
    underlyingFetch = (() => {
      dispatches.push(Date.now());
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    for (let i = 0; i < COLLECTOR_QUEUE_LIMIT + 2; i++) issueWrite();
    await drainMicrotasks();

    assert.equal(dispatches.length, 1, 'the parked transport holds the single in-flight slot');
    const overflows = outcomes.filter((o) => o.kind === 'queue-overflow');
    assert.ok(overflows.length >= 1);
    for (const overflow of overflows) {
      assert.notEqual(overflow.hiddenHold, true, 'a visible parked page is the real incident and must not be reclassified');
    }
    for (const event of sentryEvents) {
      const fingerprint = (event.context.fingerprint ?? []) as string[];
      assert.ok(!fingerprint.includes('hidden-hold'));
    }
  });
});
