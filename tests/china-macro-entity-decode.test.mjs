import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseNbsReleaseCalendar } from '../scripts/china-macro/calendar.mjs';

const SOURCE_URL = 'https://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/';

/**
 * Builds a minimal NBS calendar row: serial number, event name, then one
 * January cell (`9 /Jan`) and blank cells for the remaining months.
 */
function calendarHtml(eventCell) {
  const cells = ['<td>1</td>', `<td>${eventCell}</td>`, '<td>9 /Jan 09:30</td>'];
  while (cells.length < 14) cells.push('<td></td>');
  return `<table><tr>${cells.join('')}</tr></table>`;
}

function parseEvent(eventCell) {
  const events = parseNbsReleaseCalendar(calendarHtml(eventCell), 2026, SOURCE_URL);
  assert.equal(events.length, 1);
  assert.equal(events[0].releaseDate, '2026-01-09');
  return events[0].event;
}

describe('china-macro stripHtml: one pass must decode exactly one level', () => {
  it('does not double-decode &amp;quot; into a literal quote', () => {
    // Literal text `&quot;real&quot;` escapes to `&amp;quot;real&amp;quot;`.
    // Replacing `&amp;` before `&quot;` turns it into `"real"`.
    assert.equal(parseEvent('CPI &amp;quot;real&amp;quot; reading'), 'CPI &quot;real&quot; reading');
  });

  it('does not double-decode &amp;#39; into an apostrophe', () => {
    assert.equal(parseEvent('PPI &amp;#39;core&amp;#39; print'), 'PPI &#39;core&#39; print');
  });

  it('does not double-decode &amp;lt; markup into live markup', () => {
    assert.equal(parseEvent('Output &amp;lt;script&amp;gt; index'), 'Output &lt;script&gt; index');
  });

  it('still decodes a single level of the supported entities', () => {
    assert.equal(parseEvent('AT&amp;T &quot;Factory&quot; Prices'), 'AT&T "Factory" Prices');
    assert.equal(parseEvent('China&#39;s GDP &apos;Q1&apos;'), 'China\'s GDP \'Q1\'');
  });

  it('collapses &nbsp; and &#160; to plain spaces', () => {
    assert.equal(parseEvent('Retail&nbsp;Sales&#160;Total'), 'Retail Sales Total');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    assert.equal(parseEvent('a&#999999999;b'), 'a&#999999999;b');
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(parseEvent('Index &#128512; YoY'), 'Index \u{1F600} YoY');
  });
});
