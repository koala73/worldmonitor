import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseJapanModIndex } from '../scripts/cross-strait-activity/adapters.mjs';

// decodeHtml is private; parseJapanModIndex decodes anchor titles through it.
function decodeTitleViaParser(body) {
  const rows = parseJapanModIndex(
    `<a href="/js/pdf/2026/p20260724_05e.pdf">${body}</a>`,
  );
  assert.equal(rows.length, 1);
  return rows[0].title;
}

describe('cross-strait decodeHtml: &amp; must decode last (issue #5436)', () => {
  it('does not double-decode &amp;quot; into a live quote', () => {
    // &amp;quot; is one escape level of the literal text `&quot;`.
    // Replacing &amp; before &quot; would yield `"` (two levels).
    assert.equal(decodeTitleViaParser('PLA &amp;quot;drills&amp;quot;'), 'PLA &quot;drills&quot;');
  });

  it('does not double-decode &amp;nbsp; into a space', () => {
    assert.equal(decodeTitleViaParser('A&amp;nbsp;B'), 'A&nbsp;B');
  });

  it('preserves the deliberate non-decoding of &lt; / &gt;', () => {
    // This decoder intentionally has no &lt;/&gt; replaces; keep them literal.
    assert.equal(decodeTitleViaParser('A &lt; B &gt; C'), 'A &lt; B &gt; C');
  });

  it('still decodes a single level of its entity set', () => {
    assert.equal(decodeTitleViaParser('&quot;quoted&quot;'), '"quoted"');
    // decodeHtml collapses runs of spaces/tabs to one space after decoding.
    assert.equal(decodeTitleViaParser('5 &amp; 6 &nbsp; 7'), '5 & 6 7');
    assert.equal(decodeTitleViaParser('it&#39;s &apos;fine&apos;'), "it's 'fine'");
    assert.equal(decodeTitleViaParser('&#x41;&#66;'), 'AB');
  });

  it('maps out-of-range and surrogate numerics to U+FFFD (preserved quirk)', () => {
    // Local decodeNumericEntity rejects non-scalar values with U+FFFD,
    // unlike the shared helper which drops them to ''.
    assert.equal(decodeTitleViaParser('a&#999999999;b'), 'a\uFFFDb');
    assert.equal(decodeTitleViaParser('a&#x110000;b'), 'a\uFFFDb');
    assert.equal(decodeTitleViaParser('a&#55296;b'), 'a\uFFFDb');
  });
});
