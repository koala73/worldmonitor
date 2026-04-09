import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installSwUpdateHandler } from '../src/bootstrap/sw-update.ts';

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

interface FakeElement {
  tagName: string;
  className: string;
  innerHTML: string;
  dataset: Record<string, string>;
  _listeners: Record<string, Array<(e: unknown) => void>>;
  _removed: boolean;
  classList: { _classes: Set<string>; add(c: string): void; remove(c: string): void; has(c: string): boolean };
  remove(): void;
  addEventListener(type: string, cb: (e: unknown) => void): void;
  closest(sel: string): { dataset: Record<string, string> } | null;
}

interface FakeEnv {
  doc: {
    visibilityState: string;
    setVisibilityState(v: string): void;
    _removedListeners: Array<() => void>;
    querySelector(sel: string): FakeElement | null;
    createElement(tag: string): FakeElement;
    body: {
      appendChild(el: FakeElement): void;
      contains(el: FakeElement | null): boolean;
    };
    addEventListener(type: string, cb: () => void): void;
    removeEventListener(type: string, cb: () => void): void;
  };
  swContainer: {
    _controller: object | null;
    readonly controller: object | null;
    addEventListener(type: string, cb: () => void): void;
    fireControllerChange(): void;
  };
  reload: () => void;
  reloadCalls: number[];
  appendedToasts: FakeElement[];
  visibilityListeners: Array<() => void>;
  /** Pending dwell-timer callbacks. Each entry is the cb passed to setTimer (or a no-op if cleared). */
  pendingTimers: Array<() => void>;
}

function makeEnv(): FakeEnv {
  const visibilityListeners: Array<() => void> = [];
  const appendedToasts: FakeElement[] = [];
  const pendingTimers: Array<() => void> = [];
  let _visibilityState = 'visible';

  const doc: FakeEnv['doc'] = {
    get visibilityState() { return _visibilityState; },
    setVisibilityState(v: string) { _visibilityState = v; },
    _removedListeners: [],

    querySelector(sel: string): FakeElement | null {
      if (sel === '.update-toast') return appendedToasts.at(-1) ?? null;
      return null;
    },

    createElement(_tag: string): FakeElement {
      const el: FakeElement = {
        tagName: _tag.toUpperCase(),
        className: '',
        innerHTML: '',
        dataset: {},
        _listeners: {},
        _removed: false,
        classList: {
          _classes: new Set<string>(),
          add(c) { this._classes.add(c); },
          remove(c) { this._classes.delete(c); },
          has(c) { return this._classes.has(c); },
        },
        remove() { this._removed = true; },
        addEventListener(type: string, cb: (e: unknown) => void) {
          this._listeners[type] ??= [];
          this._listeners[type].push(cb);
        },
        closest(sel: string) {
          if (sel === '[data-action]') return null; // overridden per-click in clickToastButton
          return null;
        },
      };
      return el;
    },

    body: {
      appendChild(el: FakeElement) { appendedToasts.push(el); },
      contains(el: FakeElement | null): boolean {
        return el != null && !el._removed && appendedToasts.includes(el);
      },
    },

    addEventListener(type: string, cb: () => void) {
      if (type === 'visibilitychange') visibilityListeners.push(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      if (type === 'visibilitychange') {
        const i = visibilityListeners.indexOf(cb);
        if (i !== -1) visibilityListeners.splice(i, 1);
        doc._removedListeners.push(cb);
      }
    },
  };

  const swListeners: Array<() => void> = [];
  const swContainer: FakeEnv['swContainer'] = {
    _controller: null,
    get controller() { return this._controller; },
    addEventListener(type: string, cb: () => void) {
      if (type === 'controllerchange') swListeners.push(cb);
    },
    fireControllerChange() {
      for (const cb of [...swListeners]) cb();
    },
  };

  const reloadCalls: number[] = [];
  const reload = () => reloadCalls.push(Date.now());

  return { doc, swContainer, reload, reloadCalls, appendedToasts, visibilityListeners, pendingTimers };
}

function install(env: FakeEnv) {
  installSwUpdateHandler({
    swContainer: env.swContainer,
    document: env.doc,
    reload: env.reload,
    raf: (cb) => cb(), // synchronous — skips real rAF
    setTimer: (cb, _ms) => {
      const idx = env.pendingTimers.length;
      env.pendingTimers.push(cb);
      return idx as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (_id) => {
      const idx = _id as unknown as number;
      if (idx !== null && idx >= 0 && idx < env.pendingTimers.length) {
        env.pendingTimers.splice(idx, 1);
      }
    },
  });
}

/** Simulate tab visibility change (e.g. going to background). */
function fireVisibility(env: FakeEnv) {
  for (const cb of [...env.visibilityListeners]) cb();
}

/**
 * Fire the next pending dwell timer (simulates VISIBLE_DWELL_MS elapsing).
 * If the timer was cleared (dismiss/reload), the no-op is harmless.
 */
function fireDwellTimer(env: FakeEnv) {
  const cb = env.pendingTimers.shift();
  assert.ok(cb !== undefined, 'No pending dwell timer to fire');
  cb();
}

/** Simulate a button click inside the latest toast. */
function clickToastButton(env: FakeEnv, action: string) {
  const toast = env.appendedToasts.at(-1);
  assert.ok(toast, 'No toast found');
  const fakeTarget = {
    closest(sel: string) {
      if (sel === '[data-action]') return { dataset: { action } };
      return null;
    },
  };
  for (const cb of toast._listeners['click'] ?? []) {
    (cb as (e: { target: typeof fakeTarget }) => void)({ target: fakeTarget });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installSwUpdateHandler', () => {
  let env: FakeEnv;
  beforeEach(() => { env = makeEnv(); });

  // --- first-visit skip -------------------------------------------------------

  it('does not show a toast on the first controllerchange (no prior controller)', () => {
    env.swContainer._controller = null;
    install(env);
    env.swContainer.fireControllerChange();
    assert.equal(env.appendedToasts.length, 0);
  });

  it('shows a toast on controllerchange when a controller was already active', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    assert.equal(env.appendedToasts.length, 1);
  });

  // --- reload button ----------------------------------------------------------

  it('calls reload when the Reload button is clicked', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    clickToastButton(env, 'reload');
    assert.equal(env.reloadCalls.length, 1);
  });

  // --- dismiss button ---------------------------------------------------------

  it('does not call reload when dismiss is clicked', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    clickToastButton(env, 'dismiss');
    assert.equal(env.reloadCalls.length, 0);
  });

  it('removes the visibilitychange listener when dismiss is clicked', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    assert.ok(env.visibilityListeners.length > 0, 'expected a listener after toast shown');
    clickToastButton(env, 'dismiss');
    assert.equal(env.visibilityListeners.length, 0);
  });

  // --- hidden-tab auto-reload (requires dwell) --------------------------------

  it('calls reload when tab goes hidden after dwell timer elapses', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange(); // visible → dwell timer starts
    fireDwellTimer(env);                    // 5 s elapsed → autoReloadAllowed = true
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 1);
  });

  it('does NOT call reload when tab goes hidden before dwell timer fires', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange(); // visible → dwell timer pending
    // Do NOT call fireDwellTimer — autoReloadAllowed stays false
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0, 'no reload before dwell elapses');
  });

  it('does NOT call reload when tab goes hidden after dismiss', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    clickToastButton(env, 'dismiss');
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0);
  });

  // --- dwell timer start/cancel mechanics -------------------------------------

  it('starts dwell timer when toast appears while tab is visible', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    assert.equal(env.pendingTimers.length, 1, 'dwell timer queued on visible toast');
  });

  it('does NOT start dwell timer when toast appears while tab is hidden', () => {
    env.swContainer._controller = {};
    install(env);
    env.doc.setVisibilityState('hidden');
    env.swContainer.fireControllerChange();
    assert.equal(env.pendingTimers.length, 0, 'no dwell timer when tab already hidden');
  });

  it('starts dwell timer when tab returns to visible after a hidden-tab toast', () => {
    env.swContainer._controller = {};
    install(env);
    env.doc.setVisibilityState('hidden');
    env.swContainer.fireControllerChange();
    assert.equal(env.pendingTimers.length, 0, 'no timer while hidden');

    env.doc.setVisibilityState('visible');
    fireVisibility(env); // onHidden sees visible → startDwellTimer
    assert.equal(env.pendingTimers.length, 1, 'dwell timer started on return to visible');
  });

  // --- PRIMARY: multi-deploy same-tab scenario --------------------------------

  it('shows a new toast for deploy N+1 after deploy N was dismissed', () => {
    env.swContainer._controller = {};
    install(env);

    // Deploy N
    env.swContainer.fireControllerChange();
    assert.equal(env.appendedToasts.length, 1, 'toast shown for deploy N');

    // User dismisses deploy N
    clickToastButton(env, 'dismiss');
    assert.equal(env.reloadCalls.length, 0, 'no reload on dismiss');

    // Deploy N+1
    env.swContainer.fireControllerChange();
    assert.equal(env.appendedToasts.length, 2, 'new toast shown for deploy N+1');
  });

  it('hidden-tab fallback fires for deploy N+1 after deploy N was dismissed', () => {
    env.swContainer._controller = {};
    install(env);

    // Deploy N — dismiss (dwell timer cleared)
    env.swContainer.fireControllerChange();
    clickToastButton(env, 'dismiss');
    assert.equal(env.reloadCalls.length, 0);

    // Deploy N+1 — dwell then hide
    env.swContainer.fireControllerChange();
    assert.equal(env.appendedToasts.length, 2, 'new toast shown for N+1');

    fireDwellTimer(env); // 5 s visible → autoReloadAllowed
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 1, 'reload fires on hidden after N+1 toast');
  });

  it('hidden-tab fallback does NOT fire when both N and N+1 toasts were dismissed', () => {
    env.swContainer._controller = {};
    install(env);

    env.swContainer.fireControllerChange();
    clickToastButton(env, 'dismiss');

    env.swContainer.fireControllerChange();
    clickToastButton(env, 'dismiss');

    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0, 'no reload — both toasts dismissed');
  });

  // --- P1 regression: hidden time must not count toward dwell ----------------

  it('does NOT reload when dwell timer fires after the tab went hidden (background tick)', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange(); // visible → dwell starts

    // Tab hides before dwell completes — timer should be cancelled
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.pendingTimers.length, 0, 'dwell timer cancelled on hide');

    // Tab stays hidden — no reload
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0, 'no reload — dwell never completed');
  });

  it('requires a full fresh dwell after hide/show cycle before auto-reload', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange(); // visible → dwell starts

    // Hide at "1 s" — cancels dwell
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.pendingTimers.length, 0, 'dwell cancelled on hide');

    // Return to visible — new dwell starts
    env.doc.setVisibilityState('visible');
    fireVisibility(env);
    assert.equal(env.pendingTimers.length, 1, 'fresh dwell timer started on return');

    // Complete the new dwell → autoReloadAllowed
    fireDwellTimer(env);

    // Hide → auto-reload fires
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 1, 'reload fires only after full dwell completes');
  });

  // --- P2 regression: stale dwell timer cleared when newer deploy supersedes --

  it('cancels the previous dwell timer when a newer deploy supersedes the toast', () => {
    env.swContainer._controller = {};
    install(env);

    // Deploy N: visible → dwell timer starts
    env.swContainer.fireControllerChange();
    assert.equal(env.pendingTimers.length, 1, 'N dwell timer queued');

    // Deploy N+1: supersedes toast → old dwell must be cancelled
    env.swContainer.fireControllerChange();
    assert.equal(env.pendingTimers.length, 1, 'exactly one dwell timer active (N+1 only)');
  });

  // --- visible-transition must NOT reload (P1 regression guard) ---------------

  it('does NOT reload when visibilitychange fires while state is still visible', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    fireDwellTimer(env);
    // tab stays visible — fire visibilitychange anyway (e.g. focus events on some browsers)
    env.doc.setVisibilityState('visible');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0);
  });

  it('does NOT reload when tab goes hidden then returns to visible', () => {
    env.swContainer._controller = {};
    install(env);
    env.swContainer.fireControllerChange();
    fireDwellTimer(env); // dwell elapsed → autoReloadAllowed

    // go hidden → should reload
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 1);

    // now visible would not add a second reload
    env.doc.setVisibilityState('visible');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 1, 'no second reload on visible transition');
  });

  // --- background-loop prevention (infinite reload bug fix) -------------------

  it('does NOT auto-reload when update fires while tab is already hidden', () => {
    env.swContainer._controller = {};
    install(env);

    // Tab is in the background when the SW update activates
    env.doc.setVisibilityState('hidden');
    env.swContainer.fireControllerChange();

    // visibilitychange fires but tab is still hidden — must NOT reload (prevents infinite loop)
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0, 'no auto-reload when already in background');
  });

  it('allows auto-reload after user returns to the tab that received a background update', () => {
    env.swContainer._controller = {};
    install(env);

    // Update fires while hidden
    env.doc.setVisibilityState('hidden');
    env.swContainer.fireControllerChange();
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0, 'no reload yet — tab still hidden');

    // User returns to the tab — dwell timer starts
    env.doc.setVisibilityState('visible');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 0, 'no reload on becoming visible');

    // Dwell elapses → autoReloadAllowed = true
    fireDwellTimer(env);

    // User switches away — auto-reload is now allowed
    env.doc.setVisibilityState('hidden');
    fireVisibility(env);
    assert.equal(env.reloadCalls.length, 1, 'reload fires when user switches away after seeing toast');
  });

  // --- listener leak regression -----------------------------------------------

  it('removes the previous visibilitychange handler when a newer deploy replaces the toast', () => {
    env.swContainer._controller = {};
    install(env);

    // Deploy N — show toast, do NOT dismiss
    env.swContainer.fireControllerChange();
    assert.equal(env.visibilityListeners.length, 1, 'one listener after deploy N');

    // Deploy N+1 — replaces toast
    env.swContainer.fireControllerChange();
    assert.equal(env.visibilityListeners.length, 1, 'still exactly one listener after N+1');
    assert.ok(env.doc._removedListeners.length > 0, 'old listener was explicitly removed');
  });
});
