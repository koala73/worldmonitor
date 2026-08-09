// Entity-decoding contract for the RSS description path in
// scripts/seed-disease-outbreaks.mjs (CDC HAN + Outbreak News Today feeds).
//
// The seeder decodes entities, strips tags, trims, and truncates to 300 chars.
// The decode step MUST be single-pass: `&amp;` must not be decoded before the
// other replaces, otherwise `&amp;lt;script&amp;gt;` becomes `<script>` and
// the subsequent tag strip silently deletes the publisher's literal text
// (#5436). Out-of-range numeric references (`&#999999999;`) must be preserved
// without throwing `String.fromCodePoint`'s RangeError or welding nearby text.
//
// The decode site lives inside the seeder's private fetchRssItems (network),
// so the pure decode+strip step is exported as `cleanRssDescription` from
// scripts/_disease-outbreaks-helpers.mjs — the same seam the seeder calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanRssDescription } from '../scripts/_disease-outbreaks-helpers.mjs';

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('cleanRssDescription: one pass must decode exactly one level', () => {
  it('round-trips escaped text back to the original', () => {
    // Note: this seam strips tags after decoding (production behavior), so
    // originals must not contain `<...>` tag-shaped text — that is stripped
    // by design and covered by the tag-strip test below.
    const originals = [
      'AT&T completes merger',
      'XSS via &lt;script&gt; in Acme SDK',
      'Q3 cases > 200 & rising',
      'He said "no comment"',
      "Ireland's PM: 'no deal' & no comment",
      'plain headline with no entities',
    ];
    for (const original of originals) {
      assert.equal(cleanRssDescription(escapeXml(original)), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A description whose literal text is `&lt;script&gt;` escapes to
    // `&amp;lt;script&amp;gt;`. Decoding `&amp;` first yields `<script>`,
    // which the tag strip then deletes (or, unescaped, leaves as live markup).
    assert.equal(
      cleanRssDescription('XSS via &amp;lt;script&amp;gt; in Acme SDK'),
      'XSS via &lt;script&gt; in Acme SDK',
    );
    // The old chain ran `&amp;` BEFORE `&quot;`/`&#39;`, so these decoded
    // two levels in a single pass — the exact #5436 double-decode:
    assert.equal(cleanRssDescription('He said &amp;quot;no&amp;quot;'), 'He said &quot;no&quot;');
    assert.equal(cleanRssDescription('it&amp;#39;s'), 'it&#39;s');
  });

  it('still decodes a single level of the predefined entities', () => {
    // `&lt;`/`&gt;` decodes are exercised indirectly (decoded `<...>` pairs
    // are tag-stripped by design); here we assert the non-tag entities.
    assert.equal(cleanRssDescription('rock &amp; roll'), 'rock & roll');
    assert.equal(cleanRssDescription('&quot;quoted&quot; &apos;single&apos;'), '"quoted" \'single\'');
    assert.equal(cleanRssDescription('a&nbsp;b'), 'a b');
    assert.equal(cleanRssDescription('a&#39;b'), "a'b");
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(cleanRssDescription('&#128512;'), '\u{1F600}');
    assert.equal(cleanRssDescription('&#x1F600;'), '\u{1F600}');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.equal(cleanRssDescription('a&#999999999;b'), 'a&#999999999;b');
  });

  it('strips real tags after decoding and truncates to 300 chars', () => {
    assert.equal(cleanRssDescription('<p>Hello <b>world</b></p>'), 'Hello world');
    assert.equal(cleanRssDescription('x'.repeat(400)).length, 300);
  });

  it('keeps double-escaped markup as text through the tag strip', () => {
    const raw = 'Acme patched an XSS triggered by &amp;lt;script&amp;gt; tags in bios.';
    const desc = cleanRssDescription(raw);
    assert.match(desc, /&lt;script&gt;/);
    assert.match(desc, /tags in bios\./);
  });
});
