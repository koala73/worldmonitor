import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../scripts/china-policy/adapters.mjs';

const { stripHtml } = __testing__;

// Regression coverage for koala73/worldmonitor#5436: the adapters' private
// entity decoder ran `&amp;` before the other replaces, so one pass decoded
// TWO levels (`&amp;lt;` -> `<`), turning escaped text into live markup.
// stripHtml is the exported seam that runs text through the decoder.
describe('china-policy adapters entity decoding (#5436)', () => {
  it('does not double-decode escaped markup into live markup', () => {
    // A title whose literal text is `&lt;script&gt;` arrives as `&amp;lt;script&amp;gt;`.
    // Decoding `&amp;` first would yield `<script>`.
    assert.equal(
      stripHtml('<p>注意 &amp;lt;script&amp;gt; 字样</p>'),
      '注意 &lt;script&gt; 字样',
    );
  });

  it('does not double-decode &amp;quot; / &amp;#39; / &amp;nbsp;', () => {
    assert.equal(stripHtml('<p>&amp;quot;</p>'), '&quot;');
    assert.equal(stripHtml('<p>&amp;#39;</p>'), '&#39;');
    assert.equal(stripHtml('<p>&amp;nbsp;</p>'), '&nbsp;');
  });

  it('still decodes a single level of the predefined entities', () => {
    assert.equal(stripHtml('<p>5 &lt; 6 &amp; 7 &gt; 2</p>'), '5 < 6 & 7 > 2');
    assert.equal(stripHtml('<p>&quot;引文&quot; &apos;单&apos;</p>'), '"引文" \'单\'');
    assert.equal(stripHtml('<p>甲&nbsp;乙</p>'), '甲 乙');
  });

  it('decodes numeric references, including above the BMP', () => {
    assert.equal(stripHtml('<p>&#39;&#x27;</p>'), "''");
    assert.equal(stripHtml('<p>&#128512;</p>'), '\u{1F600}');
    assert.equal(stripHtml('<p>&#X1f600;</p>'), '\u{1F600}');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.equal(stripHtml('<p>正文&#x110000;内容</p>'), '正文&#x110000;内容');
    assert.equal(stripHtml('<p>a&#999999999;b</p>'), 'a&#999999999;b');
  });

  it('matches entities case-insensitively and keeps unknown entities as-is', () => {
    assert.equal(stripHtml('<p>&AMP;&LT;&NBSP;</p>'), '&<');
    assert.equal(stripHtml('<p>&bogus; &amp;</p>'), '&bogus; &');
  });
});
