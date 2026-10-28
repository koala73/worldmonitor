/**
 * Source-coverage gate for the unified news catalog (plan U2, R3).
 *
 * Every source the browser can show must be fetched by a digest the server
 * builds, so the dashboard, MCP and every other digest reader see the same
 * news. Today's gap is held in shared/news-catalog-pending-migration.json,
 * which may only shrink.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { INTEL_EDITION, digestCarriesFeed } from '../shared/news-catalog-browser';
import { projectBrowserCatalog } from '../shared/news-catalog';
import { VALID_VARIANTS, __testing__ as digestTesting } from '../server/worldmonitor/news/v1/list-feed-digest';
import { NEWS_LANGUAGES } from '../src/shared/public-rpc-cache';
import {
  browserPlacedNames,
  servedLayout,
  serverPlacedNames,
  uncoveredSources,
  unservedServerPlacements,
  unsupportedLanguages,
  type CoverageFeed,
} from './_lib/news-catalog-coverage.mts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const catalog = readJson('shared/news-catalog.json') as {
  feeds: CoverageFeed[];
  layout: { server: Record<string, string[]> };
};
const pendingNames: string[] = readJson('shared/news-catalog-pending-migration.json').names;
const pending = new Set(pendingNames);

// The categories each digest fetches (buildServerVariantFeeds), plus the intel
// list the full digest also fetches (INTEL_SOURCES).
const SERVED = servedLayout(catalog.layout.server, VALID_VARIANTS, INTEL_EDITION);

// Frozen snapshot of the browser-only sources when the gate landed. The pending
// list may only drop names from it, so a swap (remove one, add another) fails.
// The hash pins the snapshot: changing it is a deliberate, reviewable edit.
const BASELINE_PATH = 'tests/fixtures/news-catalog-pending-baseline.json';
const BASELINE_SHA256 = 'a1b4930b199adda8d4732123fd8298cbd019ac640ca8f0e4ae7ee159bfc686a3';

describe('news catalog source coverage', () => {
  it('every browser source is fetched by a served digest, or pending migration', () => {
    const gaps = uncoveredSources(browserPlacedNames(catalog.feeds), catalog.feeds, SERVED, pending);
    assert.deepEqual(gaps, [], `browser sources no digest fetches: ${gaps.join(', ')}`);
  });

  it('server placements are only in edition/category pairs a digest fetches', () => {
    assert.deepEqual(unservedServerPlacements(catalog.feeds, SERVED), []);
  });

  it('every catalog language is a digest language', () => {
    assert.deepEqual(unsupportedLanguages(catalog.feeds, NEWS_LANGUAGES), []);
  });

  it('the pending list only drops names from the frozen baseline', () => {
    const raw = readFileSync(join(root, BASELINE_PATH), 'utf8');
    assert.equal(
      createHash('sha256').update(raw).digest('hex'),
      BASELINE_SHA256,
      `${BASELINE_PATH} changed; it is frozen and must never gain names`,
    );
    const baseline = new Set<string>(JSON.parse(raw).names);
    const added = pendingNames.filter((name) => !baseline.has(name));
    assert.deepEqual(added, [], 'pending names not in the frozen baseline: place new sources on the server instead');
    assert.equal(new Set(pendingNames).size, pendingNames.length, 'pending list has duplicate names');
  });

  it('every pending name is a real, still-unmigrated browser source', () => {
    const browser = browserPlacedNames(catalog.feeds);
    const served = serverPlacedNames(catalog.feeds, SERVED);
    const unknown = pendingNames.filter((name) => !browser.has(name));
    const migrated = pendingNames.filter((name) => served.has(name));
    assert.deepEqual(unknown, [], 'pending names with no browser placement');
    assert.deepEqual(migrated, [], 'pending names already placed on the server: remove them from the list');
  });
});

describe('coverage rules (fixtures)', () => {
  const feed = (name: string, placements: CoverageFeed['placements'], extra: Partial<CoverageFeed> = {}): CoverageFeed => ({
    name,
    url: `https://${name.toLowerCase()}.example/rss`,
    placements,
    ...extra,
  });
  const served = servedLayout({ full: ['politics'] }, ['full'], 'intel');

  it('names an unknown source referenced by a default list (AE3)', () => {
    const feeds = [feed('Known', [{ edition: 'full', category: 'politics', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Known', 'Ghost Wire'], feeds, served, new Set()), ['Ghost Wire']);
  });

  it('a browser-only source fails unless pending', () => {
    const feeds = [feed('Browser Only', [{ edition: 'full', category: 'politics', browserOrder: 0 }])];
    const referenced = browserPlacedNames(feeds);
    assert.deepEqual(uncoveredSources(referenced, feeds, served, new Set()), ['Browser Only']);
    assert.deepEqual(uncoveredSources(referenced, feeds, served, new Set(['Browser Only'])), []);
  });

  it('a server placement in an unserved edition does not count as covered', () => {
    const feeds = [feed('Energy Desk', [{ edition: 'energy', category: 'energy', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Energy Desk'], feeds, served, new Set()), ['Energy Desk']);
    assert.deepEqual(unservedServerPlacements(feeds, served), ['Energy Desk → energy/energy']);
  });

  it('a server placement in a category the edition does not fetch does not count as covered', () => {
    const feeds = [
      feed('Typo Wire', [{ edition: 'full', category: 'politcs', serverOrder: 0, browserOrder: 0 }]),
      feed('Intel Desk', [{ edition: 'intel', category: 'intel', serverOrder: 0 }]),
    ];
    assert.deepEqual(uncoveredSources(['Typo Wire', 'Intel Desk'], feeds, served, new Set()), ['Typo Wire']);
    assert.deepEqual(unservedServerPlacements(feeds, served), ['Typo Wire → full/politcs']);
  });

  it('a language outside the digest languages fails, including per-language URL keys', () => {
    const feeds = [
      feed('Hebrew Daily', [{ edition: 'full', category: 'politics', serverOrder: 0 }], { lang: 'he' }),
      feed('Multi', [{ edition: 'full', category: 'politics', serverOrder: 1 }], { browser: { url: { en: 'https://m.example/en', gr: 'https://m.example/gr' } } }),
    ];
    assert.deepEqual(unsupportedLanguages(feeds, new Set(['en', 'el'])), ['gr (Multi)', 'he (Hebrew Daily)']);
  });
});

describe('digests serve the categories that used to need per-feed browser fetches', () => {
  const scheduled = (edition: string) =>
    new Set(digestTesting.buildDigestFeedBatches(edition, 'en').batches.flat().map(entry => entry.category));

  it('the energy edition digest schedules its energy categories', () => {
    assert.ok(VALID_VARIANTS.has('energy'));
    for (const category of ['live-news', 'energy', 'supply-chain']) {
      assert.ok(scheduled('energy').has(category), `energy digest must fetch ${category}`);
    }
  });

  it('the tech digest schedules podcasts and think tanks, the finance digest nq-news', () => {
    assert.ok(scheduled('tech').has('podcasts'));
    assert.ok(scheduled('tech').has('thinktanks'));
    assert.ok(scheduled('finance').has('nq-news'));
  });

  // AE1: a source migrated out of the browser-only list is fetched by the
  // digest in its own language, and only there.
  it('the Portuguese full digest fetches Folha de S.Paulo in latam; the English one does not', () => {
    const latamSources = (lang: string) => digestTesting.buildDigestFeedBatches('full', lang).batches.flat()
      .filter(entry => entry.category === 'latam')
      .map(entry => entry.feed.name);
    assert.ok(latamSources('pt').includes('Folha de S.Paulo'));
    assert.ok(!latamSources('en').includes('Folha de S.Paulo'));
  });

  it('the tech digest fetches its regional startup sources (U6 batch 2)', () => {
    const regional = digestTesting.buildDigestFeedBatches('tech', 'en').batches.flat()
      .filter(entry => entry.category === 'regionalStartups')
      .map(entry => entry.feed.name);
    for (const name of ['YourStory', 'KrASIA', 'MENA Startups', 'Africa Tech News', 'FinTech LATAM']) {
      assert.ok(regional.includes(name), `tech digest must fetch ${name}`);
    }
  });

  it('the tech digest fetches every tech source the browser shows (U6 batch 3)', () => {
    const fetched = new Set(digestTesting.buildDigestFeedBatches('tech', 'en').batches.flat()
      .map(entry => `${entry.category}|${entry.feed.name}`));
    const browserOnly = catalog.feeds.flatMap(feed => feed.placements
      .filter(p => p.edition === 'tech' && p.browserOrder !== undefined && (!feed.lang || feed.lang === 'en'))
      .map(p => `${p.category}|${feed.name}`))
      .filter(key => !fetched.has(key));
    assert.deepEqual(browserOnly, []);
    for (const name of ['DevOps.com', 'FwdStart Newsletter']) {
      const feed = catalog.feeds.find(f => f.name === name);
      assert.match(feed?.url ?? '', /^https:\/\//, `${name} must have an absolute URL the server can fetch`);
    }
  });

  it('every English digest fetches every source its edition shows (U6 batch 4)', () => {
    const missing: string[] = [];
    for (const edition of new Set(catalog.feeds.flatMap(feed => feed.placements.map(p => p.edition)))) {
      const variant = edition === INTEL_EDITION ? 'full' : edition;
      if (!VALID_VARIANTS.has(variant)) continue;
      const fetched = new Set(digestTesting.buildDigestFeedBatches(variant, 'en').batches.flat()
        .map(entry => entry.feed.name));
      for (const feed of catalog.feeds) {
        if (feed.lang && feed.lang !== 'en') continue;
        if (!feed.placements.some(p => p.edition === edition && p.browserOrder !== undefined)) continue;
        if (!fetched.has(feed.name)) missing.push(`${edition}|${feed.name}`);
      }
    }
    assert.deepEqual(missing, []);
    assert.deepEqual(pendingNames, []);
    // GitHub Trending dates only its channel and links to github.com, so its
    // entry opts in to both.
    const trending = catalog.feeds.find(f => f.name === 'GitHub Trending') as { channelDated?: boolean; linkHosts?: string[] } | undefined;
    assert.equal(trending?.channelDated, true);
    assert.deepEqual(trending?.linkHosts, ['github.com']);
    for (const name of ['FAS', 'New Scientist', 'Ransomware.live']) {
      const feed = catalog.feeds.find(f => f.name === name);
      assert.match(feed?.url ?? '', /^https:\/\/news\.google\.com\/rss\/search\?q=site:[^&]+\+when:\d+d&/,
        `${name} reads a dated Google News site: query`);
    }
  });

  // The pending list is by name, so a source the server fetches in one edition
  // used to hide a browser placement no digest fetches in another (MIT Tech
  // Review on the tech edition's tech panel). Panels match items by source
  // name, and the on-demand edition reads whichever digest carries its category.
  it('every browser placement of a migrated source is fetched by a digest for that panel', () => {
    const served = new Map<string, Set<string>>();
    for (const feed of catalog.feeds) {
      for (const p of feed.placements) {
        if (p.serverOrder === undefined) continue;
        const keys = served.get(feed.name) ?? new Set<string>();
        keys.add(`${p.edition}|${p.category}`);
        served.set(feed.name, keys);
      }
    }
    const gaps = catalog.feeds.flatMap(feed => feed.placements
      .filter(p => p.browserOrder !== undefined && !pending.has(feed.name))
      .filter((p) => {
        const keys = served.get(feed.name) ?? new Set<string>();
        if (keys.has(`${p.edition}|${p.category}`)) return false;
        return !(p.edition === 'ondemand' && [...keys].some(key => key.endsWith(`|${p.category}`)));
      })
      .map(p => `${p.edition}|${p.category}|${feed.name}`));
    assert.deepEqual(gaps, []);
  });

  it('a Spanish outlet the browser shows in every language builds only in the Spanish digest', () => {
    const latamSources = (lang: string) => digestTesting.buildDigestFeedBatches('full', lang).batches.flat()
      .filter(entry => entry.category === 'latam')
      .map(entry => entry.feed.name);
    assert.ok(latamSources('es').includes('La Silla Vacía'));
    assert.ok(!latamSources('en').includes('La Silla Vacía'));
    const browser = projectBrowserCatalog().editions.full!.latam!.find(feed => feed.name === 'La Silla Vacía')!;
    assert.equal(browser.lang, undefined, 'browser targeting unchanged');
    assert.equal(browser.digestLang, 'es');
  });

  it('the browser catalog states exactly which digest languages carry each source', async () => {
    // Panels read this to decide which sources a digest covers (direct
    // fetch, #9796 source fill); it must match what each digest builds.
    const browser = projectBrowserCatalog();
    const mismatches: string[] = [];
    for (const edition of VALID_VARIANTS) {
      const placed: Array<[string, typeof browser.intel]> = Object.entries(browser.editions[edition] ?? {});
      if (edition === 'full') placed.push(['intel', browser.intel]);
      for (const language of NEWS_LANGUAGES) {
        const built = new Set(digestTesting.buildDigestFeedBatches(edition, language).batches.flat()
          .map(entry => `${entry.category}|${entry.feed.name}`));
        for (const [category, feeds] of placed) {
          for (const feed of feeds) {
            if (feed.browserOnly) continue;
            if (built.has(`${category}|${feed.name}`) !== digestCarriesFeed(feed, language)) {
              mismatches.push(`${edition}/${category}/${feed.name}/${language}`);
            }
          }
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });
});

describe('relay classify covers every digest edition within its cycle', () => {
  const relay = readFileSync(join(root, 'scripts/ais-relay.cjs'), 'utf8');
  const editions = JSON.parse(readFileSync(join(root, 'scripts/shared/news-digest-editions.json'), 'utf8')) as string[];
  const minutes = (name: string) => {
    const match = relay.match(new RegExp(`const ${name} = (\\d+) \\* 60 \\* 1000;`));
    assert.ok(match, `${name} not found in ais-relay.cjs`);
    return Number(match[1]);
  };

  it('iterates the generated edition list, which matches the digest editions', () => {
    assert.match(relay, /const CLASSIFY_VARIANTS = requireShared\('news-digest-editions\.json'\);/);
    assert.deepEqual([...editions].sort(), [...VALID_VARIANTS].sort());
  });

  it('keeps the waits between editions inside the classify interval', () => {
    const interval = minutes('CLASSIFY_SEED_INTERVAL_MS');
    const staggerTotal = minutes('CLASSIFY_STAGGER_TOTAL_MS');
    const perEdition = Math.floor(staggerTotal / Math.max(1, editions.length - 1));
    assert.ok((editions.length - 1) * perEdition < interval, `${editions.length} editions overrun the ${interval}-minute interval`);
  });
});
