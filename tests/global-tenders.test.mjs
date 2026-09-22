import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAutomationFit,
  normalizeSamOpportunity,
  normalizeTedNotice,
  normalizeContractsFinderRelease,
  normalizeWorldBankNotice,
  normalizeGetsNotice,
  dedupeTenders,
  isOpenOpportunity,
  buildSnapshot,
  mergeTenderSourceResults,
  safeOfficialUrl,
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
    'publication-number': '123-2026',
    'title-lot': { fra: ['Plateforme de donnees'], eng: ['Data platform'] },
    'publication-date': '2026-07-10+02:00',
    'deadline-receipt-tender-date-lot': ['2026-07-18+02:00', '2026-07-20+02:00'],
    'organisation-name-buyer': { fra: ['Ville de Paris'], eng: ['City of Paris'] },
    'organisation-country-buyer': ['FRA'],
    'main-classification-proc': ['72200000'],
  });
  const wb = normalizeWorldBankNotice({
    id: 'WB-99', bid_description: 'Climate information system', project_ctry_code: 'KE',
    project_name: 'Climate information modernization', publication_date: '2026-07-09', submission_deadline_date: '2026-07-29',
    procurement_method_code: 'QCBS', notice_status: 'Published', borrower: 'Kenya Ministry of Environment',
  });

  assert.equal(ted.id, 'ted:123-2026');
  assert.equal(ted.money, undefined);
  assert.equal(ted.title, 'Data platform');
  assert.equal(ted.buyer, 'City of Paris');
  assert.equal(ted.countryCode, 'FR');
  assert.equal(ted.publishedAt, '2026-07-09T22:00:00.000Z');
  assert.equal(ted.deadline, '2026-07-19T22:00:00.000Z');
  assert.equal(wb.id, 'world-bank:WB-99');
  assert.equal(wb.countryCode, 'KE');
  assert.equal(wb.money, undefined);
  assert.equal(wb.description, 'Climate information modernization');
  assert.equal(wb.buyer, 'Kenya Ministry of Environment');
  assert.equal(wb.status, 'published');
  assert.equal(wb.officialUrl, 'https://projects.worldbank.org/en/projects-operations/procurement-detail/WB-99');
});

test('normalizes the official GETS feed as Oceania coverage', () => {
  const tender = normalizeGetsNotice({
    id: '34394762',
    title: 'Cloud security platform',
    link: 'https://www.gets.govt.nz/MBIE/ExternalTenderDetails.htm?id=34394762',
    buyer: 'Ministry of Business, Innovation and Employment',
    publishedAt: '2026-07-10T00:00:00Z',
    deadline: '2026-08-17T04:00:00Z',
    categories: ['81110000 - Computer services'],
    description: 'Official open tender',
  });

  assert.equal(tender.id, 'gets:34394762');
  assert.equal(tender.countryCode, 'NZ');
  assert.equal(tender.region, 'Oceania');
  assert.equal(tender.buyer, 'Ministry of Business, Innovation and Employment');
  assert.equal(tender.deadline, '2026-08-17T04:00:00.000Z');
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

test('distinguishes valid-empty and fully unavailable snapshots', () => {
  const validEmpty = buildSnapshot({
    results: [],
    sourceStatuses: [{ source: 'ted', state: 'ok', recordCount: 0, fetchedAt: '2026-07-13T12:00:00Z' }],
  });
  const unavailable = buildSnapshot({
    results: [],
    sourceStatuses: [{ source: 'ted', state: 'error', recordCount: 0, fetchedAt: '2026-07-13T12:00:00Z', error: 'down' }],
  });

  assert.equal(validEmpty.dataAvailable, true);
  assert.equal(validEmpty.availability, 'empty');
  assert.equal(unavailable.dataAvailable, false);
  assert.equal(unavailable.availability, 'unavailable');
});

test('preserves failed-source last-good records and exposes stale source state', () => {
  const previousTed = normalizeTedNotice({
    'notice-identifier': 'ted-last-good',
    'title-lot': 'Last good TED opportunity',
    'deadline-receipt-tender-date-lot': '2026-08-20T00:00:00Z',
  });
  const currentSam = normalizeSamOpportunity({
    noticeId: 'sam-current', title: 'Current SAM opportunity',
    responseDeadLine: '2026-08-21T00:00:00Z', uiLink: 'https://sam.gov/opp/sam-current/view',
  });
  const snapshot = mergeTenderSourceResults({
    settled: [
      { status: 'fulfilled', value: { records: [currentSam], status: { source: 'sam', state: 'ok', recordCount: 1, fetchedAt: '2026-07-13T12:00:00Z', lastSuccessfulAt: '2026-07-13T12:00:00Z', stale: false } } },
      { status: 'rejected', reason: new Error('timeout') },
    ],
    sourceNames: ['sam', 'ted'],
    previousSnapshot: {
      fetchedAt: Date.parse('2026-07-13T11:00:00Z'),
      tenders: [previousTed],
      sourceStatuses: [{ source: 'ted', state: 'ok', recordCount: 1, fetchedAt: '2026-07-13T11:00:00Z', lastSuccessfulAt: '2026-07-13T11:00:00Z', stale: false }],
    },
    attemptedAt: '2026-07-13T12:00:00Z',
  });

  assert.deepEqual(snapshot.tenders.map((item) => item.id).sort(), ['sam:sam-current', 'ted:ted-last-good']);
  assert.equal(snapshot.availability, 'partial');
  assert.deepEqual(snapshot.sourceStatuses[1], {
    source: 'ted', state: 'stale', recordCount: 1,
    fetchedAt: '2026-07-13T12:00:00Z', lastSuccessfulAt: '2026-07-13T11:00:00Z', stale: true, error: 'timeout',
  });
});

test('reports an all-source outage with retained data as stale', () => {
  const previous = normalizeSamOpportunity({
    noticeId: 'last-good', title: 'Last good opportunity',
    responseDeadLine: '2026-08-21T00:00:00Z', uiLink: 'https://sam.gov/opp/last-good/view',
  });
  const snapshot = mergeTenderSourceResults({
    settled: [{ status: 'rejected', reason: new Error('down') }],
    sourceNames: ['sam'],
    previousSnapshot: {
      fetchedAt: '2026-07-13T10:00:00Z', tenders: [previous],
      sourceStatuses: [{ source: 'sam', state: 'ok', recordCount: 1, fetchedAt: '2026-07-13T10:00:00Z' }],
    },
    attemptedAt: '2026-07-13T12:00:00Z',
  });

  assert.equal(snapshot.availability, 'stale');
  assert.equal(snapshot.dataAvailable, true);
  assert.equal(snapshot.fetchedAt, Date.parse('2026-07-13T10:00:00Z'));
  assert.equal(snapshot.sourceStatuses[0].state, 'stale');
});

test('does not retain a failed source record after its submission deadline', () => {
  const expired = normalizeSamOpportunity({
    noticeId: 'expired', title: 'Expired opportunity',
    responseDeadLine: '2026-07-13T11:00:00Z', uiLink: 'https://sam.gov/opp/expired/view',
  });
  const snapshot = mergeTenderSourceResults({
    settled: [{ status: 'rejected', reason: new Error('down') }],
    sourceNames: ['sam'],
    previousSnapshot: {
      fetchedAt: '2026-07-13T10:00:00Z', tenders: [expired],
      sourceStatuses: [{ source: 'sam', state: 'ok', recordCount: 1, fetchedAt: '2026-07-13T10:00:00Z' }],
    },
    attemptedAt: '2026-07-13T12:00:00Z',
  });

  assert.equal(snapshot.tenders.length, 0);
  assert.equal(snapshot.availability, 'unavailable');
  assert.equal(snapshot.sourceStatuses[0].state, 'error');
});

test('malformed previous freshness metadata cannot sink source-failure degradation', () => {
  const previous = normalizeSamOpportunity({
    noticeId: 'last-good', title: 'Last good opportunity',
    responseDeadLine: '2026-08-21T00:00:00Z', uiLink: 'https://sam.gov/opp/last-good/view',
  });
  const snapshot = mergeTenderSourceResults({
    settled: [{ status: 'rejected', reason: new Error('down') }],
    sourceNames: ['sam'],
    previousSnapshot: { fetchedAt: 'not-a-date', tenders: [previous], sourceStatuses: [] },
    attemptedAt: '2026-07-13T12:00:00Z',
  });

  assert.equal(snapshot.availability, 'stale');
  assert.equal(snapshot.sourceStatuses[0]?.lastSuccessfulAt, '');
});

test('official URLs are HTTPS and restricted to the source host', () => {
  assert.equal(safeOfficialUrl('https://sam.gov/opp/abc/view', 'sam'), 'https://sam.gov/opp/abc/view');
  assert.equal(safeOfficialUrl('http://sam.gov/opp/abc/view', 'sam'), '');
  assert.equal(safeOfficialUrl('https://attacker.example/notice', 'sam'), '');
  assert.equal(safeOfficialUrl('https://sam.gov.attacker.example/notice', 'sam'), '');
});

const CF_SUCCESS = '2026-07-13T05:00:00.000Z';
function contractsFinderSnapshot() {
  const record = normalizeContractsFinderRelease({
    id: 'fixture', date: CF_SUCCESS,
    tender: { title: 'Network services', status: 'active', tenderPeriod: { endDate: '2026-07-14T12:00:00Z' } },
  });
  return {
    fetchedAt: Date.parse(CF_SUCCESS), dataAvailable: true, tenders: [record],
    sourceStatuses: [{ source: 'contracts-finder', state: 'ok', recordCount: 1, fetchedAt: CF_SUCCESS, lastSuccessfulAt: CF_SUCCESS }],
  };
}
function failContractsFinder(previousSnapshot, attemptedAt = '2026-07-13T06:00:00.000Z') {
  return mergeTenderSourceResults({
    previousSnapshot, attemptedAt, sourceNames: ['contracts-finder'],
    settled: [{ status: 'rejected', reason: new Error('The operation was aborted due to timeout') }],
  });
}

test('Contracts Finder retains usable data with a durable failure episode and truthful clocks', () => {
  const first = failContractsFinder(contractsFinderSnapshot());
  const status = first.sourceStatuses[0];
  assert.equal(first.tenders.length, 1);
  assert.equal(status.state, 'stale');
  assert.equal(status.lastSuccessfulAt, CF_SUCCESS);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.firstFailureAt, status.fetchedAt);
  assert.match(status.error, /timeout/);
  const second = failContractsFinder(first, '2026-07-13T07:00:00.000Z');
  assert.equal(second.sourceStatuses[0].consecutiveFailures, 2);
  assert.equal(second.sourceStatuses[0].firstFailureAt, status.firstFailureAt);
  assert.equal(second.sourceStatuses[0].lastSuccessfulAt, CF_SUCCESS);
  const expired = failContractsFinder(second, '2026-07-13T08:00:00.000Z');
  assert.equal(expired.tenders.length, 0, 'source retention ends at 180 minutes, even while other sources keep publishing');
  assert.equal(expired.sourceStatuses[0].lastSuccessfulAt, CF_SUCCESS);
  const recovered = mergeTenderSourceResults({
    previousSnapshot: second, sourceNames: ['contracts-finder'], attemptedAt: '2026-07-13T07:05:00Z',
    settled: [{ status: 'fulfilled', value: { records: [], status: {
      source: 'contracts-finder', state: 'ok', recordCount: 0, fetchedAt: '2026-07-13T07:05:00Z',
    } } }],
  });
  assert.equal(recovered.sourceStatuses[0].consecutiveFailures, 0);
  assert.equal(recovered.sourceStatuses[0].firstFailureAt, '');
  assert.equal(recovered.availability, 'empty', 'verified empty is a real recovery');
});

test('Contracts Finder cannot borrow a bundle timestamp or a failed attempt as a source success', () => {
  for (const patch of [
    { state: 'stale', lastSuccessfulAt: '', fetchedAt: '2026-07-13T06:00:00Z' },
    { lastSuccessfulAt: 'bad-date' },
    { lastSuccessfulAt: '2026-07-13T07:00:00Z' },
  ]) {
    const prior = contractsFinderSnapshot();
    Object.assign(prior.sourceStatuses[0], patch);
    assert.equal(failContractsFinder(prior).tenders.length, 0, JSON.stringify(patch));
  }
  for (const patch of [{ title: '' }, { officialUrl: 'https://example.com' }, { deadline: 'bad' }, { status: 'awarded' }]) {
    const prior = contractsFinderSnapshot();
    Object.assign(prior.tenders[0], patch);
    assert.equal(failContractsFinder(prior).tenders.length, 0, JSON.stringify(patch));
  }
  const legacyFailure = contractsFinderSnapshot();
  legacyFailure.sourceStatuses[0].state = 'stale';
  assert.equal(failContractsFinder(legacyFailure).sourceStatuses[0].consecutiveFailures, 2,
    'a legacy failure must not restart as the first failure');
  for (const sourceStatuses of [null, {}, [null]]) {
    const prior = { ...contractsFinderSnapshot(), sourceStatuses };
    assert.equal(failContractsFinder(prior).tenders.length, 0);
  }
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
