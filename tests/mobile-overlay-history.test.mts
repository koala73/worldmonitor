import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OverlayHistoryManager, type OverlayHistoryEnvironment } from '../src/utils/overlay-history';

function createEnvironment({ asyncBack = false, initialState = null } = {}) {
  const listeners = new Set<(event: PopStateEvent) => void>();
  const entries: unknown[] = [initialState];
  const pendingBacks: Array<() => void> = [];
  let index = 0;

  const environment: OverlayHistoryEnvironment = {
    get state() {
      return entries[index];
    },
    pushState(state) {
      entries.splice(index + 1, entries.length, structuredClone(state));
      index += 1;
    },
    replaceState(state) {
      entries[index] = structuredClone(state);
    },
    back() {
      if (index === 0) return;
      const navigate = () => {
        index -= 1;
        const event = { state: entries[index] } as PopStateEvent;
        listeners.forEach((listener) => listener(event));
      };
      if (asyncBack) pendingBacks.push(navigate);
      else navigate();
    },
    addPopStateListener(listener) {
      listeners.add(listener);
    },
    removePopStateListener(listener) {
      listeners.delete(listener);
    },
  };

  const forward = () => {
    if (index >= entries.length - 1) return;
    index += 1;
    const event = { state: entries[index] } as PopStateEvent;
    listeners.forEach((listener) => listener(event));
  };

  const flushBack = () => {
    const navigate = pendingBacks.shift();
    assert.ok(navigate, 'an asynchronous Back navigation must be pending');
    navigate();
  };

  return { environment, getIndex: () => index, forward, flushBack };
}

describe('OverlayHistoryManager', () => {
  it('closes only the topmost overlay when browser Back is pressed', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('menu', () => closed.push('menu'));
    manager.open('search', () => closed.push('search'));
    assert.equal(getIndex(), 2);

    environment.back();
    assert.deepEqual(closed, ['search']);
    assert.equal(manager.top(), 'menu');

    environment.back();
    assert.deepEqual(closed, ['search', 'menu']);
    assert.equal(manager.top(), null);
    manager.destroy();
  });

  it('replaces menu history when transitioning into a nested region sheet', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('menu', () => closed.push('menu'));
    manager.replace('menu', 'region', () => closed.push('region'));
    assert.equal(getIndex(), 1, 'the transition must not require two Back presses');
    assert.equal(manager.top(), 'region');

    environment.back();
    assert.deepEqual(closed, ['region']);
    assert.equal(manager.top(), null);
    manager.destroy();
  });

  it('removes its synthetic entry when an overlay closes from its own control', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let popCloseCalls = 0;

    manager.open('settings', () => { popCloseCalls += 1; });
    manager.close('settings');

    assert.equal(getIndex(), 0);
    assert.equal(popCloseCalls, 0, 'the caller already closed the UI');
    assert.equal(manager.top(), null);
    manager.destroy();
  });

  it('discards retained callbacks and the active marker during app teardown', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let closeCalls = 0;

    manager.open('menu', () => { closeCalls += 1; });
    manager.reset();

    assert.equal(manager.top(), null);
    assert.equal(getIndex(), 1, 'teardown must not navigate the page');
    assert.equal((environment.state as Record<string, unknown>).__wmOverlay, undefined);
    environment.back();
    assert.equal(closeCalls, 0, 'discarded UI callbacks must not run after teardown');
    manager.destroy();
  });

  it('scrubs stale overlay markers instead of resurrecting UI on Forward', () => {
    const { environment, forward } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let closeCalls = 0;

    manager.open('search', () => { closeCalls += 1; });
    manager.close('search');
    forward();

    assert.equal(manager.top(), null);
    assert.equal(closeCalls, 0);
    assert.equal((environment.state as Record<string, unknown>).__wmOverlay, undefined);
    manager.destroy();
  });

  it('drains a fixed snapshot when a close callback opens another overlay', () => {
    const { environment } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('settings', () => {
      closed.push('settings');
      manager.open('search', () => closed.push('search'));
    });
    environment.back();

    assert.deepEqual(closed, ['settings']);
    assert.equal(manager.top(), 'search');
    manager.destroy();
  });

  it('queues an open until an asynchronous Back traversal settles', () => {
    const { environment, getIndex, flushBack } = createEnvironment({ asyncBack: true });
    const manager = new OverlayHistoryManager(environment);

    manager.open('search', () => {});
    manager.close('search');
    manager.open('settings', () => {});

    assert.equal(getIndex(), 1, 'history.state remains on the closing marker until popstate');
    assert.equal(manager.top(), null, 'the next overlay must wait for the pending traversal');

    flushBack();
    assert.equal(getIndex(), 1, 'the queued overlay gets one fresh history entry');
    assert.equal(manager.top(), 'settings');
    assert.equal(
      ((environment.state as Record<string, unknown>).__wmOverlay as { id: string }).id,
      'settings',
    );
    manager.destroy();
  });

  it('cancels a queued open when the overlay is hidden before Back settles', () => {
    const { environment, flushBack } = createEnvironment({ asyncBack: true });
    const manager = new OverlayHistoryManager(environment);

    manager.open('search', () => {});
    manager.close('search');
    const open = manager.openCancelable('map-popup', () => {});
    open.cancel();

    flushBack();
    assert.equal(manager.top(), null);
    assert.equal(environment.state, null);
    manager.destroy();
  });

  it('strips an orphaned marker left by a page reload', () => {
    const { environment, getIndex } = createEnvironment({
      initialState: { __wmOverlay: { id: 'search', token: 'previous-page' } },
    });
    const manager = new OverlayHistoryManager(environment);

    assert.equal(getIndex(), 0);
    assert.equal((environment.state as Record<string, unknown>).__wmOverlay, undefined);
    manager.open('search', () => {});
    manager.close('search');
    assert.equal(getIndex(), 0, 'the first Back closes the new overlay entry');
    manager.destroy();
  });

  it('keeps a pending gate current while its marker waits behind popstate', () => {
    const { environment, flushBack } = createEnvironment({ asyncBack: true });
    const manager = new OverlayHistoryManager(environment);

    manager.open('menu', () => {});
    manager.close('menu');
    const gate = manager.beginPending('search-pending', undefined, () => {});
    assert.equal(gate.isCurrent(), true);
    manager.replace('search-pending', 'search', () => {});

    flushBack();
    assert.equal(manager.top(), 'search');
    manager.destroy();
  });

  it('falls back to a new entry when replace does not match the top overlay', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const closed: string[] = [];

    manager.open('menu', () => closed.push('menu'));
    manager.replace('search', 'settings', () => closed.push('settings'));

    assert.equal(getIndex(), 2);
    assert.equal(manager.top(), 'settings');
    environment.back();
    assert.deepEqual(closed, ['settings']);
    assert.equal(manager.top(), 'menu');
    manager.destroy();
  });

  it('replaces a visible overlay in place and reports replacement origin', () => {
    const { environment, getIndex } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    const origins: string[] = [];

    manager.open('menu', (origin) => origins.push(`menu:${origin}`));
    manager.replaceInPlace('menu', 'search-pending', (origin) => origins.push(`search:${origin}`));

    assert.equal(getIndex(), 1);
    assert.equal(manager.top(), 'search-pending');
    assert.deepEqual(origins, ['menu:replacement']);
    environment.back();
    assert.deepEqual(origins, ['menu:replacement', 'search:history']);
    manager.destroy();
  });

  it('invalidates superseded pending gates', () => {
    const { environment } = createEnvironment();
    const manager = new OverlayHistoryManager(environment);
    let firstCancels = 0;
    let secondCancels = 0;
    const first = manager.beginPending('search-pending', undefined, () => { firstCancels += 1; });
    const second = manager.beginPending('search-pending', undefined, () => { secondCancels += 1; });

    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
    assert.equal(manager.top(), 'search-pending');
    assert.equal(firstCancels, 0);
    assert.equal(secondCancels, 0);
    manager.destroy();
  });
});
