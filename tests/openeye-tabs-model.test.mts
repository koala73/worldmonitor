import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildOpenEyeTabs,
  CORE_PANEL_HOMES,
  LIVE_PANEL_KEYS,
  MAP_PANEL_KEY,
} from '../src/components/openeye-tabs-model.ts';
import type { PanelConfig } from '../src/types/index.ts';

function settings(keys: string[]): Record<string, PanelConfig> {
  return Object.fromEntries(keys.map((k) => [k, { name: k, enabled: true }]));
}

describe('buildOpenEyeTabs', () => {
  it('opens on MAP, then LIVE, then the category sections', () => {
    const tabs = buildOpenEyeTabs(
      settings(['map', 'live-news', 'live-webcams', 'insights', 'cii', 'politics']), 'full');
    const keys = tabs.map((t) => t.key);

    assert.equal(keys[0], 'map', 'the map is the app, not a section of it');
    assert.deepEqual(keys.slice(0, 2), ['map', 'live']);
    assert.ok(keys.includes('intelligence')); // cii
    assert.ok(keys.includes('regionalNews')); // politics
    assert.ok(!keys.includes('correlation')); // nothing enabled there
    assert.ok(!keys.includes('more'));
  });

  it('has no HOME tab at all', () => {
    const tabs = buildOpenEyeTabs(
      settings(['map', 'live-news', 'insights', 'strategic-posture', 'cii']), 'full');
    const keys = tabs.map((t) => t.key);

    assert.ok(!keys.includes('home'));
    assert.ok(!keys.includes('world'));
  });

  it('gathers the live feeds onto LIVE and nowhere else', () => {
    const tabs = buildOpenEyeTabs(
      settings(['map', 'live-news', 'live-webcams', 'windy-webcams', 'insights']), 'full');
    const live = tabs.find((t) => t.key === 'live');

    assert.ok(live);
    for (const key of LIVE_PANEL_KEYS) {
      assert.ok(live.panelKeys.includes(key), `${key} must be on LIVE`);
      for (const tab of tabs) {
        if (tab.key === 'live') continue;
        assert.ok(!tab.panelKeys.includes(key), `${key} must not also be on ${tab.key}`);
      }
    }
  });

  it('adopts the leftover core panels into their real category', () => {
    // `core` means "on by default", not a subject. Once the map and the
    // feeds have their own tabs, what is left has to go somewhere honest.
    const tabs = buildOpenEyeTabs(
      settings(['map', 'insights', 'strategic-posture', 'bloc-alignment', 'cii']), 'full');
    const intel = tabs.find((t) => t.key === 'intelligence');

    assert.ok(intel, 'intelligence is where the analysis panels belong');
    for (const key of ['insights', 'strategic-posture', 'bloc-alignment']) {
      assert.equal(CORE_PANEL_HOMES[key], 'intelligence');
      assert.ok(intel.panelKeys.includes(key), `${key} must be adopted by intelligence`);
    }
    // Adopted panels lead as a group - they were the front page a moment
    // ago, and burying them under a long category list is a demotion. Their
    // order among themselves follows `core`, which is not worth pinning.
    const ownIndex = intel.panelKeys.indexOf('cii');
    assert.ok(ownIndex >= 0, 'the category keeps its own panels too');
    for (const key of ['insights', 'strategic-posture', 'bloc-alignment']) {
      assert.ok(intel.panelKeys.indexOf(key) < ownIndex,
        `${key} was adopted and should precede the category's own panels`);
    }
  });

  it('lets an adopted panel be the reason its category tab exists', () => {
    // Nothing in `intelligence` is enabled except the adopted panel; the tab
    // must still appear, or the panel vanishes.
    const tabs = buildOpenEyeTabs(settings(['map', 'insights']), 'full');
    const intel = tabs.find((t) => t.key === 'intelligence');

    assert.ok(intel);
    assert.deepEqual(intel.panelKeys, ['insights']);
  });

  it('sends a core panel to MORE when its category does not apply', () => {
    // `intelligence` is full-only. In the tech variant `insights` has no
    // category to be adopted by, and must not silently disappear.
    const tabs = buildOpenEyeTabs(settings(['map', 'insights', 'startups']), 'tech');
    const more = tabs.find((t) => t.key === 'more');

    assert.ok(more, 'a homeless core panel needs somewhere to land');
    assert.ok(more.panelKeys.includes('insights'));
  });

  it('never drops an enabled panel', () => {
    // The strongest invariant here: reorganising tabs must not lose a panel.
    const keys = ['map', 'live-news', 'live-webcams', 'windy-webcams', 'insights',
      'strategic-posture', 'bloc-alignment', 'cii', 'politics', 'custom-widget-7'];
    const tabs = buildOpenEyeTabs(settings(keys), 'full');
    const placed = new Set(tabs.flatMap((t) => t.panelKeys));

    for (const key of keys) {
      assert.ok(placed.has(key), `${key} is enabled but reachable from no tab`);
    }
  });

  it('keeps the map off every tab but its own', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'insights', 'live-news']), 'full');
    const map = tabs.find((t) => t.key === 'map');

    assert.deepEqual(map?.panelKeys, [MAP_PANEL_KEY]);
    for (const tab of tabs) {
      if (tab.key === 'map') continue;
      assert.ok(!tab.panelKeys.includes(MAP_PANEL_KEY), `${tab.key} must not carry the map`);
    }
  });

  it('drops the MAP tab when the map is disabled in settings', () => {
    // A tab that opens onto nothing is worse than one fewer tab.
    const s = settings(['map', 'insights']);
    s.map!.enabled = false;
    const tabs = buildOpenEyeTabs(s, 'full');
    const keys = tabs.map((t) => t.key);

    assert.ok(!keys.includes('map'));
    assert.ok(keys.includes('intelligence'), 'the rest of the app still has tabs');
  });

  it('drops the LIVE tab when every live panel is disabled', () => {
    const s = settings(['map', 'live-news', 'insights']);
    s['live-news']!.enabled = false;
    const tabs = buildOpenEyeTabs(s, 'full');

    assert.ok(!tabs.map((t) => t.key).includes('live'));
  });

  it('collects enabled panels outside every category into a MORE tab', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'custom-widget-42']), 'full');
    const more = tabs.find((t) => t.key === 'more');

    assert.ok(more);
    assert.deepEqual(more?.panelKeys, ['custom-widget-42']);
  });

  it('renders MAP plus the adopting category when only core panels are on', () => {
    const tabs = buildOpenEyeTabs(settings(['map', 'insights']), 'full');

    assert.deepEqual(tabs.map((t) => t.key), ['map', 'intelligence']);
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
    s.cii!.enabled = false;
    const tabs = buildOpenEyeTabs(s, 'full');

    assert.ok(!tabs.map((t) => t.key).includes('intelligence'));
  });

  it('migrates every retired tab key to MAP', () => {
    // Existing installs have 'world' or 'home' in localStorage. Dropping
    // either would land them on a tab they never chose.
    const src = readFileSync(
      new URL('../src/components/OpenEyeTabBar.ts', import.meta.url), 'utf8');
    assert.match(src, /RETIRED_TABS[\s\S]{0,160}world: 'map'/);
    assert.match(src, /RETIRED_TABS[\s\S]{0,160}home: 'map'/);
    assert.match(src, /if \(!stored\) return 'map';/);
  });
});
