// seed-hormuz entity-decode regression (koala73/worldmonitor#5436).
//
// The seeder's private decoder ran `.replace(/&amp;/g, '&')` BEFORE the
// `&lt;`/`&gt;` replaces, so one call decoded TWO levels: text a publisher
// escaped twice (`&amp;lt;script&amp;gt;`) came back as live markup
// (`<script>`). The shared single-pass decoder in scripts/_html-entities.mjs
// decodes exactly one level per call. These tests exercise the decode path
// through the exported `stripTags` seam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripTags } from '../scripts/seed-hormuz.mjs';

/** Mirrors what a well-formed HTML page produces for a plain-text string. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

describe('stripTags entity decoding: one pass must decode exactly one level', () => {
  it('round-trips escaped text back to the original', () => {
    const originals = [
      'AT&T completes merger',
      'XSS via &lt;script&gt; in Hormuz tracker',
      'Q3 revenue > $2B & rising',
      'He said "no comment"',
      "Ireland's PM: 'no deal' & <no> comment",
      'plain headline with no entities',
    ];
    for (const original of originals) {
      assert.equal(stripTags(escapeHtml(original)), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A blurb whose literal text is `&lt;script&gt;` escapes to
    // `&amp;lt;script&amp;gt;`. Decoding `&amp;` first would yield `<script>`.
    assert.equal(
      stripTags('XSS via &amp;lt;script&amp;gt; in Acme SDK'),
      'XSS via &lt;script&gt; in Acme SDK',
    );
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(stripTags('&#128512;'), '\u{1F600}');
    assert.equal(stripTags('&#x1F600;'), '\u{1F600}');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.equal(stripTags('a&#999999999;b'), 'a&#999999999;b');
  });

  it('still decodes a single level of the entities the old decoder handled', () => {
    assert.equal(stripTags('5 &lt; 6 &amp; 7 &gt; 2'), '5 < 6 & 7 > 2');
    assert.equal(stripTags('&ldquo;quoted&rdquo; &rsquo;single&lsquo;'), '“quoted” ’single‘');
    assert.equal(stripTags('dash &mdash; ndash &ndash;'), 'dash — ndash –');
    assert.equal(stripTags('it&#8217;s &#8220;fine&#8221;'), 'it’s “fine”');
    assert.equal(stripTags('a&nbsp;b'), 'a b');
  });
});

describe('stripTags: tag stripping and whitespace collapsing are unchanged', () => {
  it('strips tags before decoding and collapses whitespace', () => {
    assert.equal(
      stripTags('<p>Hello   <b>world</b> &amp; all</p>'),
      'Hello world & all',
    );
  });

  it('keeps text that was escaped twice by the publisher', () => {
    // Double-decoding produced `<script>`, which the tag strip would have
    // deleted had the order been reversed — here the escaped form must
    // survive decoding intact.
    const html = '<p>Acme patched an XSS triggered by &amp;lt;script&amp;gt; tags in bios.</p>';
    const text = stripTags(html);
    assert.match(text, /&lt;script&gt;/);
    assert.match(text, /tags in bios\./);
  });
});
