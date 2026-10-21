// 2026-10-17 audit of /verify against Google News World: the claim pool kept
// 30 entries per feed, which covered 6.6 hours of AP, and lacked the BBC's UK
// desks.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest.ts';
import { publisherFamilyFor } from '../shared/publisher-families.js';
import { selectSourcesUnderCap } from '../src/services/source-cap';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';

const { parseRssXml } = __testing__;

interface FeedEntry { name: string; url: string | Record<string, string>; lang?: string }
interface FeedsModule {
  FULL_FEEDS: Record<string, FeedEntry[]>;
  FEEDS: Record<string, FeedEntry[]>;
  INTEL_SOURCES: FeedEntry[];
  FREE_CAP_PROTECTED_SOURCES: readonly string[];
  BBC_UK_DEFAULT_SOURCES: readonly string[];
  REGIONAL_FEED_ROLLOUT_STAGES: ReadonlyArray<{ introducedNames: readonly string[] }>;
  computeDefaultDisabledSources: (locale?: string) => string[];
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(repoRoot, 'tmp-deeper-feed-pool-test');
const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

let feeds: FeedsModule;
before(async () => { feeds = await bundleFeedsModule<FeedsModule>({ repoRoot, tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('per-feed claim pool depth', () => {
  const ap = { url: gn('site:apnews.com when:1d'), name: 'AP News' };
  const xml = (n: number) => `<?xml version="1.0"?><rss><channel>${Array.from({ length: n }, (_, i) => `<item>
    <title>AP headline number ${i + 1} about the world</title>
    <link>https://apnews.com/article/story-${i + 1}</link>
    <pubDate>${new Date(Date.now() - i * 60_000).toUTCString()}</pubDate>
    <source url="https://apnews.com">AP News</source>
  </item>`).join('')}</channel></rss>`;

  it('keeps every entry of a full 100-entry Google News feed in the full variant', () => {
    const parsed = parseRssXml(xml(100), ap, 'full');
    assert.ok(parsed);
    assert.equal(parsed.items.length + (parsed.countryItems?.length ?? 0), 100);
    assert.ok(parsed.countryItems?.some((item) => item.title.includes('number 95')), 'AP entry 95 is searchable');
  });

  it('still stops at 100 entries for a longer feed', () => {
    const parsed = parseRssXml(xml(150), ap, 'full');
    assert.ok(parsed);
    assert.equal(parsed.items.length + (parsed.countryItems?.length ?? 0), 100);
  });

  it('logs gated pool links once per feed, not once per entry', (t) => {
    const npr = { url: 'https://feeds.npr.org/1001/rss.xml', name: 'NPR News', lang: 'en' };
    const item = (link: string, n: number) => `<item><title>NPR headline ${n} about Kenya talks</title><link>${link}</link>`
      + `<pubDate>${new Date(Date.now() - n * 60_000).toUTCString()}</pubDate></item>`;
    const body = Array.from({ length: 5 }, (_, i) => item(`https://feeds.npr.org/kenya-${i}`, i)).join('')
      + Array.from({ length: 40 }, (_, i) => item(`https://evil.example/phish-${i}`, i + 5)).join('');
    const warn = t.mock.method(console, 'warn', () => {});
    const parsed = parseRssXml(`<?xml version="1.0"?><rss><channel>${body}</channel></rss>`, npr, 'full');
    assert.ok(parsed);
    assert.equal(parsed.countryItems?.length, 0, 'every gated pool link is dropped');
    const drops = warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('publisher-link-gate drop'));
    assert.deepEqual(drops, ['[digest] publisher-link-gate drop feed="NPR News" variant=full hosts="evil.example:40" count=40']);
  });

  it('counts gated pool links per host when a feed drops links to several hosts', (t) => {
    const npr = { url: 'https://feeds.npr.org/1001/rss.xml', name: 'NPR News', lang: 'en' };
    const hosts = ['b.example', 'a.example', 'a.example', 'c.example', 'a.example', 'b.example'];
    const body = Array.from({ length: 5 }, (_, i) => `<item><title>NPR headline ${i}</title><link>https://feeds.npr.org/x-${i}</link>`
      + `<pubDate>${new Date(Date.now() - i * 60_000).toUTCString()}</pubDate></item>`).join('')
      + hosts.map((host, i) => `<item><title>Gated headline ${i}</title><link>https://${host}/p-${i}</link>`
        + `<pubDate>${new Date(Date.now() - (i + 5) * 60_000).toUTCString()}</pubDate></item>`).join('');
    const warn = t.mock.method(console, 'warn', () => {});
    parseRssXml(`<?xml version="1.0"?><rss><channel>${body}</channel></rss>`, npr, 'full');
    const drops = warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('publisher-link-gate drop'));
    assert.deepEqual(drops, ['[digest] publisher-link-gate drop feed="NPR News" variant=full hosts="a.example:3,b.example:2,c.example:1" count=6']);
  });

  it('keeps no pool past the dashboard cap outside the full variant', () => {
    const parsed = parseRssXml(xml(100), ap, 'tech');
    assert.ok(parsed);
    assert.equal(parsed.items.length, 5);
    assert.equal(parsed.countryItems, undefined);
  });
});

describe('feeds added by the 2026-10-17 audit', () => {
  it('folds the BBC UK desks into the BBC publisher family', () => {
    assert.equal(publisherFamilyFor('BBC UK'), publisherFamilyFor('BBC World'));
    assert.equal(publisherFamilyFor('BBC Northern Ireland'), publisherFamilyFor('BBC World'));
  });

  it('carries BBC UK and BBC Northern Ireland last in Europe in both catalogs', () => {
    for (const [name, url] of [
      ['BBC UK', 'https://feeds.bbci.co.uk/news/uk/rss.xml'],
      ['BBC Northern Ireland', 'https://feeds.bbci.co.uk/news/northern_ireland/rss.xml'],
    ] as const) {
      assert.equal(VARIANT_FEEDS.full!.europe!.find((feed) => feed.name === name)?.url, url, `${name}: server`);
      assert.equal(feeds.FULL_FEEDS.europe!.find((feed) => feed.name === name)?.url, url, `${name}: client`);
    }
    assert.deepEqual(feeds.FULL_FEEDS.europe!.slice(-2).map((feed) => feed.name), ['BBC UK', 'BBC Northern Ireland']);
  });

  it('enables BBC UK by default in English and leaves BBC Northern Ireland opt-in', () => {
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    assert.equal(disabled.has('BBC UK'), false);
    assert.equal(disabled.has('BBC Northern Ireland'), true);
  });

  it('evicts no source the free-tier cap kept before for a default English profile', () => {
    const added = ['BBC UK', 'BBC Northern Ireland'];
    const disabled = new Set(feeds.computeDefaultDisabledSources('en'));
    const protectedNames = new Set(feeds.FREE_CAP_PROTECTED_SOURCES);
    const without = Object.fromEntries(Object.entries(feeds.FEEDS)
      .map(([category, entries]) => [category, entries.filter((feed) => !added.includes(feed.name))]));
    const before = selectSourcesUnderCap(without, feeds.INTEL_SOURCES, disabled, 80, protectedNames);
    const now = selectSourcesUnderCap(feeds.FEEDS, feeds.INTEL_SOURCES, disabled, 80, protectedNames);
    for (const name of before.keep) assert.ok(now.keep.has(name), `${name} is still kept under the free cap`);
  });

  it('introduces BBC UK in its own rollout stage', () => {
    assert.deepEqual([...feeds.BBC_UK_DEFAULT_SOURCES], ['BBC UK']);
    assert.ok(feeds.REGIONAL_FEED_ROLLOUT_STAGES.some((stage) => stage.introducedNames.length === 1 && stage.introducedNames[0] === 'BBC UK'));
  });
});
