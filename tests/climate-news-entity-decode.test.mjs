// Focused regression test for koala73/worldmonitor#5436 (seed-climate-news unit).
//
// The seeder's old private decoder ran `.replace(/&lt;/g …)` then
// `.replace(/&amp;/g …)` then `.replace(/&quot;/g …)` in sequence, so one call
// decoded TWO levels for any entity ordered after `&amp;` in the chain:
// `&amp;quot;` → `&quot;` → `"`. The shared single-pass decoder in
// scripts/_html-entities.mjs decodes exactly one level for every input.
//
// Seam: parseRssItems is exported from the seeder (guarded by an isMain check
// so importing it here does not trigger a real seed run).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRssItems } from '../scripts/seed-climate-news.mjs';

const PUB = '<pubDate>Mon, 04 May 2026 12:00:00 GMT</pubDate>';

function rssItem({ title, link = 'https://example.com/story', description = '' }) {
  return `<item><title>${title}</title><link>${link}</link>${PUB}<description>${description}</description></item>`;
}

function parseOne(itemXml) {
  const items = parseRssItems(`<rss><channel>${itemXml}</channel></rss>`, 'Test Feed');
  assert.equal(items.length, 1, 'expected exactly one parsed item');
  return items[0];
}

describe('seed-climate-news entity decoding: one pass must decode exactly one level', () => {
  it('decodes a single level of the predefined entities', () => {
    const item = parseOne(rssItem({ title: 'AT&amp;T: 5 &lt; 6 &amp; 7 &gt; 2' }));
    assert.equal(item.title, 'AT&T: 5 < 6 & 7 > 2');
  });

  it('does not double-decode &amp;quot; into a live quote', () => {
    // Literal headline text is `He said &quot;no&quot;`; the publisher escaped
    // it once for XML transport. &amp; before &quot; in the old chain decoded
    // both levels in one call.
    const item = parseOne(rssItem({ title: 'He said &amp;quot;no comment&amp;quot;' }));
    assert.equal(item.title, 'He said &quot;no comment&quot;');
  });

  it('does not double-decode &amp;#39; into an apostrophe', () => {
    const item = parseOne(rssItem({ title: 'Ireland&amp;#39;s PM: &amp;#39;no deal&amp;#39;' }));
    assert.equal(item.title, 'Ireland&#39;s PM: &#39;no deal&#39;');
  });

  it('does not double-decode &amp;nbsp; into a space', () => {
    const item = parseOne(rssItem({ title: 'Price: 100&amp;nbsp;USD' }));
    assert.equal(item.title, 'Price: 100&nbsp;USD');
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A headline whose literal text is `&lt;script&gt;` escapes to
    // `&amp;lt;script&amp;gt;`; one decode level must leave `&lt;script&gt;`.
    const item = parseOne(rssItem({ title: 'XSS via &amp;lt;script&amp;gt; in Acme SDK' }));
    assert.equal(item.title, 'XSS via &lt;script&gt; in Acme SDK');
  });

  it('keeps double-escaped markup text through the summary tag strip', () => {
    const item = parseOne(rssItem({
      title: 'Acme patches XSS',
      description: 'Acme patched an XSS triggered by &amp;lt;script&amp;gt; tags in <b>user bios</b>.',
    }));
    assert.match(item.summary, /&lt;script&gt;/);
    assert.match(item.summary, /user bios/);
    assert.doesNotMatch(item.summary, /<script>/);
  });

  it('decodes numeric references above the BMP', () => {
    const item = parseOne(rssItem({ title: 'Record heat &#128293; in &quot;the south&quot;' }));
    assert.equal(item.title, 'Record heat \u{1F525} in "the south"');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    const item = parseOne(rssItem({ title: 'a&#999999999;b' }));
    assert.equal(item.title, 'a&#999999999;b');
  });

  it('decodes exactly one level in links', () => {
    const item = parseOne(rssItem({
      title: 'Link test',
      link: 'https://example.com/a?x=1&amp;y=2',
    }));
    assert.equal(item.url, 'https://example.com/a?x=1&y=2');
  });
});
