// Publisher-controlled feed bodies are parsed synchronously on the edge
// isolate. The lazy / `[^>]*` tag regexes the digest parser used backtracked
// quadratically on unterminated markup, so one hostile or broken feed could
// pin the isolate for seconds to minutes. These tests hold the replacement
// scanners to (1) the exact results of the regexes they replaced and (2) a
// linear-time budget on adversarial input.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__, fetchAndParseRss } from '../server/worldmonitor/news/v1/list-feed-digest';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const {
  parseRssXml,
  extractRawTagBody,
  extractDescription,
  asciiLower,
  scanTagBlocks,
  matchCdataTag,
  matchTagText,
  matchTagBody,
  replaceBeforeLast,
} = __testing__;

const FEED = { url: 'https://example.com/rss', name: 'Example', lang: 'en' } as const;

// ── Regex oracle: the expressions the scanners replaced ─────────────────────
// Tag names are escaped: the scanners match them literally (the old
// `dc:Date.Issued` regex let `.` match any character).
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oracle = {
  blocks: (s: string, t: string) =>
    [...s.matchAll(new RegExp(`<${esc(t)}[\\s>]([\\s\\S]*?)<\\/${esc(t)}>`, 'gi'))].map((m) => m[1]!),
  cdata: (s: string, t: string) =>
    s.match(new RegExp(`<${esc(t)}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${esc(t)}>`, 'i'))?.[1] ?? null,
  text: (s: string, t: string) =>
    s.match(new RegExp(`<${esc(t)}[^>]*>([^<]*)<\\/${esc(t)}>`, 'i'))?.[1] ?? null,
  body: (s: string, t: string) =>
    s.match(new RegExp(`<${esc(t)}[^>]*>([\\s\\S]*?)<\\/${esc(t)}>`, 'i'))?.[1] ?? null,
};

// ── Fixture feeds: parse output pinned from the regex implementation ────────
const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Example</title>
<item>
  <title><![CDATA[Ceasefire talks resume in Cairo]]></title>
  <link>https://example.com/a</link>
  <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
  <description><![CDATA[<p>Negotiators from both sides met on Monday &amp; agreed to continue.</p>]]></description>
</item>
<ITEM rdf:about="https://example.com/b">
  <TITLE>Markets &amp; oil prices rise sharply</TITLE>
  <LINK>https://example.com/b</LINK>
  <dc:date>2024-01-02T08:30:00Z</dc:date>
  <Description>&lt;img src="x.jpg"/&gt;<![CDATA[Brent crude climbed above ninety dollars a barrel.]]></Description>
  <content:encoded><![CDATA[<div>Brent crude climbed above ninety dollars a barrel on supply fears.</div>]]></content:encoded>
</ITEM>
<item>
  <title> <![CDATA[ İstanbul summit opens ]]> </title>
  <link>https://example.com/c</link>
  <dc:Date.Issued>2024-01-03</dc:Date.Issued>
  <description>Leaders gathered in İstanbul for the opening session of the summit.</description>
</item>
<item>
  <title>No date here</title>
  <link>https://example.com/d</link>
</item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Example</title>
<entry>
  <title type="html">Flood warnings issued &amp; roads closed</title>
  <link rel="alternate" type="text/html" href="https://example.com/e"/>
  <updated>2024-02-01T12:00:00Z</updated>
  <summary type="html">&lt;p&gt;Heavy rain forced closures across the region overnight.&lt;/p&gt;</summary>
</entry>
<entry xml:lang="en">
  <title><![CDATA[Election results certified]]></title>
  <link href='https://example.com/f'/>
  <published>2024-02-02T09:00:00Z</published>
  <content type="html"><![CDATA[<p>The commission certified the results after a final count.</p>]]></content>
</entry>
</feed>`;

function projectItems(xml: string) {
  const parsed = parseRssXml(xml, FEED, 'full');
  if (!parsed) return null;
  return {
    parsedTotal: parsed.parsedTotal,
    droppedUndated: parsed.droppedUndated,
    items: parsed.items.map(({ title, link, publishedAt, description }) => ({ title, link, publishedAt, description })),
  };
}

// Expected values were produced by the regex implementation (origin/main
// edd67c893) and are identical under the scanners.
describe('digest feed parser: output on fixture feeds is unchanged', () => {
  it('RSS 2.0 (CDATA, mixed-case tags, attributes, dc dates, U+00A0, İ)', () => {
    assert.deepEqual(projectItems(RSS_FIXTURE), {
      parsedTotal: 4,
      droppedUndated: 1,
      items: [
        {
          title: 'Ceasefire talks resume in Cairo',
          link: 'https://example.com/a',
          publishedAt: 1704103200000,
          description: 'Negotiators from both sides met on Monday & agreed to continue.',
        },
        {
          title: 'Markets & oil prices rise sharply',
          link: 'https://example.com/b',
          publishedAt: 1704184200000,
          description: 'Brent crude climbed above ninety dollars a barrel on supply fears.',
        },
        {
          title: 'İstanbul summit opens',
          link: 'https://example.com/c',
          publishedAt: 1704240000000,
          description: 'Leaders gathered in İstanbul for the opening session of the summit.',
        },
      ],
    });
  });

  it('Atom (link href, summary, content)', () => {
    assert.deepEqual(projectItems(ATOM_FIXTURE), {
      parsedTotal: 2,
      droppedUndated: 0,
      items: [
        {
          title: 'Flood warnings issued & roads closed',
          link: 'https://example.com/e',
          publishedAt: 1706788800000,
          description: 'Heavy rain forced closures across the region overnight.',
        },
        {
          title: 'Election results certified',
          link: 'https://example.com/f',
          publishedAt: 1706864400000,
          description: 'The commission certified the results after a final count.',
        },
      ],
    });
  });

  it('Smartraveller fixture feed (AEST/AEDT dates read at their true instant)', () => {
    const xml = readFileSync(new URL('./fixtures/smartraveller-advisories-2026-10-23.rss', import.meta.url), 'utf8');
    const projected = projectItems(xml);
    assert.equal(projected.parsedTotal, 5);
    assert.equal(projected.droppedUndated, 0);
    // 23:00 AEDT (+11) and 22:00 AEST (+10) are both 12:00 UTC.
    assert.deepEqual(
      projected.items.map((item) => [item.title, new Date(item.publishedAt).toISOString()]),
      [
        ['No travel advice', '2026-10-07T12:00:00.000Z'],
        ['Guam', '2026-10-20T12:00:00.000Z'],
        ['Armenia', '2026-06-17T12:00:00.000Z'],
        ['Mauritania', '2026-05-14T12:00:00.000Z'],
        ['Libya', '2026-08-13T12:00:00.000Z'],
      ],
    );
  });

  it('every block and tag body of the fixture feeds matches the regex oracle', () => {
    const xml = readFileSync(new URL('./fixtures/smartraveller-advisories-2026-10-23.rss', import.meta.url), 'utf8');
    for (const feed of [RSS_FIXTURE, ATOM_FIXTURE, xml]) {
      const lower = asciiLower(feed);
      for (const container of ['item', 'entry']) {
        const blocks = scanTagBlocks(feed, lower, container);
        assert.deepEqual(blocks, oracle.blocks(feed, container));
        for (const block of blocks) {
          const blockLower = asciiLower(block);
          for (const tag of ['title', 'link', 'pubDate', 'dc:date', 'dc:Date.Issued', 'published', 'updated',
            'description', 'content:encoded', 'summary', 'content', 'source']) {
            assert.equal(matchCdataTag(block, blockLower, tag), oracle.cdata(block, tag), `${tag} cdata`);
            assert.equal(matchTagText(block, blockLower, tag), oracle.text(block, tag), `${tag} text`);
            assert.equal(matchTagBody(block, blockLower, tag), oracle.body(block, tag), `${tag} body`);
          }
        }
      }
    }
  });
});

describe('digest feed parser: scanners match the regexes on fuzzed markup', () => {
  const PIECES = [
    '<item>', '<item ', '<ITEM>', '<Item\n', '</item>', '</Item>', '<itemx>', '<entry>', '</entry>',
    '<title>', '<TITLE>', '<title a="1">', '</title>', '</TITLE>', '<title', '<titles>',
    '<description>', '</description>', '<DESCRIPTION x>', '<dc:date.issued>', '</dc:Date.Issued>',
    '<![CDATA[', '<![cdata[', ']]>', ']]> ', ']]> ', ']', ' ', '\n', '\t', ' ', '﻿',
    '>', '<', '/', 'x', 'İ', 'ı', 'K', 'ab', '&amp;', '&lt;p&gt;',
  ];
  const TAGS = ['item', 'title', 'description', 'dc:Date.Issued'];

  // Deterministic mulberry32 so a failure reproduces from the printed input.
  // Math.imul keeps the multiply in 32 bits; a plain `*` overflows 2^53 and
  // drops the low bits, which collapsed the old LCG to ~200 distinct samples.
  let seed = 0x5eed;
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const sample = () => {
    let s = '';
    const len = 1 + rnd(16);
    for (let k = 0; k < len; k++) s += PIECES[rnd(PIECES.length)];
    return s;
  };

  it('the generator yields varied documents with complete tag pairs', () => {
    const docs = Array.from({ length: 20_000 }, sample);
    // The old LCG gave 222 distinct; repeats now are one-piece samples (42 values).
    assert.ok(new Set(docs).size > 18_000, `only ${new Set(docs).size} distinct documents`);
    assert.ok(new Set(docs.map((d) => d.length)).size > 100, 'lengths vary');
    const paired = docs.filter((d) => /<title[\s>][\s\S]*<\/title>/i.test(d) && /<item[\s>][\s\S]*<\/item>/i.test(d));
    assert.ok(paired.length > 200, `only ${paired.length} documents hold both an item and a title pair`);
  });

  it('20k random documents x 4 tags: identical captures', () => {
    for (let i = 0; i < 20_000; i++) {
      const s = sample();
      const lower = asciiLower(s);
      assert.equal(lower.length, s.length);
      for (const tag of TAGS) {
        const ctx = `${tag} in ${JSON.stringify(s)}`;
        assert.deepEqual(scanTagBlocks(s, lower, tag.toLowerCase()), oracle.blocks(s, tag), `blocks: ${ctx}`);
        assert.equal(matchCdataTag(s, lower, tag), oracle.cdata(s, tag), `cdata: ${ctx}`);
        assert.equal(matchTagText(s, lower, tag), oracle.text(s, tag), `text: ${ctx}`);
        assert.equal(matchTagBody(s, lower, tag), oracle.body(s, tag), `body: ${ctx}`);
      }
      assert.equal(extractRawTagBody(s, 'description'), oracle.cdata(s, 'description') ?? oracle.body(s, 'description') ?? '');
    }
  });

  it('20k random documents: replaceBeforeLast equals the plain replace', () => {
    for (let i = 0; i < 20_000; i++) {
      const s = sample();
      assert.equal(
        replaceBeforeLast(s, ']]>', /<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'),
        s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'),
        JSON.stringify(s),
      );
      assert.equal(replaceBeforeLast(s, '>', /<[^>]+>/g, ' '), s.replace(/<[^>]+>/g, ' '), JSON.stringify(s));
    }
  });
});

// ── Time bound on adversarial input ─────────────────────────────────────────
// 400 KB keeps the regex implementation clearly red (seconds per case, see
// the PR for timings) without hanging CI if it ever came back; the scanners
// take a few ms here and stay linear up to the 5 MiB fetch cap.
const SIZE = 400_000;
const BUDGET_MS = 250;
const rep = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));
const ITEM_HEAD = '<title>Headline</title><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>';
const ENTRY_HEAD = '<title>Headline</title><updated>2024-01-01T10:00:00Z</updated>';

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('digest feed parser: adversarial feeds parse in linear time', () => {
  const cases: Array<[string, () => unknown]> = [
    ['repeated <item> with no </item>', () => parseRssXml(rep('<item>'), FEED, 'full')],
    ['repeated <entry> with no </entry>', () => parseRssXml(rep('<entry>'), FEED, 'full')],
    ['repeated <title with no > in an item', () => parseRssXml(`<item>${rep('<title')}</item>`, FEED, 'full')],
    ['repeated <title><![CDATA[ with no ]]>', () => parseRssXml(`<item>${rep('<title><![CDATA[')}</item>`, FEED, 'full')],
    ['repeated <description> with no </description>',
      () => parseRssXml(`<item>${ITEM_HEAD}${rep('<description>')}</item>`, FEED, 'full')],
    ['repeated <description><![CDATA[ with no ]]>',
      () => parseRssXml(`<item>${ITEM_HEAD}${rep('<description><![CDATA[')}</item>`, FEED, 'full')],
    ['description body of repeated <',
      () => parseRssXml(`<item>${ITEM_HEAD}<description>${rep('<')}</description></item>`, FEED, 'full')],
    ['description body of repeated embedded <![CDATA[',
      () => parseRssXml(`<item>${ITEM_HEAD}<description>${rep('<![CDATA[')}</description></item>`, FEED, 'full')],
    ['atom entry with repeated <link and no >',
      () => parseRssXml(`<entry>${ENTRY_HEAD}${rep('<link')}</entry>`, FEED, 'full')],
    ['extractRawTagBody on repeated <description',
      () => extractRawTagBody(rep('<description'), 'description')],
    ['extractDescription on a body of repeated <',
      () => extractDescription(`<description>${rep('<')}</description>`, false, 'Headline')],
  ];

  for (const [label, run] of cases) {
    it(`${label}: under ${BUDGET_MS} ms at ${SIZE / 1000} KB`, () => {
      const ms = timed(run);
      assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(0)} ms`);
    });
  }
});

// ── Direct-fetch body cap ───────────────────────────────────────────────────
// The relay leg rejects bodies over 5 MiB; the direct leg used resp.text()
// with no cap, so a publisher could hand the parser any size.
describe('digest direct feed fetch: 5 MiB body cap', () => {
  const MiB = 1024 * 1024;
  const CAP_FEED = { name: 'Big Feed', url: 'https://big.example.org/feed.xml' };
  const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'LOCAL_API_MODE', 'WS_RELAY_URL'] as const;

  function streamedFeed(totalBytes: number, onPull: (bytes: number) => void): Response {
    const encoder = new TextEncoder();
    const head = encoder.encode('<?xml version="1.0"?><rss><channel><item><title>Big story</title>'
      + '<link>https://big.example.org/a</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>');
    const tail = encoder.encode('</channel></rss>');
    const pad = encoder.encode(`<!--${'x'.repeat(64 * 1024 - 7)}-->`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = sent === 0 ? head : sent + pad.byteLength + tail.byteLength <= totalBytes ? pad : tail;
        sent += chunk.byteLength;
        onPull(sent);
        controller.enqueue(chunk);
        if (chunk === tail) controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  }

  async function fetchWith(totalBytes: number) {
    const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    for (const key of ['VERCEL_ENV', 'LOCAL_API_MODE', 'WS_RELAY_URL'] as const) delete process.env[key];
    __resetKeyPrefixCacheForTests();
    const redis = createRedisFetch({});
    let pulled = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(href).host === 'redis.example') return redis.fetchImpl(input, init);
      if (href === CAP_FEED.url) return streamedFeed(totalBytes, (n) => { pulled = n; });
      throw new Error(`unexpected fetch ${href}`);
    }) as typeof fetch;
    try {
      const result = await fetchAndParseRss(CAP_FEED, 'full', new AbortController().signal);
      return { result, pulled };
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        if (oldEnv[key] === undefined) delete process.env[key];
        else process.env[key] = oldEnv[key];
      }
      __resetKeyPrefixCacheForTests();
    }
  }

  it('parses a feed under the cap', async () => {
    const { result } = await fetchWith(4 * MiB);
    assert.equal(result.items[0]?.title, 'Big story');
  });

  it('rejects a feed over the cap without reading the rest of the body', async () => {
    const { result, pulled } = await fetchWith(64 * MiB);
    assert.equal(result.items.length, 0);
    assert.equal(result.attempt?.failure, 'direct-error');
    assert.ok(pulled <= 5 * MiB + 128 * 1024, `read ${pulled} bytes past a 5 MiB cap`);
  });
});
