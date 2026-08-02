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
    buyer: 'buy', publishedFrom: '2026-07-01', publishedTo: '2026-07-15', minAutomationScore: 0,
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
  const request = { country: '', countries: [], region: '', source: '', status: '', deadlineFrom: '', deadlineTo: '', minValue: 0, maxValue: 0, currency: '', category: '', query: '', pageSize: 2, cursor: '', sort: 'closing_soon', buyer: '', publishedFrom: '', publishedTo: '', minAutomationScore: 0 };
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

test('technology-relevance threshold is optional, bounded, and composes with other filters', () => {
  const source = [
    tender('a', { automationFit: { level: 'high', score: 90, classificationVersion: 'keyword-v1', matchReasons: ['software', 'cloud', 'cybersecurity'], evidence: [] } }),
    tender('b', { automationFit: { level: 'low', score: 30, classificationVersion: 'keyword-v1', matchReasons: ['software'], evidence: [] } }),
    tender('c', { countryCode: 'GB', automationFit: { level: 'none', score: 0, classificationVersion: 'keyword-v1', matchReasons: [], evidence: [] } }),
    tender('d', { automationFit: undefined }),
  ];
  const request = { country: '', countries: [], region: '', source: '', status: '', deadlineFrom: '', deadlineTo: '', minValue: 0, maxValue: 0, currency: '', category: '', query: '', pageSize: 20, cursor: '', sort: 'relevance', buyer: '', publishedFrom: '', publishedTo: '', minAutomationScore: 0 };

  const unfiltered = filterAndPaginateTenders(source, request);
  assert.equal(unfiltered.total, 4);
  assert.deepEqual(unfiltered.appliedFilters, []);

  const filtered = filterAndPaginateTenders(source, { ...request, minAutomationScore: 30 });
  assert.deepEqual(filtered.tenders.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(filtered.appliedFilters, ['min_automation_score']);

  const composed = filterAndPaginateTenders(source, { ...request, minAutomationScore: 30, country: 'US' });
  assert.deepEqual(composed.tenders.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(composed.appliedFilters, ['country', 'min_automation_score']);

  // Out-of-range and malformed values are bounded or ignored, never trusted.
  assert.equal(filterAndPaginateTenders(source, { ...request, minAutomationScore: 10_000 }).total, 0);
  assert.equal(filterAndPaginateTenders(source, { ...request, minAutomationScore: Number.NaN }).total, 4);
  assert.equal(filterAndPaginateTenders(source, { ...request, minAutomationScore: -5 }).total, 4);
  // The contract field is int32, so non-integer input is malformed: it
  // disables the filter and never appears in appliedFilters (like page_size,
  // and matching the integer type the OpenAPI schema advertises).
  for (const malformed of [30.9, 0.5]) {
    const result = filterAndPaginateTenders(source, { ...request, minAutomationScore: malformed });
    assert.equal(result.total, 4);
    assert.deepEqual(result.appliedFilters, []);
  }

  // Pagination stays cursor-stable under the active threshold.
  const firstPage = filterAndPaginateTenders(source, { ...request, minAutomationScore: 1, pageSize: 1 });
  const secondPage = filterAndPaginateTenders(source, { ...request, minAutomationScore: 1, pageSize: 1, cursor: firstPage.nextCursor });
  assert.deepEqual(firstPage.tenders.map((item) => item.id), ['a']);
  assert.deepEqual(secondPage.tenders.map((item) => item.id), ['b']);
  assert.equal(secondPage.nextCursor, '');
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
