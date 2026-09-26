import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installChunkReloadGuard } from '../src/bootstrap/chunk-reload';
import {
  RELOAD_BLOCKING_MODAL_SELECTOR,
  RELOAD_POLICY_ATTR,
  type VisibleElementLike,
} from '../src/utils/open-modal';

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

type ModalState = 'none' | 'open' | 'mounted-hidden';

interface FakeEnv {
  modal: ModalState;
  visibilityState: 'visible' | 'hidden';
  reloadCalls: number;
  storage: Map<string, string>;
  preloadListeners: EventListener[];
  focusListeners: EventListener[];
  visibilityListeners: EventListener[];
}

function makeEnv(): FakeEnv {
  return {
    modal: 'none',
    visibilityState: 'visible',
    reloadCalls: 0,
    storage: new Map(),
    preloadListeners: [],
    focusListeners: [],
    visibilityListeners: [],
  };
}

function makeEl(visible: boolean, declared: boolean): Element & VisibleElementLike {
  return {
    checkVisibility: () => visible,
    getClientRects: () => ({ length: visible ? 1 : 0 }),
    className: declared ? 'modal-overlay' : 'cl-modalBackdrop',
    tagName: 'DIV',
    getAttribute: (name: string) =>
      name === RELOAD_POLICY_ATTR && declared ? 'blocking' : null,
  } as unknown as Element & VisibleElementLike;
}

function install(env: FakeEnv) {
  const storage = {
    getItem: (k: string) => env.storage.get(k) ?? null,
    setItem: (k: string, v: string) => { env.storage.set(k, v); },
    removeItem: (k: string) => { env.storage.delete(k); },
  };

  const eventTarget = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const fn = listener as EventListener;
      if (type === 'vite:preloadError') env.preloadListeners.push(fn);
      else if (type === 'focus') env.focusListeners.push(fn);
    },
  };

  const documentTarget = {
    get visibilityState() { return env.visibilityState; },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'visibilitychange')
        env.visibilityListeners.push(listener as EventListener);
    },
    querySelectorAll(sel: string): Iterable<Element & VisibleElementLike> {
      if (sel !== RELOAD_BLOCKING_MODAL_SELECTOR) return [];
      if (env.modal === 'none') return [];
      if (env.modal === 'mounted-hidden') return [makeEl(false, true)];
      // 'open': one hidden (always-mounted), one visible (Clerk/blocking)
      return [makeEl(false, true), makeEl(true, false)];
    },
  };

  return installChunkReloadGuard('test-version', {
    eventTarget,
    storage,
    reload: () => { env.reloadCalls += 1; },
    documentTarget,
  });
}

async function firePreloadError(env: FakeEnv) {
  for (const fn of [...env.preloadListeners]) fn(new Event('vite:preloadError'));
  await new Promise((r) => setTimeout(r, 0));
}

async function fireFocus(env: FakeEnv) {
  for (const fn of [...env.focusListeners]) fn(new Event('focus'));
  await new Promise((r) => setTimeout(r, 0));
}

async function fireVisibilityChange(env: FakeEnv, state: 'visible' | 'hidden') {
  env.visibilityState = state;
  for (const fn of [...env.visibilityListeners]) fn(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installChunkReloadGuard — modal guard', () => {

  it('reloads immediately when no modal is open', async () => {
    const env = makeEnv();
    install(env);
    await firePreloadError(env);
    assert.equal(env.reloadCalls, 1);
  });

  it('does NOT reload and does NOT burn the session key under an open modal', async () => {
    const env = makeEnv();
    env.modal = 'open';
    const storageKey = install(env);
    await firePreloadError(env);
    assert.equal(env.reloadCalls, 0, 'reload deferred');
    assert.equal(env.storage.get(storageKey), undefined, 'session key not burned');
  });

  it('reloads on the next focus after the modal closes', async () => {
    const env = makeEnv();
    env.modal = 'open';
    install(env);
    await firePreloadError(env);
    assert.equal(env.reloadCalls, 0);

    env.modal = 'none';
    await fireFocus(env);
    assert.equal(env.reloadCalls, 1, 'reload fires on focus once modal gone');
  });

  it('burns the session key when the deferred reload fires', async () => {
    const env = makeEnv();
    env.modal = 'open';
    const storageKey = install(env);
    await firePreloadError(env);

    env.modal = 'none';
    await fireFocus(env);
    assert.equal(env.storage.get(storageKey), '1', 'key burned on actual reload');
  });

  it('reloads on visibilitychange→visible after the modal closes', async () => {
    const env = makeEnv();
    env.modal = 'open';
    install(env);
    await firePreloadError(env);
    assert.equal(env.reloadCalls, 0);

    env.modal = 'none';
    await fireVisibilityChange(env, 'visible');
    assert.equal(env.reloadCalls, 1);
  });

  it('does NOT reload on visibilitychange→hidden', async () => {
    const env = makeEnv();
    env.modal = 'open';
    install(env);
    await firePreloadError(env);

    env.modal = 'none';
    await fireVisibilityChange(env, 'hidden');
    assert.equal(env.reloadCalls, 0, 'hidden→background does not fire reload');
  });

  it('stays deferred when focus fires but modal is still open', async () => {
    const env = makeEnv();
    env.modal = 'open';
    install(env);
    await firePreloadError(env);

    await fireFocus(env);  // modal still open
    assert.equal(env.reloadCalls, 0, 'still deferred');

    env.modal = 'none';
    await fireFocus(env);
    assert.equal(env.reloadCalls, 1, 'fires once modal gone');
  });

  it('is one-shot: second preloadError after reload does nothing', async () => {
    const env = makeEnv();
    install(env);
    await firePreloadError(env);
    assert.equal(env.reloadCalls, 1);

    await firePreloadError(env);
    assert.equal(env.reloadCalls, 1, 'one-shot guard prevents second reload');
  });

  it('reloads immediately when no documentTarget is provided (backward compat)', async () => {
    const env = makeEnv();
    env.modal = 'open';  // would block if documentTarget were set
    let reloads = 0;
    const eventTarget = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === 'vite:preloadError') env.preloadListeners.push(listener as EventListener);
      },
    };
    installChunkReloadGuard('no-doc-test', {
      eventTarget,
      storage: {
        getItem: (k) => env.storage.get(k) ?? null,
        setItem: (k, v) => { env.storage.set(k, v); },
        removeItem: (k) => { env.storage.delete(k); },
      },
      reload: () => { reloads += 1; },
      // no documentTarget
    });
    await firePreloadError(env);
    assert.equal(reloads, 1, 'no documentTarget → immediate reload');
  });

  it('hidden mounted modal does not block reload', async () => {
    // UnifiedSettings is always in the DOM but display:none when closed.
    // findReloadBlockingModal skips non-rendered elements.
    const env = makeEnv();
    env.modal = 'mounted-hidden';
    install(env);
    await firePreloadError(env);
    assert.equal(env.reloadCalls, 1, 'hidden overlay does not block reload');
  });

});
