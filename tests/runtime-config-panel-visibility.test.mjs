import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeConfigPanelHarness } from './helpers/runtime-config-panel-harness.mjs';

const harness = await createRuntimeConfigPanelHarness();

afterEach(() => {
  harness.reset();
});

after(() => {
  harness.cleanup();
});

describe('runtime config panel visibility', () => {
  it('keeps a fully configured desktop alert hidden when panel settings replay toggle(true)', () => {
    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 4,
      configuredCount: 4,
    });

    const panel = harness.createPanel();

    assert.equal(harness.isHidden(panel), true, 'configured alert should auto-hide on initial render');

    panel.toggle(true);

    assert.equal(
      harness.isHidden(panel),
      true,
      'reapplying enabled panel settings must not re-show an already configured alert',
    );
  });

  it('rerenders the current alert state when reopening after an explicit hide', () => {
    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 1,
      configuredCount: 0,
    });

    const panel = harness.createPanel();
    panel.hide();

    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 2,
      configuredCount: 1,
    });

    panel.toggle(true);

    assert.equal(harness.isHidden(panel), false, 'reopening should make the panel visible again');
    assert.equal(
      harness.getAlertState(panel),
      'some',
      'reopening should recompute the partial-configuration alert state',
    );
  });

  it('reappears when configuration becomes incomplete after auto-hiding as configured', () => {
    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 4,
      configuredCount: 4,
    });

    const panel = harness.createPanel();
    assert.equal(harness.isHidden(panel), true, 'configured alert should start hidden');

    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 2,
      configuredCount: 1,
    });
    harness.emitRuntimeConfigChange();

    assert.equal(
      harness.isHidden(panel),
      false,
      'subscription updates should reshow the alert when a configured setup becomes incomplete',
    );
    assert.equal(
      harness.getAlertState(panel),
      'some',
      'the reshow path should expose the partial-configuration alert state',
    );
  });

  it('shows the configured alert when all desktop features are available but setup is only partially configured', () => {
    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 4,
      configuredCount: 1,
    });

    const panel = harness.createPanel();

    assert.equal(
      harness.isHidden(panel),
      false,
      'all-available desktop setups with only some secrets configured should stay visible',
    );
    assert.equal(
      harness.getAlertState(panel),
      'configured',
      'the visible all-available branch should use the configured alert state',
    );
  });

  it('stays hidden when runtime-config subscriptions fire after the panel was disabled', () => {
    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 1,
      configuredCount: 0,
    });

    const panel = harness.createPanel();
    panel.hide();

    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 2,
      configuredCount: 1,
    });
    harness.emitRuntimeConfigChange();

    assert.equal(
      harness.isHidden(panel),
      true,
      'runtime-config subscription rerenders must respect an explicit hidden panel state',
    );
  });

  it('shows the needsKeys alert for first-run desktop setup', () => {
    harness.setRuntimeState({
      totalFeatures: 4,
      availableFeatures: 0,
      configuredCount: 0,
    });

    const panel = harness.createPanel();

    assert.equal(harness.isHidden(panel), false, 'first-run setup should show the alert');
    assert.equal(
      harness.getAlertState(panel),
      'needsKeys',
      'first-run setup should use the needsKeys alert state',
    );
  });
});
