/**
 * Names the host a failed `fetch` was trying to reach.
 *
 * ## Why this exists
 *
 * A browser fetch failure arrives as a bare `TypeError: Failed to fetch` — no
 * host, no request context. WORLDMONITOR-ZG proved that is unattributable in
 * principle, not just in practice: all 17 of its events carried an identical
 * stack in which EVERY frame is a `window.fetch` wrapper —
 *
 *   DebugBear RUM wrapper -> wmSessionFetch -> runtime dispatch -> native fetch
 *
 * — because the rejection originates inside native `fetch` and the async
 * boundary drops the calling frame. The application caller is never present, so
 * no stack-shape rule can ever tell an analytics-beacon blip apart from an
 * `api.worldmonitor.app` outage. Six rounds of Vite-chunk-name heuristics tried
 * and each broke on the next repartition (#6746).
 *
 * `sentry-init.ts` already routes the HOST-SUFFIXED form correctly:
 * `Failed to fetch (abacus.worldmonitor.app)` is suppressed by
 * `THIRD_PARTY_FETCH_HOST_ALLOWLIST` while `Failed to fetch
 * (api.worldmonitor.app)` surfaces. Chrome and Edge emit that suffix only
 * opportunistically. This module stops depending on the browser for it.
 *
 * ## Why it installs FIRST, not last
 *
 * `installFetchFailureAttribution()` must run before every other first-party
 * `window.fetch` wrapper, so it wraps native `fetch` directly and sits at the
 * BOTTOM of the chain. Three reasons, and the first is the load-bearing one:
 *
 *  1. Coverage is then automatic. Every outer wrapper delegates downward, so
 *     the bottom wrapper sees every request that reaches the network. An
 *     OUTERMOST wrapper would be bypassed by `wmSessionFetch`'s early returns
 *     (non-API targets, credential-less public data, premium paths), which is
 *     exactly the traffic — the Umami beacon — that needs attributing.
 *  2. "First" is enforceable; "last" is not. `analytics.ts` installs the
 *     collector gate lazily from three call sites and the DebugBear script
 *     installs whenever its CDN responds.
 *  3. The host is more accurate. `installWebApiRedirect` rewrites `/api/...` to
 *     `https://api.worldmonitor.app/...`; annotating below that names the host
 *     actually contacted.
 *
 * `tests/fetch-attribution-install-order.test.mts` fails if that ordering is
 * ever broken.
 *
 * ## What it must never touch
 *
 * This code sits under every app fetch, so a mistake here is a hot-path
 * regression. It rewrites ONLY an anchored, engine-emitted fetch-failure
 * message, and never an abort — a caller's abort reason must come back
 * identity-equal, a contract the #6086 / #6288 suites assert with
 * `error === reason`.
 */

/**
 * The engine-emitted phrasings for "the network request did not complete",
 * anchored so a message that merely CONTAINS one is left alone.
 *
 * Kept consistent with the shapes `src/bootstrap/sentry-init.ts` already
 * matches: Chrome/Edge `Failed to fetch`, Firefox `NetworkError when attempting
 * to fetch resource.` (the trailing period is engine-emitted and preserved),
 * Safari `Load failed`.
 *
 * NOTE on Safari: `sentry-init.ts` carries
 * `/^TypeError: Load failed( \(.*\))?$/` in `ignoreErrors`, whose optional
 * parenthetical means BOTH the bare and the annotated form are dropped before
 * `beforeSend` runs. Annotating `Load failed` therefore changes no verdict
 * today — it is done for consistency, and so the value is already right if that
 * entry is ever narrowed. WorldMonitor is consequently blind to Safari-side
 * origin failures; that is pre-existing and out of scope here (#6746 KTD5).
 */
const FETCH_FAILURE_MESSAGE =
  /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/;

// NOTE: there is deliberately no separate "already host-suffixed" guard. The
// anchored `^...$` above already rejects `Failed to fetch (some.host)`, so a
// second annotation pass is impossible and an explicit guard would be dead code
// whose test could never fail. Mutation-checked: unanchoring the regex above
// breaks the double-annotation test, which is what proves the anchoring is the
// load-bearing part.

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

/**
 * Host for `input`, or null when it cannot be resolved.
 *
 * A relative URL needs `location`; without one (worker/SSR) there is no honest
 * answer, so the caller passes the error through unchanged rather than guessing
 * a host it might attribute to the wrong party.
 */
function hostOf(input: RequestInfo | URL): string | null {
  const raw = urlOf(input);
  if (!raw) return null;
  const base = typeof location === 'undefined' ? undefined : location.href;
  try {
    return new URL(raw, base).hostname || null;
  } catch {
    return null;
  }
}

function isAbort(error: unknown, init?: RequestInit, input?: RequestInfo | URL): boolean {
  const signal = init?.signal
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
  // An aborted signal means the caller cancelled. Whatever it rejected with —
  // including an arbitrary caller-supplied reason object — comes back untouched.
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Return the error to rethrow for a failed fetch: host-annotated when the
 * message is an engine-emitted fetch failure, otherwise the original value.
 *
 * Pure — safe to call from anywhere and to test without a DOM.
 */
export function annotateFetchFailure(
  error: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): unknown {
  if (isAbort(error, init, input)) return error;
  if (!(error instanceof Error)) return error;
  if (!FETCH_FAILURE_MESSAGE.test(error.message)) return error;

  const host = hostOf(input);
  if (!host) return error;

  // A TypeError specifically: `beforeSend`'s shape detectors key on
  // `excType === 'TypeError'`, and a subclass would change the reported type.
  const annotated = new TypeError(`${error.message} (${host})`);
  // Keep the original frames. Sentry groups on the stack, and our wrapper frame
  // carries no information the original did not already have.
  if (error.stack) annotated.stack = error.stack;

  // DELIBERATELY NOT `cause`. Setting `annotated.cause = error` makes this whole
  // module inert, and the failure is silent:
  //
  //   1. `linkedErrorsIntegration()` is a DEFAULT @sentry/browser integration
  //      (build/npm/cjs/prod/sdk.js:32) and sentry-init.ts does not disable
  //      defaults, so it runs in `preprocessEvent` — BEFORE `beforeSend`.
  //   2. It walks `.cause` and expands the chain into `event.exception.values`,
  //      placing the original error LAST (@sentry/core aggregate-errors.js:20:
  //      "the last item in event.exception.values is the exception originating
  //      from the original Error"). The bare cause therefore lands at index 0.
  //   3. `beforeSend` reads `event.exception?.values?.[0]?.value`
  //      (sentry-init.ts:353) — i.e. the BARE message. The host suffix never
  //      reaches THIRD_PARTY_FETCH_HOST_ALLOWLIST and nothing is suppressed.
  //
  // Nothing is lost by omitting it: the original `stack` is copied above, and
  // the original `message` is the annotated one minus the ` (<host>)` suffix.
  // Re-adding `cause` silently reverts #6746 — every single-value test fixture
  // still passes, which is exactly how this shipped once already. The
  // two-value regression test in tests/sentry-beforesend.test.mjs is what
  // catches it.
  return annotated;
}

let installedWrapper: typeof globalThis.fetch | null = null;
let preWrapFetch: typeof globalThis.fetch | null = null;

/**
 * Wrap `window.fetch` once so every failure that reaches the network is
 * attributed. Idempotent; returns whether the gate is installed.
 */
export function installFetchFailureAttribution(): boolean {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false;
  if (installedWrapper) return true;

  // AGENTS.md bans `fetch.bind(globalThis)` (it freezes a stale reference), and
  // the prescribed `(...args) => globalThis.fetch(...)` would recurse into the
  // wrapper we are about to install. A plain assignment captures the
  // pre-wrapping value correctly — same reasoning as `wm-session.ts`.
  const original = window.fetch;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await original(input, init);
    } catch (error) {
      throw annotateFetchFailure(error, input, init);
    }
  }) as typeof window.fetch;

  try {
    window.fetch = wrapped;
  } catch {
    return false;
  }
  installedWrapper = wrapped;
  preWrapFetch = original;
  return true;
}

/**
 * Test seam — restores the pre-wrapping `fetch` and clears the install latch.
 *
 * The restore is guarded on `window.fetch` still being OUR wrapper: if some
 * other instrumentation wrapped us afterwards, putting the original back would
 * tear that wrapper's delegate out from under it. In that case we clear the
 * latch only, exactly as `analytics-collector-transport.ts` does.
 */
export function resetFetchFailureAttributionForTesting(): void {
  if (
    typeof window !== 'undefined'
    && installedWrapper
    && preWrapFetch
    && window.fetch === installedWrapper
  ) {
    try {
      window.fetch = preWrapFetch;
    } catch {
      // Some harnesses expose a non-writable fetch property.
    }
  }
  installedWrapper = null;
  preWrapFetch = null;
}
