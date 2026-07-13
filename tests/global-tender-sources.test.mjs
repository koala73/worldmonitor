import test from 'node:test';
import assert from 'node:assert/strict';

import { declareRecords, fetchCanadaBuys, fetchContractsFinder, fetchGets, fetchSam, fetchTed, fetchWorldBank } from '../scripts/seed-global-tenders.mjs';

const NOW = Date.parse('2026-07-13T12:00:00Z');

test('seeder exports its canonical record counter for contract conformance', () => {
  assert.equal(declareRecords({ tenders: [{ id: 'one' }, { id: 'two' }] }), 2);
  assert.equal(declareRecords({ tenders: [] }), 0);
  assert.equal(declareRecords(null), 0);
});

test('SAM adapter sends the documented production endpoint and MM/dd/yyyy dates', async () => {
  let requested;
  await fetchSam({
    apiKey: 'test-key', now: NOW,
    fetchJsonFn: async (url) => { requested = new URL(url); return { opportunitiesData: [] }; },
  });

  assert.equal(requested.origin + requested.pathname, 'https://api.sam.gov/opportunities/v2/search');
  assert.equal(requested.searchParams.get('postedFrom'), '06/29/2026');
  assert.equal(requested.searchParams.get('postedTo'), '07/13/2026');
});

test('adapters reject drifted success payloads instead of erasing last-good data as valid empty', async () => {
  await assert.rejects(() => fetchSam({ apiKey: 'test-key', now: NOW, fetchJsonFn: async () => ({ message: 'changed' }) }), /opportunitiesData/);
  await assert.rejects(() => fetchTed({ now: NOW, fetchJsonFn: async () => ({ message: 'changed' }) }), /notices/);
  await assert.rejects(() => fetchContractsFinder({ now: NOW, fetchJsonFn: async () => ({ message: 'changed' }) }), /releases/);
  await assert.rejects(() => fetchWorldBank({ now: NOW, fetchJsonFn: async () => ({ message: 'changed' }) }), /procnotices/);
});

test('TED adapter executes a bounded active-notice query with supported field identifiers', async () => {
  let request;
  await fetchTed({
    now: NOW,
    fetchJsonFn: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { notices: [] }; },
  });

  assert.equal(request.url, 'https://api.ted.europa.eu/v3/notices/search');
  assert.match(request.body.query, /^deadline-receipt-tender-date-lot >= 20260713 SORT BY publication-date DESC$/);
  assert.equal(request.body.scope, 'ACTIVE');
  assert.equal(request.body.onlyLatestVersions, true);
  assert.notEqual(request.body.checkQuerySyntax, true, 'syntax-check mode does not execute the search');
  assert.ok(request.body.fields.includes('publication-number'));
  assert.ok(request.body.fields.includes('notice-type'));
  assert.ok(!request.body.fields.includes('notice-type (form-type)'));
});

test('Contracts Finder adapter requests current tender-stage OCDS releases', async () => {
  let requested;
  const result = await fetchContractsFinder({
    now: NOW,
    fetchJsonFn: async (url) => {
      requested = new URL(url);
      return { releases: [{
        id: 'ocds-test', date: '2026-07-10T00:00:00Z',
        url: 'https://www.contractsfinder.service.gov.uk/Notice/ocds-test',
        buyer: { name: 'Department for Test' },
        tender: { title: 'Network services', status: 'active', tenderPeriod: { endDate: '2026-08-01T00:00:00Z' } },
      }] };
    },
  });

  assert.equal(requested.origin + requested.pathname, 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search');
  assert.equal(requested.searchParams.get('stages'), 'tender');
  assert.equal(result.records[0].countryCode, 'GB');
  assert.equal(result.records[0].region, 'Europe');
});

test('World Bank adapter uses the current v2 opportunity fields', async () => {
  let requested;
  const result = await fetchWorldBank({
    now: NOW,
    fetchJsonFn: async (url) => {
      requested = new URL(url);
      return { procnotices: [{
        id: 'OP1', notice_type: 'Invitation for Bids', submission_deadline_date: '2026-08-01T00:00:00Z',
        project_ctry_code: 'IN', project_name: 'Connectivity', bid_description: 'Network services',
      }] };
    },
  });

  assert.equal(requested.pathname, '/api/v2/procnotices');
  assert.match(requested.searchParams.get('fl'), /submission_deadline_date/);
  assert.equal(requested.searchParams.get('deadline_strdate'), '2026-07-13');
  assert.equal(result.records[0].countryCode, 'IN');
  assert.equal(result.records[0].deadline, '2026-08-01T00:00:00.000Z');
});

test('GETS adapter parses the official RSS feed into Oceania opportunities', async () => {
  const xml = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
    <title>Cloud platform</title><link>https://www.gets.govt.nz/MBIE/ExternalTenderDetails.htm?id=34394762</link>
    <description>&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;RFx ID: &lt;/b&gt;&lt;/td&gt;&lt;td&gt;34394762&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;Organisation: &lt;/b&gt;&lt;/td&gt;&lt;td&gt;MBIE&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;Close date: &lt;/td&gt;&lt;td&gt;Monday, 17 August 2026 4:00 PM +12:00&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;&lt;b&gt;Overview: &lt;/b&gt;&lt;/td&gt;&lt;td&gt;Cloud services&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</description>
    <category>81110000 - Computer services</category><pubDate>Fri, 10 Jul 2026 00:00:00 GMT</pubDate><dc:creator>MBIE</dc:creator>
  </item></channel></rss>`;
  const result = await fetchGets({ now: NOW, fetchTextFn: async () => xml });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'gets:34394762');
  assert.equal(result.records[0].countryCode, 'NZ');
  assert.equal(result.records[0].region, 'Oceania');
  assert.equal(result.records[0].buyer, 'MBIE');
});

test('CanadaBuys adapter parses the official open-tender CSV as North America coverage', async () => {
  const csv = `"title-titre-eng","referenceNumber-numeroReference","publicationDate-datePublication","tenderClosingDate-appelOffresDateCloture","amendmentDate-dateModification","tenderStatus-appelOffresStatut-eng","unspsc","unspscDescription-eng","procurementCategory-categorieApprovisionnement","noticeType-avisType-eng","contractingEntityName-nomEntitContractante-eng","noticeURL-URLavis-eng","tenderDescription-descriptionAppelOffres-eng"\n"Cloud platform","MX-123","2026-07-10","2026-08-17T16:00:00","2026-07-11","Open","81110000","Computer services","SRV","Request for Proposal","Public Services and Procurement Canada","https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/pw-test","Official cloud services tender"`;
  const result = await fetchCanadaBuys({ now: NOW, fetchTextFn: async () => csv });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'canada-buys:MX-123');
  assert.equal(result.records[0].countryCode, 'CA');
  assert.equal(result.records[0].region, 'North America');
  assert.equal(result.records[0].buyer, 'Public Services and Procurement Canada');
});
