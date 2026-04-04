import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

const seedSrc = readFileSync('scripts/seed-regulatory-actions.mjs', 'utf8');

const pureSrc = seedSrc
  .replace(/^import\s.*$/gm, '')
  .replace(/const isDirectRun[\s\S]*?}\n\nexport\s*{[\s\S]*?};?\s*$/m, '');

const ctx = vm.createContext({
  console,
  Date,
  Math,
  Number,
  Array,
  Set,
  String,
  RegExp,
  URL,
  URLSearchParams,
  AbortSignal,
  CHROME_UA: 'Mozilla/5.0 (test)',
});

vm.runInContext(pureSrc, ctx);

const {
  decodeEntities,
  stripHtml,
  extractAtomLink,
  parseRssItems,
  parseAtomEntries,
  parseFeed,
  normalizeFeedItems,
  dedupeAndSortActions,
  fetchAllFeeds,
} = ctx;

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    assert.equal(decodeEntities('Tom &amp; Jerry &#38; &#x26;'), 'Tom & Jerry & &');
  });
});

describe('stripHtml', () => {
  it('removes tags and CDATA while preserving text', () => {
    assert.equal(stripHtml('<![CDATA[Hello <strong>world</strong>]]>'), 'Hello world');
  });

  it('strips entity-escaped HTML tags (FINRA-style descriptions)', () => {
    assert.equal(stripHtml('&lt;h2&gt;Summary&lt;/h2&gt;&lt;p&gt;FINRA amends Rule 4210.&lt;/p&gt;'), 'Summary FINRA amends Rule 4210.');
  });
});

describe('parseRssItems', () => {
  it('extracts RSS items with description, normalized links, and pubDate', () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title><![CDATA[SEC &amp; Co. Charges <b>Issuer</b>]]></title>
          <description><![CDATA[Alleges <strong>fraud</strong> &amp; disclosure failures]]></description>
          <link>/news/press-release/2026-10</link>
          <pubDate>Mon, 30 Mar 2026 18:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;

    assert.deepEqual(normalize(parseRssItems(xml, 'https://www.sec.gov/news/pressreleases.rss')), [{
      title: 'SEC & Co. Charges Issuer',
      description: 'Alleges fraud & disclosure failures',
      link: 'https://www.sec.gov/news/press-release/2026-10',
      publishedAt: '2026-03-30T18:00:00.000Z',
    }]);
  });
});

describe('extractAtomLink + parseAtomEntries', () => {
  it('prefers alternate href and extracts summary/content with normalized publishedAt', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Fed issues notice</title>
          <summary><![CDATA[Detailed <b>policy</b> summary]]></summary>
          <link rel="self" href="https://example.test/self" />
          <link rel="alternate" href="/press/notice-a" />
          <updated>2026-03-29T12:30:00Z</updated>
        </entry>
      </feed>`;

    assert.equal(
      extractAtomLink('<entry><link rel="self" href="https://example.test/self" /><link rel="alternate" href="/press/notice-a" /></entry>'),
      '/press/notice-a'
    );

    assert.deepEqual(normalize(parseAtomEntries(xml, 'https://www.federalreserve.gov/feeds/press_all.xml')), [{
      title: 'Fed issues notice',
      description: 'Detailed policy summary',
      link: 'https://www.federalreserve.gov/press/notice-a',
      publishedAt: '2026-03-29T12:30:00.000Z',
    }]);

    const contentXml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>FDIC update</title>
          <content type="html"><![CDATA[<p>Formal <strong>administrative</strong> note</p>]]></content>
          <link href="https://fdic.example.test/a" />
          <published>2026-03-28T09:15:00Z</published>
        </entry>
      </feed>`;

    assert.deepEqual(normalize(parseAtomEntries(contentXml, 'https://www.fdic.gov/feed')), [{
      title: 'FDIC update',
      description: 'Formal administrative note',
      link: 'https://fdic.example.test/a',
      publishedAt: '2026-03-28T09:15:00.000Z',
    }]);
  });
});

describe('parseFeed', () => {
  it('detects Atom feeds automatically', () => {
    const atom = '<feed><entry><title>A</title><link href="https://example.test/a" /><updated>2026-03-28T00:00:00Z</updated></entry></feed>';
    const parsed = normalize(parseFeed(atom, 'https://example.test/feed'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].link, 'https://example.test/a');
  });
});

describe('normalizeFeedItems', () => {
  it('skips incomplete entries and generates deterministic ids', () => {
    const normalized = normalize(normalizeFeedItems([
      { title: 'SEC Charges XYZ Corp', link: 'https://example.test/sec', publishedAt: '2026-03-29T14:00:00.000Z' },
      { title: 'SEC Summary', description: 'extra context', link: 'https://example.test/sec-2', publishedAt: '2026-03-29T14:30:00.000Z' },
      { title: '', link: 'https://example.test/missing', publishedAt: '2026-03-29T14:00:00.000Z' },
    ], 'SEC'));

    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].id, 'sec-sec-charges-xyz-corp-20260329-140000');
    assert.equal(normalized[0].description, '');
    assert.equal(normalized[1].description, 'extra context');
  });
});

describe('dedupeAndSortActions', () => {
  it('deduplicates by canonical link and sorts newest first', () => {
    const actions = normalize(dedupeAndSortActions([
      {
        id: 'older',
        agency: 'SEC',
        title: 'Older',
        link: 'https://example.test/path#frag',
        publishedAt: '2026-03-28T10:00:00.000Z',
      },
      {
        id: 'newer',
        agency: 'FDIC',
        title: 'Newer',
        link: 'https://example.test/new',
        publishedAt: '2026-03-30T10:00:00.000Z',
      },
      {
        id: 'duplicate',
        agency: 'SEC',
        title: 'Duplicate',
        link: 'https://example.test/path',
        publishedAt: '2026-03-29T10:00:00.000Z',
      },
    ]));

    assert.deepEqual(actions.map((item) => item.id), ['newer', 'older']);
    assert.equal(actions[1].link, 'https://example.test/path');
  });
});

describe('fetchAllFeeds', () => {
  const feeds = [
    { agency: 'SEC', url: 'https://feeds.test/sec', userAgent: 'Custom-SEC-UA' },
    { agency: 'FDIC', url: 'https://feeds.test/fdic' },
  ];

  it('returns normalized aggregate when at least one feed succeeds', async () => {
    const requests = [];
    const fetchStub = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/sec')) {
        return {
          ok: true,
          text: async () => `<rss><channel><item><title>SEC Charges Bank</title><link>https://sec.test/a</link><pubDate>Mon, 30 Mar 2026 18:00:00 GMT</pubDate></item></channel></rss>`,
        };
      }
      throw new Error('FDIC timeout');
    };

    const result = normalize(await fetchAllFeeds(fetchStub, feeds));
    assert.equal(result.length, 1);
    assert.equal(result[0].agency, 'SEC');
    assert.equal(requests[0].options.headers['User-Agent'], 'Custom-SEC-UA');
    assert.equal(requests[1].options.headers['User-Agent'], ctx.CHROME_UA);
  });

  it('throws when all feeds fail', async () => {
    await assert.rejects(
      fetchAllFeeds(async () => { throw new Error('nope'); }, feeds),
      /All regulatory feeds failed/
    );
  });
});
