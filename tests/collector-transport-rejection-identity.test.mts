import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * WORLDMONITOR-Z6 / ZG (#6746).
 *
 * The Umami tracker is third-party code that does not handle its own rejection,
 * so a failed beacon POST used to surface as an unhandled bare
 * `TypeError: Failed to fetch` — no host in the message, no caller in the stack.
 * Sentry could not separate it from a genuine api.worldmonitor.app outage, and
 * five rounds of chunk-name heuristics that tried to do it from the stack each
 * broke on the next Vite re-partition.
 *
 * The fix gives the rejection an identity at its source. These tests pin the
 * three properties that make that identity load-bearing:
 *
 *   1. The tracker-facing rejection carries the marker.
 *   2. The shipped Sentry filter actually matches that marker.
 *   3. Naming it did not corrupt the failure classification the health cohorts
 *      and the retry policy read.
 */

const _store = new Map<string, string>();
before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => _store.get(k) ?? null,
        setItem: (k: string, v: string) => { _store.set(k, v); },
        removeItem: (k: string) => { _store.delete(k); },
      },
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    },
  });
});

const {
  CollectorTransportError,
  CollectorDeliveryError,
  collectorFailureFromError,
  configureCollectorTransport,
  installCollectorFetchGate,
  resetCollectorTransportForTesting,
} = await import('../src/services/analytics-collector-transport.ts');

const COLLECTOR_ENDPOINT = 'https://abacus.worldmonitor.app/api/send';

/** Same shape the module builds for its own latch deadline. */
function timeoutError(raced: boolean): Error {
  const error = new Error('collector deadline elapsed');
  error.name = 'TimeoutError';
  (error as Error & { collectorLatchRaced?: boolean }).collectorLatchRaced = raced;
  return error;
}

describe('collector transport rejection identity (WORLDMONITOR-Z6/ZG)', () => {
  // The assertions below this one all exercise the class in isolation, which
  // would keep passing if the dispatch site stopped USING it. This drives a real
  // collector write through the installed gate so the call site itself is pinned
  // — reverting `runCollectorRequest` to `request.reject(error)` fails here.
  it('rejects the TRACKER-facing promise with the marker, and delivery with the raw error', async () => {
    resetCollectorTransportForTesting();
    const outcomes: unknown[] = [];
    configureCollectorTransport({
      endpoint: COLLECTOR_ENDPOINT,
      isCriticalEvent: () => false,
      onOutcome: (outcome) => { outcomes.push(outcome); },
      reportEnvironmentHealth: async () => true,
    });
    assert.ok(installCollectorFetchGate(), 'gate must install over the stubbed window.fetch');

    // window.fetch is stubbed (see `before`) to reject with a bare
    // `TypeError: Failed to fetch` — the exact production shape.
    const transport = (window as unknown as { fetch: typeof fetch }).fetch(COLLECTOR_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'event', payload: { name: 'triage-probe' } }),
    });

    const rejection = await transport.then(
      () => { throw new Error('collector write should not resolve when the network fails'); },
      (error: unknown) => error,
    );

    assert.ok(
      rejection instanceof CollectorTransportError,
      `tracker-facing rejection must carry the marker, got: ${String(rejection)}`,
    );
    // And the raw browser error must survive underneath, or classification and
    // diagnosis both lose the real cause.
    assert.ok((rejection as InstanceType<typeof CollectorTransportError>).cause instanceof TypeError);

    resetCollectorTransportForTesting();
  });

  it('leaves an already-named TimeoutError unwrapped', () => {
    // The wrap is scoped to the ANONYMOUS shape. A timeout already rejects with
    // a distinctly-named TimeoutError that Sentry groups on its own, and the
    // #6086/#6288 timeout suites pin that identity on the tracker-facing promise
    // in a dozen places. Renaming it would buy no attribution and break a real
    // contract, so this pins the narrowing rather than leaving it incidental.
    assert.equal(collectorFailureFromError(timeoutError(false)).kind, 'timeout');
    assert.equal(collectorFailureFromError(new TypeError('Failed to fetch')).kind, 'network');
  });

  it('names the beacon failure instead of passing the bare browser error through', () => {
    const wrapped = new CollectorTransportError(new TypeError('Failed to fetch'));

    assert.equal(wrapped.name, 'CollectorTransportError');
    assert.match(wrapped.message, /^Umami collector beacon transport rejected: /);
    // The underlying browser phrasing is retained for diagnosis — the point is
    // that it is no longer the WHOLE message, which is what made it
    // indistinguishable from a first-party outage.
    assert.match(wrapped.message, /Failed to fetch$/);
  });

  it('the shipped Sentry ignoreErrors entry matches that exact message', () => {
    // Read the pattern out of the shipped config rather than restating it, so a
    // rename on either side fails here instead of silently un-filtering the
    // class in production.
    const sentryInit = readFileSync(
      new URL('../src/bootstrap/sentry-init.ts', import.meta.url),
      'utf8',
    );
    const entry = sentryInit.match(
      /^\s*(\/\^\?*\(\?:CollectorTransportError: \)\?Umami collector beacon transport rejected\\b\/),\s*$/m,
    ) ?? sentryInit.match(/^\s*(\/[^\n]*Umami collector beacon transport rejected[^\n]*\/),\s*$/m);
    assert.ok(
      entry,
      'sentry-init.ts must carry an ignoreErrors entry for the collector beacon marker — ' +
        'without it the rejection is named but still reported, and Z6/ZG stay open.',
    );

    // Rebuild the literal and check it against the real message, so the test
    // proves the filter FIRES rather than merely that a line exists.
    const source = entry[1].replace(/^\//, '').replace(/\/$/, '');
    const pattern = new RegExp(source);
    const message = new CollectorTransportError(new TypeError('Failed to fetch')).message;
    assert.ok(
      pattern.test(message),
      `the shipped pattern ${entry[1]} does not match the message the code emits (${message})`,
    );

    // Counter-check: it must NOT swallow a bare first-party fetch failure, which
    // is the whole reason the chunk-name allowlist could not be widened.
    assert.equal(pattern.test('Failed to fetch'), false);
    assert.equal(pattern.test('TypeError: Failed to fetch'), false);
  });

  it('keeps timeout classification exact through the wrapper', () => {
    // A wrapped TimeoutError that fell through to `network` would silently
    // corrupt the timeout/raced split the health cohorts are built on — the
    // failure mode that makes "just wrap it" quietly wrong.
    assert.deepEqual(
      collectorFailureFromError(new CollectorTransportError(timeoutError(false))),
      { kind: 'timeout' },
    );
    assert.deepEqual(
      collectorFailureFromError(new CollectorTransportError(timeoutError(true))),
      { kind: 'timeout', raced: true },
    );
    assert.deepEqual(
      collectorFailureFromError(new CollectorTransportError(new TypeError('Failed to fetch'))),
      { kind: 'network' },
    );
  });

  it('still unwraps a delivery failure carried through the wrapper', () => {
    const failure = { kind: 'missing-receipt', status: 200 } as const;
    assert.deepEqual(
      collectorFailureFromError(new CollectorTransportError(new CollectorDeliveryError(failure))),
      failure,
    );
  });

  it('leaves the unwrapped classification path untouched', () => {
    // The wrapper is additive: every pre-existing input must classify exactly as
    // it did before, or the retry policy changes behaviour as a side effect.
    assert.deepEqual(collectorFailureFromError(timeoutError(false)), { kind: 'timeout' });
    assert.deepEqual(collectorFailureFromError(timeoutError(true)), { kind: 'timeout', raced: true });
    assert.deepEqual(collectorFailureFromError(new TypeError('Failed to fetch')), { kind: 'network' });
  });
});
