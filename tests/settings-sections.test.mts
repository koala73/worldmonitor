import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTION_IDS,
  buildNav,
  diffNav,
  isAvailable,
  isPreferenceSection,
  reduceNav,
  type NavState,
  type SettingsFacts,
  type SettingsSectionId,
} from '../src/config/settings-sections.ts';

const facts = (overrides: Partial<SettingsFacts> = {}): SettingsFacts => ({
  signedIn: true,
  isDesktopApp: false,
  embedAccess: true,
  account: { plan: 'Pro', email: 'a@example.com' },
  panels: { on: 18, total: 64 },
  sourcesOn: 412,
  theme: 'auto',
  ...overrides,
});

const signedOut = facts({ signedIn: false, account: null, embedAccess: false });

function at(page: SettingsSectionId | null, f = facts()): NavState {
  return page === null ? reduceNav(null, { type: 'open' }, f) : reduceNav(null, { type: 'open', target: page }, f);
}

function rowIds(f: SettingsFacts): string[] {
  return buildNav(f).flatMap((group) => group.rows.map((row) => (row.kind === 'section' ? row.id : 'sign-in')));
}

describe('settings sections registry', () => {
  it('declares every section once', () => {
    assert.equal(new Set(SETTINGS_SECTION_IDS).size, SETTINGS_SECTION_IDS.length);
    assert.deepEqual([...SETTINGS_SECTION_IDS], [
      'account', 'panels', 'sources', 'notifications',
      'display', 'map', 'ai', 'video',
      'api-keys', 'embeds', 'mcp-clients',
      'sync', 'about',
    ]);
  });

  it('routes the preference pages to preferences-content and the rest to the shell', () => {
    const preference = SETTINGS_SECTION_IDS.filter(isPreferenceSection);
    assert.deepEqual(preference, ['display', 'map', 'ai', 'video', 'sync']);
  });

  it('applies the availability truth table', () => {
    const cases: Array<[string, SettingsFacts, SettingsSectionId, boolean]> = [
      ['signed in', facts(), 'account', true],
      ['signed out', signedOut, 'account', false],
      ['web', facts(), 'notifications', true],
      ['desktop', facts({ isDesktopApp: true }), 'notifications', false],
      ['embed access', facts(), 'embeds', true],
      ['no embed access', facts({ embedAccess: false }), 'embeds', false],
      ['signed out', signedOut, 'mcp-clients', true],
      ['signed out', signedOut, 'api-keys', true],
      ['signed out', signedOut, 'sync', true],
      ['desktop', facts({ isDesktopApp: true }), 'about', true],
    ];
    for (const [label, f, id, expected] of cases) {
      assert.equal(isAvailable(id, f), expected, `${id} when ${label}`);
    }
  });

  it('shows a sign-in row in place of the account card when signed out', () => {
    assert.equal(rowIds(facts())[0], 'account');
    assert.equal(rowIds(signedOut)[0], 'sign-in');
    assert.ok(!rowIds(signedOut).includes('account'));
  });

  it('hides unavailable sections from the home list and keeps registry order', () => {
    const desktopNoEmbeds = rowIds(facts({ isDesktopApp: true, embedAccess: false }));
    assert.ok(!desktopNoEmbeds.includes('notifications'));
    assert.ok(!desktopNoEmbeds.includes('embeds'));
    assert.deepEqual(rowIds(facts()), [...SETTINGS_SECTION_IDS]);
  });

  it('groups rows under their headings, with the account card ungrouped', () => {
    const groups = buildNav(facts());
    assert.deepEqual(groups.map((g) => [g.id, g.labelKey]), [
      ['account', null],
      ['dashboard', 'settings.groups.dashboard'],
      ['preferences', 'settings.groups.preferences'],
      ['developer', 'settings.groups.developer'],
      ['app', 'settings.groups.app'],
    ]);
    assert.equal(SETTINGS_GROUPS.length, groups.length);
  });

  it('summarises rows as data the view formats', () => {
    const rows = new Map(buildNav(facts({ theme: 'dark' })).flatMap((g) => g.rows)
      .flatMap((row) => (row.kind === 'section' ? [[row.id, row] as const] : [])));
    assert.deepEqual(rows.get('panels')?.summary, { kind: 'count', on: 18, total: 64 });
    assert.deepEqual(rows.get('sources')?.summary, { kind: 'total', count: 412 });
    assert.deepEqual(rows.get('display')?.summary, { kind: 'text', key: 'preferences.themeDark' });
    assert.deepEqual(rows.get('account')?.summary, { kind: 'account', plan: 'Pro', email: 'a@example.com' });
    assert.equal(rows.get('map')?.summary, null);
    assert.equal(rows.get('api-keys')?.badge, 'pro');
    assert.equal(rows.get('mcp-clients')?.badge, null);
  });

  it('follows the theme in the display summary', () => {
    const display = (theme: SettingsFacts['theme']) => {
      const row = buildNav(facts({ theme })).flatMap((g) => g.rows)
        .find((r) => r.kind === 'section' && r.id === 'display');
      return row?.kind === 'section' ? row.summary : undefined;
    };
    assert.deepEqual(display('auto'), { kind: 'text', key: 'settings.summary.themeAuto' });
    assert.deepEqual(display('light'), { kind: 'text', key: 'preferences.themeLight' });
  });
});

describe('settings navigation reducer', () => {
  it('opens on the home list without a target', () => {
    assert.equal(at(null).page, null);
  });

  it('opens straight onto an available target', () => {
    assert.equal(at('notifications').page, 'notifications');
    assert.equal(at('account').page, 'account');
  });

  it('opens an unavailable target on the home list', () => {
    assert.equal(at('embeds', facts({ embedAccess: false })).page, null);
    assert.equal(at('account', signedOut).page, null);
    assert.equal(at('notifications', facts({ isDesktopApp: true })).page, null);
  });

  it('selects an available section and ignores an unavailable one', () => {
    const home = at(null, facts({ embedAccess: false }));
    const panels = reduceNav(home, { type: 'select', id: 'panels' }, facts({ embedAccess: false }));
    assert.equal(panels.page, 'panels');
    assert.equal(reduceNav(panels, { type: 'select', id: 'embeds' }, facts({ embedAccess: false })), panels);
  });

  it('goes back to the home list', () => {
    assert.equal(reduceNav(at('map'), { type: 'back' }, facts()).page, null);
  });

  it('returns the same state for a repeated event', () => {
    const map = at('map');
    assert.equal(reduceNav(map, { type: 'select', id: 'map' }, facts()), map);
    const home = at(null);
    assert.equal(reduceNav(home, { type: 'back' }, facts()), home);
    assert.equal(reduceNav(map, { type: 'facts-changed' }, facts()), map);
  });

  it('evicts a page that became unavailable', () => {
    const embeds = at('embeds');
    assert.equal(reduceNav(embeds, { type: 'facts-changed' }, facts({ embedAccess: false })).page, null);
    const account = at('account');
    assert.equal(reduceNav(account, { type: 'facts-changed' }, signedOut).page, null);
  });

  it('re-opens onto a new target while already open', () => {
    const map = at('map');
    assert.equal(reduceNav(map, { type: 'open', target: 'notifications' }, facts()).page, 'notifications');
    assert.equal(reduceNav(map, { type: 'open' }, facts()).page, null);
  });
});

describe('settings navigation effects', () => {
  it('enters the first page of a session', () => {
    assert.deepEqual(diffNav(null, at('panels')), { leave: null, enter: 'panels' });
    assert.deepEqual(diffNav(null, at(null)), { leave: null, enter: null });
  });

  it('leaves before it enters', () => {
    const panels = at('panels');
    const sources = reduceNav(panels, { type: 'select', id: 'sources' }, facts());
    assert.deepEqual(diffNav(panels, sources), { leave: 'panels', enter: 'sources' });
  });

  it('leaves without entering on back', () => {
    const mcp = at('mcp-clients');
    assert.deepEqual(diffNav(mcp, reduceNav(mcp, { type: 'back' }, facts())), { leave: 'mcp-clients', enter: null });
  });

  it('has no effects for a no-op transition', () => {
    const mcp = at('mcp-clients');
    assert.deepEqual(diffNav(mcp, reduceNav(mcp, { type: 'select', id: 'mcp-clients' }, facts())), { leave: null, enter: null });
    const home = at(null);
    assert.deepEqual(diffNav(home, reduceNav(home, { type: 'back' }, facts())), { leave: null, enter: null });
  });
});
