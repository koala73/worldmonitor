// Major publishers that Google News World leads with and no feed carried
// (2026-10-16 audit): NYT, Washington Post, The Economist, The Independent,
// Sky News, Times of Israel, Middle East Eye and Japan Times. Publisher RSS or Google News
// site: feeds, default-on for English, last in their categories.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { selectSourcesUnderCap } from '../src/services/source-cap';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';

interface FeedEntry { name: string; url: string | Record<string, string>; lang?: string }
interface FeedsModule {
  FULL_FEEDS: Record<string, FeedEntry[]>;
  FEEDS: Record<string, FeedEntry[]>;
  INTEL_SOURCES: FeedEntry[];
  FREE_CAP_PROTECTED_SOURCES: readonly string[];
  MAJOR_PUBLISHER_DEFAULT_SOURCES: readonly string[];
  REGIONAL_FEED_ROLLOUT_STAGES: ReadonlyArray<{ introducedNames: readonly string[] }>;
  computeDefaultDisabledSources: (locale?: string) => string[];
}

const countryAdditions = new Set<string>(JSON.parse(readFileSync('shared/country-news-opt-ins.json', 'utf8')));
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(repoRoot, 'tmp-major-publisher-feeds-test');
const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const EXPECTED: Record<string, { category: string; url: string }> = {
  'New York Times World': { category: 'politics', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  'Washington Post World': { category: 'politics', url: 'https://feeds.washingtonpost.com/rss/world' },
  'The Economist': { category: 'politics', url: gn('site:economist.com when:1d') },
  'The Independent': { category: 'politics', url: 'https://www.independent.co.uk/news/world/rss' },
  'Sky News': { category: 'europe', url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
  'Times of Israel': { category: 'middleeast', url: gn('site:timesofisrael.com when:1d') },
  'Middle East Eye': { category: 'middleeast', url: gn('site:middleeasteye.net when:1d') },
  'Japan Times': { category: 'asia', url: gn('site:japantimes.co.jp when:1d') },
};
const NAMES = Object.keys(EXPECTED);
// Appended after this pack by the 2026-10-17 audit (tests/deeper-feed-pool.test.mts).
const LATER = ['BBC UK', 'BBC Northern Ireland', 'Deutschlandfunk', 'ZDFheute'];

let feeds: FeedsModule;
before(async () => { feeds = await bundleFeedsModule<FeedsModule>({ repoRoot, tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('major publisher feeds', () => {
  it('both catalogs carry each feed in the same category with the same upstream URL', () => {
    assert.deepEqual([...feeds.MAJOR_PUBLISHER_DEFAULT_SOURCES].sort(), [...NAMES].sort());
    for (const [name, { category, url }] of Object.entries(EXPECTED)) {
      const server = VARIANT_FEEDS.full![category]!.find((feed) => feed.name === name);
      const client = feeds.FULL_FEEDS[category]!.find((feed) => feed.name === name);
      assert.equal(server?.url, url, `${name}: server URL`);
      assert.equal(client?.url, url, `${name}: client URL`);
      assert.equal(server?.lang, undefined, `${name}: reachable from every digest language`);
    }
  });

  it('comes last in its category, after every source that was there before', () => {
    for (const [category, entries] of Object.entries(feeds.FULL_FEEDS)) {
      const names = entries.map((feed) => feed.name);
      const firstNew = names.findIndex((name) => NAMES.includes(name));
      if (firstNew < 0) continue;
      assert.ok(names.slice(firstNew).every((name) => NAMES.includes(name) || LATER.includes(name) || countryAdditions.has(name)), `${category}: new feeds are appended`);
    }
  });

  it('is default-on in English', () => {
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    for (const name of NAMES) assert.equal(disabled.has(name), false, `${name} is enabled by default`);
  });

  it('evicts no source the free-tier cap kept before for a default English profile', () => {
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    const protectedNames = new Set(feeds.FREE_CAP_PROTECTED_SOURCES);
    const without = Object.fromEntries(Object.entries(feeds.FEEDS)
      .map(([category, entries]) => [category, entries.filter((feed) => !NAMES.includes(feed.name))]));
    const before = selectSourcesUnderCap(without, feeds.INTEL_SOURCES, disabled, 80, protectedNames);
    const now = selectSourcesUnderCap(feeds.FEEDS, feeds.INTEL_SOURCES, disabled, 80, protectedNames);
    for (const name of before.keep) assert.ok(now.keep.has(name), `${name} is still kept under the free cap`);
  });

  it('is introduced by its own rollout stage, so pre-existing capped profiles still reconstruct', () => {
    const stage = feeds.REGIONAL_FEED_ROLLOUT_STAGES.find((s) => s.introducedNames.includes(NAMES[0]!))!;
    assert.deepEqual([...stage.introducedNames].sort(), [...NAMES].sort());
  });
});
