import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_BUS_ACTION_TYPES,
  parseAgentBusAction,
} from '../shared/agent-bus-actions.ts';

describe('agent bus action schema', () => {
  it('parses v1 dashboard control actions', () => {
    assert.deepEqual([...AGENT_BUS_ACTION_TYPES], [
      'suggest-widget',
      'open_panel',
      'set_view',
      'set_layers',
    ]);

    const openPanel = parseAgentBusAction({
      type: 'open_panel',
      label: 'Open Strategic Risk',
      panelId: 'strategic-risk',
    });
    assert.equal(openPanel.ok, true);
    if (openPanel.ok) {
      assert.equal(openPanel.action.type, 'open_panel');
      assert.equal(openPanel.action.panelId, 'strategic-risk');
    }

    const setView = parseAgentBusAction({
      type: 'set_view',
      view: 'mena',
      zoom: 3,
    });
    assert.equal(setView.ok, true);

    const setLayers = parseAgentBusAction({
      type: 'set_layers',
      layers: { conflicts: true, weather: false },
    });
    assert.equal(setLayers.ok, true);
  });

  it('keeps legacy suggest-widget compatible', () => {
    const parsed = parseAgentBusAction({
      type: 'suggest-widget',
      prefill: 'chart oil prices',
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.action.type, 'suggest-widget');
      assert.equal(parsed.action.label, 'Create chart widget');
      assert.equal(parsed.action.prefill, 'chart oil prices');
    }
  });

  it('rejects malformed, unknown, or overbroad actions', () => {
    const unknown = parseAgentBusAction({ type: 'delete_everything' });
    assert.equal(unknown.ok, false);

    const extraField = parseAgentBusAction({
      type: 'open_panel',
      panelId: 'forecast',
      persist: true,
    });
    assert.equal(extraField.ok, false);

    const badPanelId = parseAgentBusAction({
      type: 'open_panel',
      panelId: '../forecast',
    });
    assert.equal(badPanelId.ok, false);
  });

  it('bounds map view targets', () => {
    assert.equal(parseAgentBusAction({ type: 'set_view', view: 'eu', zoom: 4 }).ok, true);
    assert.equal(parseAgentBusAction({ type: 'set_view', lat: 34.5, lon: 39.0, zoom: 5 }).ok, true);
    assert.equal(parseAgentBusAction({ type: 'set_view', lat: 34.5 }).ok, false);
    assert.equal(parseAgentBusAction({ type: 'set_view', view: 'moon' }).ok, false);
    assert.equal(parseAgentBusAction({ type: 'set_view', lat: 120, lon: 39.0 }).ok, false);
    assert.equal(parseAgentBusAction({ type: 'set_view', lat: 34.5, lon: 39.0, zoom: 99 }).ok, false);
  });

  it('requires explicit layer changes', () => {
    assert.equal(parseAgentBusAction({ type: 'set_layers', layers: { conflicts: true } }).ok, true);
    assert.equal(parseAgentBusAction({ type: 'set_layers', layers: {} }).ok, false);
    assert.equal(parseAgentBusAction({ type: 'set_layers', layers: { conflicts: 'true' } }).ok, false);
  });
});
