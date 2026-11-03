import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createMinimalPanelHarness } from './helpers/minimal-panel-harness.mjs';

type Calls = { __layoutCustomizedCalls?: string[] };

function pointer(type: string, clientY: number): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientY });
}

describe('Panel row resize reports layout customization (#6420)', () => {
  afterEach(() => {
    delete (globalThis as Calls).__layoutCustomizedCalls;
  });

  it('a completed drag that changes the span fires panel-resize; a bare click does not', async () => {
    const harness = await createMinimalPanelHarness();
    try {
      const panel = harness.createPanel({ id: 'layout-telemetry-test' });
      const handle = panel.getElement().querySelector('.panel-resize-handle');
      assert.ok(handle, 'row resize handle rendered');

      handle.dispatchEvent(pointer('mousedown', 0));
      harness.document.dispatchEvent(pointer('mouseup', 0));
      assert.deepEqual((globalThis as Calls).__layoutCustomizedCalls ?? [], [], 'click without drag');

      handle.dispatchEvent(pointer('mousedown', 0));
      harness.document.dispatchEvent(pointer('mousemove', 1000));
      harness.document.dispatchEvent(pointer('mouseup', 1000));
      assert.deepEqual((globalThis as Calls).__layoutCustomizedCalls, ['panel-resize']);
    } finally {
      harness.cleanup();
    }
  });
});
