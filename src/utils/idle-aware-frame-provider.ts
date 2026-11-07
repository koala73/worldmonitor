/**
 * A requestAnimationFrame stand-in for render loops that poll every frame.
 *
 * deck.gl's animation loop requests a frame on every vsync to check for
 * pending layer updates, even when nothing changed. Each scheduled frame makes
 * the browser run a full style, prepaint and intersection-observer pass, which
 * was most of the dashboard's idle main-thread time.
 *
 * While active (within `activeWindowMs` of the last `wake()`), callbacks run on
 * display frames. Otherwise they run on a slow timer, which still lets the loop
 * notice async work (icon atlases, deferred layer props) within
 * `idleIntervalMs`. `wake()` moves a pending timer callback to the next display
 * frame, so interaction never waits for the idle interval.
 */

export interface IdleAwareFrameProviderOptions {
  idleIntervalMs: number;
  activeWindowMs: number;
  now?: () => number;
  requestAnimationFrame?: (cb: (time: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  setTimeout?: (cb: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
}

export interface IdleAwareFrameProvider {
  requestAnimationFrame(cb: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  /** True while a requested callback has not run yet. A running loop always has one. */
  hasPendingFrame(): boolean;
  wake(): void;
  dispose(): void;
}

type Pending = { cb: (time: number) => void; kind: 'raf' | 'timeout'; id: number };

export function createIdleAwareFrameProvider(options: IdleAwareFrameProviderOptions): IdleAwareFrameProvider {
  const now = options.now ?? (() => performance.now());
  const raf = options.requestAnimationFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const caf = options.cancelAnimationFrame ?? ((id) => window.cancelAnimationFrame(id));
  const setTimer = options.setTimeout ?? ((cb, ms) => window.setTimeout(cb, ms));
  const clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));

  let lastWake = Number.NEGATIVE_INFINITY;
  let nextHandle = 1;
  let disposed = false;
  const pending = new Map<number, Pending>();

  const scheduleFrame = (handle: number, cb: (time: number) => void): void => {
    const id = raf((time) => {
      pending.delete(handle);
      cb(time);
    });
    pending.set(handle, { cb, kind: 'raf', id });
  };

  const scheduleTimer = (handle: number, cb: (time: number) => void): void => {
    const id = setTimer(() => {
      pending.delete(handle);
      cb(now());
    }, options.idleIntervalMs);
    pending.set(handle, { cb, kind: 'timeout', id });
  };

  return {
    requestAnimationFrame(cb) {
      const handle = nextHandle++;
      if (disposed) return handle;
      if (now() - lastWake <= options.activeWindowMs) scheduleFrame(handle, cb);
      else scheduleTimer(handle, cb);
      return handle;
    },
    cancelAnimationFrame(handle) {
      const entry = pending.get(handle);
      if (!entry) return;
      pending.delete(handle);
      if (entry.kind === 'raf') caf(entry.id);
      else clearTimer(entry.id);
    },
    hasPendingFrame() {
      return pending.size > 0;
    },
    wake() {
      if (disposed) return;
      lastWake = now();
      for (const [handle, entry] of pending) {
        if (entry.kind !== 'timeout') continue;
        clearTimer(entry.id);
        scheduleFrame(handle, entry.cb);
      }
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) {
        if (entry.kind === 'raf') caf(entry.id);
        else clearTimer(entry.id);
      }
      pending.clear();
    },
  };
}
