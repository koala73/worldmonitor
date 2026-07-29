import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseNbsIndustrialRelease } from '../scripts/china-macro/adapters.mjs';

const SOURCE_URL = 'https://www.stats.gov.cn/english/PressRelease/202607/t20260715_1234567.html';

/**
 * Builds a minimal NBS industrial-production release page. `title` lands in
 * the ArticleTitle meta tag, which `metaContent()` runs through the private
 * `decodeHtml` — the seam this suite exercises.
 */
function nbsIndustrialHtml(title) {
  return `<html><head>
<meta name="ArticleTitle" content="${title}">
<meta name="PubDate" content="2026/07/15 10:00">
</head><body>
<p>In June 2026, the total value added of industrial enterprises above the
designated size increased by 6.8% year on year.</p>
</body></html>`;
}

function parseTitle(title) {
  const observation = parseNbsIndustrialRelease(nbsIndustrialHtml(title), {
    retrievalTime: '2026-07-15T03:00:00.000Z',
    sourceUrl: SOURCE_URL,
  });
  assert.equal(observation.observationPeriod, '2026-06');
  return observation.releaseTitle;
}

describe('china-macro adapters decodeHtml: one pass must decode exactly one level', () => {
  it('does not double-decode &amp;quot; into a literal quote', () => {
    // Literal text `&quot;Industrial&quot;` escapes to `&amp;quot;Industrial&amp;quot;`.
    // Replacing `&amp;` before `&quot;` turns it into `"Industrial"`.
    assert.equal(
      parseTitle('June 2026 &amp;quot;Industrial&amp;quot; Production'),
      'June 2026 &quot;Industrial&quot; Production',
    );
  });

  it('does not double-decode &amp;#39; into an apostrophe', () => {
    assert.equal(
      parseTitle('June 2026 China&amp;#39;s Output'),
      'June 2026 China&#39;s Output',
    );
  });

  it('does not double-decode &amp;lt; markup into live markup', () => {
    assert.equal(
      parseTitle('June 2026 Output &amp;lt;b&amp;gt; Index'),
      'June 2026 Output &lt;b&gt; Index',
    );
  });

  it('still decodes a single level of the supported entities', () => {
    assert.equal(
      parseTitle('June 2026 AT&amp;T &quot;Factory&quot; Output'),
      'June 2026 AT&T "Factory" Output',
    );
    assert.equal(
      parseTitle('June 2026 China&#39;s GDP &apos;Q2&apos;'),
      'June 2026 China\'s GDP \'Q2\'',
    );
  });

  it('collapses &nbsp; and &#160; to plain spaces', () => {
    // `&#160;` decodes to a literal U+00A0 via the shared helper; decodeHtml
    // must keep the historical plain-space contract so releaseTitle and the
    // downstream `englishMonthPeriod` regex see an ordinary space.
    const title = parseTitle('June&#160;2026 Industrial&nbsp;Production');
    assert.equal(title, 'June 2026 Industrial Production');
    assert.ok(!title.includes(' '));
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(parseTitle('June 2026 Index &#128512; YoY'), 'June 2026 Index \u{1F600} YoY');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.equal(
      parseTitle('June 2026 a&#999999999;b Output'),
      'June 2026 a&#999999999;b Output',
    );
  });
});
