import assert from 'node:assert/strict';
import test from 'node:test';

import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

test('mobile deep dive closes through Back, restores focus, and releases its callback', async () => {
  const harness = await createCountryDeepDivePanelHarness({ mobile: true });
  try {
    const trigger = harness.document.createElement('button');
    harness.document.body.appendChild(trigger);
    trigger.focus();

    const panel = harness.createPanel();
    let closeCalls = 0;
    panel.onClose(() => { closeCalls += 1; });
    panel.show('Canada', 'CA', null, {});

    assert.equal(harness.getHistoryEntry(), 'deep-dive');
    assert.equal(harness.getPanelRoot().classList.contains('active'), true);
    assert.equal(harness.historyBack(), 'deep-dive');
    assert.equal(harness.getPanelRoot().classList.contains('active'), false);
    assert.equal(harness.document.activeElement, trigger);
    assert.equal(closeCalls, 1);
    assert.equal(harness.getHistoryEntry(), null);

    assert.equal(harness.historyForward(), 'deep-dive');
    assert.equal(harness.getPanelRoot().classList.contains('active'), false, 'Forward cannot resurrect the panel');
    assert.equal(closeCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test('mobile deep dive control close clears its history marker', async () => {
  const harness = await createCountryDeepDivePanelHarness({ mobile: true });
  try {
    const panel = harness.createPanel();
    let closeCalls = 0;
    panel.onClose(() => { closeCalls += 1; });
    panel.show('Canada', 'CA', null, {});

    const closeButton = harness.getPanelRoot().querySelector('#deep-dive-close');
    assert.ok(closeButton, 'the deep-dive close control must be rendered');
    closeButton.dispatchEvent(new Event('click'));

    assert.equal(harness.getPanelRoot().classList.contains('active'), false);
    assert.equal(harness.getHistoryEntry(), null);
    assert.equal(closeCalls, 1);
  } finally {
    harness.cleanup();
  }
});
