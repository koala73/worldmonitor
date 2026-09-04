/**
 * Regression coverage for the Clerk UI-open retry/capture state machine
 * (`runClerkSurfaceOpen`) added to fix WORLDMONITOR-SC / WORLDMONITOR-SD.
 *
 * Clerk's `openSignIn` / `openSignUp` throw SYNCHRONOUSLY ("Clerk was not
 * loaded with Ui components") when the session layer loaded but the UI
 * component controller never attached. The old code called the Clerk method
 * unguarded, so the throw escaped as an uncaught error on every Sign In /
 * Create Account click. `runClerkSurfaceOpen` must:
 *   1. swallow the synchronous throw (no uncaught error),
 *   2. retry once on the next frame (absorb the load()-vs-mount race),
 *   3. report exactly one handled event only when the retry ALSO fails.
 *
 * The full openSignIn() path needs a browser + Clerk SDK; this exercises the
 * decoupled state machine, which is the part most likely to regress.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runClerkSurfaceOpen, waitForClerkSurfaceOpen } from '../src/services/clerk.ts';

describe('runClerkSurfaceOpen', () => {
  it('opens once and never schedules a retry when the surface is ready', () => {
    let opens = 0;
    let retries = 0;
    let failures = 0;
    runClerkSurfaceOpen(
      () => { opens += 1; },
      () => { failures += 1; },
      () => { retries += 1; },
    );
    assert.equal(opens, 1);
    assert.equal(retries, 0);
    assert.equal(failures, 0);
  });

  it('does not let a synchronous throw escape (the WORLDMONITOR-SC/-SD crash)', () => {
    assert.doesNotThrow(() => {
      runClerkSurfaceOpen(
        () => { throw new Error('Clerk was not loaded with Ui components'); },
        () => {},
        // Never run the retry so we isolate the first-call guarantee.
        () => {},
      );
    });
  });

  it('recovers when the surface becomes ready on the retry frame — no capture', () => {
    let opens = 0;
    let failures = 0;
    runClerkSurfaceOpen(
      () => {
        opens += 1;
        if (opens === 1) throw new Error('Clerk was not loaded with Ui components');
        // second call (retry frame) succeeds — components finished mounting
      },
      () => { failures += 1; },
      (cb) => { cb(); }, // run the scheduled retry synchronously
    );
    assert.equal(opens, 2);
    assert.equal(failures, 0);
  });

  it('reports exactly one handled failure when the retry also throws', () => {
    let opens = 0;
    const captured: unknown[] = [];
    runClerkSurfaceOpen(
      () => { opens += 1; throw new Error('Clerk was not loaded with Ui components'); },
      (err) => { captured.push(err); },
      (cb) => { cb(); },
    );
    assert.equal(opens, 2); // initial + one retry
    assert.equal(captured.length, 1);
    assert.ok(captured[0] instanceof Error);
    assert.match((captured[0] as Error).message, /not loaded with Ui components/);
  });

  it('schedules the retry rather than calling open synchronously twice', () => {
    let opens = 0;
    let scheduled: (() => void) | null = null;
    runClerkSurfaceOpen(
      () => { opens += 1; throw new Error('not ready'); },
      () => {},
      (cb) => { scheduled = cb; }, // capture but do not run
    );
    assert.equal(opens, 1, 'retry must be deferred, not run inline');
    assert.equal(typeof scheduled, 'function');
  });
});

describe('waitForClerkSurfaceOpen', () => {
  it('settles false when the first open throws and the retry scheduler never runs', async () => {
    const result = await waitForClerkSurfaceOpen(
      () => { throw new Error('Clerk was not loaded with Ui components'); },
      25,
      () => {},
    );
    assert.equal(result, false);
  });

  it('does not open after the wait cap has already settled', async () => {
    let opens = 0;
    let lateRetry: (() => void) | undefined;
    const result = await waitForClerkSurfaceOpen(
      () => {
        opens += 1;
        throw new Error('not ready');
      },
      20,
      (cb) => { lateRetry = cb; },
    );
    assert.equal(result, false);
    lateRetry?.();
    assert.equal(opens, 1);
  });

  it('does not report opened until isOpen is true', async () => {
    let visible = false;
    let sawPending = false;
    const pending = waitForClerkSurfaceOpen(
      () => {},
      400,
      (cb) => { setTimeout(cb, 15); },
      { isOpen: () => visible },
    );
    const raced = await Promise.race([
      pending.then((opened) => ({ opened })),
      new Promise<{ pending: true }>((resolve) => {
        setTimeout(() => resolve({ pending: true }), 40);
      }),
    ]);
    if ('pending' in raced) {
      sawPending = true;
      visible = true;
    }
    assert.equal(sawPending, true);
    assert.equal(await pending, true);
  });

  it('returns false when open succeeds but the modal never appears', async () => {
    const result = await waitForClerkSurfaceOpen(
      () => {},
      30,
      (cb) => { setTimeout(cb, 5); },
      { isOpen: () => false },
    );
    assert.equal(result, false);
  });

  it('does not open when the signal is already aborted', async () => {
    let opens = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      waitForClerkSurfaceOpen(
        () => { opens += 1; },
        100,
        () => {},
        { signal: controller.signal },
      ),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(opens, 0);
  });

  it('rejects when the signal aborts before the modal is present', async () => {
    const controller = new AbortController();
    const pending = waitForClerkSurfaceOpen(
      () => {},
      400,
      (cb) => { setTimeout(cb, 15); },
      { isOpen: () => false, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
  });

  it('retries via setTimeout even when requestAnimationFrame never fires', async () => {
    const previousRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: () => 0,
    });
    try {
      let opens = 0;
      const opened = await waitForClerkSurfaceOpen(
        () => {
          opens += 1;
          if (opens === 1) throw new Error('not ready');
        },
        500,
      );
      assert.equal(opens, 2);
      assert.equal(opened, true);
    } finally {
      if (previousRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', previousRaf);
      else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
  });
});
