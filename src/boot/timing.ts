/** Waiting primitives for the boot sequence.
 *
 *  These are separated from the director because *how* the sequence waits is
 *  the thing that was wrong with it: every beat waited on a wall clock, so a
 *  stalled frame desynchronised the JS timeline from the CSS one and the
 *  sequence carried on without the animation it was supposedly waiting for. */

/** Sleep, cut short by `signal`. A non-positive delay resolves immediately,
 *  which is what `scale: 0` in the tests relies on. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

/** Resolve on the next frame, so a style change made now is committed before
 *  the caller's next one — the standard way to make two class changes animate
 *  as two beats rather than collapsing into one. Falls back to a timeout where
 *  there is no rAF (jsdom, and any headless run). */
export function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 16);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

/** Wait for `property` to finish transitioning on `el`.
 *
 *  Prefer this to `wait(<the same number the CSS uses>)`. A blind sleep assumes
 *  the transition started the instant the class was added, and under load it
 *  does not: the eye's dock was measured starting ~2 s after it was requested,
 *  by which time the director had already moved on and faded it out mid-flight.
 *
 *  `fallbackMs` is a safety net, not the expected path. `transitionend` never
 *  fires when the transition does not start at all — no computed change,
 *  `display: none`, a reduced-motion override, or the browser simply dropping
 *  it — and hanging there would strand the boot on a black screen forever.
 *  Give it the transition's duration plus real slack. */
export function waitForTransition(
  el: HTMLElement,
  property: string,
  fallbackMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('transitionend', onEnd);
      signal.removeEventListener('abort', finish);
      resolve();
    };

    const onEnd = (e: Event) => {
      // The grid carries thousands of children with transitions of their own,
      // and transitionend bubbles — so a cell finishing its fade is not the
      // grid finishing its flight.
      if (e.target !== el) return;
      if ((e as TransitionEvent).propertyName !== property) return;
      finish();
    };

    const timer = setTimeout(finish, Math.max(0, fallbackMs));
    el.addEventListener('transitionend', onEnd);
    signal.addEventListener('abort', finish, { once: true });
  });
}
