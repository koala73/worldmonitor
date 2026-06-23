import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMinimalPanelHarness } from './helpers/minimal-panel-harness.mjs';

describe('Panel.runWhenConnected', () => {
  let harness: Awaited<ReturnType<typeof createMinimalPanelHarness>>;
  let originalMutationObserver: PropertyDescriptor | undefined;
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(async () => {
    originalMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: function MutationObserverShouldNotBeUsed() {
        throw new Error('runWhenConnected must not install a MutationObserver');
      },
    });
    originalSetTimeout = globalThis.setTimeout;
    harness = await createMinimalPanelHarness();
  });

  afterEach(() => {
    harness.cleanup();
    globalThis.setTimeout = originalSetTimeout;
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

    harness.document.body.appendChild(panel.getElement());
    assert.equal(calls, 0, 'DOM insertion alone should wait for the layout attachment signal');

    panel.publicNotifyConnected();

    assert.equal(calls, 1, 'queued work should run once after connection');
  });

  it('drops queued work when the panel is destroyed before connection', () => {
    const panel = harness.createPanel();
    let calls = 0;

    panel.publicRunWhenConnected(() => { calls += 1; });

    panel.destroy();
    harness.document.body.appendChild(panel.getElement());
    panel.publicNotifyConnected();

    assert.equal(calls, 0, 'destroy should discard queued connected work');
  });

  it('does not re-arm queued work when called after destroy', () => {
    const panel = harness.createPanel();

    // Normal teardown: queue once, then destroy clears the pending connected work.
    panel.publicRunWhenConnected(() => {});
    panel.destroy();

    // A late async callback (an in-flight fetch's `.finally(() => scheduleRefresh())`
    // resolving after destroy) re-enters runWhenConnected. It must not queue work.
    let lateCalls = 0;
    const rearmed = panel.publicRunWhenConnected(() => { lateCalls += 1; });

    assert.equal(rearmed, false, 'post-destroy runWhenConnected must report not-run');
    assert.equal(lateCalls, 0, 'destroyed panel must not run queued work');
  });

  it('does not run the synchronous fast-path after destroy while still attached', () => {
    const panel = harness.createPanel();
    harness.document.body.appendChild(panel.getElement());
    // destroy() does not detach the element, so isConnected stays true.
    panel.destroy();

    let calls = 0;
    const ran = panel.publicRunWhenConnected(() => { calls += 1; });

    assert.equal(ran, false, 'fast-path must be blocked after destroy');
    assert.equal(calls, 0, 'callback must not run on a destroyed panel');
  });

  it('retries in environments without MutationObserver until attachment is visible', async () => {
    delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
    const panel = harness.createPanel();
    let calls = 0;

    panel.publicRunWhenConnected(() => { calls += 1; });
    await new Promise(resolve => originalSetTimeout(resolve, 70));
    assert.equal(calls, 0, 'fallback must not drop detached work before attachment');

    harness.document.body.appendChild(panel.getElement());
    await new Promise(resolve => originalSetTimeout(resolve, 70));

    assert.equal(calls, 1, 'fallback retry should flush after eventual attachment');
  });

  it('surfaces callback errors without preventing later queued callbacks', () => {
    const panel = harness.createPanel();
    const scheduledThrows: Array<() => void> = [];
    globalThis.setTimeout = ((cb: TimerHandler): number => {
      if (typeof cb === 'function') scheduledThrows.push(cb as () => void);
      return 0;
    }) as typeof globalThis.setTimeout;
    let secondRan = false;

    panel.publicRunWhenConnected(() => { throw new Error('connected callback failed'); });
    panel.publicRunWhenConnected(() => { secondRan = true; });

    harness.document.body.appendChild(panel.getElement());
    panel.publicNotifyConnected();

    assert.equal(secondRan, true, 'later callbacks should still run after an earlier callback throws');
    assert.equal(scheduledThrows.length, 1, 'callback error should be re-thrown asynchronously');
    assert.throws(scheduledThrows[0], /connected callback failed/);
  });

  it('does not use a full-document MutationObserver for connection waiting', async () => {
    const source = await readFile(new URL('../src/components/Panel.ts', import.meta.url), 'utf8');

    assert.equal(source.includes('new MutationObserver'), false);
    assert.equal(source.includes('subtree: true'), false);
  });
});
