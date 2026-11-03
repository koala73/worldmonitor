// The desktop alert used to pitch a waitlist for a license that already ships
// as World Monitor Pro, and kept telling Pro users their features needed keys
// after Pro started supplying cloud data on desktop (#9396).
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeConfigPanelHarness } from './helpers/runtime-config-panel-harness.mjs';

const harness = await createRuntimeConfigPanelHarness();
const PARTIAL = { totalFeatures: 4, availableFeatures: 2, configuredCount: 1 };

afterEach(() => harness.reset());
after(() => harness.cleanup());

describe('runtime config alert Pro copy', () => {
  it('offers World Monitor Pro, not a waitlist, to a free desktop', () => {
    harness.setRuntimeState(PARTIAL);
    const html = harness.createPanel().content.innerHTML;
    assert.equal(harness.getAlertState(harness.createPanel()), 'some');
    assert.match(html, /modals\.runtimeConfig\.skipSetupPro/);
    assert.match(html, /data-get-pro[^>]*>\s*modals\.runtimeConfig\.getPro/);
    assert.doesNotMatch(html, /reserveEarlyAccess|modals\.runtimeConfig\.skipSetup(?!Pro)|data-early-access/);
  });

  it('tells a Pro desktop that cloud data covers missing keys, with no upsell', () => {
    harness.setRuntimeState(PARTIAL);
    harness.setEntitled(true);
    const panel = harness.createPanel();
    assert.equal(harness.isHidden(panel), false);
    assert.equal(harness.getAlertState(panel), 'pro');
    assert.match(panel.content.innerHTML, /modals\.runtimeConfig\.alertTitle\.pro/);
    assert.match(panel.content.innerHTML, /modals\.runtimeConfig\.proCloud/);
    assert.doesNotMatch(panel.content.innerHTML, /data-get-pro|skipSetupPro/);
  });

  it('switches to the Pro state when the entitlement arrives after render', () => {
    harness.setRuntimeState(PARTIAL);
    const panel = harness.createPanel();
    assert.equal(harness.getAlertState(panel), 'some');
    harness.setEntitled(true);
    assert.equal(harness.getAlertState(panel), 'pro');
  });
});
