import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  shouldExpandGlobalContextPanel,
  shouldHideCollapsedRightPanels,
} from './rightRailPolicy.js';

test('Tactical HUD hides collapsed right-rail siblings while one panel is expanded', () => {
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'tactical',
    hasExpandedPanel: true,
  }), true);
});

test('collapsed launchers remain when Tactical has no expanded panel', () => {
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'tactical',
    hasExpandedPanel: false,
  }), false);
});

test('other HUD layouts keep collapsed right-rail launchers visible', () => {
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'minimal',
    hasExpandedPanel: true,
  }), false);
  assert.equal(shouldHideCollapsedRightPanels({
    hudVariant: 'full',
    hasExpandedPanel: true,
  }), false);
});

test('desktop Display participates in Tactical exclusivity without changing mobile Display behavior', () => {
  const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(ui, /const isMobile = window\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
  assert.match(
    ui,
    /!panel\.classList\.contains\('collapsed'\) && \(!isMobile \|\| panel\.id !== 'pp-toggles'\)/,
  );
  assert.doesNotMatch(
    ui,
    /panel\.id !== 'pp-toggles' && !panel\.classList\.contains\('collapsed'\)/,
  );
  assert.match(ui, /if \(exclusive && panel\.classList\.contains\('collapsed'\)\) panel\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(css, /#right-context-rail\.layout-exclusive > \[data-panel-id\]\.collapsed \{/);
});

test('explicit Contacts, Space Missions, and Cockpit actions expand Global Context after success', () => {
  for (const action of ['contacts', 'space-missions', 'cockpit']) {
    assert.equal(shouldExpandGlobalContextPanel({
      action,
      explicitUserAction: true,
      succeeded: true,
    }), true, `${action} should reveal its supporting context`);
  }
});

test('Cockpit expansion is independent of whether a track was already selected', () => {
  for (const selectedTrack of [null, 'UAL649']) {
    assert.equal(shouldExpandGlobalContextPanel({
      action: 'cockpit',
      explicitUserAction: true,
      succeeded: true,
      selectedTrack,
    }), true);
  }
});

test('restoration and programmatic replay preserve the saved Global Context collapse state', () => {
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'contacts',
    explicitUserAction: false,
    succeeded: true,
  }), false);
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'space-missions',
    explicitUserAction: true,
    succeeded: true,
    restoring: true,
  }), false);
});

test('failed or unrelated actions never expand Global Context', () => {
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'contacts',
    explicitUserAction: true,
    succeeded: false,
  }), false, 'a failed transition must preserve the prior panel state for rollback');
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'search-nearby',
    explicitUserAction: true,
    succeeded: true,
  }), false);
});
