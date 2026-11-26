import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { decodeXmlEntities, extractDescription } = __testing__;

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('decodeXmlEntities: one pass must decode exactly one level', () => {
  it('round-trips escaped text back to the original', () => {
    const originals = [
      'AT&T completes merger',
      'XSS via &lt;script&gt; in Acme SDK',
      'Q3 revenue > $2B & rising',
      'He said "no comment"',
      "Ireland's PM: 'no deal' & <no> comment",
      'plain headline with no entities',
    ];
    for (const original of originals) {
      assert.equal(decodeXmlEntities(escapeXml(original)), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A headline whose literal text is `&lt;script&gt;` escapes to `&amp;lt;script&amp;gt;`.
    // Decoding `&amp;` first would yield `<script>`.
    assert.equal(
      decodeXmlEntities('XSS via &amp;lt;script&amp;gt; in Acme SDK'),
      'XSS via &lt;script&gt; in Acme SDK',
    );
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(decodeXmlEntities('&#128512;'), '\u{1F600}');
    assert.equal(decodeXmlEntities('&#x1F600;'), '\u{1F600}');
  });

  it('drops out-of-range numeric references instead of throwing', () => {
    assert.equal(decodeXmlEntities('a&#999999999;b'), 'ab');
  });

  it('still decodes a single level of the predefined entities', () => {
    assert.equal(decodeXmlEntities('5 &lt; 6 &amp; 7 &gt; 2'), '5 < 6 & 7 > 2');
    assert.equal(decodeXmlEntities('&quot;quoted&quot; &apos;single&apos;'), '"quoted" \'single\'');
  });
});

describe('extractDescription: escaped markup survives the tag strip', () => {
  it('keeps text that was escaped twice by the publisher', () => {
    const block = `<item><description>Acme patched an XSS triggered by &amp;lt;script&amp;gt; tags in user-supplied profile bios.</description></item>`;
    const description = extractDescription(block, false, 'Unrelated headline');
    // Double-decoding produced `<script>`, which the `<[^>]+>` strip then
    // deleted along with the surrounding words.
    assert.match(description, /&lt;script&gt;/);
    assert.match(description, /tags in user-supplied profile bios/);
  });
});

describe('parseRssXml: CDATA titles are entity-decoded', () => {
  const feedXml = (titleTag: string) => `<?xml version="1.0"?><rss><channel><item>
  ${titleTag}<link>https://www.koreaherald.com/article/10620001</link>
  <pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate></item></channel></rss>`;
  const titleOf = (titleTag: string) =>
    __testing__.parseRssXml(feedXml(titleTag), { name: 'The Korea Herald', url: 'https://www.koreaherald.com/rss/newsAll' }, 'full')?.items[0]?.title;

  // The Korea Herald writes HTML-escaped text inside CDATA. On 2026-11-23 its
  // "Sudan&apos;s capital" took a different story key from "Sudan's capital",
  // so an alert already sent went out again as a new story.
  it('decodes the escapes a publisher puts inside CDATA', () => {
    assert.equal(
      titleOf("<title><![CDATA[Drone strikes hit homes, UN building in Sudan&apos;s capital]]></title>"),
      "Drone strikes hit homes, UN building in Sudan's capital",
    );
    assert.equal(titleOf('<title><![CDATA[AT&amp;T &quot;merger&quot; &#8212; done]]></title>'), 'AT&T "merger" — done');
  });

  it('gives a CDATA title and a plain title the same text', () => {
    assert.equal(
      titleOf("<title><![CDATA[Korea&apos;s exports rise]]></title>"),
      titleOf('<title>Korea&apos;s exports rise</title>'),
    );
  });

  it('keeps a bare ampersand inside CDATA', () => {
    assert.equal(titleOf('<title><![CDATA[M&A activity picks up & rates fall]]></title>'), 'M&A activity picks up & rates fall');
  });
});
