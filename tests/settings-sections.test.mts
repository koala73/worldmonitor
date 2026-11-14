import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTION_IDS,
  buildNav,
  diffNav,
  isAvailable,
  isPreferenceSection,
  pageEntryEffect,
  reduceNav,
  searchNav,
  searchTerms,
  type NavGroup,
  type NavLayout,
  type NavState,
  type SettingsFacts,
  type SettingsSectionId,
  type Translate,
} from '../src/config/settings-sections.ts';

const EN: unknown = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));

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

function at(page: SettingsSectionId | null, f = facts(), layout: NavLayout = 'sheet'): NavState {
  return reduceNav(null, { type: 'open', target: page ?? undefined, layout, recent: null }, f);
}

function openIn(layout: NavLayout, target?: SettingsSectionId, recent: SettingsSectionId | null = null, f = facts()): NavState {
  return reduceNav(null, { type: 'open', target, layout, recent }, f);
}

function relayout(prev: NavState, layout: NavLayout, recent: SettingsSectionId | null = null, f = facts()): NavState {
  return reduceNav(prev, { type: 'relayout', layout, recent }, f);
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
    const reopen = (target?: SettingsSectionId) => reduceNav(map, { type: 'open', target, layout: 'sheet', recent: 'map' }, facts());
    assert.equal(reopen('notifications').page, 'notifications');
    assert.equal(reopen().page, null);
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

describe('settings page history entry', () => {
  it('holds an entry for an open page on the phone sheet above a Settings entry', () => {
    assert.equal(pageEntryEffect(at('notifications'), true), 'hold');
  });

  it('releases it on the home list, in the modal, or without a Settings entry beneath', () => {
    assert.equal(pageEntryEffect(at(null), true), 'release');
    assert.equal(pageEntryEffect(null, true), 'release');
    assert.equal(pageEntryEffect(openIn('modal', 'notifications'), true), 'release');
    assert.equal(pageEntryEffect(at('notifications'), false), 'release');
  });

  it('follows navigation: a row holds it, back releases it, an evicted page releases it', () => {
    const page = reduceNav(at(null), { type: 'select', id: 'account' }, facts());
    assert.equal(pageEntryEffect(page, true), 'hold');
    assert.equal(pageEntryEffect(reduceNav(page, { type: 'back' }, facts()), true), 'release');
    assert.equal(pageEntryEffect(reduceNav(page, { type: 'facts-changed' }, signedOut), true), 'release');
  });

  it('keeps holding one entry while the open page changes', () => {
    const panels = at('panels');
    const sources = reduceNav(panels, { type: 'open', target: 'sources', layout: 'sheet', recent: 'panels' }, facts());
    assert.equal(pageEntryEffect(panels, true), 'hold');
    assert.equal(pageEntryEffect(sources, true), 'hold');
  });

  it('releases it when the sheet widens into the modal and holds it again on return', () => {
    const map = at('map');
    const wide = relayout(map, 'modal', 'map');
    assert.equal(pageEntryEffect(wide, true), 'release');
    assert.equal(pageEntryEffect(relayout(wide, 'sheet', 'map'), true), 'hold');
  });
});

describe('settings navigation in the two-pane modal', () => {
  it('opens on Display the first time, then on the recent page', () => {
    assert.deepEqual(openIn('modal'), openIn('modal', undefined, null));
    assert.equal(openIn('modal').page, 'display');
    assert.equal(openIn('modal').layout, 'modal');
    assert.equal(openIn('modal', undefined, 'sources').page, 'sources');
  });

  it('opens straight onto an available target', () => {
    assert.equal(openIn('modal', 'notifications', 'sources').page, 'notifications');
  });

  it('falls back to the recent page, then Display, for an unavailable target', () => {
    const noEmbeds = facts({ embedAccess: false });
    assert.equal(openIn('modal', 'embeds', 'map', noEmbeds).page, 'map');
    assert.equal(openIn('modal', 'embeds', null, noEmbeds).page, 'display');
    assert.equal(openIn('modal', 'account', 'account', signedOut).page, 'display');
  });

  it('selects an available section and ignores an unavailable one', () => {
    const noEmbeds = facts({ embedAccess: false });
    const display = openIn('modal', undefined, null, noEmbeds);
    const about = reduceNav(display, { type: 'select', id: 'about' }, noEmbeds);
    assert.equal(about.page, 'about');
    assert.equal(reduceNav(about, { type: 'select', id: 'embeds' }, noEmbeds), about);
  });

  it('never shows the home list: back keeps the page', () => {
    const map = openIn('modal', 'map');
    assert.equal(reduceNav(map, { type: 'back' }, facts()), map);
  });

  it('moves an evicted page to Display, not to a home list', () => {
    const account = openIn('modal', 'account');
    const after = reduceNav(account, { type: 'facts-changed' }, signedOut);
    assert.equal(after.page, 'display');
    assert.equal(after.layout, 'modal');
    assert.deepEqual(diffNav(account, after), { leave: 'account', enter: 'display' });
  });

  it('keeps the open page when the modal narrows into the sheet', () => {
    const map = openIn('modal', 'map');
    const narrow = relayout(map, 'sheet', 'map');
    assert.equal(narrow.layout, 'sheet');
    assert.equal(narrow.page, 'map');
    assert.deepEqual(diffNav(map, narrow), { leave: null, enter: null });
    assert.equal(reduceNav(narrow, { type: 'back' }, facts()).page, null);
  });

  it('keeps the open sheet page when the sheet widens into the modal', () => {
    const sources = relayout(at('sources'), 'modal', 'sources');
    assert.equal(sources.layout, 'modal');
    assert.equal(sources.page, 'sources');
  });

  it('selects the recent page, else Display, when the sheet home list widens into the modal', () => {
    const fromHome = (recent: SettingsSectionId | null) => relayout(at(null), 'modal', recent);
    assert.equal(fromHome(null).page, 'display');
    assert.equal(fromHome('about').page, 'about');
    assert.deepEqual(diffNav(at(null), fromHome('about')), { leave: null, enter: 'about' });
    assert.equal(relayout(at(null, signedOut), 'modal', 'account', signedOut).page, 'display');
  });

  it('returns the same state for a relayout that keeps the layout', () => {
    const map = openIn('modal', 'map');
    assert.equal(relayout(map, 'modal', 'about'), map);
    const home = at(null);
    assert.equal(relayout(home, 'sheet', 'about'), home);
  });
});

describe('settings sidebar search', () => {
  const lookup = (dict: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);

  /** i18next's t over real catalogues: `ui` is the UI language, English answers lng 'en'. */
  const translate = (ui: unknown): Translate => (key, { lng }) => lookup(lng === 'en' ? EN : ui, key) ?? key;
  const text = searchTerms(translate(EN));

  const ids = (groups: readonly NavGroup[]) =>
    groups.flatMap((group) => group.rows.map((row) => (row.kind === 'section' ? row.id : 'sign-in')));

  it('keeps every row for an empty or blank query', () => {
    const all = buildNav(facts());
    assert.deepEqual(ids(searchNav(all, '', text).groups), [...SETTINGS_SECTION_IDS]);
    assert.deepEqual(ids(searchNav(all, '   ', text).groups), [...SETTINGS_SECTION_IDS]);
  });

  it('matches the translated label and description, ignoring case', () => {
    assert.deepEqual(ids(searchNav(buildNav(facts()), 'PRIVACY', text).groups), ['account', 'about']);
    assert.deepEqual(ids(searchNav(buildNav(facts()), 'theme', text).groups), ['account', 'display', 'map']);
  });

  it('matches registry keywords and needs every word of the query', () => {
    const search = (q: string) => ids(searchNav(buildNav(facts()), q, text).groups);
    assert.deepEqual(search('ollama'), ['account', 'ai']);
    assert.deepEqual(search('text size'), ['account', 'panels', 'display']);
    assert.deepEqual(search('desktop key'), ['account', 'api-keys']);
    assert.deepEqual(search('telegram'), ['account', 'notifications']);
    assert.deepEqual(search('backup'), ['account', 'sync']);
    assert.deepEqual(search('claude'), ['account', 'mcp-clients']);
    assert.deepEqual(search('globe tiles'), ['account', 'map']);
    assert.deepEqual(search('stream autoplay'), ['account', 'video']);
  });

  it('drops groups left empty and keeps their headings in order', () => {
    const result = searchNav(buildNav(facts()), 'privacy', text);
    assert.deepEqual(result.groups.map((group) => group.id), ['account', 'app']);
  });

  it('counts hits so the view can say nothing matched, while the account card stays', () => {
    assert.equal(searchNav(buildNav(facts()), 'zzz', text).hits, 0);
    assert.deepEqual(ids(searchNav(buildNav(facts()), 'zzz', text).groups), ['account']);
    assert.deepEqual(ids(searchNav(buildNav(signedOut), 'zzz', text).groups), ['sign-in']);
    assert.equal(searchNav(buildNav(facts()), 'privacy', text).hits, 1);
    assert.equal(searchNav(buildNav(facts()), 'billing', text).hits, 1);
  });

  it('gives every section a non-empty keyword list in the English catalogue', () => {
    for (const group of buildNav(facts())) {
      for (const row of group.rows) {
        if (row.kind !== 'section') continue;
        const keywords = lookup(EN, row.keywordsKey);
        assert.ok(keywords !== null && typeof keywords === 'object', `${row.id} has keywords at ${row.keywordsKey}`);
        const words = Object.values(keywords as object);
        assert.ok(words.length > 0 && words.every((word) => typeof word === 'string' && word.trim() !== ''), `${row.id} keywords are words`);
      }
    }
  });

  it('gives every rendering of a key: the UI language, then English, lists flattened', () => {
    const fr = { settings: { keywords: { about: { 0: 'mentions légales', 1: 'confidentialité' } }, sections: { about: 'À propos' } } };
    const terms = searchTerms(translate(fr));
    assert.deepEqual(terms('settings.keywords.about'), ['mentions légales', 'confidentialité', 'terms', 'privacy', 'license', 'legal']);
    assert.deepEqual(terms('settings.sections.about'), ['À propos', 'About']);
    assert.deepEqual(terms('settings.missing'), []);
  });

  it('finds a row in another language by its translated keyword and by the English original', () => {
    const fr = { settings: { keywords: { about: { 0: 'mentions légales', 1: 'confidentialité' } } } };
    const search = (q: string) => searchNav(buildNav(facts()), q, searchTerms(translate(fr)));
    assert.deepEqual(ids(search('MENTIONS légales').groups), ['account', 'about']);
    assert.deepEqual(ids(search('legal').groups), ['account', 'about']);
    assert.equal(search('mentions').hits, 1);
  });
});
