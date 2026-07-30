import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchGets } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-07-13T12:00:00Z');

// The GETS feed embeds an HTML table inside an XML-escaped <description>.
// `overviewXml` is injected as it appears in the raw XML, so a publisher
// HTML string `&amp;lt;` shows up here as `&amp;amp;lt;`.
function getsXml(overviewXml) {
  return `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
    <title>Cloud platform</title><link>https://www.gets.govt.nz/MBIE/ExternalTenderDetails.htm?id=34394762</link>
    <description>&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;RFx ID: &lt;/b&gt;&lt;/td&gt;&lt;td&gt;34394762&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;Close date: &lt;/td&gt;&lt;td&gt;Monday, 17 August 2026 4:00 PM +12:00&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;Overview: &lt;/b&gt;&lt;/td&gt;&lt;td&gt;${overviewXml}&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</description>
    <category>81110000 - Computer services</category><pubDate>Fri, 10 Jul 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`;
}

async function fetchOverview(overviewXml) {
  const result = await fetchGets({ now: NOW, fetchTextFn: async () => getsXml(overviewXml) });
  assert.equal(result.records.length, 1);
  return result.records[0].description;
}

test('decodeHtml does not double-decode escaped markup into live markup', async () => {
  // Publisher text is the literal `&lt;script&gt;`; one XML unescape and one
  // HTML decode must stop at `&lt;script&gt;`, never `<script>`.
  const description = await fetchOverview('XSS via &amp;amp;lt;script&amp;amp;gt; in Acme SDK');
  assert.equal(description, 'XSS via &lt;script&gt; in Acme SDK');
});

test('decodeHtml preserves out-of-range numeric references instead of throwing or welding text', async () => {
  const description = await fetchOverview('a&amp;#999999999;b');
  assert.equal(description, 'a&#999999999;b');
});

test('decodeHtml still decodes exactly one level of the predefined entities', async () => {
  const description = await fetchOverview('5 &amp;lt; 6 &amp;amp; 7 &amp;gt; 2 &amp;quot;q&amp;quot;');
  assert.equal(description, '5 < 6 & 7 > 2 "q"');
});

test('decodeHtml preserves tag stripping, <br> newlines, nbsp, and whitespace collapse', async () => {
  const description = await fetchOverview('cloud&amp;nbsp;&lt;b&gt;platform&lt;/b&gt;&lt;br&gt;refresh');
  assert.equal(description, 'cloud platform refresh');
});
