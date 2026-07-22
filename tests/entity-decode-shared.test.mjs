import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeHtmlEntities, decodeNumericReference } from '../scripts/shared/entity-decode.mjs';

const STD = { named: { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } };

// Mirrors what a well-formed feed generator produces for a plain-text string.
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('decodeHtmlEntities: one pass decodes exactly one level', () => {
  it('round-trips singly-escaped text', () => {
    for (const original of [
      'AT&T completes merger',
      'XSS via <script> in Acme SDK',
      'Q3 revenue > $2B & rising',
      'He said "no comment"',
      "Ireland's PM: 'no deal' & <no> comment",
    ]) {
      assert.equal(decodeHtmlEntities(escapeXml(original), STD), original);
    }
  });

  it('does NOT double-decode escaped-once markup (issue #5436)', () => {
    // `&amp;lt;script&amp;gt;` is the escaping of the literal text
    // `&lt;script&gt;` and must stay literal, never become `<script>`.
    assert.equal(decodeHtmlEntities('&amp;lt;script&amp;gt;', STD), '&lt;script&gt;');
    assert.equal(decodeHtmlEntities('a &amp;#38; b', STD), 'a &#38; b');
  });
});

describe('numeric references', () => {
  it('decodes decimal and hex when numericDefault is "decode"', () => {
    assert.equal(decodeHtmlEntities('&#65;&#x42;', { numericDefault: 'decode' }), 'AB');
  });

  it('range-guards malformed refs instead of throwing (RangeError source)', () => {
    assert.equal(decodeHtmlEntities('x&#999999999;y', { numericDefault: 'decode' }), 'xy');
    assert.equal(decodeNumericReference(0x110000), '');
    assert.equal(decodeNumericReference(Number.NaN), '');
  });

  it('applies numericOverrides and leaves others literal', () => {
    const cfg = { numericOverrides: { 8217: "'", 8220: '"', 8221: '"' }, numericDefault: 'literal' };
    assert.equal(decodeHtmlEntities('&#8217;&#8220;x&#8221;', cfg), '\'"x"');
    assert.equal(decodeHtmlEntities('&#65;', cfg), '&#65;');
  });
});

describe('config variants used by the seeders', () => {
  it('preserves curly quotes when a seeder maps them so (hormuz)', () => {
    const cfg = { named: { ldquo: '“', rdquo: '”' }, numericOverrides: { 8220: '“', 8221: '”' }, numericDefault: 'literal' };
    assert.equal(decodeHtmlEntities('&ldquo;x&rdquo; &#8220;y&#8221;', cfg), '“x” “y”');
  });

  it('matches names case-insensitively when requested (regulatory)', () => {
    assert.equal(decodeHtmlEntities('A&AMP;B', { named: { amp: '&' }, caseInsensitive: true }), 'A&B');
  });

  it('routes unknown entities and numerics to a space (sovereign-wealth)', () => {
    assert.equal(
      decodeHtmlEntities('a&nbsp;b&mdash;c&#8212;d', { named: { nbsp: ' ', amp: '&' }, numericDefault: 'space', unknownToSpace: true }),
      'a b c d',
    );
  });
});
