import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPakistanEpads, fetchGeorgia, fetchArmenia, fetchPakistan } from '../scripts/_global-tender-feeds.mjs';
import { tracksTenderFreshness, safeOfficialUrl } from '../scripts/_global-tenders.mjs';
import { createTenderReceipt, observeTenderSource, observeTenderRequest } from '../scripts/_global-tender-receipts.mjs';
import { __testing__ as seeder } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const epads = (closing = 'Tuesday, November 10, 2026 10:30 AM') => `<table><thead><th>Procurement Title</th></thead><tbody class="table-border-bottom-0"><tr>
  <td>1</td><td><a href="/opportunities/federal/procurements/123"><span title="Cloud &amp; data platform">Cloud...</span></a><span title="Public Agency">Public Agency</span></td>
  <td>Published On: Friday, October 30, 2026 12:00 AM Closing On: ${closing}</td><td>Supplies Single Stage</td><td>View</td>
  </tr></tbody></table>`;
const georgiaList = `<table id="list_apps_by_subject"><tr onclick="ShowApp(123,'',0,'abc123')"><td>1</td></tr></table>`;
const georgia = (fields = {}) => `<div id="app_main"><table>${Object.entries({
  'Announcment number': 'NAT26000123', 'Procurement proceeding status': 'Tender announced',
  'Procuring entities': 'Public Agency', 'Procuring category': '45200000 - Infrastructure works',
  'Procurement announcment date': '30.10.2026 12:00', 'Deadline for bid submission': '10.11.2026 14:00',
  'Estimated value of procurement': '160`000.00 GEL', 'Procurement type': 'NAT', ...fields,
}).map(([key, value]) => `<tr><td>${key}</td><td>${value}</td></tr>`).join('')}</table><div class="blabla">Water infrastructure works</div></div>`;
const armeniaList = `<h3>Search results</h3>CfT Title:<input name="status" value="cft.status.tender.submission"><a href="/epps/cft/prepareViewCfTWS.do?resourceId=456">Water infrastructure works</a>`;
const armenia = (fields = {}) => `<dl>${Object.entries({
  'CfT Id': 'AM-123', 'Title': 'Տեղական վերնագիր', 'Title (EN)': 'Water infrastructure works',
  'Name of Contracting Authority': 'Public Agency', 'CPV Codes': '45200000 - Infrastructure works',
  'Date of Publication/Invitation': '30/10/2026 12:00',
  'Time-limit for receipt of tenders or requests to participate': '10/11/2026 10:00',
  'Date of Awarding': '', 'Estimated value (AMD)': '', Procedure: 'Open', ...fields,
}).map(([key, value]) => `<dt>${key}:</dt><dd>${value}</dd>`).join('')}</dl>`;

function sessionTransport(list, detail) {
  const requests = [];
  const fetchResponseFn = async (url, options) => {
    const target = new URL(url);
    requests.push({ url: target, options });
    assert.equal(options.redirect, 'manual');
    if (requests.length === 1) return new Response('<html>Home</html>', { headers: { 'Set-Cookie': 'anonymous=one; Path=/; HttpOnly' } });
    assert.equal(options.headers.Cookie, 'anonymous=one');
    assert.equal(options.maxRetries, 0);
    assert.equal(options.retry429, false);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 75_000);
    if (target.pathname.endsWith('changeLanguage.do')) return new Response('<html lang="en"></html>');
    if (target.searchParams.get('action') === 'app_main' || target.pathname.includes('prepareViewCfTWS')) return new Response(detail);
    return new Response(list);
  };
  return { requests, fetchResponseFn };
}

test('EPADS projects complete title, buyer and actual Pakistan timestamps from one public list', async () => {
  let count = 0;
  const result = await fetchPakistanEpads({ now: NOW, fetchTextFn: async (url, options) => {
    count++;
    assert.equal(url, 'https://epads.gov.pk/');
    assert.equal(options.maxRetries, 0);
    return epads() + '<script>const privateContact = "private-phone";</script>';
  } });
  assert.equal(count, 1);
  assert.equal(result.records[0].title, 'Cloud & data platform');
  assert.equal(result.records[0].buyer, 'Public Agency');
  assert.equal(result.records[0].countryCode, 'PK');
  assert.equal(result.records[0].deadline, '2026-11-10T05:30:00.000Z');
  assert.equal(result.records[0].publishedAt, '2026-10-29T19:00:00.000Z');
  assert.equal(result.records[0].officialUrl, 'https://epads.gov.pk/opportunities/federal/procurements/123');
  assert.doesNotMatch(JSON.stringify(result), /private-phone|anonymous/);
});

test('EPADS resolves countdown deadlines from the official detail timer without estimating them', async () => {
  const result = await fetchPakistanEpads({ now: NOW, fetchTextFn: async (url) => url === 'https://epads.gov.pk/'
    ? epads('12h 20m Left') : '<script>showBiddingTimer("1794299400", "0");</script>' });
  assert.equal(result.records[0].deadline, new Date(1794299400 * 1000).toISOString());
  await assert.rejects(fetchPakistanEpads({ now: NOW, fetchTextFn: async (url) => url === 'https://epads.gov.pk/'
    ? epads('12h 20m Left') : '<html>Login</html>' }));
});

test('EPADS excludes expired tenders and rejects malformed or missing closing times', async () => {
  const expired = await fetchPakistanEpads({ now: NOW, fetchTextFn: async () => epads('Friday, October 30, 2026 10:30 AM') });
  assert.deepEqual(expired.records, []);
  for (const closing of ['November 10, 2026', 'November 31, 2026 10:30 AM', 'November 10, 2026 10:99 AM', 'November 10, 2026 13:00 PM']) {
    await assert.rejects(fetchPakistanEpads({ now: NOW, fetchTextFn: async () => epads(closing) }));
  }
  await assert.rejects(fetchPakistanEpads({ now: NOW, fetchTextFn: async () => '<html>Login</html>' }));
});

test('Georgia uses an anonymous session and detail closing time rather than the list date', async () => {
  const transport = sessionTransport(georgiaList, georgia());
  const result = await fetchGeorgia({ now: NOW, ...transport });
  assert.equal(transport.requests.length, 3);
  assert.equal(transport.requests[1].url.searchParams.get('app_status'), '10');
  assert.equal(result.records[0].countryCode, 'GE');
  assert.equal(result.records[0].deadline, '2026-11-10T10:00:00.000Z');
  assert.equal(result.records[0].title, 'Water infrastructure works');
  assert.deepEqual(result.records[0].money, { amount: 160000, currency: 'GEL' });
  assert.equal(result.records[0].officialUrl, 'https://tenders.procurement.gov.ge/public/?go=123&lang=en');
  assert.deepEqual(result.records[0].categoryCodes, ['45200000']);
  assert.doesNotMatch(JSON.stringify(result), /abc123|anonymous/);
});

test('publisher sessions follow bounded same-origin redirects without requesting other origins', async () => {
  for (const destination of ['http://127.0.0.1/private', 'http://169.254.169.254/', 'https://attacker.example/']) {
    let calls = 0;
    await assert.rejects(fetchGeorgia({ now: NOW, fetchResponseFn: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: destination } });
    } }), /publisher origin/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(fetchGeorgia({ now: NOW, fetchResponseFn: async () => {
    calls++;
    return new Response('', { status: 302, headers: { Location: '?loop=1' } });
  } }), /redirect limit/);
  assert.equal(calls, 4);
  const transport = sessionTransport(armeniaList, armenia());
  const result = await fetchArmenia({ now: NOW, fetchResponseFn: async (url, options) => {
    if (new URL(url).pathname.endsWith('changeLanguage.do')) {
      assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { Location: '/epps/english.do' } });
    }
    if (new URL(url).pathname.endsWith('english.do')) return new Response('<html lang="en"></html>');
    return transport.fetchResponseFn(url, options);
  } });
  assert.equal(result.records.length, 1);
});

test('the seed transport exposes redirects only to explicit manual callers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { Location: '/home' } });
  });
  const response = await seeder.fetchResponse('https://www.armeps.am/epps/changeLanguage.do', { redirect: 'manual', maxRetries: 0 });
  assert.equal(response.status, 302);
});

test('Georgia excludes later-stage and cancelled notices and rejects incomplete detail responses', async () => {
  for (const status of ['Cancelled', 'Contract awarded', 'Bidding completed']) {
    const result = await fetchGeorgia({ now: NOW, ...sessionTransport(georgiaList, georgia({ 'Procurement proceeding status': status })) });
    assert.deepEqual(result.records, []);
  }
  await assert.rejects(fetchGeorgia({ now: NOW, ...sessionTransport(georgiaList, georgia({ 'Deadline for bid submission': '10.11.2026' })) }));
  await assert.rejects(fetchGeorgia({ now: NOW, ...sessionTransport(georgiaList, '<html>Login</html>') }));
});

test('Armenia requests the submission-stage search and keeps absent estimated value absent', async () => {
  const transport = sessionTransport(armeniaList, armenia());
  const result = await fetchArmenia({ now: NOW, ...transport });
  assert.equal(transport.requests.length, 4);
  const search = transport.requests[2];
  assert.equal(search.options.method, 'POST');
  assert.equal(new URLSearchParams(search.options.body).get('status'), 'cft.status.tender.submission');
  assert.equal(result.records[0].deadline, '2026-11-10T06:00:00.000Z');
  assert.equal(result.records[0].money, undefined);
  assert.equal(result.records[0].countryCode, 'AM');
  assert.deepEqual(result.records[0].categoryCodes, ['45200000']);
});

test('Armenia rejects ignored active filters and incomplete deadlines and excludes awarded notices', async () => {
  await assert.rejects(fetchArmenia({ now: NOW, ...sessionTransport(armeniaList.replace('cft.status.tender.submission', 'cft.status.award'), armenia()) }));
  await assert.rejects(fetchArmenia({ now: NOW, ...sessionTransport(armeniaList, armenia({ 'Time-limit for receipt of tenders or requests to participate': '' })) }));
  const result = await fetchArmenia({ now: NOW, ...sessionTransport(armeniaList, armenia({ 'Date of Awarding': '31/10/2026 12:00' })) });
  assert.deepEqual(result.records, []);
});

test('new portals accept verified empty lists, reject shells and track their own freshness', async () => {
  const emptyEpads = '<th>Procurement Title</th><tbody class="table-border-bottom-0">No procurements found</tbody>';
  const cases = [
    ['pakistan-epads', fetchPakistanEpads, emptyEpads],
    ['georgia-spa', fetchGeorgia, '<table id="list_apps_by_subject"></table>0 Record(s)'],
    ['armenia-armeps', fetchArmenia, 'Search results CfT Title:<input name="status" value="cft.status.tender.submission">0 results in total'],
  ];
  for (const [source, fetchSource, list] of cases) {
    const result = await fetchSource({ now: NOW, fetchTextFn: async () => list, ...sessionTransport(list, '') });
    assert.deepEqual(result.records, []);
    assert.equal(result.status.state, 'ok');
    assert.equal(tracksTenderFreshness(source), true);
    assert.equal(safeOfficialUrl('https://attacker.example/tender', source), '');
    await assert.rejects(fetchSource({ now: NOW, fetchTextFn: async () => '<html>Login</html>', ...sessionTransport('<html>Login</html>', '') }));
  }
});

test('session requests preserve source receipts without persisting cookies or query keys', async () => {
  const receipt = createTenderReceipt(NOW);
  const transport = sessionTransport(georgiaList, georgia());
  await observeTenderSource('georgia-spa', fetchGeorgia, { now: NOW,
    fetchResponseFn: (url, options) => observeTenderRequest(url, options, transport.fetchResponseFn),
  }, receipt);
  assert.equal(receipt.sources[0].requestCount, 3);
  assert.ok(receipt.sources[0].requests.every((request) => request.phase === 'complete'));
  assert.doesNotMatch(JSON.stringify(receipt), /anonymous|abc123|Cookie/);
});

test('PPRA projects its organization from the matching expandable row for EPADS deduplication', async () => {
  const html = `<tr class="cb-rt-main"><td><button data-id="1"></button></td>
    <td data-label="Tender Details"><strong>Cloud platform</strong></td><td data-label="Status">Published</td>
    <td data-label="Closing">Nov 10, 2026 10:30 AM</td><td data-label="Actions"><a href="/public/tenders/tender-details/TS1">View</a></td></tr>
    <tr class="cb-rt-detail" id="cb-rt-detail-1"><td><span>Organization</span><span><strong><i></i>Public Agency</strong><small>private-contact</small></span></td></tr>`;
  const result = await fetchPakistan({ now: NOW, fetchTextFn: async () => html });
  assert.equal(result.records[0].buyer, 'Public Agency');
  assert.doesNotMatch(JSON.stringify(result), /private-contact/);
});
