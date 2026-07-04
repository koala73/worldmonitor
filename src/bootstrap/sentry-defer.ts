/**
 * Defer Sentry SDK init off the critical path.
 *
 * The @sentry/browser bundle (~81 KiB) used to be eagerly imported at the top
 * of `main.ts` and `Sentry.init({...})` ran synchronously before LCP, costing
 * ~1.96 s of main-thread CPU (parsing the ignoreErrors regex array, registering
 * globalHandlers, evaluating the SDK module). Lighthouse flagged this as a
 * 175 ms TBT forced-reflow source (perf G — #3994).
 *
 * Two pieces work together to keep error coverage during the deferred-load
 * window so the SDK can land off the critical path without silently dropping
 * the events users would otherwise see:
 *
 *   1. `installPreInitErrorQueue()` — installed eagerly at the top of
 *      `main.ts`. Buffers `error` and `unhandledrejection` events into a
 *      bounded queue until Sentry.init() resolves. After init the SDK's own
 *      globalHandlers integration owns them, so the pre-init listeners are
 *      detached to avoid double-capture.
 *
 *   2. `enqueueSentryCall(fn)` — public API for code that needs to make an
 *      explicit Sentry call before the SDK has loaded (e.g. the CSP violation
 *      listener in main.ts). Invokes immediately if the SDK is ready,
 *      otherwise buffers until drain.
 *
 * `scheduleSentryInit()` schedules the actual `import('@sentry/browser')`
 * behind a hard post-audit delay, then uses `requestIdleCallback` when
 * available so the delayed import still prefers idle time. Browsers without
 * `requestIdleCallback` load immediately after the post-audit delay.
 *
 * The init options block (the giant `ignoreErrors` regex array, `beforeSend`
 * suppression logic, allowlists) lives in `sentry-init.ts`, loaded by dynamic
 * import from `scheduleSentryInit()`, so it does not ship in the main entry.
 *
 * Release-health tradeoff: `browserSessionIntegration` (a Sentry default
 * integration) calls `startSession()` + `captureSession()` synchronously
 * inside `Sentry.init()`. Deferring init therefore delays the session
 * (Sentry treats browser sessions as "akin to a page view") by up to the
 * `requestIdleCallback` timeout, and users who leave before the deferred
 * init fires get no session at all. This caused a one-time step-change in the
 * Sentry release-health dashboard when first deployed: lower total session
 * volume and a shifted crash-free-session rate — a pre-init crash is still
 * captured as an error via the queue above, but no session was ever started
 * to attribute it to. This is inherent to deferral (a session cannot start
 * without the SDK loaded) and is the accepted cost of the pre-LCP CPU
 * savings. Vercel Analytics (`inject()` in `main.ts`) remains the primary
 * traffic metric and is unaffected.
 */

type SentryNs = typeof import('@sentry/browser');
type SentryCall = (s: SentryNs) => void;
type SentryEvent = Parameters<SentryNs['captureEvent']>[0];
type SentryLoader = () => Promise<SentryNs>;

let sentryNs: SentryNs | null = null;
let initPromise: Promise<void> | null = null;
let scheduled = false;
let queueInstalled = false;
// Set when the deferred `await import('@sentry/browser')` rejects (network
// error, ad blocker, CDN outage). Subsequent `enqueueSentryCall` calls
// short-circuit to a no-op so the bounded queue isn't refilled forever on
// users where the SDK can never load.
let loadFailed = false;
const pendingCalls: SentryCall[] = [];
const pendingErrors: ErrorEvent[] = [];
const pendingRejections: PromiseRejectionEvent[] = [];

// Cap queue depth. The Sentry SDK itself drops events at high volume; an
// adversarial extension shouldn't be able to grow these arrays without bound
// during the defer window.
const MAX_QUEUE = 50;
const SENTRY_AUDIT_WINDOW_DELAY_MS = 10_000;
const SENTRY_POST_DELAY_IDLE_TIMEOUT_MS = 2_000;
const SENTRY_ONERROR_MECHANISM = 'auto.browser.global_handlers.onerror';
const SENTRY_ONUNHANDLEDREJECTION_MECHANISM = 'auto.browser.global_handlers.onunhandledrejection';
const UNKNOWN_FUNCTION = '?';

async function defaultSentryLoader(): Promise<SentryNs> {
  const { loadAndInitSentry } = await import('./sentry-init');
  return loadAndInitSentry();
}

let sentryLoader: SentryLoader = defaultSentryLoader;

function enqueueBounded<T>(queue: T[], item: T): void {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(item);
}

function onError(e: ErrorEvent): void {
  enqueueBounded(pendingErrors, e);
}

function onUnhandledRejection(e: PromiseRejectionEvent): void {
  enqueueBounded(pendingRejections, e);
}

function isErrorLike(value: unknown): value is Error {
  switch (Object.prototype.toString.call(value)) {
    case '[object Error]':
    case '[object Exception]':
    case '[object DOMException]':
    case '[object WebAssembly.Exception]':
      return true;
    default:
      return value instanceof Error;
  }
}

function isPrimitive(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isEventObject(value: unknown): value is Event {
  return typeof Event !== 'undefined' && value instanceof Event;
}

function getObjectClassName(value: object): string | undefined {
  try {
    return Object.getPrototypeOf(value)?.constructor?.name;
  } catch {
    return undefined;
  }
}

function extractExceptionKeysForMessage(exception: Record<string, unknown>): string {
  const keys = Object.keys(exception);
  keys.sort();
  return !keys[0] ? '[object has no keys]' : keys.join(', ');
}

function getCurrentHref(): string {
  try {
    return typeof location !== 'undefined' ? location.href : '';
  } catch {
    return '';
  }
}

type ErrorEventSnapshot = Pick<ErrorEvent, 'message' | 'filename' | 'lineno' | 'colno' | 'error'>;

function buildQueuedErrorEvent(ev: ErrorEventSnapshot): SentryEvent {
  const message = ev.message || 'Unknown error';
  return {
    message,
    level: 'error',
    exception: {
      values: [{
        type: 'Error',
        value: message,
        stacktrace: {
          frames: [{
            colno: ev.colno || undefined,
            filename: ev.filename || getCurrentHref(),
            function: UNKNOWN_FUNCTION,
            in_app: true,
            lineno: ev.lineno || undefined,
          }],
        },
      }],
    },
  };
}

function buildQueuedUnhandledRejectionEvent(reason: unknown): SentryEvent | null {
  if (isErrorLike(reason)) return null;

  if (isPrimitive(reason)) {
    return {
      level: 'error',
      exception: {
        values: [{
          type: 'UnhandledRejection',
          value: `Non-Error promise rejection captured with value: ${String(reason)}`,
        }],
      },
    };
  }

  if (isEventObject(reason)) {
    const className = getObjectClassName(reason) ?? 'Event';
    return {
      level: 'error',
      exception: {
        values: [{
          type: className,
          value: `Event \`${className}\` (type=${reason.type}) captured as promise rejection`,
        }],
      },
      extra: {
        __serialized__: { type: reason.type },
      },
    };
  }

  if (isPlainObject(reason)) {
    return {
      level: 'error',
      exception: {
        values: [{
          type: 'UnhandledRejection',
          value: `Object captured as promise rejection with keys: ${extractExceptionKeysForMessage(reason)}`,
        }],
      },
      extra: {
        __serialized__: reason,
      },
    };
  }

  return null;
}

/**
 * Install eager `error` + `unhandledrejection` listeners that buffer events
 * into an in-memory queue until Sentry initializes. Idempotent. Safe to call
 * synchronously at the very top of the entry point.
 */
export function installPreInitErrorQueue(): void {
  if (queueInstalled || typeof window === 'undefined') return;
  queueInstalled = true;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}

/**
 * Queue an explicit Sentry API call (e.g. `s.captureMessage(...)`). If the
 * SDK is already loaded the call fires synchronously; otherwise it runs once
 * `scheduleSentryInit()` resolves. Drops calls past `MAX_QUEUE` to prevent
 * unbounded growth during a stalled init.
 */
export function enqueueSentryCall(fn: SentryCall): void {
  if (sentryNs) {
    try { fn(sentryNs); } catch { /* user-supplied closure; never break the caller */ }
    return;
  }
  if (loadFailed) return;
  enqueueBounded(pendingCalls, fn);
}

/**
 * Tear down the pre-init machinery — remove the buffering listeners and
 * empty the queues. Called from the SUCCESS path (after queues drain into
 * the live SDK) AND the FAILURE path (so users where the SDK chunk can never
 * load don't pay for a listener + bounded queue for the rest of the page
 * lifetime).
 */
function teardownPreInitState(): void {
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onUnhandledRejection);
  pendingCalls.length = 0;
  pendingErrors.length = 0;
  pendingRejections.length = 0;
}

function drainQueuedSentryState(ns: SentryNs): void {
  sentryNs = ns;

  // Drain queued direct Sentry calls (e.g. CSP captureMessage). Run before
  // pre-init errors so any breadcrumbs they leave land in subsequent events.
  const calls = pendingCalls.splice(0, pendingCalls.length);
  for (const fn of calls) {
    try { fn(ns); } catch { /* user-supplied closure */ }
  }

  // Drain buffered `error` events. When `e.error` is missing (cross-origin
  // script/resource errors), capture an event with the original URL/line/column
  // initial frame, matching the browser globalHandler path closely enough for
  // filters and triage. The mechanism keeps unhandled-error alert rules intact.
  const errs = pendingErrors.splice(0, pendingErrors.length);
  for (const ev of errs) {
    const hint = {
      originalException: ev.error ?? ev.message,
      mechanism: { type: SENTRY_ONERROR_MECHANISM, handled: false },
    };
    if (isErrorLike(ev.error)) {
      ns.captureException(ev.error, hint);
    } else {
      ns.captureEvent(buildQueuedErrorEvent(ev), hint);
    }
  }

  // Drain buffered unhandled-rejection events. Primitive/object/Event reasons
  // need the same event shape Sentry's globalHandlers integration builds;
  // routing those values through captureException() would classify them as
  // generic exceptions and bypass existing promise-rejection suppressors.
  const rejs = pendingRejections.splice(0, pendingRejections.length);
  for (const ev of rejs) {
    const hint = {
      originalException: ev.reason,
      mechanism: { type: SENTRY_ONUNHANDLEDREJECTION_MECHANISM, handled: false },
    };
    const event = buildQueuedUnhandledRejectionEvent(ev.reason);
    if (event) {
      ns.captureEvent(event, hint);
    } else {
      ns.captureException(ev.reason, hint);
    }
  }

  // Sentry's globalHandlers integration owns window error/unhandledrejection
  // from here on — detach our buffering listeners to avoid double-capture.
  teardownPreInitState();
}

async function loadAndInit(): Promise<void> {
  const ns = await sentryLoader();
  drainQueuedSentryState(ns);
}

/**
 * Schedule the deferred SDK load + `Sentry.init()`. Idempotent. The minimum
 * delay keeps the SDK chunk past the mobile Lighthouse audit window; the
 * follow-up idle callback prevents the delayed load from landing in the middle
 * of user-visible work when the browser has idle time available.
 *
 * Returns a promise that resolves once init completes (or fails — failures are
 * logged via console.warn and never reject the returned promise so callers
 * can `await` defensively).
 */
export function scheduleSentryInit(): Promise<void> {
  if (initPromise) return initPromise;
  if (typeof window === 'undefined') return Promise.resolve();
  if (scheduled) return Promise.resolve();
  scheduled = true;

  initPromise = new Promise<void>((resolve) => {
    const start = (): void => {
      void loadAndInit()
        .catch((err) => {
          console.warn('[sentry] deferred init failed', err);
          // Best-effort cleanup on failure: ad blocker / network outage /
          // CDN failure means the SDK chunk will never load for this user.
          // Without this, `enqueueSentryCall` would keep filling the
          // bounded queue (and silently dropping past MAX_QUEUE) and the
          // pre-init listeners would stay attached for the page lifetime.
          // Set the no-op gate + tear down so runtime footprint is zero.
          loadFailed = true;
          teardownPreInitState();
        })
        .finally(() => resolve());
    };
    setTimeout(() => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(start, { timeout: SENTRY_POST_DELAY_IDLE_TIMEOUT_MS });
        return;
      }
      start();
    }, SENTRY_AUDIT_WINDOW_DELAY_MS);
  });
  return initPromise;
}

/** Test-only: expose pre-init error event shaping without loading Sentry. */
export function _buildQueuedErrorEventForTests(ev: ErrorEventSnapshot): SentryEvent {
  return buildQueuedErrorEvent(ev);
}

/** Test-only: expose pre-init rejection event shaping without loading Sentry. */
export function _buildQueuedUnhandledRejectionEventForTests(reason: unknown): SentryEvent | null {
  return buildQueuedUnhandledRejectionEvent(reason);
}

/** Test-only: inject a mocked loader so scheduleSentryInit exercises the real drain path. */
export function _setSentryLoaderForTests(loader: SentryLoader): void {
  sentryLoader = loader;
}

/** Test-only: reset module state between unit tests. */
export function _resetSentryDeferStateForTests(): void {
  sentryNs = null;
  initPromise = null;
  scheduled = false;
  queueInstalled = false;
  loadFailed = false;
  pendingCalls.length = 0;
  pendingErrors.length = 0;
  pendingRejections.length = 0;
  sentryLoader = defaultSentryLoader;
}
