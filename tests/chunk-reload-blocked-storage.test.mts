import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearChunkReloadGuard, installChunkReloadGuard } from '../src/bootstrap/chunk-reload';

interface TestEventTarget {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

describe('chunk reload guard with blocked sessionStorage', () => {
  it('keeps one-shot reload behavior and clears safely when the storage getter throws', () => {
    const originalWindow = globalThis.window;
    let listener: EventListenerOrEventListenerObject | undefined;
    let reloads = 0;
    const eventTarget: TestEventTarget = {
      addEventListener(_type, nextListener) {
        listener = nextListener;
      },
    };
    const fakeWindow = {
      get sessionStorage(): Storage {
        throw new DOMException('storage blocked', 'SecurityError');
      },
    };

    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    try {
      const storageKey = installChunkReloadGuard('blocked-storage-test', {
        eventTarget,
        reload: () => { reloads += 1; },
      });

      assert.equal(typeof listener, 'function');
      (listener as EventListener)(new Event('vite:preloadError'));
      (listener as EventListener)(new Event('vite:preloadError'));
      assert.equal(reloads, 1, 'the memory fallback must preserve the one-shot guard');

      assert.doesNotThrow(() => clearChunkReloadGuard(storageKey));
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});
