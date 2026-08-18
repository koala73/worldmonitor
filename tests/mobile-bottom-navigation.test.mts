import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  reconcileOverlayForTab,
  type OverlayReconcileHandlers,
} from '../src/app/mobile-overlay-reconcile.ts';

const layout = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/**
 * Records the effect sequence `reconcileOverlayForTab` performs. The ORDER is
 * part of the contract — a dirty Settings overlay must be closed through its
 * own handler before the tab bar moves — so the recorder keeps one flat log
 * rather than per-effect counters.
 */
function recorder(initialTop: string | null) {
  const effects: string[] = [];
  let top = initialTop;
  const handlers: OverlayReconcileHandlers = {
    top: () => top as never,
    dismiss: (id) => {
      effects.push(`dismiss:${id}`);
      top = null;
    },
    settingsHasPendingChanges: () => false,
    closeSettings: () => effects.push('closeSettings'),
    setActive: (tab) => effects.push(`setActive:${tab}`),
  };
  return {
    handlers,
    effects,
    setTop(next: string | null) {
      top = next;
    },
  };
}

describe('mobile primary-tab overlay reconciliation', () => {
  it('reports no overlay to reconcile when nothing is open', () => {
    const r = recorder(null);
    assert.equal(reconcileOverlayForTab('search', r.handlers), undefined);
    assert.deepEqual(r.effects, []);
  });

  it('toggles Search closed when its own tab is re-tapped', () => {
    const r = recorder('search');
    assert.equal(reconcileOverlayForTab('search', r.handlers), null);
    assert.deepEqual(r.effects, ['dismiss:search', 'setActive:today']);
  });

  it('treats the pending search overlay as the same family', () => {
    const r = recorder('search-pending');
    assert.equal(reconcileOverlayForTab('search', r.handlers), null);
    assert.deepEqual(r.effects, ['dismiss:search-pending', 'setActive:today']);
  });

  it('toggles every More-family overlay closed when More is re-tapped', () => {
    for (const overlay of ['menu', 'region', 'settings', 'settings-pending']) {
      const r = recorder(overlay);
      assert.equal(reconcileOverlayForTab('more', r.handlers), null, overlay);
      assert.deepEqual(r.effects, [`dismiss:${overlay}`, 'setActive:today'], overlay);
    }
  });

  it('dismisses the open overlay when navigating to a non-overlay tab', () => {
    for (const tab of ['today', 'map', 'alerts']) {
      const r = recorder('menu');
      assert.equal(reconcileOverlayForTab(tab, r.handlers), undefined, tab);
      assert.deepEqual(r.effects, ['dismiss:menu'], tab);
    }
  });

  it('hands the open overlay back for in-place replacement across tab families', () => {
    // Search open, More tapped: More replaces it in place, so it must stay
    // registered — dismissing here would pop a history entry the replacement
    // still needs.
    const r = recorder('search');
    assert.equal(reconcileOverlayForTab('more', r.handlers), 'search');
    assert.deepEqual(r.effects, []);

    const r2 = recorder('settings-pending');
    assert.equal(reconcileOverlayForTab('search', r2.handlers), 'settings-pending');
    assert.deepEqual(r2.effects, []);
  });

  it('closes a dirty Settings overlay through its own handler instead of replacing it', () => {
    // close('replacement') would discard the draft without confirmation, so
    // this path must route through UnifiedSettings.close() and return null so
    // the caller opens nothing.
    const r = recorder('settings');
    r.handlers.settingsHasPendingChanges = () => true;

    assert.equal(reconcileOverlayForTab('search', r.handlers), null);
    assert.deepEqual(r.effects, ['closeSettings', 'setActive:more']);
  });

  it('never dismisses a dirty Settings overlay, on any tab', () => {
    for (const tab of ['today', 'map', 'search', 'alerts', 'more']) {
      const r = recorder('settings');
      r.handlers.settingsHasPendingChanges = () => true;
      reconcileOverlayForTab(tab, r.handlers);
      assert.ok(
        !r.effects.some((e) => e.startsWith('dismiss:')),
        `tab ${tab} dismissed a dirty Settings overlay`,
      );
    }
  });

  it('only consults the pending-changes flag for Settings itself', () => {
    // A stale flag from a previously-open Settings must not divert the menu or
    // region overlays into the draft-protection branch.
    const r = recorder('menu');
    r.handlers.settingsHasPendingChanges = () => true;
    assert.equal(reconcileOverlayForTab('more', r.handlers), null);
    assert.deepEqual(r.effects, ['dismiss:menu', 'setActive:today']);
  });
});

describe('mobile P0 navigation shell (#5201)', () => {
  // The tab bar is markup and CSS with no runtime seam to call; the dashboard
  // itself is exercised on mobile viewports by the Playwright suite.
  it('renders the five primary destinations in a real navigation landmark', () => {
    assert.match(layout, /<nav class="mobile-tab-bar"[^>]*aria-label="Primary"/);
    for (const tab of ['today', 'map', 'search', 'alerts', 'more']) {
      assert.match(layout, new RegExp(`data-mobile-tab="${tab}"`));
    }
  });

  it('retires the mobile footer, hamburger, and search FAB it replaces', () => {
    assert.doesNotMatch(layout, /id="searchMobileFab"/);
    assert.doesNotMatch(layout, /id="hamburgerBtn"/);
    assert.doesNotMatch(css, /\.hamburger-btn/);
    assert.doesNotMatch(css, /\.search-mobile-fab/);
  });

  it('keeps every bottom sheet clear of the fixed tab bar', () => {
    // A sheet that ends under the tab bar buries its primary action.
    for (const selector of [
      /\.map-popup\.map-popup-sheet\s*\{[^}]*padding-bottom:\s*calc\(58px/,
      /\.region-bottom-sheet\s*\{[^}]*padding-bottom:\s*calc\(58px/,
      /\.search-overlay\.search-mobile \.search-sheet\s*\{[^}]*padding-bottom:\s*calc\(58px/,
    ]) {
      assert.match(css, selector);
    }
    assert.match(css, /\.mobile-tab-bar\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*10003/);
  });

  it('defaults first-time mobile visitors to the collapsed-map Today state before hydration', () => {
    // The inline shell script and the hydrated reader must agree, or the map
    // expands then snaps shut on boot.
    assert.match(layout, /loadFromStorage<boolean>\('mobile-map-collapsed', true\)/);
    assert.match(shell, /localStorage\.getItem\('mobile-map-collapsed'\)!=='false'/);
  });
});
