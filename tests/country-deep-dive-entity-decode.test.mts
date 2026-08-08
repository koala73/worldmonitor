import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeHtmlEntities } from '../src/utils/html-entities.ts';
import {
  dedupeHeadlines,
  normalizeHeadlineKey,
} from '../src/components/CountryDeepDivePanel-news-utils.ts';
import type { NewsItem } from '../src/types/index.ts';

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('decodeHtmlEntities: one pass must decode exactly one level', () => {
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
      assert.equal(decodeHtmlEntities(escapeXml(original)), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A headline whose literal text is `&lt;script&gt;` escapes to `&amp;lt;script&amp;gt;`.
    // Decoding `&amp;` first would yield `<script>`.
    assert.equal(
      decodeHtmlEntities('XSS via &amp;lt;script&amp;gt; in Acme SDK'),
      'XSS via &lt;script&gt; in Acme SDK',
    );
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(decodeHtmlEntities('&#128512;'), '\u{1F600}');
    assert.equal(decodeHtmlEntities('&#x1F600;'), '\u{1F600}');
  });

  it('preserves out-of-range numeric references instead of throwing', () => {
    assert.equal(decodeHtmlEntities('a&#999999999;b'), 'a&#999999999;b');
  });

  it('preserves surrogate-range numeric references instead of emitting lone surrogates', () => {
    assert.equal(decodeHtmlEntities('a&#55296;b'), 'a&#55296;b');
    assert.equal(decodeHtmlEntities('a&#xD800;b'), 'a&#xD800;b');
  });

  it('does not weld CVE identifiers around invalid numeric references', () => {
    assert.equal(
      decodeHtmlEntities('CVE-2026-1234&#999999999;CVE-2026-5678'),
      'CVE-2026-1234&#999999999;CVE-2026-5678',
    );
  });

  it('blanks unknown entities and invalid numeric refs when unknownEntity: "blank"', () => {
    assert.equal(decodeHtmlEntities('a &bogus; b', { unknownEntity: 'blank' }), 'a   b');
    assert.equal(decodeHtmlEntities('&amp;bogus;', { unknownEntity: 'blank' }), '&bogus;');
    // A space, not '', so adjacent digits cannot weld (`100...200` -> `100 200`).
    assert.equal(decodeHtmlEntities('100&#999999999;200', { unknownEntity: 'blank' }), '100 200');
  });

  it('still decodes a single level of the predefined entities', () => {
    assert.equal(decodeHtmlEntities('5 &lt; 6 &amp; 7 &gt; 2'), '5 < 6 & 7 > 2');
    assert.equal(decodeHtmlEntities('&quot;quoted&quot; &apos;single&apos;'), '"quoted" \'single\'');
  });
});

describe('normalizeHeadlineKey / dedupeHeadlines: single-level decode', () => {
  it('treats a double-escaped title and its single-level decode as the same story', () => {
    const a = normalizeHeadlineKey('XSS via &amp;lt;script&amp;gt; in Acme SDK');
    const b = normalizeHeadlineKey('XSS via &lt;script&gt; in Acme SDK');
    assert.equal(a, b);
    assert.ok(a.length > 0);
  });

  it('still collapses encoded and plain variants of the same headline', () => {
    const a = normalizeHeadlineKey('AT&amp;T announces new tower buildout');
    const b = normalizeHeadlineKey('AT&T announces new tower buildout');
    assert.equal(a, b);
  });

  it('dedupes a double-escaped title against its literal-text twin', () => {
    const items = [
      { title: 'XSS via &amp;lt;script&amp;gt; in Acme SDK', source: 'BlogA' },
      { title: 'XSS via &lt;script&gt; in Acme SDK', source: 'BlogB' },
    ].map(
      ({ title, source }) =>
        ({
          title,
          link: `https://example.com/${encodeURIComponent(title)}::${source}`,
          source,
          pubDate: new Date('2026-04-12T00:00:00Z'),
          isAlert: false,
        }) as NewsItem,
    );
    const out = dedupeHeadlines(items);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.extraSources.length, 1);
  });
});
