import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseWikipediaRankingsTable } from '../scripts/seed-sovereign-wealth.mjs';

// Minimal wikitable whose fund-name cell carries the entity payload under
// test. Column order mirrors the fixture contract in
// tests/seed-sovereign-wealth.test.mjs (country, abbrev, fund, assets,
// inception, origin).
const TABLE = (fundNameHtml) => `
<html><body>
<table class="wikitable sortable">
  <tbody>
    <tr>
      <td>Norway</td>
      <td>TSTF</td>
      <td>${fundNameHtml}</td>
      <td>100</td>
      <td>1990</td>
      <td>Oil &amp; Gas</td>
    </tr>
  </tbody>
</table>
</body></html>`;

function fundNameOf(fundNameHtml) {
  const cache = parseWikipediaRankingsTable(TABLE(fundNameHtml));
  const records = cache.byAbbrev.get('TSTF');
  assert.ok(records && records.length === 1, 'fixture row must parse to exactly one record');
  return records[0].fundName;
}

describe('stripHtmlInline (via parseWikipediaRankingsTable): one pass decodes exactly one level', () => {
  it('does not double-decode escaped markup into live markup', () => {
    // A fund name whose literal text is `&lt;script&gt;` is stored as
    // `&amp;lt;script&amp;gt;`. Decoding `&amp;` before the catch-all
    // re-exposes `&lt;`/`&gt;` to a second pass (and a naive `&amp;`-first
    // chain would even yield `<script>`). One pass must keep it literal.
    assert.equal(
      fundNameOf('Acme &amp;lt;script&amp;gt; Fund'),
      'Acme &lt;script&gt; Fund',
    );
  });

  it('decodes numeric character references instead of blanking them', () => {
    // Old catch-all `&[#\w]+;` -> ' ' turned an em-dash reference into a
    // plain space; the shared decoder decodes it properly.
    assert.equal(fundNameOf('Alpha&#8212;Beta Fund'), 'Alpha—Beta Fund');
    assert.equal(fundNameOf('Alpha&#x2014;Beta Fund'), 'Alpha—Beta Fund');
  });

  it('keeps a double-escaped nbsp literal after one level of decoding', () => {
    // Old order (`&amp;` first, then catch-all) made `&amp;nbsp;` vanish;
    // one level of decoding must leave the literal text `&nbsp;`.
    assert.equal(fundNameOf('Global&amp;nbsp;Macro Fund'), 'Global&nbsp;Macro Fund');
  });

  it('blanks out-of-range numeric references instead of throwing or welding', () => {
    // unknownEntity: 'blank' replaces invalid refs with a space (the old
    // catch-all behavior) so adjacent digits cannot weld into one number.
    assert.equal(fundNameOf('Foo&#999999999;Bar Fund'), 'Foo Bar Fund');
    assert.equal(fundNameOf('Foo&#55296;Bar Fund'), 'Foo Bar Fund');
  });

  it('does not weld AUM digits across a malformed numeric reference', () => {
    // Review finding: dropping `&#999999999;` to '' would parse as 100200.
    assert.equal(fundNameOf('100&#999999999;200 Global Fund'), '100 200 Global Fund');
  });

  it('preserves the catch-all intent for unknown named entities', () => {
    // Unknown entities still blank to a single space (unknownEntity: 'blank').
    assert.equal(fundNameOf('Foo&bogus;Bar Fund'), 'Foo Bar Fund');
  });

  it('still blanks plain nbsp to a regular space', () => {
    assert.equal(fundNameOf('Global&nbsp;Macro Fund'), 'Global Macro Fund');
  });

  it('still decodes a single level of the predefined entities', () => {
    assert.equal(fundNameOf('AT&amp;T &lt;Global&gt; Fund'), 'AT&T <Global> Fund');
  });
});
