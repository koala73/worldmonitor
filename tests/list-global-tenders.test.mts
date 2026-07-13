import test from 'node:test';
import assert from 'node:assert/strict';

import { applySnapshotFreshness, filterAndPaginateTenders } from '../server/worldmonitor/economic/v1/list-global-tenders';

const tender = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  source: 'sam', sourceNoticeId: id, officialUrl: `https://example.test/${id}`,
  countryCode: 'US', region: 'North America', title: `Tender ${id}`, description: 'Cybersecurity software', buyer: 'Buyer',
  publishedAt: '2026-07-10T00:00:00.000Z', updatedAt: '', deadline: '2026-07-20T00:00:00.000Z', status: 'open', noticeType: 'solicitation',
  money: { amount: 1000, currency: 'USD' }, categoryCodes: ['541512'], sectors: ['services'], eligibilityRequirements: [], submissionUrls: [],
  participationMode: 'unknown', automationFit: { level: 'medium', score: 60, classificationVersion: 'keyword-v1', matchReasons: ['software'], evidence: ['software'] },
  ...overrides,
});

test('filters by country, query, category, money and deadline without treating missing values as matches', () => {
  const result = filterAndPaginateTenders([
    tender('a'),
    tender('b', { countryCode: 'GB', title: 'Road repair', categoryCodes: ['45233100'], money: { amount: 0, currency: '' } }),
  ], {
    country: 'US', countries: [], region: '', source: '', status: 'open', deadlineFrom: '2026-07-15', deadlineTo: '2026-07-30',
    minValue: 500, maxValue: 2000, currency: 'USD', category: '5415', query: 'cybersecurity', pageSize: 20, cursor: '', sort: 'closing_soon',
    buyer: 'buy', publishedFrom: '2026-07-01', publishedTo: '2026-07-15',
  });

  assert.equal(result.total, 1);
  assert.equal(result.tenders[0]?.id, 'a');
  assert.equal(result.countryCoverage, 'observed');
  assert.deepEqual(result.appliedFilters, ['country', 'status', 'deadline_from', 'deadline_to', 'min_value', 'max_value', 'currency', 'category', 'query', 'buyer', 'published_from', 'published_to']);
});

test('uses bounded cursor pagination and stable sorting', () => {
  const source = [
    tender('c', { deadline: '2026-07-22T00:00:00.000Z' }),
    tender('a', { deadline: '2026-07-20T00:00:00.000Z' }),
    tender('b', { deadline: '2026-07-21T00:00:00.000Z' }),
  ];
  const request = { country: '', countries: [], region: '', source: '', status: '', deadlineFrom: '', deadlineTo: '', minValue: 0, maxValue: 0, currency: '', category: '', query: '', pageSize: 2, cursor: '', sort: 'closing_soon', buyer: '', publishedFrom: '', publishedTo: '' };
  const first = filterAndPaginateTenders(source, request);
  const second = filterAndPaginateTenders(source, { ...request, cursor: first.nextCursor });
  const invalid = filterAndPaginateTenders(source, { ...request, cursor: '999999' });

  assert.deepEqual(first.tenders.map((item) => item.id), ['a', 'b']);
  assert.equal(first.nextCursor, '2');
  assert.deepEqual(second.tenders.map((item) => item.id), ['c']);
  assert.equal(second.nextCursor, '');
  assert.deepEqual(invalid.tenders, []);
  const unknownCountry = filterAndPaginateTenders(source, { ...request, country: 'ZZ' });
  assert.equal(unknownCountry.countryCoverage, 'unknown');
});

test('marks retained snapshots and source statuses stale after the freshness budget', () => {
  const fetchedAt = Date.parse('2026-07-13T08:00:00Z');
  const snapshot = applySnapshotFreshness({
    fetchedAt,
    dataAvailable: true,
    availability: 'available',
    tenders: [tender('a')],
    sourceStatuses: [{ source: 'sam', state: 'ok', recordCount: 1, fetchedAt: '2026-07-13T08:00:00Z', lastSuccessfulAt: '2026-07-13T08:00:00Z', stale: false }],
  }, Date.parse('2026-07-13T12:00:00Z'));

  assert.equal(snapshot.availability, 'stale');
  assert.equal(snapshot.dataAvailable, true);
  assert.equal(snapshot.sourceStatuses?.[0]?.state, 'stale');
  assert.equal(snapshot.sourceStatuses?.[0]?.stale, true);
});
