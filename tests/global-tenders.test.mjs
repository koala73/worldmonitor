import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAutomationFit,
  normalizeSamOpportunity,
  normalizeTedNotice,
  normalizeContractsFinderRelease,
  normalizeWorldBankNotice,
  dedupeTenders,
  isOpenOpportunity,
  buildSnapshot,
} from '../scripts/_global-tenders.mjs';

test('normalizes official notices with stable provenance and typed money', () => {
  const tender = normalizeSamOpportunity({
    noticeId: 'abc-123',
    solicitationNumber: 'RFP-42',
    title: 'Cybersecurity automation platform',
    fullParentPathName: 'Department of Example',
    postedDate: '2026-07-10',
    responseDeadLine: '2026-07-20T15:00:00Z',
    type: 'Solicitation',
    naicsCode: '541512',
    uiLink: 'https://sam.gov/opp/abc-123/view',
  });

  assert.equal(tender.money, undefined);
  assert.equal(tender.id, 'sam:abc-123');
  assert.equal(tender.sourceNoticeId, 'abc-123');
  assert.equal(tender.countryCode, 'US');
  assert.equal(tender.officialUrl, 'https://sam.gov/opp/abc-123/view');
  assert.equal(tender.automationFit.level, 'medium');
  assert.ok(tender.automationFit.matchReasons.includes('cybersecurity'));
  assert.equal(tender.participationMode, 'unknown');
});

test('normalizes TED and World Bank records without inventing unavailable values', () => {
  const ted = normalizeTedNotice({
    'notice-identifier': '123-2026',
    'title-lot': 'Data platform',
    'publication-date': '2026-07-10',
    'deadline-receipt-tender-date-lot': '2026-07-18T12:00:00Z',
    'organisation-name-buyer': 'City of Paris',
    'organisation-country-buyer': 'FR',
    'main-classification-proc': ['72200000'],
  });
  const wb = normalizeWorldBankNotice({
    id: 'WB-99', bid_description: 'Climate information system', country_code: 'KE',
    project_name: 'Climate information modernization', noticedate: '2026-07-09', submission_date: '2026-07-29',
    procurement_method_code: 'QCBS', notice_status: 'Published', borrower: 'Kenya Ministry of Environment',
  });

  assert.equal(ted.id, 'ted:123-2026');
  assert.equal(ted.money, undefined);
  assert.equal(ted.buyer, 'City of Paris');
  assert.equal(wb.id, 'world-bank:WB-99');
  assert.equal(wb.countryCode, 'KE');
  assert.equal(wb.money, undefined);
  assert.equal(wb.description, 'Climate information modernization');
  assert.equal(wb.buyer, 'Kenya Ministry of Environment');
  assert.equal(wb.status, 'published');
  assert.equal(wb.officialUrl, 'https://projects.worldbank.org/en/projects-operations/procurement/notices/notice-detail/WB-99');
});

test('normalizes a UK OCDS tender with official provenance and its typed value', () => {
  const tender = normalizeContractsFinderRelease({
    id: 'ocds-213czf-uk-1',
    date: '2026-07-10T00:00:00Z',
    buyer: { name: 'Example Council' },
    tender: {
      title: 'Cloud security platform',
      status: 'active',
      tenderPeriod: { endDate: '2026-07-28T12:00:00Z' },
      value: { amount: 125000, currency: 'GBP' },
      classification: { id: '48730000' },
    },
  });

  assert.equal(tender.id, 'contracts-finder:ocds-213czf-uk-1');
  assert.equal(tender.officialUrl, 'https://www.contractsfinder.service.gov.uk/Notice/ocds-213czf-uk-1');
  assert.deepEqual(tender.money, { amount: 125000, currency: 'GBP' });
  assert.equal(tender.countryCode, 'GB');
});

test('deduplicates source notice revisions and reports partial source failure explicitly', () => {
  const older = normalizeSamOpportunity({ noticeId: 'same', title: 'Older', postedDate: '2026-07-01', uiLink: 'https://sam.gov/a' });
  const newer = { ...older, title: 'Newer', updatedAt: '2026-07-11T00:00:00Z' };
  const snapshot = buildSnapshot({
    results: [older, newer],
    sourceStatuses: [
      { source: 'sam', state: 'ok', recordCount: 2 },
      { source: 'ted', state: 'error', recordCount: 0, error: 'timeout' },
    ],
    fetchedAt: 1_784_000_000_000,
  });

  assert.deepEqual(dedupeTenders([older, newer]).map((item) => item.title), ['Newer']);
  assert.equal(snapshot.availability, 'partial');
  assert.equal(snapshot.dataAvailable, true);
  assert.equal(snapshot.tenders.length, 1);
  assert.equal(snapshot.sourceStatuses[1].state, 'error');
});

test('keeps historical awards and records with unknown closing dates out of the open-opportunity feed', () => {
  const future = normalizeSamOpportunity({ noticeId: 'future', title: 'Current opportunity', responseDeadLine: '2026-07-30T00:00:00Z', uiLink: 'https://sam.gov/future' });
  const award = { ...future, status: 'awarded' };
  const expired = { ...future, deadline: '2026-07-01T00:00:00.000Z' };
  const unknownDeadline = { ...future, deadline: '' };

  assert.equal(isOpenOpportunity(future, Date.parse('2026-07-13T00:00:00Z')), true);
  assert.equal(isOpenOpportunity(award, Date.parse('2026-07-13T00:00:00Z')), false);
  assert.equal(isOpenOpportunity(expired, Date.parse('2026-07-13T00:00:00Z')), false);
  assert.equal(isOpenOpportunity(unknownDeadline, Date.parse('2026-07-13T00:00:00Z')), false);
});

test('automation relevance requires source text evidence and never infers eligibility', () => {
  const fit = classifyAutomationFit({ title: 'Managed services', description: '', categories: [] });
  assert.equal(fit.level, 'none');
  assert.deepEqual(fit.matchReasons, []);
  assert.deepEqual(fit.evidence, []);
});
