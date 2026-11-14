import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FocusMapSync, type FocusMapTarget } from '../src/app/focus-map-sync.ts';
import type { ResolvedScope } from '../src/services/tab-focus.ts';

type Call = { focus: { chosen: string[]; neighbours: string[] } | null; fit: boolean };

function fakeMap(): FocusMapTarget & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    setFocusScope(focus, options) {
      calls.push({ focus: focus ? { chosen: [...focus.chosen], neighbours: [...focus.neighbours] } : null, fit: options.fit });
    },
  };
}

function resolved(countries: string[], neighbours: string[], extra: Partial<ResolvedScope['scope']> = {}): ResolvedScope {
  return {
    scope: { countries, neighbours: neighbours.length > 0, ...extra },
    chosen: countries,
    neighbours,
  };
}

const SEA = resolved(['TH', 'VN', 'ID'], ['KH', 'LA', 'MY']);

describe('focus map sync (#10453)', () => {
  it('outlines and fits when a focus is set', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.attachMap(map);
    sync.onScopeChanged(SEA);
    assert.deepEqual(map.calls.at(-1), {
      focus: { chosen: ['TH', 'VN', 'ID'], neighbours: ['KH', 'LA', 'MY'] },
      fit: true,
    });
  });

  it('clears the outline without moving the map', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.attachMap(map);
    sync.onScopeChanged(SEA);
    sync.onScopeChanged(null);
    assert.deepEqual(map.calls.at(-1), { focus: null, fit: false });
  });

  it('refits only when the chosen countries change', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.attachMap(map);
    sync.onScopeChanged(SEA);
    // Dates edited: same countries, so the user's pan stays.
    sync.onScopeChanged(resolved(['TH', 'VN', 'ID'], ['KH', 'LA', 'MY'], { start: '2026-11-14' }));
    assert.equal(map.calls.at(-1)!.fit, false);
    // Neighbours switched off: the outline loses the neighbours, the frame
    // (chosen only) is the same.
    sync.onScopeChanged(resolved(['TH', 'VN', 'ID'], []));
    assert.deepEqual(map.calls.at(-1), { focus: { chosen: ['TH', 'VN', 'ID'], neighbours: [] }, fit: false });
    // A country added: refit.
    sync.onScopeChanged(resolved(['TH', 'VN', 'ID', 'PH'], []));
    assert.equal(map.calls.at(-1)!.fit, true);
    // The same set in another order is the same frame.
    sync.onScopeChanged(resolved(['PH', 'ID', 'VN', 'TH'], []));
    assert.equal(map.calls.at(-1)!.fit, false);
  });

  it('refits when switching back to a focused tab', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.attachMap(map);
    sync.onScopeChanged(SEA);
    sync.onScopeChanged(null); // an unfocused tab
    sync.onScopeChanged(SEA); // back to the focused tab
    assert.equal(map.calls.at(-1)!.fit, true);
  });

  it('holds a focus that arrives before the map exists and fits once it is attached', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    // Reload of a focused tab: the tab store restores the focus before the
    // map module has loaded.
    sync.onScopeChanged(SEA);
    assert.equal(map.calls.length, 0);
    sync.attachMap(map);
    assert.deepEqual(map.calls, [{
      focus: { chosen: ['TH', 'VN', 'ID'], neighbours: ['KH', 'LA', 'MY'] },
      fit: true,
    }]);
  });

  it('attaches without a call when there is no focus', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.onScopeChanged(null);
    sync.attachMap(map);
    assert.deepEqual(map.calls, []);
  });

  it('a team dashboard with a stored map view keeps that view and still outlines', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.attachMap(map);
    // openTeamDashboard: the scope is restored inside createAndActivateTab,
    // then applyTeamMap sets the analyst's saved centre and zoom.
    sync.keepMapView(() => sync.onScopeChanged(SEA));
    assert.deepEqual(map.calls.at(-1), {
      focus: { chosen: ['TH', 'VN', 'ID'], neighbours: ['KH', 'LA', 'MY'] },
      fit: false,
    });
    // The hold ends with the call; the next real change fits again.
    sync.onScopeChanged(resolved(['TH'], []));
    assert.equal(map.calls.at(-1)!.fit, true);
  });

  it('a held focus that arrives before the map exists does not fit on attach', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.keepMapView(() => sync.onScopeChanged(SEA));
    sync.attachMap(map);
    assert.deepEqual(map.calls, [{
      focus: { chosen: ['TH', 'VN', 'ID'], neighbours: ['KH', 'LA', 'MY'] },
      fit: false,
    }]);
  });

  it('keepMapView returns the callback result and ends the hold when it throws', () => {
    const map = fakeMap();
    const sync = new FocusMapSync();
    sync.attachMap(map);
    assert.equal(sync.keepMapView(() => 7), 7);
    assert.throws(() => sync.keepMapView(() => { throw new Error('boom'); }), /boom/);
    sync.onScopeChanged(SEA);
    assert.equal(map.calls.at(-1)!.fit, true);
  });
});
