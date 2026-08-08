import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToPlainText } from '../scripts/_trade-parse-utils.mjs';

/** Mirrors what an HTML publisher produces when escaping plain-text content. */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

describe('htmlToPlainText: one pass must decode exactly one level', () => {
  it('round-trips escaped text back to the original', () => {
    const originals = [
      'Effective tariff rate stood at 17.4% & rising',
      'XSS via &lt;script&gt; in trade report',
      'Q3 revenue > $2B & costs < $1B',
      'He said "no comment" on tariffs',
      "Ireland's PM: 'no deal' on quotas",
    ];
    for (const original of originals) {
      assert.equal(htmlToPlainText(`<p>${escapeHtml(original)}</p>`), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // Text whose literal content is `&lt;script&gt;` escapes to
    // `&amp;lt;script&amp;gt;`. Decoding `&amp;` first in a chain would let a
    // second replace turn it into `<script>`.
    assert.equal(
      htmlToPlainText('<p>XSS via &amp;lt;script&amp;gt; in report</p>'),
      'XSS via &lt;script&gt; in report',
    );
  });

  it('does not double-decode &amp;quot; into a quote character', () => {
    // Literal text `&quot;` escapes to `&amp;quot;`. A chain decoding `&amp;`
    // before `&quot;` yields `"` — two levels in one pass.
    assert.equal(
      htmlToPlainText('<p>label &amp;quot;effective rate&amp;quot; here</p>'),
      'label &quot;effective rate&quot; here',
    );
  });

  it('does not double-decode &amp;#39; into an apostrophe', () => {
    assert.equal(
      htmlToPlainText("<p>It&amp;#39;s not a real apostrophe</p>"),
      "It&#39;s not a real apostrophe",
    );
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.equal(htmlToPlainText('<p>a&#999999999;b</p>'), 'a&#999999999;b');
    assert.equal(htmlToPlainText('<p>a&#x110000;b</p>'), 'a&#x110000;b');
  });

  it('decodes a single level of numeric references, including above the BMP', () => {
    assert.equal(htmlToPlainText('<p>&#128512; &#x1F600;</p>'), '\u{1F600} \u{1F600}');
  });

  it('still strips tags, scripts, styles, and comments before decoding', () => {
    const html = '<style>.x{}</style><script>bad()</script><!-- c --><p>effective tariff rate reaching <strong>7.5%</strong></p>';
    assert.equal(htmlToPlainText(html), 'effective tariff rate reaching 7.5%');
  });
});
