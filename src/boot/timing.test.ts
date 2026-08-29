import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wait, waitForTransition } from './timing';

/** jsdom has no real style engine, so transitions never actually run — the
 *  event has to be synthesised. TransitionEvent is not constructible here
 *  either, so the propertyName rides on a plain Event. */
function endTransition(el: HTMLElement, propertyName: string) {
  el.dispatchEvent(Object.assign(new Event('transitionend', { bubbles: true }), { propertyName }));
}

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('wait', () => {
  it('resolves after the delay', async () => {
    const ctrl = new AbortController();
    const t = Date.now();
    await wait(30, ctrl.signal);
    expect(Date.now() - t).toBeGreaterThanOrEqual(20);
  });

  it('resolves immediately for a non-positive delay', async () => {
    await expect(wait(0, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('resolves immediately when already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const t = Date.now();
    await wait(5000, ctrl.signal);
    expect(Date.now() - t).toBeLessThan(100);
  });

  it('cuts a pending delay short when aborted', async () => {
    const ctrl = new AbortController();
    const t = Date.now();
    const p = wait(5000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await p;
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('waitForTransition', () => {
  it('resolves when the named property finishes transitioning', async () => {
    const ctrl = new AbortController();
    const p = waitForTransition(el, 'transform', 5000, ctrl.signal);
    setTimeout(() => endTransition(el, 'transform'), 10);
    const t = Date.now();
    await p;
    // Resolved on the event, not by burning the whole 5s fallback.
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('ignores a different property finishing first', async () => {
    const ctrl = new AbortController();
    let done = false;
    const p = waitForTransition(el, 'transform', 200, ctrl.signal).then(() => { done = true; });
    endTransition(el, 'opacity');
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });

  it('ignores a transition finishing on a descendant', async () => {
    // #boot's grid is full of children. A cell's own transition ending is not
    // the grid's dock transition ending.
    const child = document.createElement('span');
    el.appendChild(child);
    const ctrl = new AbortController();
    let done = false;
    const p = waitForTransition(el, 'transform', 200, ctrl.signal).then(() => { done = true; });
    endTransition(child, 'transform');
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    await p;
  });

  it('falls back to the timeout when the transition never starts', async () => {
    // transitionend never fires if the transition did not start — no computed
    // change, display:none, reduced motion, or the browser dropping it under
    // load. Waiting forever there strands the boot on a black screen, which is
    // strictly worse than cutting the animation short.
    const ctrl = new AbortController();
    const t = Date.now();
    await waitForTransition(el, 'transform', 40, ctrl.signal);
    expect(Date.now() - t).toBeGreaterThanOrEqual(30);
  });

  it('resolves immediately when already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const t = Date.now();
    await waitForTransition(el, 'transform', 5000, ctrl.signal);
    expect(Date.now() - t).toBeLessThan(100);
  });

  it('resolves once, and stops listening afterwards', async () => {
    const ctrl = new AbortController();
    let resolutions = 0;
    const p = waitForTransition(el, 'transform', 5000, ctrl.signal).then(() => { resolutions++; });
    endTransition(el, 'transform');
    endTransition(el, 'transform');
    await p;
    await new Promise((r) => setTimeout(r, 20));
    expect(resolutions).toBe(1);
  });
});
