// Unit tests for panel-driven feed resolution (src/config/feed-resolution.ts).
//
// Regression motivation — the concrete bug this fixes:
//
// A user customized the `full` (geopolitical) variant by enabling Tech panels
// (Startups & VC, Unicorn Tracker, GitHub Trending, Cybersecurity, …). The
// panels rendered but sat on "Loading..." forever. Root cause: `loadNews()`
// built its work-list from `Object.entries(FEEDS)` — the ACTIVE VARIANT'S
// PRESET — so any enabled news panel whose category wasn't in that one
// variant's feed map never had its feeds fetched.
//
// `resolveNewsCategories` makes the data layer panel-driven instead of
// variant-driven: it loads the preset PLUS any extra categories required by
// the user's enabled panels, flagging the extras `isCustom` (they aren't in
// the per-variant server digest and must be fetched directly client-side).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeCanonicalFeeds,
  resolveNewsCategories,
  enabledNewsCategoryKeys,
} from '../src/config/feed-resolution.ts';
import type { Feed } from '../src/types/index.ts';

const f = (name: string, url: string): Feed => ({ name, url });

describe('mergeCanonicalFeeds', () => {
  test('unions categories across variant maps', () => {
    const merged = mergeCanonicalFeeds([
      { politics: [f('BBC', 'bbc')] },
      { startups: [f('TechCrunch', 'tc')] },
    ]);
    assert.deepStrictEqual(Object.keys(merged).sort(), ['politics', 'startups']);
    assert.strictEqual(merged.politics?.length, 1);
    assert.strictEqual(merged.startups?.length, 1);
  });

  test('merges + dedupes feeds for a category present in multiple variants', () => {
    const merged = mergeCanonicalFeeds([
      { tech: [f('The Verge', 'verge'), f('Hacker News', 'hn')] },
      { tech: [f('Hacker News', 'hn'), f('Ars Technica', 'ars')] },
    ]);
    const urls = merged.tech?.map(x => x.url);
    assert.deepStrictEqual(urls, ['verge', 'hn', 'ars'], 'duplicate URL collapsed, order preserved (first wins)');
  });

  test('dedupes multi-URL (Record) feeds by stringified url', () => {
    const multi: Feed = { name: 'Multi', url: { a: 'x', b: 'y' } };
    const merged = mergeCanonicalFeeds([
      { region: [multi] },
      { region: [{ name: 'Multi', url: { a: 'x', b: 'y' } }] },
    ]);
    assert.strictEqual(merged.region?.length, 1, 'identical Record url deduped');
  });

  test('ignores non-array values defensively', () => {
    const merged = mergeCanonicalFeeds([
      { good: [f('A', 'a')], bad: undefined as unknown as Feed[] },
    ]);
    assert.deepStrictEqual(Object.keys(merged), ['good']);
  });
});

describe('resolveNewsCategories', () => {
  const FULL_PRESET = {
    politics: [f('BBC', 'bbc')],
    tech: [f('Verge', 'verge')],
  };
  const CANONICAL = {
    politics: [f('BBC', 'bbc')],
    tech: [f('Verge', 'verge')],
    startups: [f('TechCrunch', 'tc')],
    github: [f('GitHub Blog', 'gh')],
    forex: [f('Forex News', 'fx')],
  };

  test('preset categories resolve with isCustom=false', () => {
    const resolved = resolveNewsCategories(FULL_PRESET, CANONICAL, []);
    assert.deepStrictEqual(
      resolved.map(c => ({ key: c.key, isCustom: c.isCustom })),
      [
        { key: 'politics', isCustom: false },
        { key: 'tech', isCustom: false },
      ],
    );
  });

  // THE BUG REPRO: a Tech panel enabled in the `full` variant.
  // Against the old `Object.entries(FEEDS)` logic, `startups` would never
  // appear in the work-list. resolveNewsCategories must surface it as custom.
  test('enabled panel NOT in the preset resolves as a custom category', () => {
    const resolved = resolveNewsCategories(FULL_PRESET, CANONICAL, [
      'politics', // preset panel — already covered, must not duplicate
      'startups', // customized in from the Tech variant
      'github',   // customized in from the Tech variant
    ]);
    const byKey = new Map(resolved.map(c => [c.key, c]));
    assert.strictEqual(byKey.get('startups')?.isCustom, true);
    assert.strictEqual(byKey.get('github')?.isCustom, true);
    assert.deepStrictEqual(byKey.get('startups')?.feeds, CANONICAL.startups);
    // preset panel passed in enabledPanelKeys must not produce a 2nd entry
    assert.strictEqual(resolved.filter(c => c.key === 'politics').length, 1);
    assert.strictEqual(byKey.get('politics')?.isCustom, false);
  });

  test('symmetric across variants — a full-variant panel customized into tech', () => {
    const TECH_PRESET = { startups: [f('TechCrunch', 'tc')] };
    const resolved = resolveNewsCategories(TECH_PRESET, CANONICAL, ['startups', 'forex']);
    const byKey = new Map(resolved.map(c => [c.key, c]));
    assert.strictEqual(byKey.get('startups')?.isCustom, false);
    assert.strictEqual(byKey.get('forex')?.isCustom, true);
  });

  test('enabled panel with no feeds anywhere is skipped (no phantom entry)', () => {
    const resolved = resolveNewsCategories(FULL_PRESET, CANONICAL, ['intel']);
    assert.strictEqual(resolved.find(c => c.key === 'intel'), undefined);
  });

  test('preset categories with empty feed arrays are excluded', () => {
    const resolved = resolveNewsCategories(
      { politics: [f('BBC', 'bbc')], empty: [] },
      CANONICAL,
      [],
    );
    assert.deepStrictEqual(resolved.map(c => c.key), ['politics']);
  });

  test('duplicate enabled panel keys do not produce duplicate custom entries', () => {
    const resolved = resolveNewsCategories(FULL_PRESET, CANONICAL, ['startups', 'startups']);
    assert.strictEqual(resolved.filter(c => c.key === 'startups').length, 1);
  });
});

// `newsCategoryPanelKeys` is the registry panel-layout fills as it registers
// NewsPanels: categoryKey → the panel key that NewsPanel actually took. A
// category key already claimed by a non-news panel never lands in it.
describe('enabledNewsCategoryKeys', () => {
  // App.ts seeds panelSettings with EVERY ALL_PANELS key (cross-variant ones
  // enabled:false) and panel registration keys on presence, not on `.enabled` —
  // so the registry holds disabled categories too. Only enabled ones may become
  // custom categories.
  test('includes enabled panels, excludes disabled ones', () => {
    const registry = new Map([['politics', 'politics'], ['startups', 'startups']]);
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(registry, {
        politics: { enabled: true },
        startups: { enabled: false }, // cross-variant panel, disabled in this variant
      }),
      ['politics'],
    );
  });

  test('excludes a registered category with no settings entry', () => {
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(new Map([['orphan', 'orphan']]), {}),
      [],
    );
  });

  // #5376 REPRO: `commodities`, `supply-chain` and `live-news` are CANONICAL_FEEDS
  // category keys whose panel key is owned by a NON-news panel on every variant
  // (CommoditiesPanel market prices, SupplyChainPanel, LiveNewsPanel 24/7 video),
  // so panel-layout's NewsPanel registration for them is a no-op and they are
  // absent from the registry. Their DATA panel's `enabled: true` must not make
  // them news categories: with no NewsPanel to render into, every feed fetched is
  // pure waste — 19 uncapped /api/rss-proxy calls per dashboard load.
  test('a category key owned by a non-news panel is never a news category (#5376)', () => {
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(new Map([['politics', 'politics']]), {
        politics: { enabled: true },
        commodities: { enabled: true },    // CommoditiesPanel (market prices)
        'supply-chain': { enabled: true }, // SupplyChainPanel
        'live-news': { enabled: true },    // LiveNewsPanel (24/7 video)
      }),
      ['politics'],
    );
  });

  // A category whose NewsPanel took its own key reads enablement from that key.
  // Unrelated `${key}-news` settings entries (another variant's remapped panel,
  // or a stale one left in a user's persisted settings) must not suppress it.
  test('reads enablement from the registered key, ignoring stale ${key}-news entries', () => {
    const registry = new Map([
      ['commodities', 'commodities'],
      ['climate', 'climate'],
      ['mining', 'mining'],
    ]);
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(registry, {
        commodities: { enabled: true },
        'commodities-news': { enabled: false },
        climate: { enabled: true },
        'climate-news': { enabled: false },
        mining: { enabled: true },
        'mining-news': { enabled: false },
      }),
      ['commodities', 'climate', 'mining'],
    );
  });

  // Collision case: `markets` is occupied by a non-news DATA panel, so the news
  // panel registered under `markets-news` and the registry maps
  // markets → markets-news. Enablement must be read from panelSettings
  // ['markets-news'] — NOT panelSettings['markets'] (the data panel).
  test('collision: reads the remapped ${key}-news settings entry, not the data panel', () => {
    const registry = new Map([['markets', 'markets-news']]);

    // data panel enabled, news panel enabled → included
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(registry, {
        markets: { enabled: true },
        'markets-news': { enabled: true },
      }),
      ['markets'],
    );

    // data panel enabled, news panel DISABLED → excluded (data state must not leak)
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(registry, {
        markets: { enabled: true },
        'markets-news': { enabled: false },
      }),
      [],
    );
  });

  test('duplicate registry entries do not produce duplicate keys', () => {
    assert.deepStrictEqual(
      enabledNewsCategoryKeys(
        [['startups', 'startups'], ['startups', 'startups']],
        { startups: { enabled: true } },
      ),
      ['startups'],
    );
  });
});
