import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHUNK_RELOAD_STORAGE_KEY, installChunkReloadGuard } from '../src/bootstrap/chunk-reload';

interface TestEventTarget {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

const blocked = (): never => {
  throw new DOMException('storage blocked', 'SecurityError');
};

async function reloadsWithWindow(fakeWindow: object, events: number): Promise<number> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let listener: EventListenerOrEventListenerObject | undefined;
  let reloads = 0;
  const eventTarget: TestEventTarget = {
    addEventListener(_type, nextListener) {
      listener = nextListener;
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  try {
    installChunkReloadGuard('blocked-storage-test', {
      eventTarget,
      reload: () => { reloads += 1; },
    });
    assert.equal(typeof listener, 'function');
    for (let i = 0; i < events; i += 1) {
      (listener as EventListener)(new Event('vite:preloadError'));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return reloads;
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

describe('chunk reload guard with blocked storage', () => {
  it('records the reload in localStorage when the sessionStorage getter throws', async () => {
    const local = new Map<string, string>();
    const fakeWindow = {
      get sessionStorage(): Storage {
        return blocked();
      },
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => { local.set(key, value); },
      },
    };

    assert.equal(await reloadsWithWindow(fakeWindow, 2), 1);
    assert.equal(local.get(CHUNK_RELOAD_STORAGE_KEY), 'blocked-storage-test');
  });

  it('does not reload, and does not throw, when every storage getter throws', async () => {
    const fakeWindow = {
      get sessionStorage(): Storage {
        return blocked();
      },
      get localStorage(): Storage {
        return blocked();
      },
    };

    assert.equal(await reloadsWithWindow(fakeWindow, 2), 0);
  });
});
