/**
 * WORLDMONITOR-109: marketing /pro called AbortSignal.timeout in the
 * pricing catalog fetch. Chrome Mobile 101 (pre-Chrome 103) throws
 * TypeError before fetch runs. Pin the fallback helper and every call
 * site that could reproduce the production stack.
 *
 * The failure mode is specific and easy to under-test, so the first case below
 * is a positive control for the premise itself: it proves a bare
 * `AbortSignal.timeout` call is NOT rescuable by the `.catch()` sitting on the
 * same fetch chain. That is why the fix has to live at the construction site
 * rather than in error handling, and why the source sweep further down covers
 * the whole bundle instead of the one file that happened to crash.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTimeoutSignal, isTimeoutOrAbortError } from '../pro-test/src/services/timeout-signal.ts';
import { createTimeoutSignal as createDashboardTimeoutSignal } from '../src/services/timeout-signal.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/** Run `fn` with `AbortSignal.timeout` removed, as on Chrome < 103. */
function withoutNativeTimeout<T>(fn: () => T): T {
  const original = AbortSignal.timeout;
  // @ts-expect-error intentional removal for old-engine coverage
  delete AbortSignal.timeout;
  try {
    assert.equal(typeof AbortSignal.timeout, 'undefined');
    return fn();
  } finally {
    AbortSignal.timeout = original;
  }
}

describe('the bug being fixed (WORLDMONITOR-109)', () => {
  it('a bare AbortSignal.timeout call escapes the .catch() on its own fetch chain', () => {
    // If this ever stops throwing synchronously, the premise behind the fix
    // changed and every case below stops proving anything about production.
    let reachedCatch = false;
    const escaped = withoutNativeTimeout(() => {
      try {
        void Promise.resolve()
          .then(() => ({ signal: AbortSignal.timeout(5_000) }))
          .catch(() => { reachedCatch = true; });
        // The real call-site position: an argument to fetch(), evaluated
        // before fetch() is entered, so no promise exists to reject.
        return { signal: AbortSignal.timeout(5_000) } as unknown as null;
      } catch (err) {
        return err as unknown as null;
      }
    });
    assert.ok(escaped instanceof TypeError, 'expected a synchronous TypeError');
    assert.match(
      (escaped as unknown as TypeError).message,
      /AbortSignal\.timeout is not a function/,
    );
    assert.equal(reachedCatch, false, 'the synchronous throw never reaches .catch()');
  });
});

describe('createTimeoutSignal', () => {
  it('returns a signal that aborts after the budget when AbortSignal.timeout is missing', async () => {
    const signal = withoutNativeTimeout(() => createTimeoutSignal(20));
    assert.equal(signal.aborted, false, 'must not be pre-aborted — that would kill every fetch');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(signal.aborted, true, 'an inert signal would silently drop every fetch deadline');
  });

  it('reports the native TimeoutError reason on the fallback path', () => {
    // A bare controller.abort() yields AbortError instead. That distinction is
    // load-bearing: analytics-collector-transport.ts branches on
    // `name === 'TimeoutError'` to tell a timeout from a caller cancellation,
    // so an AbortError-shaped fallback would silently reclassify every
    // old-engine timeout.
    const signal = withoutNativeTimeout(() => createTimeoutSignal(1));
    return new Promise<void>((done) => {
      signal.addEventListener('abort', () => {
        assert.equal((signal.reason as DOMException).name, 'TimeoutError');
        done();
      }, { once: true });
    });
  });

  // A native `AbortSignal.timeout` reason's stack is the header line alone, so
  // it parses to zero frames. A JS-built DOMException diverges two ways, and
  // either one reaches Sentry as a first-party rejection when a browser
  // extension's fetch hook leaks it, as the insights loader's reason did
  // (WORLDMONITOR-125/12Z/11N): Chromium leaves it stackless, so Sentry's fetch
  // instrumentation writes the fetch call site onto it, and engines that record
  // a stack give it the timer callback's frames. Node's DOMException is the
  // framed shape, so the stackless one has to be recreated or its case passes
  // vacuously.
  const NativeDOMException = globalThis.DOMException;
  class StacklessDOMException extends NativeDOMException {
    constructor(...args: ConstructorParameters<typeof DOMException>) {
      super(...args);
      delete (this as { stack?: string }).stack;
    }
  }
  const engines = [
    { engine: 'stackless (Chromium)', Engine: StacklessDOMException, framed: false },
    { engine: 'framed (Firefox, Node)', Engine: NativeDOMException, framed: true },
  ];
  // Both copies, though the mirror-parity test pins them byte-identical: the
  // dashboard copy is the one whose `!hasFirstParty` suppression this protects.
  const bundles = [
    { bundle: 'marketing', create: createTimeoutSignal },
    { bundle: 'dashboard', create: createDashboardTimeoutSignal },
  ];
  for (const { bundle, create } of bundles) {
    for (const { engine, Engine, framed } of engines) {
      it(`${bundle}: stamps the native header-only stack on a ${engine} fallback reason`, { timeout: 1_000 }, async () => {
        const probe = new Engine('x', 'TimeoutError').stack;
        if (framed) assert.match(probe ?? '', /\n\s+at /, 'precondition: this engine records construction frames');
        else assert.equal(probe, undefined, 'precondition: the stub reproduces Chromium\'s stackless DOMException');

        globalThis.DOMException = Engine;
        let reason: DOMException;
        try {
          const signal = withoutNativeTimeout(() => create(1));
          reason = await new Promise<DOMException>((done) => {
            signal.addEventListener('abort', () => done(signal.reason as DOMException), { once: true });
          });
        } finally {
          globalThis.DOMException = NativeDOMException;
        }
        assert.ok(reason instanceof NativeDOMException);
        assert.equal(reason.name, 'TimeoutError', 'analytics-collector-transport branches on the name');
        assert.equal(reason.message, 'signal timed out');
        assert.equal(reason.stack, 'TimeoutError: signal timed out');
      });
    }

    it(`${bundle}: still aborts when the engine refuses the stack stamp`, { timeout: 1_000 }, async () => {
      // The stamp only improves telemetry; the abort is the deadline itself.
      // An engine whose DOMException pins `stack` would make defineProperty
      // throw inside the timer, and a swallowed throw there must not cost the
      // fetch its deadline (the WORLDMONITOR-109 class this fallback exists for).
      class LockedStackDOMException extends NativeDOMException {
        constructor(...args: ConstructorParameters<typeof DOMException>) {
          super(...args);
          Object.defineProperty(this, 'stack', { value: 'TimeoutError: signal timed out\n    at locked', configurable: false, writable: false });
        }
      }
      assert.throws(
        () => Object.defineProperty(new LockedStackDOMException('x', 'TimeoutError'), 'stack', { value: 'y' }),
        TypeError,
        'precondition: the stub refuses a stack redefinition',
      );
      globalThis.DOMException = LockedStackDOMException;
      let reason: DOMException;
      try {
        const signal = withoutNativeTimeout(() => create(1));
        reason = await new Promise<DOMException>((done) => {
          signal.addEventListener('abort', () => done(signal.reason as DOMException), { once: true });
        });
      } finally {
        globalThis.DOMException = NativeDOMException;
      }
      assert.equal(reason.name, 'TimeoutError');
      assert.equal(reason.message, 'signal timed out');
    });
  }

  it('prefers native AbortSignal.timeout when present', () => {
    const original = AbortSignal.timeout;
    const seen: number[] = [];
    AbortSignal.timeout = (ms) => {
      seen.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      const signal = createTimeoutSignal(1_234);
      assert.deepEqual(seen, [1_234], 'must delegate, not reimplement, when native exists');
      assert.equal(signal.aborted, false);
    } finally {
      AbortSignal.timeout = original;
    }
  });
});

describe('isTimeoutOrAbortError (WORLDMONITOR-10F)', () => {
  it('matches Safari AbortError "Fetch is aborted" and native TimeoutError', () => {
    // Production event aee57f9d965b4b2b888bde214054d8d1: Mobile Safari
    // AbortError + DOMException.code 20. Synthetic values only.
    assert.equal(
      isTimeoutOrAbortError(Object.assign(new Error('Fetch is aborted'), { name: 'AbortError' })),
      true,
    );
    assert.equal(
      isTimeoutOrAbortError(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })),
      true,
    );
  });

  it('preserves first-party failures for Sentry', () => {
    assert.equal(isTimeoutOrAbortError(new TypeError('Failed to fetch')), false);
    assert.equal(isTimeoutOrAbortError(new Error('network down')), false);
    assert.equal(isTimeoutOrAbortError(null), false);
    assert.equal(isTimeoutOrAbortError('AbortError'), false);
  });
});

describe('ProEntitlementProvider skips Sentry on abort/timeout (WORLDMONITOR-10F)', () => {
  it('gates check-entitlement captureException behind isTimeoutOrAbortError', () => {
    const appSrc = readFileSync(resolve(root, 'pro-test/src/App.tsx'), 'utf-8');
    // Capture site must still exist for real failures, but abort/timeout skip first.
    assert.match(
      appSrc,
      /if\s*\(\s*!isTimeoutOrAbortError\(\s*err\s*\)\s*\)\s*\{\s*Sentry\.captureException\(\s*err\s*,\s*\{\s*tags:\s*\{\s*surface:\s*'pro-marketing'\s*,\s*action:\s*'check-entitlement'/,
    );
    assert.match(appSrc, /signal:\s*createTimeoutSignal\(\s*8_000\s*\)/);
  });
});

/** Every .ts/.tsx source file under a root, excluding the helper itself. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && entry !== 'timeout-signal.ts') {
      out.push(full);
    }
  }
  return out;
}

const BARE_CALL = /\bAbortSignal\.timeout\s*\(/;

describe('/pro bundle has no bare AbortSignal.timeout call sites', () => {
  const files = sourceFiles(resolve(root, 'pro-test/src'));

  it('scans a non-trivial number of files', () => {
    // Without this, a broken walker (wrong path, over-eager skip) would leave
    // the sweep below vacuously green.
    assert.ok(files.length > 20, `expected to scan the /pro sources, scanned ${files.length}`);
  });

  it('detects a planted violation', () => {
    // Positive control for the regex: proves the sweep can actually fail.
    assert.match('  signal: AbortSignal.timeout(5000),', BARE_CALL);
    assert.doesNotMatch('  signal: createTimeoutSignal(5000),', BARE_CALL);
  });

  it('routes every /pro fetch deadline through createTimeoutSignal()', () => {
    // The production crash came from PricingSection, but App.tsx, teasers.ts
    // and checkout.ts all built signals the same way. (entitlement-watchdog.ts
    // was a fourth until #7222 removed the /pro copy.)
    // Pinning only the one file that happened to page would leave the rest
    // free to regress.
    const offenders = files
      .filter((f) => BARE_CALL.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(root, f));
    assert.deepEqual(
      offenders,
      [],
      'Use createTimeoutSignal() from services/timeout-signal.ts instead — a bare call throws '
      + 'synchronously on Chrome < 103 / Safari < 16 and escapes the surrounding .catch() '
      + `(WORLDMONITOR-109). Offenders: ${offenders.join(', ')}`,
    );
  });
});
