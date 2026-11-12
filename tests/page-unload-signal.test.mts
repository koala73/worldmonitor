import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  _resetPageUnloadSignalForTests,
  installPageUnloadSignal,
  isPageUnloading,
} from '../src/bootstrap/page-unload-signal.ts';

function fakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type: string) { for (const fn of listeners.get(type) ?? []) fn(); },
    count(type: string) { return listeners.get(type)?.length ?? 0; },
  };
}

afterEach(() => _resetPageUnloadSignalForTests());

describe('page unload signal', () => {
  it('is false until the page starts to unload', () => {
    installPageUnloadSignal(fakeWindow() as never);
    assert.equal(isPageUnloading(), false);
  });

  it('turns on at beforeunload and at pagehide', () => {
    for (const type of ['beforeunload', 'pagehide']) {
      _resetPageUnloadSignalForTests();
      const win = fakeWindow();
      installPageUnloadSignal(win as never);
      win.fire(type);
      assert.equal(isPageUnloading(), true, type);
    }
  });

  it('expires after the window, so a cancelled navigation reports normally again', () => {
    const win = fakeWindow();
    installPageUnloadSignal(win as never);
    const start = Date.now();
    win.fire('beforeunload');
    assert.equal(isPageUnloading(start + 2_900), true);
    assert.equal(isPageUnloading(start + 3_200), false);
  });

  it('clears when a bfcache page is shown again', () => {
    const win = fakeWindow();
    installPageUnloadSignal(win as never);
    win.fire('pagehide');
    win.fire('pageshow');
    assert.equal(isPageUnloading(), false);
  });

  it('installs its listeners once', () => {
    const win = fakeWindow();
    installPageUnloadSignal(win as never);
    installPageUnloadSignal(win as never);
    assert.equal(win.count('beforeunload'), 1);
  });
});
