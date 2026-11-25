import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing__, fetchGets } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const RSS_URL = 'https://www.gets.govt.nz/ExternalRSSFeed.htm';

function indexRow({ id, agency, ref, title, typeTitle, typeAbbr, close, org }) {
  const href = `${agency}/ExternalTenderDetails.htm?id=${id}`;
  return `
                    <tr id="tender-${id}" class="tender blueRow">
                        <td style="width:10%"><a href="${href}">${id}</a></td>
                        <td style="width:15%"><a href="${href}">${ref}</a></td>
                        <td style="width:25%"><a href="${href}">${title}</a></td>
                        <td style="width:10%"><a href="${href}"><abbr title="${typeTitle}">${typeAbbr}</abbr></a></td>
                        <td style="width:30%">
                                                            ${close}
                                                    </td>
                        <td style="width:20%">${org}</td>
                    </tr>`;
}

function indexPage(rows, { start = 1, total = rows.length, page = 1 } = {}) {
  const end = start + rows.length - 1;
  return `<html><body><h1>Current tenders</h1>
<table id="treetbl" width="100%" class="treetbl"><tbody>
<tr class="hdrow"><td><b>RFx ID</b></td></tr>
<tr class="tender"><td colspan="6"></td></tr>
${rows.map(indexRow).join('\n')}
</tbody></table>
<span class="paging">
${start} - ${end} of ${total}
${end < total ? `<a  href="ExternalIndex.htm?page=${page + 1}&orderBy=date"><img id="next-active" src="/ext/default/img/gets/next_active.png"></a>` : ''}
</span></body></html>`;
}

function detailPage({ id, open, categories, overview }) {
  return `<html><body><table class="tender-details-info-tbl">
<tr>
<td class="label-cell">RFx ID&nbsp;:</td>
<td>${id}</td>
</tr>
<tr>
<td class="label-cell">Open Date&nbsp;:</td>
<td>
${open}
</td>
</tr>
<tr>
<td class="label-cell">
Categories&nbsp;:
</td>
<td>
<ul style="margin-left:0em !important;margin-top:0em !important;">
${categories.map((category) => `<li>${category}</li>`).join('\n')}
</ul>
</td>
</tr>
</table>
<div class="detail-divider">
<span class="legend">Overview</span>
</div>
<p>${overview}</p>
<form action="TendererLogin.auth" method="get"></form>
</body></html>`;
}

const ACC = {
  id: '35331516', agency: 'ACC', ref: 'MCON 2026',
  title: 'Future delivery options for ACC&#39;s Medical Consumables',
  typeTitle: 'Request for Information (Market research)', typeAbbr: 'RFI',
  close: '3:00 PM 27 Nov 2026 (Pacific/Auckland UTC+13:00)', org: 'Accident Compensation Corporation',
};
const ORION = {
  id: '35370310', agency: 'Orion', ref: '[None]',
  title: 'Strategic Network Design &amp; Engineering Services',
  typeTitle: 'Request for Proposals', typeAbbr: 'RFP',
  close: '4:00 PM 27 Nov 2026 (Pacific/Auckland UTC+13:00)', org: 'Orion New Zealand Limited',
};
const NZDF = {
  id: '35389657', agency: 'NZDF', ref: 'NZDF-1',
  title: 'Base maintenance panel',
  typeTitle: 'Registration of Interest', typeAbbr: 'ROI',
  close: '12:00 PM 3 Feb 2027 (Pacific/Auckland UTC+13:00)', org: 'New Zealand Defence Force',
};

function wafBlock() {
  return Object.assign(new Error('HTTP 403'), { status: 403, nonRetryable: true });
}

function fakeGets(pages, { rss = async () => { throw wafBlock(); } } = {}) {
  const requested = [];
  const fetchTextFn = async (url) => {
    requested.push(url);
    if (url === RSS_URL) return rss();
    if (Object.hasOwn(pages, url)) return pages[url];
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchTextFn, requested };
}

const detailUrl = (row) => `https://www.gets.govt.nz/${row.agency}/ExternalTenderDetails.htm?id=${row.id}`;

test('GETS falls back to the official current-tenders index when the RSS feed is blocked', async () => {
  const { fetchTextFn, requested } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([ACC, ORION], { total: 3 }),
    'https://www.gets.govt.nz/ExternalIndex.htm?page=2&orderBy=date': indexPage([NZDF], { start: 3, total: 3, page: 2 }),
    [detailUrl(ACC)]: detailPage({
      id: ACC.id, open: 'Tuesday, 27 October 2026 2:00 PM (Pacific/Auckland UTC+13:00)',
      categories: ['42000000 - Medical Equipment and Accessories and Supplies', '43230000 - Software'],
      overview: 'ACC is seeking information.<br>We welcome insights.',
    }),
    [detailUrl(ORION)]: detailPage({
      id: ORION.id, open: 'Monday, 9 November 2026 9:00 AM (Pacific/Auckland UTC+13:00)',
      categories: ['81100000 - Professional engineering services'], overview: 'Engineering panel.',
    }),
    [detailUrl(NZDF)]: detailPage({
      id: NZDF.id, open: 'Friday, 20 November 2026 5:30 PM (Pacific/Auckland UTC+13:00)',
      categories: [], overview: 'Maintenance.',
    }),
  });

  const result = await fetchGets({ now: NOW, fetchTextFn });

  assert.equal(requested[0], RSS_URL, 'RSS stays the primary source');
  assert.equal(result.status.state, 'ok');
  assert.equal(result.status.recordCount, 3);
  assert.deepEqual(result.records.map((record) => record.id), ['gets:35389657', 'gets:35370310', 'gets:35331516'], 'newest RFx IDs first');

  const [nzdf, orion, acc] = result.records;
  assert.equal(acc.officialUrl, detailUrl(ACC));
  assert.equal(acc.title, "Future delivery options for ACC's Medical Consumables");
  assert.equal(acc.buyer, 'Accident Compensation Corporation');
  assert.equal(acc.noticeType, 'Request for Information (Market research)');
  assert.equal(acc.countryCode, 'NZ');
  assert.equal(acc.region, 'Oceania');
  assert.equal(acc.deadline, '2026-11-27T02:00:00.000Z', 'close time honours the UTC+13:00 offset in the page');
  assert.equal(acc.publishedAt, '2026-10-27T01:00:00.000Z', 'open date comes from the detail page');
  assert.deepEqual(acc.categoryCodes, ['42000000 - Medical Equipment and Accessories and Supplies', '43230000 - Software']);
  assert.equal(acc.description, 'ACC is seeking information. We welcome insights.');

  assert.equal(orion.title, 'Strategic Network Design & Engineering Services');
  assert.equal(orion.publishedAt, '2026-11-08T20:00:00.000Z', 'AM hours and single-digit days parse');
  assert.equal(nzdf.deadline, '2027-02-02T23:00:00.000Z');
  assert.equal(nzdf.publishedAt, '2026-11-20T04:30:00.000Z', 'PM hours add twelve');
});

test('GETS keeps the RSS feed when it answers and never reads the index', async () => {
  const xml = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
    <title>Cloud platform</title><link>https://www.gets.govt.nz/MBIE/ExternalTenderDetails.htm?id=34394762</link>
    <description>&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;Close date: &lt;/td&gt;&lt;td&gt;Monday, 14 December 2026 4:00 PM +13:00&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</description>
    <pubDate>Fri, 20 Nov 2026 00:00:00 GMT</pubDate><dc:creator>MBIE</dc:creator>
  </item></channel></rss>`;
  const { fetchTextFn, requested } = fakeGets({}, { rss: async () => xml });

  const result = await fetchGets({ now: NOW, fetchTextFn });

  assert.deepEqual(requested, [RSS_URL]);
  assert.deepEqual(result.records.map((record) => record.id), ['gets:34394762']);
});

test('GETS index fallback rejects a page with no tender rows instead of reporting a healthy empty source', async () => {
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': '<html><body><h1>Maintenance</h1></body></html>',
  });

  await assert.rejects(() => fetchGets({ now: NOW, fetchTextFn }), /index page 1 contains no tender rows/);
});

test('GETS index fallback rejects a row whose close date drifted out of the known format', async () => {
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([{ ...ACC, close: 'Closing soon' }]),
  });

  await assert.rejects(() => fetchGets({ now: NOW, fetchTextFn }), /index row 35331516 drifted/);
});

test('GETS index fallback rejects a detail page that belongs to another notice', async () => {
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([ACC]),
    [detailUrl(ACC)]: detailPage({ id: '1', open: 'Tuesday, 27 October 2026 2:00 PM (Pacific/Auckland UTC+13:00)', categories: [], overview: '' }),
  });

  await assert.rejects(() => fetchGets({ now: NOW, fetchTextFn }), /detail page for 35331516 does not describe that notice/);
});

test('GETS index fallback reads every page and keeps the newest notices, not the soonest-closing ones', async () => {
  const row = (n) => ({ ...ORION, id: String(35000000 + n), agency: 'GETS', close: `4:00 PM ${(n % 28) + 1} Dec 2026 (Pacific/Auckland UTC+13:00)` });
  const pages = {};
  for (const [page, start] of [[1, 1], [2, 61], [3, 121]]) {
    const rows = Array.from({ length: 60 }, (_, index) => row(start + index));
    pages[`https://www.gets.govt.nz/ExternalIndex.htm?page=${page}&orderBy=date`] = indexPage(rows, { start, total: 180, page });
    for (const entry of rows) {
      pages[detailUrl(entry)] = detailPage({ id: entry.id, open: 'Monday, 9 November 2026 9:00 AM (Pacific/Auckland UTC+13:00)', categories: [], overview: 'Panel.' });
    }
  }
  const { fetchTextFn, requested } = fakeGets(pages);

  const result = await fetchGets({ now: NOW, fetchTextFn });

  assert.ok(requested.includes('https://www.gets.govt.nz/ExternalIndex.htm?page=3&orderBy=date'), 'paging continues past the record cap');
  assert.equal(result.records.length, 100);
  assert.equal(result.records[0].id, 'gets:35000180');
  assert.equal(result.records.at(-1).id, 'gets:35000081');
  assert.equal(requested.filter((url) => url.includes('ExternalTenderDetails')).length, 100, 'detail pages are read only for kept notices');
});

const OPEN = 'Tuesday, 27 October 2026 2:00 PM (Pacific/Auckland UTC+13:00)';

test('GETS index fallback rejects an impossible calendar date instead of rolling it into the next month', async () => {
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([{ ...ACC, close: '3:00 PM 31 Feb 2027 (Pacific/Auckland UTC+13:00)' }]),
  });

  await assert.rejects(() => fetchGets({ now: NOW, fetchTextFn }), /index row 35331516 drifted/);
});

test('GETS index fallback rejects a detail page whose open date no longer parses', async () => {
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([ACC]),
    [detailUrl(ACC)]: detailPage({ id: ACC.id, open: 'To be confirmed', categories: [], overview: 'x' }),
  });

  await assert.rejects(() => fetchGets({ now: NOW, fetchTextFn }), /open date for 35331516/);
});

test('GETS index fallback follows the stated total when a page drops its next link', async () => {
  const page1 = indexPage([ACC, ORION], { total: 3 }).replace(/<a {2}href="ExternalIndex\.htm\?page=2[^\n]*/, '');
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': page1,
    'https://www.gets.govt.nz/ExternalIndex.htm?page=2&orderBy=date': indexPage([NZDF], { start: 3, total: 3, page: 2 }),
    [detailUrl(ACC)]: detailPage({ id: ACC.id, open: OPEN, categories: [], overview: 'x' }),
    [detailUrl(ORION)]: detailPage({ id: ORION.id, open: OPEN, categories: [], overview: 'x' }),
    [detailUrl(NZDF)]: detailPage({ id: NZDF.id, open: OPEN, categories: [], overview: 'x' }),
  });

  const result = await fetchGets({ now: NOW, fetchTextFn });

  assert.equal(result.records.length, 3, 'paging follows the stated total, not the next link');
});

test('GETS index fallback rejects a page whose row count disagrees with its stated range', async () => {
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([ACC], { total: 1 }).replace('1 - 1 of 1', '1 - 2 of 2'),
  });

  await assert.rejects(() => fetchGets({ now: NOW, fetchTextFn }), /index page 1 range/);
});

test('GETS index fallback still reads a row that gains an attribute before its id', async () => {
  const page = indexPage([ACC]).replace('<tr id="tender-', '<tr data-row="1" id="tender-');
  const { fetchTextFn } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': page,
    [detailUrl(ACC)]: detailPage({ id: ACC.id, open: OPEN, categories: [], overview: 'x' }),
  });

  const result = await fetchGets({ now: NOW, fetchTextFn });

  assert.deepEqual(result.records.map((record) => record.id), ['gets:35331516']);
});

test('GETS passes one absolute deadline to every read, RSS included', async () => {
  const deadlines = new Set();
  const { fetchTextFn: inner } = fakeGets({
    'https://www.gets.govt.nz/ExternalIndex.htm?page=1&orderBy=date': indexPage([ACC]),
    [detailUrl(ACC)]: detailPage({ id: ACC.id, open: OPEN, categories: [], overview: 'x' }),
  });
  const fetchTextFn = async (url, options = {}) => {
    deadlines.add(options.deadlineAt);
    return inner(url, options);
  };

  await fetchGets({ now: NOW, fetchTextFn });

  assert.equal(deadlines.size, 1);
  const [deadlineAt] = deadlines;
  assert.ok(Number.isFinite(deadlineAt) && deadlineAt - Date.now() < 140_000, 'deadline fits inside the 140s seed fetch phase');
});

test('a read past its deadline fails without a request, and each attempt is clamped to the time left', async () => {
  const calls = [];
  const transport = async (_url, options) => {
    calls.push(options.timeoutMs);
    return new Response('busy', { status: 503, headers: { 'Retry-After': '30' } });
  };

  await assert.rejects(() => __testing__.fetchResponse('https://www.gets.govt.nz/x', { deadlineAt: Date.now() - 1 }, transport), /budget/);
  assert.equal(calls.length, 0);

  await assert.rejects(() => __testing__.fetchResponse('https://www.gets.govt.nz/x', { deadlineAt: Date.now() + 5_000, timeoutMs: 15_000, maxRetries: 2 }, transport), /HTTP 503/);
  assert.equal(calls.length, 1, 'a Retry-After longer than the time left is not slept on');
  assert.ok(calls[0] <= 5_000);
});
