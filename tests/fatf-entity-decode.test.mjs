// Pin the anchor-text entity decode in seed-fatf-listing.mjs: one pass must
// decode exactly ONE level. The old hand-rolled decoder replaced `&amp;`
// BEFORE `&lt;/&gt;`, so `&amp;lt;script&amp;gt;` (publisher-escaped literal
// text) came out as live `<script>` markup. Unmatched anchor text surfaces
// via `unmatchedCandidates`, which is the exported observable seam.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractListedCountries, buildNameLookup } from '../scripts/seed-fatf-listing.mjs';

const nameLookup = buildNameLookup();

function anchor(innerHtml, slug = 'Unmatched-Placeholder') {
  return `<a href="https://www.fatf-gafi.org/en/countries/detail/${slug}.html">${innerHtml}</a>`;
}

function unmatchedFor(innerHtml, slug) {
  const { unmatchedCandidates } = extractListedCountries(
    `<html><body><div class="cmp-text">${anchor(innerHtml, slug)}</div></body></html>`,
    nameLookup,
  );
  return [...unmatchedCandidates];
}

describe('extractListedCountries anchor-text decode: exactly one level', () => {
  it('does not double-decode &amp;lt; into live markup', () => {
    // Literal anchor text `&lt;script&gt;` escapes to `&amp;lt;script&amp;gt;`.
    // Replacing `&amp;` first would yield `<script>`.
    assert.deepEqual(
      unmatchedFor('XSS via &amp;lt;script&amp;gt; in template'),
      ['XSS via &lt;script&gt; in template'],
    );
  });

  it('still decodes a single level of the entities FATF emits', () => {
    assert.deepEqual(
      unmatchedFor('A &amp; B &lt;C&gt; &#39;quoted&#39;'),
      ['A & B <C> \'quoted\''],
    );
  });

  it('decodes &amp;amp; to a single literal &amp;', () => {
    assert.deepEqual(unmatchedFor('Tom &amp;amp; Jerry'), ['Tom &amp; Jerry']);
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.deepEqual(unmatchedFor('a&#999999999;b'), ['a&#999999999;b']);
  });

  it('round-trips a real country with an escaped apostrophe into the lookup', () => {
    const { listed, unmatchedCandidates } = extractListedCountries(
      `<html><body><div class="cmp-text">${anchor('Côte d&#39;Ivoire', 'Cote-d-Ivoire')}</div></body></html>`,
      nameLookup,
    );
    assert.deepEqual([...listed], ['CI']);
    assert.equal(unmatchedCandidates.size, 0);
  });
});
