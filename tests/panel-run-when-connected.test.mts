import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMinimalPanelHarness } from './helpers/minimal-panel-harness.mjs';

class TestMutationObserver {
  static instances: TestMutationObserver[] = [];
  private readonly callback: () => void;
  public disconnected = false;

  constructor(callback: () => void) {
    this.callback = callback;
    TestMutationObserver.instances.push(this);
  }

  observe(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  flush(): void {
    this.callback();
  }
}

describe('Panel.runWhenConnected', () => {
  let harness: Awaited<ReturnType<typeof createMinimalPanelHarness>>;
  let originalMutationObserver: PropertyDescriptor | undefined;

  beforeEach(async () => {
    originalMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: TestMutationObserver,
    });
    TestMutationObserver.instances = [];
    harness = await createMinimalPanelHarness();
  });

  afterEach(() => {
    harness.cleanup();
    if (originalMutationObserver) {
      Object.defineProperty(globalThis, 'MutationObserver', originalMutationObserver);
    } else {
      delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
    }
  });

  it('queues work until the panel element is connected', () => {
    const panel = harness.createPanel();
    let calls = 0;

    const ranImmediately = panel.publicRunWhenConnected(() => { calls += 1; });

    assert.equal(ranImmediately, false);
    assert.equal(calls, 0, 'detached work should not run');
    assert.equal(TestMutationObserver.instances.length, 1, 'detached work should install one observer');

    harness.document.body.appendChild(panel.getElement());
    TestMutationObserver.instances[0].flush();

    assert.equal(calls, 1, 'queued work should run once after connection');
    assert.equal(TestMutationObserver.instances[0].disconnected, true, 'observer should disconnect after flushing');
  });

  it('drops queued work when the panel is destroyed before connection', () => {
    const panel = harness.createPanel();
    let calls = 0;

    panel.publicRunWhenConnected(() => { calls += 1; });
    assert.equal(TestMutationObserver.instances.length, 1);

    panel.destroy();
    harness.document.body.appendChild(panel.getElement());
    TestMutationObserver.instances[0].flush();

    assert.equal(calls, 0, 'destroy should discard queued connected work');
    assert.equal(TestMutationObserver.instances[0].disconnected, true);
  });
});
