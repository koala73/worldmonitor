import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOpenEyeTabs } from '../src/components/openeye-tabs-model.ts';
import type { PanelConfig } from '../src/types/index.ts';

function settings(keys: string[]): Record<string, PanelConfig> {
  return Object.fromEntries(keys.map((k) => [k, { name: k, enabled: true }]));
}

describe('buildOpenEyeTabs', () => {
  it('puts core panels on the WORLD tab and one tab per populated category', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'live-news', 'cii', 'politics']), 'full');
    const keys = tabs.map((t) => t.key);

    assert.equal(keys[0], 'world');
    assert.ok(tabs[0].panelKeys.includes('map'));
    assert.ok(tabs[0].panelKeys.includes('live-news'));
    assert.ok(keys.includes('intelligence')); // cii
    assert.ok(keys.includes('regionalNews')); // politics
    assert.ok(!keys.includes('correlation')); // nothing enabled there
    assert.ok(!keys.includes('more'));
  });

  it('collects enabled panels outside every category into a MORE tab', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'custom-widget-42']), 'full');
    const more = tabs.find((t) => t.key === 'more');

    assert.ok(more);
    assert.deepEqual(more?.panelKeys, ['custom-widget-42']);
  });

  it('renders only the WORLD tab when just core panels are enabled', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'insights']), 'full');

    assert.deepEqual(tabs.map((t) => t.key), ['world']);
  });

  it('scopes section tabs to the active variant', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'cii', 'startups']), 'tech');
    const keys = tabs.map((t) => t.key);

    assert.ok(keys.includes('startupsVc'));
    assert.ok(!keys.includes('intelligence')); // full-only category
    // cii has no tech category → lands in MORE
    assert.deepEqual(tabs.find((t) => t.key === 'more')?.panelKeys, ['cii']);
  });

  it('never lists a disabled panel as a tab member', () => {
    const s = settings(['map', 'cii']);
    s.cii.enabled = false;
    const tabs = buildOpenEyeTabs(s, 'full');

    assert.ok(!tabs.map((t) => t.key).includes('intelligence'));
  });
});
