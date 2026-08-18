/**
 * Unit tests for the fetch-failure host attribution decision
 * (`src/services/fetch-failure-attribution.ts`).
 *
 * #6746 / WORLDMONITOR-ZG. A bare `TypeError: Failed to fetch` reaches Sentry
 * with no host and no caller — every frame in the stack is a `window.fetch`
 * wrapper, so no stack-shape rule can attribute it. Appending the host makes it
 * route through the already-tested `THIRD_PARTY_FETCH_HOST_ALLOWLIST` in
 * `src/bootstrap/sentry-init.ts` instead.
 *
 * The pass-through cases matter as much as the annotation cases: this code sits
 * under every app fetch, so anything it touches by mistake is a regression in a
 * hot path.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { annotateFetchFailure } from '../src/services/fetch-failure-attribution.ts';

const ORIGIN = 'https://www.worldmonitor.app/dashboard';

let savedLocation: unknown;

beforeEach(() => {
  savedLocation = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).location = { href: ORIGIN };
});

afterEach(() => {
  if (savedLocation === undefined) delete (globalThis as Record<string, unknown>).location;
  else (globalThis as Record<string, unknown>).location = savedLocation;
});

/** The shape a browser actually throws for a failed fetch. */
function fetchFailure(message: string): TypeError {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at fetch (native)`;
  return error;
}

const messageOf = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

describe('annotateFetchFailure — annotation', () => {
  it('appends the host to a bare Chrome/Edge "Failed to fetch"', () => {
    const original = fetchFailure('Failed to fetch');
    const result = annotateFetchFailure(original, 'https://abacus.worldmonitor.app/api/send');
    assert.equal(messageOf(result), 'Failed to fetch (abacus.worldmonitor.app)');
  });

  it('annotates a first-party API failure too — the allowlist decides, not this module', () => {
    const original = fetchFailure('Failed to fetch');
    const result = annotateFetchFailure(original, 'https://api.worldmonitor.app/api/bootstrap');
    assert.equal(messageOf(result), 'Failed to fetch (api.worldmonitor.app)');
  });

  it('keeps the value a TypeError so beforeSend shape detectors still match', () => {
    const result = annotateFetchFailure(fetchFailure('Failed to fetch'), 'https://api.worldmonitor.app/x');
    // Assert the annotation actually happened first, or this passes on a no-op.
    assert.equal(messageOf(result), 'Failed to fetch (api.worldmonitor.app)');
    assert.ok(result instanceof TypeError, 'must stay a TypeError');
    assert.equal((result as Error).name, 'TypeError');
  });

  it('does NOT set `cause` — that would make the whole module inert (#6746 P0)', () => {
    // `linkedErrorsIntegration()` is a DEFAULT @sentry/browser integration and
    // runs in preprocessEvent, BEFORE beforeSend. It expands `.cause` into
    // `event.exception.values` with the original error LAST, so the BARE cause
    // lands at index 0 — and beforeSend reads values[0] (sentry-init.ts:353).
    // With `cause` set, the host suffix never reaches the allowlist and nothing
    // is ever suppressed. This assertion is the guard against re-adding it.
    const original = fetchFailure('Failed to fetch');
    const result = annotateFetchFailure(original, 'https://api.worldmonitor.app/x');
    assert.equal(
      (result as { cause?: unknown }).cause,
      undefined,
      'setting cause activates LinkedErrors and silently defeats host attribution',
    );
    // The original is still recoverable: same stack, and message minus the suffix.
    assert.equal((result as Error).stack, original.stack);
  });

  it('preserves the original stack rather than pointing at the wrapper', () => {
    const original = fetchFailure('Failed to fetch');
    const result = annotateFetchFailure(original, 'https://api.worldmonitor.app/x');
    // Must be a DIFFERENT object that nonetheless carries the original stack —
    // asserting the stack alone would pass on a no-op passthrough.
    assert.notEqual(result, original, 'annotation must produce a new error');
    assert.equal((result as Error).stack, original.stack);
  });

  it('annotates the Firefox phrasing WITHOUT a trailing period', () => {
    // The module admits `resource\.?`. sentry-init.ts's host detector originally
    // required the period literally, so this variant was annotated and then
    // never routed to the allowlist — annotated but unsuppressable. Both sides
    // now accept the optional period; this pins the tolerant half.
    const original = fetchFailure('NetworkError when attempting to fetch resource');
    const result = annotateFetchFailure(original, 'https://data.debugbear.com/beacon');
    assert.equal(
      messageOf(result),
      'NetworkError when attempting to fetch resource (data.debugbear.com)',
    );
  });

  it('annotates the Firefox phrasing, keeping its trailing period', () => {
    const original = fetchFailure('NetworkError when attempting to fetch resource.');
    const result = annotateFetchFailure(original, 'https://data.debugbear.com/beacon');
    assert.equal(
      messageOf(result),
      'NetworkError when attempting to fetch resource. (data.debugbear.com)',
    );
  });

  it('annotates the Safari phrasing (inert today — see KTD5)', () => {
    // `sentry-init.ts` ignoreErrors carries /^TypeError: Load failed( \(.*\))?$/,
    // which already drops BOTH the bare and the host-suffixed form. Annotating
    // changes no verdict today; it is done for consistency and so the value is
    // already correct if that entry is ever narrowed.
    const original = fetchFailure('Load failed');
    const result = annotateFetchFailure(original, 'https://api.worldmonitor.app/x');
    assert.equal(messageOf(result), 'Load failed (api.worldmonitor.app)');
  });

  it('resolves a relative URL against location before naming the host', () => {
    const result = annotateFetchFailure(fetchFailure('Failed to fetch'), '/api/bootstrap');
    assert.equal(messageOf(result), 'Failed to fetch (www.worldmonitor.app)');
  });

  it('reads the URL from a Request input', () => {
    const request = new Request('https://api.worldmonitor.app/api/bootstrap');
    const result = annotateFetchFailure(fetchFailure('Failed to fetch'), request);
    assert.equal(messageOf(result), 'Failed to fetch (api.worldmonitor.app)');
  });

  it('reads the URL from a URL input', () => {
    const result = annotateFetchFailure(
      fetchFailure('Failed to fetch'),
      new URL('https://tiles.openfreemap.org/style.json'),
    );
    assert.equal(messageOf(result), 'Failed to fetch (tiles.openfreemap.org)');
  });
});

describe('annotateFetchFailure — pass-through', () => {
  it('never double-annotates a message the browser already host-suffixed', () => {
    const original = fetchFailure('Failed to fetch (api.worldmonitor.app)');
    const result = annotateFetchFailure(original, 'https://api.worldmonitor.app/x');
    assert.equal(result, original, 'must be the same object, untouched');
  });

  // The next two isolate the abort guard on purpose. An ordinary AbortError
  // ("The operation was aborted.") and an ordinary plain-object reason are both
  // already rejected by the message/instanceof checks further down, so testing
  // with those passes even when the abort guard is deleted — mutation-verified.
  // Each case below therefore uses a value that WOULD otherwise be annotated,
  // leaving the abort guard as the only thing that can produce the pass.

  it('leaves an AbortError alone even when its message looks like a fetch failure', () => {
    const abort = new Error('Failed to fetch');
    abort.name = 'AbortError';
    const result = annotateFetchFailure(abort, 'https://api.worldmonitor.app/x');
    assert.equal(result, abort, 'an abort must never be rewritten');
  });

  it('returns a caller abort reason identity-equal (the #6086/#6288 contract)', () => {
    // A caller may abort with ANY value, including a fetch-failure-shaped Error.
    // The contract asserted at tests/analytics-beacon-rejection.test.mts:946,1110
    // is `error === reason`, so this must come back as the very same object.
    const reason = new TypeError('Failed to fetch');
    const controller = new AbortController();
    controller.abort(reason);
    const result = annotateFetchFailure(reason, 'https://api.worldmonitor.app/x', {
      signal: controller.signal,
    });
    assert.equal(result, reason, 'the caller must get its own reason object back');
  });

  it('honours an aborted signal carried on a Request input', () => {
    const controller = new AbortController();
    const reason = new TypeError('Failed to fetch');
    controller.abort(reason);
    const request = new Request('https://api.worldmonitor.app/x', { signal: controller.signal });
    assert.equal(annotateFetchFailure(reason, request), reason);
  });

  it('leaves a non-fetch TypeError alone', () => {
    const other = new TypeError('x.toLowerCase is not a function');
    const result = annotateFetchFailure(other, 'https://api.worldmonitor.app/x');
    assert.equal(result, other);
  });

  it('leaves a partial-match message alone', () => {
    // Anchored matching only — a message that merely CONTAINS the phrase is not
    // the engine-emitted failure and must not be rewritten.
    const other = new TypeError('Failed to fetch the widget catalogue');
    const result = annotateFetchFailure(other, 'https://api.worldmonitor.app/x');
    assert.equal(result, other);
  });

  it('leaves the error alone when the URL cannot be resolved', () => {
    const original = fetchFailure('Failed to fetch');
    const result = annotateFetchFailure(original, '');
    assert.equal(result, original);
  });

  it('leaves a non-Error rejection alone', () => {
    const result = annotateFetchFailure('just a string', 'https://api.worldmonitor.app/x');
    assert.equal(result, 'just a string');
  });

  it('leaves an Error-LOOKALIKE alone even when its message is a fetch phrasing', () => {
    // A string rejection passes the message check anyway, so it does not
    // isolate the `instanceof Error` guard — mutation-verified. A duck-typed
    // object does: without the guard it would be rewritten into a TypeError,
    // silently replacing whatever value the caller actually rejected with.
    const lookalike = { message: 'Failed to fetch', name: 'TypeError' };
    const result = annotateFetchFailure(lookalike, 'https://api.worldmonitor.app/x');
    assert.equal(result, lookalike, 'a non-Error must be returned untouched');
  });

  it('does not throw when location is absent (SSR / worker context)', () => {
    delete (globalThis as Record<string, unknown>).location;
    const original = fetchFailure('Failed to fetch');
    // A relative URL has no resolvable host without a location — pass through.
    assert.doesNotThrow(() => annotateFetchFailure(original, '/api/bootstrap'));
    // An absolute URL still resolves.
    assert.equal(
      messageOf(annotateFetchFailure(original, 'https://api.worldmonitor.app/x')),
      'Failed to fetch (api.worldmonitor.app)',
    );
  });
});
