import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTimeout, TimeoutError } from '../src/utils/with-timeout.ts';

describe('withTimeout', () => {
  it('resolves with the source value when the source resolves first', async () => {
    const v = await withTimeout(Promise.resolve(42), 50, 'unit');
    assert.equal(v, 42);
  });

  it('rejects with the source error when the source rejects first', async () => {
    const err = new Error('boom');
    await assert.rejects(
      () => withTimeout(Promise.reject(err), 50, 'unit'),
      (e) => e === err,
    );
  });

  it('rejects with a TimeoutError after the budget when the source hangs forever', async () => {
    const pendingForever = new Promise(() => {}); // intentional: never settles
    const start = Date.now();
    await assert.rejects(
      () => withTimeout(pendingForever, 25, 'hang-test'),
      (e) => {
        assert.ok(e instanceof TimeoutError, `expected TimeoutError, got ${e}`);
        assert.equal(e.label, 'hang-test');
        assert.equal(e.timeoutMs, 25);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 20 && elapsed < 200, `elapsed ${elapsed}ms outside [20,200)`);
  });

  it('clears the timer when the source resolves, so a longer test exits without dangling work', async () => {
    // Tracks whether the timer-finalizer ran. If we don't clearTimeout, the
    // reject path still fires and is swallowed by a finished Promise.race —
    // but the node:test runner would keep the event loop alive until the
    // budget elapses, which would balloon a 5ms test into a 5000ms one.
    const start = Date.now();
    const v = await withTimeout(
      new Promise((res) => setTimeout(() => res('done'), 5)),
      5_000, // big budget; if not cleared, test loop stays alive ~5s
      'cleanup-check',
    );
    const elapsed = Date.now() - start;
    assert.equal(v, 'done');
    // A clean clearTimeout means we return as soon as the source resolves
    // (~5ms), not after the 5_000ms budget.
    assert.ok(elapsed < 500, `elapsed ${elapsed}ms — clearTimeout likely not firing`);
  });

  it('invokes onTimeout exactly once when the budget fires', async () => {
    let calls = 0;
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 15, 'onTimeout-check', () => { calls++; }),
      TimeoutError,
    );
    assert.equal(calls, 1);
  });

  it('does not invoke onTimeout when the source resolves first', async () => {
    let calls = 0;
    const v = await withTimeout(Promise.resolve('ok'), 50, 'no-timeout', () => { calls++; });
    assert.equal(v, 'ok');
    // Give any rogue timer a beat to fire (it shouldn't, but prove it).
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(calls, 0);
  });

  it('swallows onTimeout errors and still rejects with the TimeoutError', async () => {
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 15, 'throwing-cb', () => {
        throw new Error('callback should not hijack the reject path');
      }),
      TimeoutError,
    );
  });

  it('does not invoke onTimeout when the source rejects before the budget', async () => {
    // Coverage gap surfaced by Greptile on PR #3718: a source that rejects
    // FAST should NOT trigger the onTimeout side-effect (the previous
    // "does not invoke onTimeout when the source resolves first" test only
    // covered the resolve path). Without the .finally(clearTimeout) the
    // timer would fire after Promise.race already settled with the
    // rejection — and onTimeout would run AFTER the rejection had already
    // propagated to the caller. That's the worst kind of side-effect:
    // visible to telemetry, but the caller already moved on.
    let calls = 0;
    const fastRejection = Promise.reject(new Error('immediate'));
    await assert.rejects(
      () => withTimeout(fastRejection, 50, 'reject-first', () => { calls++; }),
      (err) => (err as Error).message === 'immediate',
    );
    // Wait past the budget to prove the timer was cleared (callback would
    // have fired by now if clearTimeout hadn't run).
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(calls, 0);
  });
});
