import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { publisherFamilyFor } from '../shared/publisher-families.js';

interface FeedEntry {
  name: string;
  url: string | Record<string, string>;
  lang?: string;
}

interface ClientFeedsModule {
  FULL_FEEDS: Record<string, FeedEntry[]>;
  CANONICAL_FEEDS: Record<string, FeedEntry[]>;
  SOURCE_TIERS: Record<string, number>;
  SOURCE_TYPES: Record<string, string>;
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string }>;
}

interface ServerFeedsModule {
  VARIANT_FEEDS: Record<string, Record<string, FeedEntry[]>>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(repoRoot, 'tmp-direct-news-feed-pack-test');

const DIRECT_PACK = {
  'Fox Business': { category: 'finance', financeCategory: 'markets', url: 'https://moxie.foxbusiness.com/google-publisher/latest.xml' },
  Wired: { category: 'tech', url: 'https://www.wired.com/feed/rss' },
  'Business Insider': { category: 'finance', financeCategory: 'markets', url: 'https://www.businessinsider.com/rss' },
  Handelsblatt: { category: 'europe', url: 'https://www.handelsblatt.com/contentexport/feed/schlagzeilen', lang: 'de' },
  Welt: { category: 'europe', url: 'https://www.welt.de/feeds/latest.rss', lang: 'de' },
  Telegraph: { category: 'europe', url: 'https://www.telegraph.co.uk/rss.xml' },
  GlobeNewswire: { category: 'finance', financeCategory: 'markets', url: 'https://www.globenewswire.com/RssFeed/subjectcode/22/feedTitle/GlobeNewswire' },
  'Business Wire': { category: 'finance', financeCategory: 'markets', url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeGVtRWA==' },
  'U.S. Trade Representative': { category: 'gov', url: 'https://ustr.gov/rss.xml' },
  Chainwire: { category: 'finance', financeCategory: 'crypto', url: 'https://chainwire.org/feed/' },
  'Interfax RU': { category: 'europe', url: 'https://www.interfax.ru/rss.asp', lang: 'ru' },
  'Interfax EN': { category: 'europe', url: 'https://news.google.com/rss/search?q=site%3Ainterfax.com%20when%3A7d&hl=en-US&gl=US&ceid=US:en' },
  'PR Newswire': { category: 'finance', financeCategory: 'markets', url: 'https://news.google.com/rss/search?q=site%3Aprnewswire.com%20when%3A1d&hl=en-US&gl=US&ceid=US:en' },
  'Coinbase Blog': { category: 'finance', financeCategory: 'crypto', url: 'https://news.google.com/rss/search?q=site%3Acoinbase.com%2Fblog%20when%3A7d&hl=en-US&gl=US&ceid=US:en' },
  'Binance Announcements': { category: 'finance', financeCategory: 'crypto', url: 'https://news.google.com/rss/search?q=site%3Abinance.com%2Fen%2Fsupport%2Fannouncement%20when%3A3d&hl=en-US&gl=US&ceid=US:en' },
  Jin10: { category: 'finance', financeCategory: 'crypto', url: 'https://news.google.com/rss/search?q=site%3Ajin10.com%20when%3A1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', lang: 'zh' },
} as const;

const DIRECT_FETCH_HOSTS = [
  'moxie.foxbusiness.com',
  'www.wired.com',
  'www.businessinsider.com',
  'feeds.businessinsider.com',
  'www.handelsblatt.com',
  'feeds.cms.handelsblatt.com',
  'www.welt.de',
  'www.telegraph.co.uk',
  'www.globenewswire.com',
  'feed.businesswire.com',
  'ustr.gov',
  'chainwire.org',
  'www.interfax.ru',
] as const;

const LICENSED_DIRECT_HOSTS = DIRECT_FETCH_HOSTS.filter(
  (host) => host !== 'feeds.businessinsider.com' && host !== 'feeds.cms.handelsblatt.com',
);

const SITE_SCOPED_PUBLISHER_HOSTS = ['interfax.com', 'prnewswire.com', 'coinbase.com', 'binance.com', 'jin10.com'] as const;

let client: ClientFeedsModule;
let server: ServerFeedsModule;

function findFeed(feeds: Record<string, FeedEntry[]>, category: string, name: string): FeedEntry | undefined {
  return (feeds[category] ?? []).find((feed) => feed.name === name);
}

before(async () => {
  client = await bundleFeedsModule<ClientFeedsModule>({
    repoRoot,
    tempDir,
    outfileName: 'client-feeds.mjs',
  });

  mkdirSync(tempDir, { recursive: true });
  const result = await build({
    entryPoints: [join(repoRoot, 'server/worldmonitor/news/v1/_feeds.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    absWorkingDir: repoRoot,
  });
  const serverOutfile = join(tempDir, 'server-feeds.mjs');
  writeFileSync(serverOutfile, result.outputFiles[0]!.text, 'utf8');
  server = await import(`${pathToFileURL(serverOutfile).href}?t=${Date.now()}`) as ServerFeedsModule;
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('direct licensed news feed pack', () => {
  it('adds every row to the full client and server catalogs with exact routing', () => {
    for (const [name, expected] of Object.entries(DIRECT_PACK)) {
      const clientFeed = findFeed(client.FULL_FEEDS, expected.category, name);
      const serverFeed = findFeed(server.VARIANT_FEEDS.full, expected.category, name);
      assert.ok(clientFeed, `client full/${expected.category} missing ${name}`);
      assert.ok(serverFeed, `server full/${expected.category} missing ${name}`);
      assert.equal(clientFeed.url, expected.url, `client URL drifted for ${name}`);
      assert.equal(serverFeed.url, expected.url, `server URL drifted for ${name}`);
      assert.equal(clientFeed.lang, 'lang' in expected ? expected.lang : undefined, `client lang drifted for ${name}`);
      assert.equal(serverFeed.lang, 'lang' in expected ? expected.lang : undefined, `server lang drifted for ${name}`);
    }
  });

  it('also exposes finance-specific rows in their finance variant categories', () => {
    for (const [name, expected] of Object.entries(DIRECT_PACK)) {
      if (!('financeCategory' in expected)) continue;
      const clientFeed = findFeed(client.CANONICAL_FEEDS, expected.financeCategory, name);
      const serverFeed = findFeed(server.VARIANT_FEEDS.finance, expected.financeCategory, name);
      assert.ok(clientFeed, `client finance/${expected.financeCategory} missing ${name}`);
      assert.ok(serverFeed, `server finance/${expected.financeCategory} missing ${name}`);
      assert.equal(clientFeed.url, expected.url, `client finance URL drifted for ${name}`);
      assert.equal(serverFeed.url, expected.url, `server finance URL drifted for ${name}`);
      assert.equal(clientFeed.lang, 'lang' in expected ? expected.lang : undefined, `client finance lang drifted for ${name}`);
      assert.equal(serverFeed.lang, 'lang' in expected ? expected.lang : undefined, `server finance lang drifted for ${name}`);
    }
  });

  it('contains no OpenNews transport, host, or route', () => {
    const catalogText = [
      readFileSync(join(repoRoot, 'src/config/feeds.ts'), 'utf8'),
      readFileSync(join(repoRoot, 'server/worldmonitor/news/v1/_feeds.ts'), 'utf8'),
    ].join('\n').toLowerCase();
    assert.doesNotMatch(catalogText, /opennews|ai\.6551\.io|\/open\/news/);
  });

  it('allowlists every direct host and redirect target', () => {
    for (const host of DIRECT_FETCH_HOSTS) {
      assert.ok(isAllowedDomain(host), `${host} must be RSS-allowlisted`);
    }
  });

  it('reviews tier and provenance without treating press releases as independent wires', () => {
    for (const name of Object.keys(DIRECT_PACK)) {
      assert.ok(client.SOURCE_TIERS[name] >= 1, `${name} missing source tier`);
      assert.ok(client.SOURCE_TYPES[name], `${name} missing reviewed source type`);
      assert.ok(client.SOURCE_PROPAGANDA_RISK[name], `${name} missing reviewed risk`);
    }
    for (const name of ['GlobeNewswire', 'Business Wire', 'PR Newswire', 'Chainwire']) {
      assert.equal(client.SOURCE_TYPES[name], 'other', `${name} must not claim independent wire status`);
    }
    assert.equal(publisherFamilyFor('Interfax EN'), publisherFamilyFor('Interfax RU'));
  });

  it('records acquired publisher rights for direct and site-scoped publisher hosts', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'shared/source-attribution-manifest.json'), 'utf8'),
    ) as {
      entries: Array<{ host: string; status: string; observed: boolean }>;
    };
    const entries = new Map(manifest.entries.map((entry) => [entry.host, entry]));
    for (const host of LICENSED_DIRECT_HOSTS) {
      assert.equal(entries.get(host)?.status, 'reviewed', `${host} publisher rights must be reviewed`);
    }
    for (const host of SITE_SCOPED_PUBLISHER_HOSTS) {
      assert.equal(entries.get(host)?.status, 'reviewed', `${host} publisher rights must be reviewed`);
      assert.equal(entries.get(host)?.observed, true, `${host} must be an active source host`);
    }
  });
});
