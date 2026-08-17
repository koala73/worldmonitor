/**
 * Load-bearing guard for the install ORDER of the fetch-failure attribution
 * wrapper (#6746 / WORLDMONITOR-ZG).
 *
 * The wrapper only works if it is installed FIRST among first-party
 * `window.fetch` wrappers, so it wraps native `fetch` directly and sits at the
 * bottom of the delegation chain. Every outer wrapper delegates downward, so a
 * bottom wrapper sees every request that reaches the network — whereas an
 * OUTERMOST one would be bypassed by `wmSessionFetch`'s early returns
 * (non-API targets, credential-less public data, premium paths), which carry
 * exactly the Umami-beacon traffic this change needs to attribute.
 *
 * That ordering is a single line in `src/main.ts` and nothing at runtime
 * enforces it, so it is asserted statically here. This replaces
 * `tests/debugbear-trampoline-chunks.test.mjs`, whose invariant was tied to
 * Vite chunk names that Rollup re-partitions freely — an install-order
 * invariant cannot be perturbed by a bundler.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installFetchFailureAttribution,
  resetFetchFailureAttributionForTesting,
} from '../src/services/fetch-failure-attribution.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainPath = resolve(__dirname, '../src/main.ts');

/** Call sites that install a `window.fetch` wrapper SYNCHRONOUSLY from `src/main.ts`. */
const LATER_WRAPPER_INSTALLS = ['installRuntimeFetchPatch()', 'installWebApiRedirect()'];
const ATTRIBUTION_INSTALL = 'installFetchFailureAttribution()';

/**
 * Bootstrap calls that DO eventually install a `window.fetch` wrapper, but only
 * asynchronously — `initAnalytics()` reaches `installCollectorFetchGate()` via
 * `scheduleAfterFirstPaint(loadUmamiScript, ...)`, and `initDebugBearRum()`
 * injects a CDN script that wraps fetch whenever it loads.
 *
 * Both are called BEFORE the attribution install, so attribution is innermost
 * only because of that deferral — not because of source order. Listed here so
 * the dependency is explicit rather than accidental.
 */
const DEFERRED_FETCH_WRAPPERS = new Set(['initAnalytics()', 'initDebugBearRum()']);

/**
 * Bootstrap calls that do not touch `window.fetch` at all.
 *
 * `installChunkReloadGuard` and `installSwUpdateHandler` were surfaced by this
 * guard's own closed-world check on its first run (the earlier zero-arg-only
 * scan missed them); both verified fetch-free — zero `window.fetch =` /
 * `globalThis.fetch =` assignments in src/bootstrap/chunk-reload.ts and
 * src/bootstrap/sw-update.ts.
 */
const NON_FETCH_BOOTSTRAP = new Set([
  'installChunkReloadGuard()',
  'installSwUpdateHandler()',
  'initI18n()',
  'initLiveChannelsWindow()',
  'initMetaTags()',
  'initSettingsWindow()',
  'initVercelAnalytics()',
  'installLcpAttributionDebug()',
  'installPreInitErrorQueue()',
  'installStaleBundleCheck()',
  'installUtmInterceptor()',
]);

/**
 * Strips comments so a mention in prose does not read as a call site. Without
 * this the guard would pass on a commented-out install.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Index of a call site, counting only real code. */
function callIndex(source: string, call: string): number {
  return stripComments(source).indexOf(call);
}

describe('fetch attribution install order (src/main.ts)', () => {
  const source = readFileSync(mainPath, 'utf-8');
  const code = stripComments(source);

  it('installs the attribution wrapper exactly once', () => {
    const hits = code.split(ATTRIBUTION_INSTALL).length - 1;
    assert.equal(hits, 1, `expected exactly one ${ATTRIBUTION_INSTALL} in src/main.ts, found ${hits}`);
  });

  it('imports the installer from the attribution module', () => {
    assert.match(
      code,
      /import\s*\{[^}]*installFetchFailureAttribution[^}]*\}\s*from\s*'@\/services\/fetch-failure-attribution'/,
      'src/main.ts must import installFetchFailureAttribution',
    );
  });

  for (const later of LATER_WRAPPER_INSTALLS) {
    it(`installs attribution BEFORE ${later}`, () => {
      const attribution = callIndex(source, ATTRIBUTION_INSTALL);
      const other = callIndex(source, later);
      assert.ok(attribution !== -1, `${ATTRIBUTION_INSTALL} missing from src/main.ts`);
      assert.ok(other !== -1, `${later} missing from src/main.ts — update this guard`);
      assert.ok(
        attribution < other,
        `${ATTRIBUTION_INSTALL} must precede ${later}; attribution must wrap native fetch, `
        + 'not sit above another wrapper that early-returns past it',
      );
    });
  }

  it('forces every new bootstrap installer to be triaged (closed-world)', () => {
    // CLOSED-WORLD, not an opt-in allowlist. The previous version of this test
    // ended in `assert.ok(unknown.length >= 0)` — mathematically always true, so
    // the one check meant to catch a new fetch wrapper sneaking in ahead of ours
    // could never fail. Five reviewers flagged it independently.
    //
    // The fix inverts the burden: EVERY bootstrap call in main.ts must appear in
    // one of the two sets below. A newly added installer fails this test until
    // someone classifies it, which is exactly the moment to ask "does it wrap
    // window.fetch, and if so does it install after us?".
    //
    // Matches `init*`/`install*`/`setup*` with or without arguments, so a
    // parameterised installer cannot slip through on shape alone.
    const bootstrapCalls = new Set(
      [...code.matchAll(/\b((?:install|init|setup)[A-Z]\w*)\s*\(/g)].map((m) => `${m[1]}()`),
    );

    const knownFetchWrappers = new Set([ATTRIBUTION_INSTALL, ...LATER_WRAPPER_INSTALLS]);
    for (const known of knownFetchWrappers) {
      assert.ok(bootstrapCalls.has(known), `${known} must still be called from src/main.ts`);
    }

    const unclassified = [...bootstrapCalls].filter(
      (c) => !knownFetchWrappers.has(c) && !DEFERRED_FETCH_WRAPPERS.has(c) && !NON_FETCH_BOOTSTRAP.has(c),
    );
    assert.deepEqual(
      unclassified,
      [],
      'New bootstrap call(s) in src/main.ts are unclassified. Decide for each: does it '
      + 'wrap window.fetch? -> LATER_WRAPPER_INSTALLS (and it must come AFTER attribution). '
      + 'Does it reach a fetch wrapper asynchronously? -> DEFERRED_FETCH_WRAPPERS. '
      + 'Neither? -> NON_FETCH_BOOTSTRAP.',
    );
  });

  for (const deferred of DEFERRED_FETCH_WRAPPERS) {
    it(`${deferred} is called before attribution — which is why its deferral is load-bearing`, () => {
      // Named for what it actually checks. Source ORDER only; the deferral
      // itself is pinned by the next test. An earlier version of this test
      // claimed to "pin the deferral" while asserting nothing but this index
      // comparison — it would have passed even if the callee started wrapping
      // fetch synchronously, which is the whole risk.
      const idx = callIndex(source, deferred);
      assert.notEqual(idx, -1, `${deferred} missing from src/main.ts — update this guard`);
      assert.ok(
        idx < callIndex(source, ATTRIBUTION_INSTALL),
        `${deferred} precedes attribution, so we are innermost only by its deferral`,
      );
    });
  }

  it('initAnalytics defers the collector gate past first paint', () => {
    // THE actual invariant. `initAnalytics()` runs before the attribution
    // install, and it reaches `installCollectorFetchGate()` — which wraps
    // window.fetch. Attribution is innermost only because that gate is never
    // reached synchronously from init:
    //
    //   - loadUmamiScript() (the one unguarded call) is scheduled via
    //     scheduleAfterFirstPaint, not called inline;
    //   - the other call sites sit behind a `window.umami` check, and that
    //     global only exists once the deferred script has loaded.
    //
    // Drop the scheduling and the collector captures NATIVE fetch, silently
    // un-attributing the exact Umami-beacon traffic this module exists to
    // attribute. That regression is invisible in every other test, so assert
    // the wiring here.
    const analyticsSrc = stripComments(
      readFileSync(resolve(__dirname, '../src/services/analytics.ts'), 'utf-8'),
    );
    assert.match(
      analyticsSrc,
      /scheduleAfterFirstPaint\(\s*loadUmamiScript/,
      'analytics.ts must schedule loadUmamiScript after first paint — calling it inline from '
      + 'initAnalytics would install the collector fetch gate before attribution',
    );
    assert.ok(
      !/^\s*loadUmamiScript\(\);/m.test(analyticsSrc),
      'loadUmamiScript() must not be invoked synchronously at statement level',
    );
  });
});

describe('installFetchFailureAttribution — idempotence', () => {
  it('wraps window.fetch only once across repeated installs', () => {
    const savedWindow = (globalThis as Record<string, unknown>).window;
    resetFetchFailureAttributionForTesting();
    const nativeFetch = (async () => new Response('ok')) as typeof fetch;
    const fakeWindow = { fetch: nativeFetch };
    (globalThis as Record<string, unknown>).window = fakeWindow;
    try {
      assert.equal(installFetchFailureAttribution(), true, 'first install must succeed');
      const afterFirst = fakeWindow.fetch;
      assert.notEqual(afterFirst, nativeFetch, 'first install must replace window.fetch');

      assert.equal(installFetchFailureAttribution(), true, 'second install reports installed');
      assert.equal(fakeWindow.fetch, afterFirst, 'second install must NOT re-wrap');
    } finally {
      resetFetchFailureAttributionForTesting();
      if (savedWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = savedWindow;
    }
  });

  it('passes a SUCCESSFUL fetch straight through', () => {
    // The wrapper sits under every request in the app, so the success path is
    // the overwhelmingly common one — and it was entirely untested.
    const savedWindow = (globalThis as Record<string, unknown>).window;
    resetFetchFailureAttributionForTesting();
    const response = new Response('ok');
    const calls: Array<[unknown, unknown]> = [];
    const nativeFetch = (async (input: unknown, init: unknown) => {
      calls.push([input, init]);
      return response;
    }) as unknown as typeof fetch;
    const fakeWindow = { fetch: nativeFetch };
    (globalThis as Record<string, unknown>).window = fakeWindow;
    try {
      installFetchFailureAttribution();
      const init = { method: 'POST' };
      return fakeWindow.fetch('https://api.worldmonitor.app/x', init).then((r: Response) => {
        assert.equal(r, response, 'the original Response must be returned unchanged');
        assert.deepEqual(calls, [['https://api.worldmonitor.app/x', init]],
          'input and init must be forwarded unmodified');
      });
    } finally {
      resetFetchFailureAttributionForTesting();
      if (savedWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = savedWindow;
    }
  });

  it('reset restores the pre-wrapping fetch', () => {
    const savedWindow = (globalThis as Record<string, unknown>).window;
    resetFetchFailureAttributionForTesting();
    const nativeFetch = (async () => new Response('ok')) as typeof fetch;
    const fakeWindow = { fetch: nativeFetch };
    (globalThis as Record<string, unknown>).window = fakeWindow;
    try {
      installFetchFailureAttribution();
      assert.notEqual(fakeWindow.fetch, nativeFetch, 'precondition: install replaced fetch');
      resetFetchFailureAttributionForTesting();
      assert.equal(fakeWindow.fetch, nativeFetch, 'reset must put the original back');
    } finally {
      resetFetchFailureAttributionForTesting();
      if (savedWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = savedWindow;
    }
  });

  it('reports failure instead of throwing when window.fetch is absent', () => {
    const savedWindow = (globalThis as Record<string, unknown>).window;
    resetFetchFailureAttributionForTesting();
    (globalThis as Record<string, unknown>).window = { fetch: undefined };
    try {
      assert.equal(installFetchFailureAttribution(), false);
    } finally {
      resetFetchFailureAttributionForTesting();
      if (savedWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = savedWindow;
    }
  });

  it('annotates a rejection that travels through the installed wrapper', () => {
    const savedWindow = (globalThis as Record<string, unknown>).window;
    const savedLocation = (globalThis as Record<string, unknown>).location;
    resetFetchFailureAttributionForTesting();
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const fakeWindow = { fetch: failing };
    (globalThis as Record<string, unknown>).window = fakeWindow;
    (globalThis as Record<string, unknown>).location = { href: 'https://www.worldmonitor.app/dashboard' };
    try {
      installFetchFailureAttribution();
      return fakeWindow.fetch('https://abacus.worldmonitor.app/api/send').then(
        () => assert.fail('expected rejection'),
        (error: unknown) => {
          assert.equal(
            error instanceof Error ? error.message : String(error),
            'Failed to fetch (abacus.worldmonitor.app)',
          );
        },
      );
    } finally {
      resetFetchFailureAttributionForTesting();
      if (savedWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = savedWindow;
      if (savedLocation === undefined) delete (globalThis as Record<string, unknown>).location;
      else (globalThis as Record<string, unknown>).location = savedLocation;
    }
  });
});
