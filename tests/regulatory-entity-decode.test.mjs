import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, stripHtml } from '../scripts/seed-regulatory-actions.mjs';

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('decodeEntities: one pass must decode exactly one level', () => {
  it('round-trips escaped text back to the original', () => {
    const originals = [
      'SEC & CFTC joint action',
      'XSS via &lt;script&gt; in filing title',
      'Q3 penalty > $2B & rising',
      'Agency said "no comment"',
      "FINRA's notice: 'no deal' & <no> comment",
      'plain headline with no entities',
    ];
    for (const original of originals) {
      assert.equal(decodeEntities(escapeXml(original)), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A title whose literal text is `&lt;script&gt;` escapes to `&amp;lt;script&amp;gt;`.
    // Decoding `&amp;` first would yield `<script>`.
    assert.equal(
      decodeEntities('Firm disclosed &amp;lt;script&amp;gt; vector'),
      'Firm disclosed &lt;script&gt; vector',
    );
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(decodeEntities('&#128512;'), '\u{1F600}');
    assert.equal(decodeEntities('&#x1F600;'), '\u{1F600}');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.doesNotThrow(() => decodeEntities('a&#999999999;b'));
    assert.equal(decodeEntities('a&#999999999;b'), 'a&#999999999;b');
    assert.equal(decodeEntities('a&#xFFFFFFFF;b'), 'a&#xFFFFFFFF;b');
  });

  it('still decodes a single level of the predefined entities', () => {
    assert.equal(decodeEntities('5 &lt; 6 &amp; 7 &gt; 2'), '5 < 6 & 7 > 2');
    assert.equal(decodeEntities('&quot;quoted&quot; &apos;single&apos;'), '"quoted" \'single\'');
  });
});

describe('stripHtml: escaped markup survives the tag strip', () => {
  it('keeps text that was escaped twice by the publisher', () => {
    // Double-decoding produced `<script>`, which the `<[^>]+>` strip then
    // deleted along with the alert payload text boundary.
    const stripped = stripHtml('Enforcement action over &amp;lt;script&amp;gt; tags in filings.');
    assert.match(stripped, /&lt;script&gt;/);
    assert.match(stripped, /tags in filings\./);
  });

  it('still strips tags exposed by a single decode level (FINRA-style descriptions)', () => {
    assert.equal(
      stripHtml('&lt;h2&gt;Summary&lt;/h2&gt;&lt;p&gt;FINRA amends Rule 4210.&lt;/p&gt;'),
      'Summary FINRA amends Rule 4210.',
    );
  });
});
