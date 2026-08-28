import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { resolveHostOrigin } from '../scripts/source-origin.mjs';
import { __testing__ as digestTesting } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { selectSourcesUnderCap } from '../src/services/source-cap';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';

interface FeedEntry {
  name: string;
  url: string | Record<string, string>;
  lang?: string;
}

interface ClientFeedsModule {
  FEEDS: Record<string, FeedEntry[]>;
  FULL_FEEDS: Record<string, FeedEntry[]>;
  INTEL_SOURCES: FeedEntry[];
  SOURCE_TIERS: Record<string, number>;
  SOURCE_TYPES: Record<string, string>;
  SOURCE_PROPAGANDA_RISK: Record<string, { risk: string }>;
  computeDefaultDisabledSources: (locale?: string) => string[];
}

const SOURCE = 'Times of India';
const URL = 'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms';
const HOST = 'timesofindia.indiatimes.com';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = join(repoRoot, 'tmp-times-of-india-feed-test');

let client: ClientFeedsModule;

before(async () => {
  client = await bundleFeedsModule<ClientFeedsModule>({
    repoRoot,
    tempDir,
    outfileName: 'client-feeds.mjs',
  });
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('Times of India licensed India feed', () => {
  it('uses the same direct feed and provider identity on client and server Asia surfaces', () => {
    const clientFeed = client.FULL_FEEDS.asia?.find((feed) => feed.name === SOURCE);
    const serverFeed = VARIANT_FEEDS.full?.asia?.find((feed) => feed.name === SOURCE);

    assert.ok(clientFeed, `client full/asia missing ${SOURCE}`);
    assert.ok(serverFeed, `server full/asia missing ${SOURCE}`);
    assert.equal(clientFeed.url, URL);
    assert.equal(serverFeed.url, URL);
    assert.equal(clientFeed.lang, 'en');
    assert.equal(serverFeed.lang, 'en');
  });

  it('records India origin, India coverage, RSS allowlisting, and reviewed editorial metadata', () => {
    const geography = JSON.parse(
      readFileSync(join(repoRoot, 'shared/source-geography.json'), 'utf8'),
    ) as Record<string, string[]>;

    assert.deepEqual(geography[SOURCE], ['IN']);
    assert.equal(resolveHostOrigin(HOST), 'IN');
    assert.equal(isAllowedDomain(HOST), true);
    assert.equal(client.SOURCE_TIERS[SOURCE], 2);
    assert.equal(client.SOURCE_TYPES[SOURCE], 'mainstream');
    assert.equal(client.SOURCE_PROPAGANDA_RISK[SOURCE]?.risk, 'low');
  });

  it('records the licensed rights basis without confidential agreement details', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'shared/source-attribution-manifest.json'), 'utf8'),
    ) as {
      entries: Array<{
        host: string;
        provider: string;
        license: string;
        attribution: string;
        status: string;
        references: Array<{ path: string }>;
      }>;
    };
    const entry = manifest.entries.find((candidate) => candidate.host === HOST);

    assert.ok(entry, `attribution manifest missing ${HOST}`);
    assert.equal(entry.provider, SOURCE);
    assert.equal(entry.status, 'reviewed');
    assert.match(entry.license, /World Monitor agreement/);
    assert.equal(entry.attribution, `Credit ${SOURCE} and link to the original item.`);
    assert.deepEqual(
      entry.references.map((reference) => reference.path).sort(),
      ['server/worldmonitor/news/v1/_feeds.ts', 'src/config/feeds.ts'],
    );
    assert.doesNotMatch(
      `${entry.license} ${entry.attribution}`,
      /(?:agreement|contract)\s*(?:id|number)|commercial term|fee|price/i,
    );
  });

  it('is opt-in and appended so adding it cannot evict an existing free-tier source', () => {
    assert.equal(client.FULL_FEEDS.asia.at(-1)?.name, SOURCE);

    const currentDisabled = new Set(client.computeDefaultDisabledSources('en'));
    assert.equal(currentDisabled.has(SOURCE), true, `${SOURCE} must remain opt-in`);

    const current = selectSourcesUnderCap(
      client.FEEDS,
      client.INTEL_SOURCES,
      currentDisabled,
      80,
    );
    const previousFeeds = Object.fromEntries(
      Object.entries(client.FEEDS).map(([category, feeds]) => [
        category,
        feeds.filter((feed) => feed.name !== SOURCE),
      ]),
    );
    const previousDisabled = new Set(currentDisabled);
    previousDisabled.delete(SOURCE);
    const previous = selectSourcesUnderCap(
      previousFeeds,
      client.INTEL_SOURCES,
      previousDisabled,
      80,
    );

    assert.deepEqual(current.keep, previous.keep);
    assert.deepEqual(current.autoDisabled, previous.autoDisabled);
  });

  it('preserves headline, summary, timestamp, publisher credit, and original link during digest ingestion', () => {
    const publishedAt = new Date(Date.now() - 60_000).toISOString();
    const originalLink = 'https://timesofindia.indiatimes.com/india/example-story/articleshow/123456.cms';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><item>
        <title><![CDATA[India policy & markets update]]></title>
        <description>&lt;a href="${originalLink}"&gt;&lt;img src="https://static.toiimg.com/photo/123456.cms" /&gt;&lt;/a&gt;<![CDATA[The policy update includes enough original context for the digest summary and downstream analysis surfaces.]]></description>
        <link><![CDATA[${originalLink}]]></link>
        <guid><![CDATA[${originalLink}]]></guid>
        <pubDate>${publishedAt}</pubDate>
      </item></channel></rss>`;

    const parsed = digestTesting.parseRssXml(
      xml,
      { name: SOURCE, url: URL, lang: 'en' },
      'full',
    );

    assert.ok(parsed);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0]?.source, SOURCE);
    assert.equal(parsed.items[0]?.title, 'India policy & markets update');
    assert.equal(parsed.items[0]?.link, originalLink);
    assert.equal(parsed.items[0]?.publishedAt, new Date(publishedAt).getTime());
    assert.match(parsed.items[0]?.description ?? '', /enough original context/);
    assert.doesNotMatch(parsed.items[0]?.description ?? '', /<img|toiimg/i);
  });
});
