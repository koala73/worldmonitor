import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { VARIANT_FEEDS, isServerFeedReachableForLanguage } from '../server/worldmonitor/news/v1/_feeds';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { isFeedInLanguage } from '../src/services/feed-language';
import { digestCarriesFeed } from '../shared/news-catalog-browser';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { publisherFamilyFor, publisherFamilyForDomain } from '../shared/publisher-families.js';
import { SOURCE_TYPES, getSourceProvenanceState } from '../shared/source-provenance';
import { SOURCE_TIERS } from '../server/_shared/source-tiers';
import type { Feed } from '../src/types';
import { applyMigrationChain, buildMigrations, migrateGermanRssSourcesV10 } from '../src/utils/cloud-prefs-migrations';

const SOURCES = [
  { name: 'Deutschlandfunk', url: 'https://www.deutschlandfunk.de/nachrichten-100.rss', domain: 'deutschlandfunk.de' },
  { name: 'ZDFheute', url: 'https://www.zdfheute.de/rss/zdf/nachrichten', domain: 'zdfheute.de' },
] as const;
type Client = {
  FULL_FEEDS: Record<string, Feed[]>;
  computeDefaultDisabledSources: (locale?: string) => string[];
};
const tempDir = mkdtempSync(join(tmpdir(), 'german-news-'));
let client: Client;
before(async () => { client = await bundleFeedsModule<Client>({ repoRoot: process.cwd(), tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('German public-service RSS sources', () => {
  it('migrates returning profiles once, respecting German defaults and later explicit choices', () => {
    const names = SOURCES.map(s => s.name);
    const migrate = migrateGermanRssSourcesV10;
    const key = 'worldmonitor-disabled-feeds';
    for (const locale of ['en', 'fr', 'de', 'de-DE']) {
      const blob = { [key]: JSON.stringify(['user-choice']) };
      const result = migrate(blob, names, locale);
      assert.deepEqual(JSON.parse(result[key] as string), locale.startsWith('de') ? ['user-choice'] : ['user-choice', ...names]);
      assert.equal(migrate(result, names, locale), result, 'migration is idempotent');
    }
    // Empty means an explicit enable-all selection; malformed preferences are not rewritten.
    for (const raw of ['[]', 'bad-json', '[42]', '{}']) {
      const blob = { [key]: raw };
      assert.equal(migrate(blob, names, 'en'), blob);
    }
    assert.equal(migrate({}, names, 'en')[key], undefined);
    const disabledGerman = { [key]: JSON.stringify([names[0]]) };
    assert.equal(migrate(disabledGerman, names, 'de'), disabledGerman, 'explicit German disable is preserved');
    assert.deepEqual(JSON.parse(migrate({ [key]: '["user-choice","user-choice","user-choice"]' }, names, 'en')[key] as string), ['user-choice', 'user-choice', 'user-choice', ...names]);
    let locale = 'en';
    const migrations = buildMigrations({}, { germanRss: { sources: names, locale: () => locale } });
    const oldCloud = { [key]: '["user-choice"]' };
    assert.deepEqual(JSON.parse(applyMigrationChain(oldCloud, 9, 10, migrations)[key] as string), ['user-choice', ...names]);
    locale = 'de';
    assert.equal(applyMigrationChain(oldCloud, 9, 10, migrations), oldCloud, 'cloud migration uses the current locale');
    locale = 'en';
    assert.equal(applyMigrationChain(oldCloud, 10, 10, migrations), oldCloud, 'later explicit selections survive cloud sync');
  });
  it('registers matching German feeds last in Full Europe, with no other variant placement', () => {
    for (const view of [client.FULL_FEEDS, VARIANT_FEEDS.full]) {
      assert.deepEqual(view.europe!.slice(-2).map(f => f.name), SOURCES.map(s => s.name));
      for (const row of SOURCES) {
        const feed = view.europe!.find(f => f.name === row.name);
        assert.equal(feed?.url, row.url);
        assert.equal(feed?.lang, 'de');
        assert.ok(!feed?.strategicDefault);
      }
    }
    for (const [variant, categories] of Object.entries(VARIANT_FEEDS)) {
      if (variant === 'full') continue;
      assert.ok(Object.values(categories).flat().every(f => !SOURCES.some(s => s.name === f.name)));
    }
  });

  it('defaults on only for German locales, while explicit selections are fetchable in every locale', () => {
    for (const language of ['de', 'de-DE', 'de-AT', 'en', 'fr', 'ar']) {
      const disabled = new Set(client.computeDefaultDisabledSources(language));
      for (const row of SOURCES) {
        assert.equal(disabled.has(row.name), !language.startsWith('de'), `${language}: ${row.name}`);
      }
    }
    for (const row of SOURCES) {
      const feed = client.FULL_FEEDS.europe!.find(f => f.name === row.name)!;
      const server = VARIANT_FEEDS.full!.europe!.find(f => f.name === row.name)!;
      assert.ok(feed && server);
      for (const language of ['de', 'en', 'fr', 'ar']) {
        assert.ok(isFeedInLanguage(feed, language), `${row.name}: browser ${language}`);
        assert.ok(isServerFeedReachableForLanguage(server, language), `${row.name}: server ${language}`);
        assert.ok(digestCarriesFeed(feed, language), `${row.name}: cache reader ${language}`);
        assert.ok(__testing__.buildDigestFeedBatches('full', language).batches.flat()
          .some(entry => entry.feed.name === row.name), `${row.name}: scheduled in ${language}`);
      }
    }
    assert.equal(isFeedInLanguage({ name: 'Existing German source', url: 'https://example.com/rss', lang: 'de' }, 'en'), false);
  });

  it('allows only the required RSS hosts and assigns explicit publisher metadata', () => {
    for (const row of SOURCES) {
      assert.ok(isAllowedDomain(new URL(row.url).hostname));
      assert.ok(!isAllowedDomain(`${row.domain}.evil.example`));
      assert.equal(SOURCE_TIERS[row.name], 2);
      assert.equal(SOURCE_TYPES[row.name], 'mainstream');
      assert.equal(getSourceProvenanceState(row.name).risk, 'unknown');
      assert.equal(getSourceProvenanceState(row.name).riskDeclared, true);
      assert.equal(publisherFamilyForDomain(row.domain), publisherFamilyFor(row.name));
    }
    assert.notEqual(publisherFamilyFor('Deutschlandfunk'), publisherFamilyFor('ZDFheute'));
  });

  it('parses dated German items and preserves publisher links without accepting unrelated hosts', () => {
    for (const row of SOURCES) {
      const feed = VARIANT_FEEDS.full!.europe!.find(f => f.name === row.name)!;
      assert.ok(feed);
      const link = `https://www.${row.domain}/nachrichten/test`;
      const xml = (url: string) => `<rss><channel><item><title>Deutschland und Europa beraten über Wirtschaft</title><link>${url}</link><pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate></item></channel></rss>`;
      const parsed = __testing__.parseRssXml(xml(link), feed, 'full');
      assert.equal(parsed?.items.length, 1);
      assert.equal(parsed!.items[0]!.link, link);
      assert.equal(parsed!.items[0]!.source, row.name);
      assert.equal(__testing__.parseRssXml(xml('https://evil.example/story'), feed, 'full')?.items[0]?.link, '');
    }
  });
});
