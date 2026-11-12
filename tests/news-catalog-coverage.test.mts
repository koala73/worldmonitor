/**
 * Source-coverage gate for the unified news catalog (plan U2, R3, R4).
 *
 * Every source the browser can show must be fetched by a digest the server
 * builds, so the dashboard, MCP and every other digest reader see the same
 * news. Panels read only digests, so a source no digest fetches would show
 * nothing.
 */
import assert from 'node:assert/strict';
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
  undigestedBrowserPlacements,
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

// The categories each digest fetches (buildServerVariantFeeds), plus the intel
// list the full digest also fetches (INTEL_SOURCES).
const SERVED = servedLayout(catalog.layout.server, VALID_VARIANTS, INTEL_EDITION);

describe('news catalog source coverage', () => {
  it('every browser source is fetched by a served digest', () => {
    const gaps = uncoveredSources(browserPlacedNames(catalog.feeds), catalog.feeds, SERVED);
    assert.deepEqual(gaps, [], `browser sources no digest fetches: ${gaps.join(', ')}`);
  });

  it('every browser placement is fetched by a digest for that panel, from the same entry', () => {
    assert.deepEqual(undigestedBrowserPlacements(catalog.feeds, SERVED, 'ondemand'), []);
  });

  it('server placements are only in edition/category pairs a digest fetches', () => {
    assert.deepEqual(unservedServerPlacements(catalog.feeds, SERVED), []);
  });

  it('every catalog language is a digest language', () => {
    assert.deepEqual(unsupportedLanguages(catalog.feeds, NEWS_LANGUAGES), []);
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
    assert.deepEqual(uncoveredSources(['Known', 'Ghost Wire'], feeds, served), ['Ghost Wire']);
  });

  it('a browser-only source fails', () => {
    const feeds = [feed('Browser Only', [{ edition: 'full', category: 'politics', browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(browserPlacedNames(feeds), feeds, served), ['Browser Only']);
    assert.deepEqual(undigestedBrowserPlacements(feeds, served, 'ondemand'), ['Browser Only → full/politics']);
  });

  it('a browser entry fails when only a same-named entry with another URL is served', () => {
    const feeds = [
      feed('Wire', [{ edition: 'full', category: 'politics', serverOrder: 0 }]),
      { ...feed('Wire', [{ edition: 'full', category: 'politics', browserOrder: 0 }]), url: 'https://wire.example/other' },
    ];
    assert.deepEqual(uncoveredSources(['Wire'], feeds, served), [], 'the name is served');
    assert.deepEqual(undigestedBrowserPlacements(feeds, served, 'ondemand'), ['Wire → full/politics']);
  });

  it('an on-demand placement is served by any edition that fetches its category', () => {
    const feeds = [feed('Desk', [
      { edition: 'full', category: 'politics', serverOrder: 0 },
      { edition: 'ondemand', category: 'politics', browserOrder: 0 },
    ])];
    assert.deepEqual(undigestedBrowserPlacements(feeds, served, 'ondemand'), []);
  });

  it('a server placement in an unserved edition does not count as covered', () => {
    const feeds = [feed('Energy Desk', [{ edition: 'energy', category: 'energy', serverOrder: 0, browserOrder: 0 }])];
    assert.deepEqual(uncoveredSources(['Energy Desk'], feeds, served), ['Energy Desk']);
    assert.deepEqual(unservedServerPlacements(feeds, served), ['Energy Desk → energy/energy']);
  });

  it('a server placement in a category the edition does not fetch does not count as covered', () => {
    const feeds = [
      feed('Typo Wire', [{ edition: 'full', category: 'politcs', serverOrder: 0, browserOrder: 0 }]),
      feed('Intel Desk', [{ edition: 'intel', category: 'intel', serverOrder: 0 }]),
    ];
    assert.deepEqual(uncoveredSources(['Typo Wire', 'Intel Desk'], feeds, served), ['Typo Wire']);
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
    // Panels read this to decide which sources a digest covers (#9796
    // source fill); it must match what each digest builds.
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
