// Publisher RSS feeds for US, UK, Brazilian and French outlets that only had
// Google News coverage or none (2026-11-18 audit). Each one reads the
// publisher's own feed, ships opt-in in every interface language, and keeps
// its links on the publisher's hosts.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { isFeedInLanguage } from '../src/services/feed-language';
import { digestCarriesFeed } from '../shared/news-catalog-browser';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { publisherFamilyFor, publisherFamilyForDomain } from '../shared/publisher-families.js';
import { assessCorroboration, evidenceFromCluster } from '../server/_shared/corroboration';
import { SOURCE_PROPAGANDA_RISK } from '../shared/source-provenance';
import { SOURCE_TIERS } from '../server/_shared/source-tiers';
import { applyMigrationChain, buildMigrations, migratePublisherDirectOptInsV13 } from '../src/utils/cloud-prefs-migrations';
import type { Feed } from '../src/types';

const SOURCES = [
  { name: 'ProPublica', category: 'us', url: 'https://www.propublica.org/feeds/propublica/main' },
  { name: 'The Atlantic', category: 'us', url: 'https://www.theatlantic.com/feed/all/' },
  { name: 'NPR World', category: 'politics', url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'BBC News', category: 'europe', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'Guardian UK', category: 'europe', url: 'https://www.theguardian.com/uk-news/rss' },
  { name: 'Channel 4 News', category: 'europe', url: 'https://www.channel4.com/news/feed' },
  { name: 'g1', category: 'latam', url: 'https://g1.globo.com/rss/g1/', lang: 'pt' },
  { name: 'g1 Mundo', category: 'latam', url: 'https://g1.globo.com/rss/g1/mundo/', lang: 'pt' },
  { name: 'Folha Mundo', category: 'latam', url: 'https://feeds.folha.uol.com.br/mundo/rss091.xml', lang: 'pt' },
  { name: 'Estadão Política', category: 'latam', url: 'https://www.estadao.com.br/arc/outboundfeeds/feeds/rss/sections/politica/', lang: 'pt' },
  { name: 'Estadão Internacional', category: 'latam', url: 'https://www.estadao.com.br/arc/outboundfeeds/feeds/rss/sections/internacional/', lang: 'pt' },
  { name: 'BBC News Brasil', category: 'latam', url: 'https://feeds.bbci.co.uk/portuguese/rss.xml', lang: 'pt' },
  { name: 'Nexo Jornal', category: 'latam', url: 'https://www.nexojornal.com.br/rss.xml', lang: 'pt' },
  { name: 'DW Brasil', category: 'latam', url: 'https://rss.dw.com/xml/rss-br-all', lang: 'pt' },
  { name: 'RFI Brasil', category: 'latam', url: 'https://www.rfi.fr/br/rss', lang: 'pt' },
  { name: 'Le Monde à la une', category: 'europe', url: 'https://www.lemonde.fr/rss/une.xml', lang: 'fr' },
  { name: 'Le Monde International', category: 'europe', url: 'https://www.lemonde.fr/international/rss_full.xml', lang: 'fr' },
  { name: 'Le Figaro', category: 'europe', url: 'https://www.lefigaro.fr/rss/figaro_actualites.xml', lang: 'fr' },
  { name: "L'Express", category: 'europe', url: 'https://www.lexpress.fr/arc/outboundfeeds/rss/alaune.xml', lang: 'fr' },
  { name: 'Le Nouvel Obs', category: 'europe', url: 'https://www.nouvelobs.com/a-la-une/rss.xml', lang: 'fr' },
  { name: 'Courrier international', category: 'europe', url: 'https://www.courrierinternational.com/feed/all/rss.xml', lang: 'fr' },
  { name: 'France 24 Français', category: 'europe', url: 'https://www.france24.com/fr/rss', lang: 'fr' },
  { name: 'RFI', category: 'europe', url: 'https://www.rfi.fr/fr/rss', lang: 'fr' },
  { name: 'TV5Monde Info', category: 'europe', url: 'https://information.tv5monde.com/rss.xml', lang: 'fr' },
] as const;
const names = SOURCES.map((source) => source.name);
type Client = {
  FULL_FEEDS: Record<string, Feed[]>;
  computeDefaultDisabledSources: (locale?: string) => string[];
  getLocaleBoostedSources: (locale: string) => Set<string>;
};
const tempDir = mkdtempSync(join(tmpdir(), 'publisher-direct-'));
let client: Client;
before(async () => { client = await bundleFeedsModule<Client>({ repoRoot: process.cwd(), tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('publisher-direct RSS feeds', () => {
  it('lists exactly these sources as the opt-in pack, in order', () => {
    assert.deepEqual(JSON.parse(readFileSync('shared/publisher-direct-opt-ins.json', 'utf8')), names);
  });

  it('places each publisher feed in the full client and server views with its own URL', () => {
    for (const view of [client.FULL_FEEDS, VARIANT_FEEDS.full!]) {
      for (const source of SOURCES) {
        const feed = view[source.category]?.find((entry) => entry.name === source.name);
        assert.ok(feed, `${source.name} missing from full/${source.category}`);
        assert.equal(feed.url, source.url);
        assert.equal(feed.lang, 'lang' in source ? source.lang : undefined);
        assert.ok(!feed.strategicDefault, `${source.name} must stay opt-in`);
        assert.doesNotMatch(String(feed.url), /news\.google\.com/);
      }
    }
  });

  it('starts disabled and unboosted in every interface language but stays selectable', () => {
    for (const language of ['en', 'pt', 'pt-BR', 'fr', 'de', 'ar']) {
      const disabled = new Set(client.computeDefaultDisabledSources(language));
      const boosted = client.getLocaleBoostedSources(language);
      for (const source of SOURCES) {
        assert.ok(disabled.has(source.name), `${source.name} disabled in ${language}`);
        assert.ok(!boosted.has(source.name), `${source.name} is not locale-boosted in ${language}`);
        const feed = client.FULL_FEEDS[source.category]!.find((entry) => entry.name === source.name)!;
        assert.ok(isFeedInLanguage(feed, language), `${source.name} selectable in ${language}`);
        assert.ok(digestCarriesFeed(feed, language), `${source.name} reaches the ${language} digest`);
      }
    }
    assert.ok(client.getLocaleBoostedSources('fr').has('Le Monde'), 'existing French defaults stay intact');
  });

  it('schedules every feed in the English, Portuguese and French digests', () => {
    for (const language of ['en', 'pt', 'fr']) {
      const scheduled = __testing__.buildDigestFeedBatches('full', language).batches.flat();
      for (const name of names) assert.ok(scheduled.some((entry) => entry.feed.name === name), `${name} in ${language}`);
    }
  });

  it('migrates stored preferences once and leaves later choices alone', () => {
    const key = 'worldmonitor-disabled-feeds';
    const stored = { [key]: '["existing-choice"]', unrelated: 'keep' };
    const result = migratePublisherDirectOptInsV13(stored, names);
    assert.deepEqual(JSON.parse(result[key] as string), ['existing-choice', ...names]);
    assert.equal(result.unrelated, 'keep');
    assert.equal(migratePublisherDirectOptInsV13(result, names), result);
    const migrations = buildMigrations({}, { publisherDirect: { optInSources: names } });
    assert.deepEqual(applyMigrationChain(stored, 12, 13, migrations), result);
    assert.equal(applyMigrationChain(stored, 13, 13, migrations), stored, 'later explicit opt-ins survive sync');
    for (const raw of ['[]', 'bad-json', '[42]', '{}']) {
      const blob = { [key]: raw };
      assert.equal(migratePublisherDirectOptInsV13(blob, names), blob, 'preserve enable-all and invalid preferences');
    }
  });

  it('keeps publisher links, drops foreign links, and allowlists every host', () => {
    for (const source of SOURCES) {
      const feed = VARIANT_FEEDS.full![source.category]!.find((entry) => entry.name === source.name)!;
      const host = new URL(source.url).hostname;
      assert.ok(isAllowedDomain(host), `${host} allowlisted`);
      assert.ok(!isAllowedDomain(`${host}.evil.example`));
      assert.ok(SOURCE_TIERS[source.name], `${source.name} has a source tier`);
      assert.ok(SOURCE_PROPAGANDA_RISK[source.name], `${source.name} declares provenance`);
      const xml = (link: string) => `<rss><channel><item><title>Government announces new measures</title><link>${link}</link><pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate></item></channel></rss>`;
      assert.equal(__testing__.parseRssXml(xml('https://evil.example/story'), feed, 'full')?.items[0]?.link, '', `${source.name} drops foreign links`);
    }
    // Each feed's items link to the publisher's site, not the feed host.
    const articleLinks: Record<string, string> = {
      'NPR World': 'https://www.npr.org/2026/11/18/1/story',
      'BBC News': 'https://www.bbc.com/news/articles/c1',
      'BBC News Brasil': 'https://www.bbc.com/portuguese/articles/c1',
      'Folha Mundo': 'https://www1.folha.uol.com.br/mundo/2026/11/story.shtml',
      'DW Brasil': 'https://www.dw.com/pt-br/story/a-1',
      ProPublica: 'https://projects.propublica.org/story/',
      RFI: 'https://www.france24.com/fr/story',
    };
    for (const [name, link] of Object.entries(articleLinks)) {
      const source = SOURCES.find((entry) => entry.name === name)!;
      const feed = VARIANT_FEEDS.full![source.category]!.find((entry) => entry.name === name)!;
      const xml = `<rss><channel><item><title>Government announces new measures</title><link>${link}</link><pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate></item></channel></rss>`;
      assert.equal(__testing__.parseRssXml(xml, feed, 'full')?.items[0]?.link, link, `${name} keeps ${link}`);
    }
  });

  it('groups sister titles so they cannot corroborate each other', () => {
    const groups = [
      ['BBC News', 'BBC World', 'BBC News Brasil'],
      ['Guardian UK', 'Guardian World'],
      ['NPR World', 'NPR News'],
      ['g1', 'g1 Mundo', 'G1 Política', 'O Globo'],
      ['Folha Mundo', 'Folha de S.Paulo'],
      ['Estadão Política', 'Estadão Internacional'],
      ['RFI', 'RFI Brasil'],
      ['Le Monde', 'Le Monde à la une', 'Le Monde International', 'Courrier international', 'Le Nouvel Obs'],
      ['France 24 Français', 'France 24'],
      ['DW Brasil', 'DW News'],
    ];
    for (const group of groups) {
      const family = publisherFamilyFor(group[0]!);
      assert.ok(family, `${group[0]} has a publisher family`);
      for (const name of group) assert.equal(publisherFamilyFor(name), family, `${name} shares ${group[0]}'s family`);
      assert.deepEqual(assessCorroboration(evidenceFromCluster({
        allItems: group.map((source) => ({ source })),
      })), { state: 'single-publisher', publishers: 1 }, `${group.join(' + ')} is one publisher`);
    }
    assert.equal(publisherFamilyForDomain('www.courrierinternational.com'), publisherFamilyFor('Le Monde'));
    assert.equal(publisherFamilyForDomain('www.estadao.com.br'), publisherFamilyFor('Estadão Política'));
    assert.notEqual(publisherFamilyFor('Le Figaro'), publisherFamilyFor('Le Monde'));
  });

  it('reads Franceinfo from its own host, not the cross-host francetvinfo redirect', () => {
    const feeds = Object.values(VARIANT_FEEDS.full!).flat();
    const franceinfo = feeds.find((feed) => feed.name === 'Franceinfo');
    assert.equal(franceinfo?.url, 'https://www.franceinfo.fr/titres.rss');
    assert.ok(!feeds.some((feed) => feed.url.includes('francetvinfo.fr')));
    assert.ok(!isAllowedDomain('www.francetvinfo.fr'), 'retired host leaves the allowlist');
  });
});
