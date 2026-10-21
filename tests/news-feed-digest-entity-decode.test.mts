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
