import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRssItems } from '../scripts/seed-security-advisories.mjs';

function rssItem({ title = 'Advisory', description = '', link = 'https://example.com/x', pubDate = 'Mon, 01 Jan 2024 00:00:00 GMT' } = {}) {
  return `
    <rss version="2.0"><channel><item>
      <title>${title}</title>
      <link>${link}</link>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
    </item></channel></rss>`;
}

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('security advisories stripHtml: one pass must decode exactly one level', () => {
  it('does not double-decode escaped markup into live markup', () => {
    const [item] = parseRssItems(rssItem({
      description: 'XSS via &amp;lt;script&amp;gt; in Acme SDK',
    }));
    // Decoding `&amp;` before `&lt;`/`&gt;` turned this into live `<script>`.
    assert.equal(item.description, 'XSS via &lt;script&gt; in Acme SDK');
  });

  it('round-trips singly-escaped text back to the original', () => {
    const originals = [
      'AT&T completes merger',
      'XSS via <script> in Acme SDK',
      'Q3 revenue > $2B & rising',
      'He said "no comment"',
    ];
    for (const original of originals) {
      const [item] = parseRssItems(rssItem({ description: escapeXml(original) }));
      assert.equal(item.description, original);
    }
  });

  it('strips real tags but keeps escaped markup as text', () => {
    const [item] = parseRssItems(rssItem({
      description: '<p>Advisory &amp;lt;b&amp;gt;update&amp;lt;/b&amp;gt; issued</p>',
    }));
    assert.equal(item.description, 'Advisory &lt;b&gt;update&lt;/b&gt; issued');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    const [item] = parseRssItems(rssItem({ description: 'a&#999999999;b' }));
    assert.equal(item.description, 'a&#999999999;b');
  });

  it('decodes numeric references used by advisory feeds', () => {
    const [item] = parseRssItems(rssItem({
      description: 'don&#8217;t &#8220;travel&#8221; &#128512;',
    }));
    assert.equal(item.description, 'don’t “travel” 😀');
  });

  it('decodes CDATA content and collapses whitespace', () => {
    const [item] = parseRssItems(rssItem({
      description: '<![CDATA[Level  4 &amp; rising]]>',
    }));
    assert.equal(item.description, 'Level 4 & rising');
  });
});
