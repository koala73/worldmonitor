/**
 * "A settings entry with no panel" — the class of bug #5871 was.
 *
 * `commodities-news` shipped enabled by default on the finance variant
 * (`FINANCE_PANELS`) and inside the `finCommodities` mission preset, but the
 * CANONICAL_FEEDS pass in panel-layout only remapped a colliding feed category
 * to `${key}-news` for a hardcoded `markets`/`crypto`/`economic` set. The
 * `commodities` key is BOTH a FINANCE_FEEDS category and the key CommoditiesPanel
 * registers under, so the NewsPanel asked for `commodities`, the dedup guard
 * dropped it, and no panel was ever created. Users got a "Commodities News"
 * toggle that did nothing.
 *
 * Two things are asserted here, and they need each other:
 *
 *  1. The REAL resolver (`newsPanelKeyForCategory`, extracted from the loop so
 *     it is reachable from a test at all) is driven over the REAL catalog. A
 *     source regex asserting "panel-layout no longer has a hardcoded set" would
 *     go green the moment someone reintroduced one under a different name, and
 *     could never tell which catalog entries are actually reachable.
 *  2. The pass is replayed in registration ORDER, because the collision only
 *     exists because CommoditiesPanel registers first. A test that ignored order
 *     could not distinguish "remapped to commodities-news" from "silently lost".
 *
 * Mutation-verified: restoring the hardcoded `new Set(['markets','crypto',
 * 'economic'])` inside `newsPanelKeyForCategory` fails
 * "every *-news catalog entry is reachable" with `commodities-news` orphaned.
 *
 * The catalog and the registration order are read from source rather than
 * imported: `src/config/panels.ts` and `src/config/feeds.ts` both reach
 * `import.meta.env` transitively (via `@/utils/proxy`), which the tsx runner
 * behind `npm run test:data` cannot provide. Only literal object keys and
 * literal registration keys are extracted — no behavior is mirrored here; every
 * decision below comes from the imported production function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hasPanelSettingEntry,
  newsPanelKeyForCategory,
  newsPanelKeyLookupsFor,
  type NewsPanelKeyLookups,
} from '../src/app/news-panel-keys.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = (relPath: string): string => readFileSync(resolve(root, relPath), 'utf-8');

const feedsSrc = src('src/config/feeds.ts');
const panelsSrc = src('src/config/panels.ts');
const layoutSrc = src('src/app/panel-layout.ts');

// Order matches `mergeCanonicalFeeds([...])` in src/config/feeds.ts, so the replay
// visits categories in the same order `Object.keys(CANONICAL_FEEDS)` does. No two
// categories compete for one panel key today, but matching the order costs nothing
// and removes a way for the replay to diverge from production later.
const FEED_PRESETS = ['FULL_FEEDS', 'TECH_FEEDS', 'FINANCE_FEEDS', 'COMMODITY_FEEDS', 'ENERGY_FEEDS', 'HAPPY_FEEDS'];
const PANEL_PRESETS = ['FULL_PANELS', 'TECH_PANELS', 'FINANCE_PANELS', 'HAPPY_PANELS', 'COMMODITY_PANELS', 'ENERGY_PANELS'];

/**
 * Index just past the `{` that opens `const <name> ... = {`, and the index of
 * its matching `}`. Quote- and comment-aware so a `//` inside one of the many
 * feed URLs, or a brace inside a comment, cannot desynchronize the walk.
 */
function objectLiteralBody(source: string, name: string): string {
  const decl = source.search(new RegExp(`(?:export\\s+)?const\\s+${name}\\b`));
  assert.notEqual(decl, -1, `const ${name} not found`);
  const open = source.indexOf('= {', decl) + 2;
  assert.ok(open > 1, `opening brace of ${name} not found`);

  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated object literal for ${name}`);
}

/**
 * Top-level keys of an object literal.
 *
 * Three filters, each closing a way this could over-collect: brace depth (so a
 * nested `name:` inside a panel config or a feed entry never counts), "inside a
 * comment" (so a commented-out entry is not resurrected), and "starts its own
 * line" (so a `Foo:` inside a string VALUE cannot masquerade as a key — every
 * one of these files is biome-formatted one-entry-per-line).
 */
function topLevelKeys(source: string, name: string): string[] {
  const body = objectLiteralBody(source, name);
  const depthAt = new Array<number>(body.length).fill(0);
  const inComment = new Array<boolean>(body.length).fill(false);
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    depthAt[i] = depth;
    inComment[i] = lineComment || blockComment;
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; inComment[i] = true; continue; }
    if (ch === '/' && next === '*') { blockComment = true; inComment[i] = true; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }

  const startsLine = (index: number): boolean => {
    for (let i = index - 1; i >= 0; i--) {
      if (body[i] === '\n') return true;
      if (body[i] !== ' ' && body[i] !== '\t') return false;
    }
    return true;
  };

  const keys: string[] = [];
  const keyRe = /(?:'([A-Za-z][\w-]*)'|"([A-Za-z][\w-]*)"|([A-Za-z][\w-]*))\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    if (depthAt[m.index] !== 0) continue;
    if (inComment[m.index]) continue;
    if (!startsLine(m.index)) continue;
    keys.push(m[1] ?? m[2] ?? m[3]!);
  }
  return keys;
}

function unionOfPresets(source: string, names: string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) for (const key of topLevelKeys(source, name)) out.add(key);
  return out;
}

/**
 * Every preset const of `type` actually declared in `source` — i.e. what
 * FEED_PRESETS / PANEL_PRESETS above are supposed to name.
 *
 * Derived rather than listed, because a hand-maintained list that silently drifts
 * from the registry it mirrors is the entire bug this file guards against, and a
 * guard is not exempt from its own lesson. A preset here is a const of the right
 * annotation assigned an object literal with at least one top-level key of its
 * own — which excludes the derived aggregates for free: `ALL_PANELS` is an object
 * literal but spreads-only (no keys), and `CANONICAL_FEEDS` / `DEFAULT_PANELS`
 * are assigned function calls rather than literals.
 */
function declaredPresetConsts(source: string, type: string): string[] {
  const re = new RegExp(`const\\s+(\\w+)\\s*:\\s*${type}\\s*=\\s*\\{`, 'g');
  return [...source.matchAll(re)]
    .map(m => m[1]!)
    .filter(name => topLevelKeys(source, name).length > 0)
    .sort();
}

/** CANONICAL_FEEDS keys — the union the pass iterates. */
const feedCategories = unionOfPresets(feedsSrc, FEED_PRESETS);
/** ALL_PANELS keys — every panel key any variant can put in `panelSettings`. */
const catalogPanelKeys = unionOfPresets(panelsSrc, PANEL_PRESETS);

type Registration = { key: string; index: number; viaCreateNewsPanel: boolean };

/**
 * Every panel key panel-layout claims, in source order, with the ones that go
 * through `createNewsPanel` flagged — those record a category→panel-key entry in
 * `ctx.newsCategoryPanelKeys`, which is what `hasNewsPanel` reads.
 */
function panelRegistrations(): Registration[] {
  const out: Registration[] = [];
  for (const m of layoutSrc.matchAll(/this\.lazy(?:Panel|DefaultPanel|ImportedPanel)\(\s*'([^']+)'/g)) {
    out.push({ key: m[1]!, index: m.index!, viaCreateNewsPanel: false });
  }
  for (const m of layoutSrc.matchAll(/this\.createNewsPanel\(\s*'([^']+)'/g)) {
    out.push({ key: m[1]!, index: m.index!, viaCreateNewsPanel: true });
  }
  return out.sort((a, b) => a.index - b.index);
}

const loopIndex = layoutSrc.indexOf('for (const key of Object.keys(CANONICAL_FEEDS))');
const registrations = panelRegistrations();

/**
 * Feed-category panels registered BELOW the pass — invisible to `ctx.panels` and
 * `lazyPanelRegistrations` while it runs, so panel-layout names them in
 * `LATE_REGISTERED_PANEL_KEYS` instead. Mirrored here from the same source order
 * the production constant is maintained against, and the "declares every
 * feed-category panel registered after the loop" test asserts the two agree —
 * which is what stops this mirror from quietly diverging.
 */
const lateRegisteredFeedCategories = [...new Set(
  registrations.filter(reg => reg.index > loopIndex && feedCategories.has(reg.key)).map(reg => reg.key),
)].sort();

/**
 * Replay the pass the way `createPanels()` runs it: everything registered above
 * the loop has already claimed its key, so the loop sees those claims and only
 * those. `shouldCreatePanel` gates every registration on `key in panelSettings`,
 * and App.ts merges ALL_PANELS into panelSettings on every variant, so a
 * registration claims its key exactly when the catalog carries it.
 *
 * Returns panelKey → the feed category it renders, for every panel the pass
 * actually creates.
 */
function replayNewsPanelPass(): Map<string, string> {
  // Shaped like the real members panel-layout hands the adapter, not like a
  // convenient stand-in: registration reserves the key in `lazyPanelRegistrations`
  // and `ctx.panels` stays EMPTY for the whole synchronous pass (a lazy panel only
  // lands in `ctx.panels` once its chunk loads, long after). Modelling those as one
  // merged "claimed" set is what would let an adapter that consults only
  // `ctx.panels` — the #5871 bug in adapter form — replay green.
  const lazyPanelRegistrations = new Set<string>();
  const panels: Record<string, unknown> = {};
  const newsCategoryPanelKeys = new Set<string>();
  for (const reg of registrations) {
    if (reg.index > loopIndex) continue;
    if (!catalogPanelKeys.has(reg.key)) continue;
    if (reg.viaCreateNewsPanel && !lazyPanelRegistrations.has(reg.key)) newsCategoryPanelKeys.add(reg.key);
    lazyPanelRegistrations.add(reg.key);
  }

  const lookups = newsPanelKeyLookupsFor({
    canonicalFeeds: Object.fromEntries([...feedCategories].map(key => [key, []])),
    panels,
    lazyPanelRegistrations,
    newsCategoryPanelKeys,
    panelSettings: Object.fromEntries([...catalogPanelKeys].map(key => [key, {}])),
    lateRegisteredPanelKeys: new Set(lateRegisteredFeedCategories),
  });

  const created = new Map<string, string>();
  for (const categoryKey of feedCategories) {
    const panelKey = newsPanelKeyForCategory(categoryKey, lookups);
    if (!panelKey) continue;
    created.set(panelKey, categoryKey);
    lazyPanelRegistrations.add(panelKey);
    newsCategoryPanelKeys.add(categoryKey);
  }
  return created;
}

/** Panel keys with their own dedicated registration (not created by the pass). */
const dedicatedPanelKeys = new Set(registrations.map(reg => reg.key));
/** Of those, the ones that are NOT a generic NewsPanel — the collision sources. */
const nonNewsPanelKeys = new Set(registrations.filter(reg => !reg.viaCreateNewsPanel).map(reg => reg.key));

/**
 * Lookups where nothing is claimed and everything has a settings entry, so each
 * case below can turn exactly ONE guard on and know which one fired.
 */
function permissiveLookups(overrides: Partial<NewsPanelKeyLookups> = {}): NewsPanelKeyLookups {
  return {
    isFeedCategory: () => true,
    hasNewsPanel: () => false,
    isPanelKeyClaimed: () => false,
    hasPanelSetting: () => true,
    ...overrides,
  };
}

describe('newsPanelKeyForCategory guards (#5871)', () => {
  // The composite replay below exercises the resolver only through the ONE state
  // the real catalog happens to produce, which leaves most of its guards free to
  // be deleted without failing anything. Each case here makes a single guard the
  // reason for the answer, so removing that guard changes this file's result.

  it('takes the category key when nothing owns it', () => {
    assert.equal(newsPanelKeyForCategory('forex', permissiveLookups()), 'forex');
  });

  it('remaps to ${key}-news when a data panel owns the category key', () => {
    assert.equal(
      newsPanelKeyForCategory('commodities', permissiveLookups({
        isPanelKeyClaimed: (panelKey) => panelKey === 'commodities',
      })),
      'commodities-news',
    );
  });

  it('skips a key with no feed list', () => {
    assert.equal(
      newsPanelKeyForCategory('climate-news', permissiveLookups({ isFeedCategory: () => false })),
      null,
    );
  });

  it('skips a category that already has a NewsPanel', () => {
    // `createNewsPanel('politics')` runs before the pass; without this guard the
    // pass sees the key claimed by that very registration and remaps the category
    // onto a phantom `politics-news`.
    assert.equal(
      newsPanelKeyForCategory('politics', permissiveLookups({
        hasNewsPanel: (categoryKey) => categoryKey === 'politics',
        isPanelKeyClaimed: (panelKey) => panelKey === 'politics',
      })),
      null,
    );
  });

  it('skips when the remapped key is itself already claimed', () => {
    // Both `X` and `X-news` taken: any key this returned would be a registration
    // no-op, and reporting it as created is what made #5871 invisible.
    assert.equal(
      newsPanelKeyForCategory('markets', permissiveLookups({ isPanelKeyClaimed: () => true })),
      null,
    );
  });

  it('skips when the resolved key has no settings entry', () => {
    // `supply-chain` today: SupplyChainPanel owns the key, and no
    // `supply-chain-news` catalog entry exists to remap onto.
    assert.equal(
      newsPanelKeyForCategory('supply-chain', permissiveLookups({
        isPanelKeyClaimed: (panelKey) => panelKey === 'supply-chain',
        hasPanelSetting: (panelKey) => panelKey !== 'supply-chain-news',
      })),
      null,
    );
  });
});

describe('newsPanelKeyLookupsFor (#5871)', () => {
  const stateWith = (over: Partial<Parameters<typeof newsPanelKeyLookupsFor>[0]> = {}) =>
    newsPanelKeyLookupsFor({
      canonicalFeeds: { commodities: [], forex: [] },
      panels: {},
      lazyPanelRegistrations: new Set<string>(),
      newsCategoryPanelKeys: new Set<string>(),
      panelSettings: { commodities: {}, 'commodities-news': {}, forex: {} },
      lateRegisteredPanelKeys: new Set<string>(),
      ...over,
    });

  it('counts a key claimed by a lazy registration that has not loaded yet', () => {
    // The mechanism of #5871. During createPanels() the whole registration pass is
    // synchronous and `ctx.panels` is still EMPTY — a lazy panel only lands there
    // when its chunk resolves. An adapter that consulted only `ctx.panels` would
    // call `commodities` unclaimed, hand the NewsPanel the data panel's own key,
    // and the registration would silently no-op exactly as the hardcoded set did.
    const lookups = stateWith({ lazyPanelRegistrations: new Set(['commodities']) });
    assert.equal(lookups.isPanelKeyClaimed('commodities'), true);
    assert.equal(newsPanelKeyForCategory('commodities', lookups), 'commodities-news');
  });

  it('counts a key claimed by an already-created panel', () => {
    const lookups = stateWith({ panels: { commodities: { id: 'commodities' } } });
    assert.equal(newsPanelKeyForCategory('commodities', lookups), 'commodities-news');
  });

  it('counts a late-registered key as claimed', () => {
    const lookups = stateWith({ lateRegisteredPanelKeys: new Set(['commodities']) });
    assert.equal(newsPanelKeyForCategory('commodities', lookups), 'commodities-news');
  });

  it('leaves an unclaimed key alone', () => {
    assert.equal(newsPanelKeyForCategory('forex', stateWith()), 'forex');
  });

  it('reads panelSettings by presence, matching shouldCreatePanel', () => {
    // `hasOwnProperty`, not truthiness — every other registration in panel-layout
    // gates on presence, so resolving on a stricter rule would hand back a key the
    // registration then refuses.
    assert.equal(hasPanelSettingEntry({ 'markets-news': undefined }, 'markets-news'), true);
    assert.equal(hasPanelSettingEntry({}, 'markets-news'), false);
    assert.equal(
      stateWith({ panelSettings: { commodities: {}, 'commodities-news': undefined } })
        .hasPanelSetting('commodities-news'),
      true,
    );
  });
});

describe('news panel key reachability (#5871)', () => {
  it('parsers resolve non-empty sets (guards against silent regex drift)', () => {
    assert.notEqual(loopIndex, -1, 'CANONICAL_FEEDS loop not found in panel-layout.ts');
    // Spot-check both sides of the collision this file exists for, so a parser
    // that silently stopped seeing FINANCE_* fails here rather than vacuously
    // passing the reachability assertion with an empty work-list.
    for (const key of ['commodities', 'markets', 'crypto', 'economic', 'supply-chain', 'live-news']) {
      assert.ok(feedCategories.has(key), `expected '${key}' among feed categories`);
    }
    for (const key of ['commodities', 'commodities-news', 'markets', 'markets-news', 'climate-news']) {
      assert.ok(catalogPanelKeys.has(key), `expected '${key}' in the panel catalog`);
    }
    for (const key of ['heatmap', 'markets', 'commodities', 'live-news']) {
      assert.ok(registrations.some((registration) => registration.key === key), `expected '${key}' among panel registrations`);
    }
  });

  it('names every feed and panel preset that actually exists', () => {
    // Without this, FEED_PRESETS / PANEL_PRESETS are exactly the shape of the bug
    // this file exists to catch: a hand-maintained list that drifts from the
    // registry it mirrors. A renamed or newly-added preset would silently shrink
    // the key sets, and the reachability assertion below would keep passing over
    // a smaller world — the same way `commodities` fell off COLLIDING_NEWS_PANEL_KEYS.
    assert.deepEqual(
      declaredPresetConsts(feedsSrc, 'Record<string, Feed\\[\\]>'),
      [...FEED_PRESETS].sort(),
      'src/config/feeds.ts declares a different set of feed presets than FEED_PRESETS names',
    );
    assert.deepEqual(
      declaredPresetConsts(panelsSrc, 'Record<string, PanelConfig>'),
      [...PANEL_PRESETS].sort(),
      'src/config/panels.ts declares a different set of panel presets than PANEL_PRESETS names',
    );
  });

  it('every *-news catalog entry is reachable from a feed category', () => {
    const created = replayNewsPanelPass();
    const orphans = [...catalogPanelKeys]
      .filter(key => key.endsWith('-news'))
      .filter(key => !created.has(key))
      // A key with its own registration (climate-news → ClimateNewsPanel,
      // live-news → LiveNewsPanel) is created directly, not by this pass.
      .filter(key => !dedicatedPanelKeys.has(key))
      .sort();
    assert.deepEqual(
      orphans,
      [],
      `panel catalog entries that no feed category resolves to — the settings toggle and any ` +
        `mission preset referencing them do nothing: ${orphans.join(', ')}`,
    );
  });

  it("maps the 'commodities' feed category onto the 'commodities-news' panel", () => {
    const created = replayNewsPanelPass();
    assert.equal(
      created.get('commodities-news'),
      'commodities',
      "'commodities' is a FINANCE_FEEDS category AND CommoditiesPanel's key, so its NewsPanel " +
        "must be remapped to 'commodities-news' — the key the finance catalog and the " +
        'finCommodities mission preset both reference (#5871)',
    );
    assert.equal(
      created.has('commodities'),
      false,
      "the NewsPanel must not claim 'commodities' — CommoditiesPanel owns it",
    );
  });

  it('keeps the pre-existing markets/crypto/economic remaps intact', () => {
    const created = replayNewsPanelPass();
    for (const base of ['markets', 'crypto', 'economic']) {
      assert.equal(created.get(`${base}-news`), base, `expected ${base} → ${base}-news`);
      assert.equal(created.has(base), false, `NewsPanel must not claim the '${base}' data-panel key`);
    }
  });

  it('never creates a generic NewsPanel for a key another panel owns', () => {
    const created = replayNewsPanelPass();
    for (const [panelKey] of created) {
      assert.equal(
        dedicatedPanelKeys.has(panelKey),
        false,
        `'${panelKey}' already has its own registration in panel-layout — a NewsPanel claiming it ` +
          'is a silent no-op, or shadows the real panel (regression #4382)',
      );
    }
  });

  it('declares every feed-category panel registered after the loop as late-registered', () => {
    // The one thing the pass cannot derive. `ctx.panels` and `lazyPanelRegistrations`
    // only hold what registered ABOVE the loop, so a feed-category panel registered
    // below it is invisible and gets shadowed by a generic NewsPanel (regression
    // #4382, which is what happened to `live-news`). `LATE_REGISTERED_PANEL_KEYS`
    // is the hand-maintained half; this binds it to the actual source order, so
    // moving a panel below the loop — or dropping a key from the set — fails here.
    const declaredBlock = layoutSrc.match(/LATE_REGISTERED_PANEL_KEYS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    assert.ok(declaredBlock, 'LATE_REGISTERED_PANEL_KEYS declaration not found in panel-layout.ts');
    const declared = [...declaredBlock[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!).sort();
    assert.deepEqual(
      lateRegisteredFeedCategories,
      declared,
      'every feed-category panel registered after the CANONICAL_FEEDS pass must be listed in ' +
        'LATE_REGISTERED_PANEL_KEYS, and nothing else should be',
    );
  });

  it('records every colliding feed category that still resolves to no panel', () => {
    const created = replayNewsPanelPass();
    const renderedCategories = new Set(created.values());
    // The mirror image of the reachability check above: a feed category whose key
    // a NON-news panel owns and which has no `${key}-news` outlet either. Nothing
    // is user-visible for it, so only the guard can see it — this is exactly the
    // shape `commodities` had before #5871.
    const collidingWithoutOutlet = [...feedCategories]
      .filter(key => nonNewsPanelKeys.has(key))
      .filter(key => !renderedCategories.has(key))
      .sort();
    assert.deepEqual(
      collidingWithoutOutlet,
      [
        // The dedicated LiveNewsPanel (24/7 video) owns this key on every variant.
        // CANONICAL_FEEDS['live-news'] exists to seed the energy variant's headline
        // sources, not to render a panel — deliberate since #4382.
        'live-news',
        // COMMODITY_FEEDS/ENERGY_FEEDS category whose key SupplyChainPanel owns.
        // No `supply-chain-news` catalog entry exists, so nothing is user-visible
        // and #5376 already removed it from the client's news work-list. Shipping a
        // panel for it is a product decision, not part of this fix (#5871).
        'supply-chain',
      ],
      'a feed category whose key another panel owns renders nowhere — add a `${key}-news` catalog ' +
        'entry, or record it here with the reason it is intentional',
    );
  });

  it('knows every panel-registration primitive panel-layout defines', () => {
    // `panelRegistrations()` discovers registration ORDER by grepping three method
    // names. A fourth primitive would be invisible to it, so a feed-category panel
    // registered through it could move below the pass with LATE_REGISTERED_PANEL_KEYS
    // never updated — and the drift guard above would stay green while a generic
    // NewsPanel shadowed it (regression #4382, through a seam nothing tracks).
    const primitives = [...layoutSrc.matchAll(/^\s*private (lazy\w*Panel|createNewsPanel\w*)\b/gm)]
      .map(m => m[1]!)
      .sort();
    assert.deepEqual(
      primitives,
      ['createNewsPanel', 'createNewsPanelWithLabel', 'lazyDefaultPanel', 'lazyImportedPanel', 'lazyPanel'],
      'a new panel-registration primitive appeared in panel-layout.ts — teach panelRegistrations() ' +
        'about it (or this file stops seeing part of the registration order it replays)',
    );
  });

  it('panel-layout binds the production resolver and lookup adapter', () => {
    const lookupStart = layoutSrc.lastIndexOf('const newsPanelKeyLookups =', loopIndex);
    assert.notEqual(lookupStart, -1, 'newsPanelKeyLookups construction not found before the loop');
    const lookupEnd = layoutSrc.indexOf('});', lookupStart);
    assert.notEqual(lookupEnd, -1, 'newsPanelKeyLookups construction has no closing object');
    const lookupRegion = layoutSrc.slice(lookupStart, lookupEnd + 3);
    assert.match(
      lookupRegion,
      /newsPanelKeyLookupsFor\(\{/,
      'panel-layout must build the production lookups through newsPanelKeyLookupsFor',
    );
    for (const binding of [
      'canonicalFeeds: CANONICAL_FEEDS',
      'panels: this.ctx.panels',
      'lazyPanelRegistrations: this.lazyPanelRegistrations',
      'newsCategoryPanelKeys: this.ctx.newsCategoryPanelKeys',
      'panelSettings: this.ctx.panelSettings',
      'lateRegisteredPanelKeys: LATE_REGISTERED_PANEL_KEYS',
    ]) {
      assert.ok(
        lookupRegion.includes(binding),
        `newsPanelKeyLookupsFor must receive the live production binding: ${binding}`,
      );
    }

    const createCall = layoutSrc.indexOf('createNewsPanelWithLabel(panelKey', loopIndex);
    assert.notEqual(createCall, -1, 'createNewsPanelWithLabel call not found inside the loop');
    const loopRegion = layoutSrc.slice(loopIndex, createCall);
    assert.match(
      loopRegion,
      /newsPanelKeyForCategory\(/,
      'the CANONICAL_FEEDS loop must delegate panel-key resolution to newsPanelKeyForCategory — ' +
        'the assertions above only bind production behaviour while it does',
    );
    assert.doesNotMatch(
      layoutSrc,
      /COLLIDING_NEWS_PANEL_KEYS/,
      'the hardcoded collision set is what omitted `commodities` (#5871); the collision is derived ' +
        'from the live registry now',
    );
  });
});
