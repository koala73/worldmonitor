import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { validateDecisionSignalProvenance } from '../shared/decision-signal-provenance';
import {
  CHINA_CORPORATE_DISCLOSURE_KEY,
  DISCLOSURE_TYPES,
  EMPTY_RESULT_DEGRADE_AFTER,
  OFFICIAL_EXCHANGE_SOURCE_CONTRACTS,
  REVIEWED_DISCLOSURE_ISSUERS,
  buildChinaCorporateDisclosureSnapshot,
  classifyDisclosureTitle,
  fetchChinaCorporateDisclosureSnapshot,
  findReviewedDisclosureIssuer,
  normalizeSseAnnouncements,
  normalizeSzseAnnouncements,
  readBoundedJsonResponse,
} from '../scripts/china-corporate-disclosures/adapters.mjs';
import {
  chinaCorporateDisclosureContentMeta,
  validateChinaCorporateDisclosureSnapshot,
} from '../scripts/seed-china-corporate-disclosures.mjs';

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/china-corporate-disclosures');
const fixture = (name: string) => JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8'));
const retrievedAt = '2026-07-25T10:00:00.000Z';

describe('official China corporate disclosures (#5577)', () => {
  it('maps only the reviewed A/H basket and keeps HKEX blocked', () => {
    assert.equal(CHINA_CORPORATE_DISCLOSURE_KEY, 'market:china:corporate-disclosures:v1');
    assert.deepEqual(
      REVIEWED_DISCLOSURE_ISSUERS.map((issuer) => `${issuer.exchange}:${issuer.securityCode}:${issuer.symbol}`),
      [
        'SSE:600519:600519.SS',
        'SSE:601318:601318.SS',
        'SSE:600900:600900.SS',
        'SSE:688981:688981.SS',
        'SZSE:300750:300750.SZ',
        'HKEX:0700:0700.HK',
        'HKEX:1211:1211.HK',
        'HKEX:0939:0939.HK',
        'HKEX:0857:0857.HK',
      ],
    );
    assert.equal(findReviewedDisclosureIssuer('SSE', '600519')?.name, 'Kweichow Moutai');
    assert.equal(findReviewedDisclosureIssuer('SSE', '999999'), null);
    assert.equal(findReviewedDisclosureIssuer('HKEX', '0700')?.name, 'Tencent');
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.hkex.launchStatus, 'blocked');
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.hkex.maxRequestsPerRun, 0);
  });

  it('records Railway reachability, request/redirect/response bounds, robots, terms, and source decisions', () => {
    for (const id of ['sse', 'szse'] as const) {
      const contract = OFFICIAL_EXCHANGE_SOURCE_CONTRACTS[id];
      assert.equal(contract.launchStatus, 'launched');
      assert.equal(contract.preflight.environment, 'railway-production');
      assert.equal(contract.preflight.reachable, true);
      assert.ok(contract.maxRequestsPerRun > 0 && contract.maxRequestsPerRun <= 4);
      assert.ok(contract.maxResponseBytes >= 32_000 && contract.maxResponseBytes <= 262_144);
      assert.equal(contract.redirectPolicy, 'error');
      assert.equal(contract.documentRetrieval, 'lazy-link-only');
      assert.equal(contract.paginationPolicy, 'bounded_first_page');
      assert.equal(contract.saturationBehavior, 'degraded_on_page_limit');
      assert.deepEqual(contract.emptyResultPolicy, {
        degradeAfterConsecutive: EMPTY_RESULT_DEGRADE_AFTER,
        reason: 'COVERAGE_GAP',
      });
      assert.match(contract.termsUrl, /^https:/);
      assert.match(contract.termsNote, /metadata|document bodies/i);
      assert.match(contract.robots.status, /^(empty|not_published)$/);
      assert.equal(contract.admissionDecision, 'admitted_metadata_only');
    }

    const hkex = OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.hkex;
    assert.equal(hkex.preflight.reachable, true);
    assert.equal(hkex.admissionDecision, 'rejected');
    assert.equal(hkex.blockedReason, 'TERMS_PROHIBIT_AUTOMATED_ACCESS');
    assert.match(hkex.termsUrl, /^https:/);
  });

  it('classifies the seven owned categories without collision inflation', () => {
    assert.deepEqual(DISCLOSURE_TYPES, [
      'halt',
      'resumption',
      'earnings_warning',
      'restructuring',
      'share_pledge',
      'investigation',
      'exchange_risk_alert',
    ]);

    for (const row of fixture('collisions.json') as Array<{ title: string; expected: string | null }>) {
      assert.equal(classifyDisclosureTitle(row.title), row.expected, row.title);
    }
  });

  it('normalizes official metadata, rejects unreviewed issuers, and never fetches document bodies', () => {
    const sse = normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt });
    const szse = normalizeSzseAnnouncements(fixture('szse.json'), { retrievedAt });

    assert.equal(sse.some((row) => row.issuer.securityCode === '999999'), false);
    assert.equal(sse.every((row) => row.exchange === 'SSE'), true);
    assert.equal(szse.every((row) => row.exchange === 'SZSE'), true);
    assert.equal(sse.every((row) => row.documentUrl.startsWith('https://www.sse.com.cn/')), true);
    assert.equal(szse.every((row) => row.documentUrl.startsWith('https://disc.static.szse.cn/download/')), true);
    assert.equal(sse.every((row) => !('documentBody' in row)), true);
    assert.equal(szse.every((row) => !('documentBody' in row)), true);
    assert.equal(
      sse.find((row) => row.titleOriginal.includes('业绩说明会'))?.disclosureType,
      null,
      'an earnings briefing must not become an earnings warning',
    );
  });

  it('deduplicates announcements and applies corrections/cancellations to the correct event with history', () => {
    const sse = normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt });
    const szse = normalizeSzseAnnouncements(fixture('szse.json'), { retrievedAt });
    const riskAlert = sse.find((row) => row.disclosureType === 'exchange_risk_alert');
    assert.ok(riskAlert);
    const repeatedOriginal = {
      ...riskAlert,
      announcementId: '600519_20260720_W002',
      documentUrl: 'https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-07-20/600519_20260720_W002.pdf',
      publicationTime: { value: '2026-07-20', precision: 'day' as const },
      retrievalTime: '2026-07-20T18:00:00.000Z',
    };
    const snapshot = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: [...sse, sse[0], repeatedOriginal],
        },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: szse },
      ],
    });

    assert.equal(snapshot.status, 'healthy');
    assert.equal(
      snapshot.sourceDecisions
        .filter((decision) => decision.launchStatus === 'launched')
        .every(
          (decision) => decision.paginationPolicy === 'bounded_first_page'
            && decision.saturationBehavior === 'degraded_on_page_limit',
        ),
      true,
      'the persisted source decision documents the intentional saturation behavior',
    );
    assert.deepEqual(
      [...new Set(snapshot.events.map((event) => event.disclosureType))].sort(),
      [...DISCLOSURE_TYPES].sort(),
    );
    const pledge = snapshot.events.find((event) => event.disclosureType === 'share_pledge');
    assert.ok(pledge);
    assert.equal(pledge.announcementId, '600519_20260703_P003');
    assert.equal(pledge.status, 'cancelled');
    assert.equal(pledge.history.length, 3);
    assert.deepEqual(pledge.history.map((revision) => revision.revisionState), [
      'original',
      'corrected',
      'cancelled',
    ]);
    assert.equal(new Set(pledge.history.map((revision) => revision.announcementId)).size, 3);
    assert.equal(pledge.history[0].provenance.claims.supersession.status, 'known');
    assert.equal(
      (pledge.history[0].provenance.claims.supersession as { value: { state: string } }).value.state,
      'superseded',
    );
    assert.equal(
      (pledge.provenance.claims.supersession as { value: { state: string } }).value.state,
      'cancelled',
    );
    const riskEvents = snapshot.events.filter(
      (event) => event.exchange === 'SSE' && event.disclosureType === 'exchange_risk_alert',
    );
    assert.equal(riskEvents.length, 2, 'repeated original notices are separate events');
    assert.equal(riskEvents.every((event) => event.history.length === 1), true);

    const ambiguousCorrection = {
      ...riskAlert,
      announcementId: '600519_20260721_W003',
      documentUrl: 'https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-07-21/600519_20260721_W003.pdf',
      publicationTime: { value: '2026-07-21', precision: 'day' as const },
      retrievalTime: '2026-07-21T18:00:00.000Z',
      revisionState: 'corrected' as const,
    };
    const ambiguous = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: [riskAlert, repeatedOriginal, ambiguousCorrection],
        },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    const ambiguousEvent = ambiguous.events.find(
      (event) => event.announcementId === ambiguousCorrection.announcementId,
    );
    assert.ok(ambiguousEvent);
    assert.equal(
      ambiguousEvent.history.length,
      1,
      'a correction with multiple same-subject candidates must not attach to an arbitrary event',
    );
    assert.equal(ambiguousEvent.lineage.status, 'partial');

    for (const event of snapshot.events) {
      for (const revision of event.history) {
        const result = validateDecisionSignalProvenance(revision.provenance);
        assert.equal(
          result.ok,
          true,
          result.ok ? '' : result.errors.map((issue) => `${issue.path}:${issue.code}`).join(', '),
        );
      }
    }
  });

  it('attaches unclassifiable revisions when lineage is unique and retains unmatched revisions for audit', () => {
    const riskAlert = normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt })
      .find((row) => row.disclosureType === 'exchange_risk_alert');
    assert.ok(riskAlert);
    const matchedCorrection = {
      ...riskAlert,
      announcementId: '600519_unclassifiable_correction',
      titleOriginal: '关于事项的更正公告',
      documentUrl: 'https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-07-21/600519_unclassifiable_correction.pdf',
      publicationTime: { value: '2026-07-21', precision: 'day' as const },
      retrievalTime: '2026-07-21T18:00:00.000Z',
      disclosureType: null,
      revisionState: 'corrected' as const,
    };
    const matched = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: [riskAlert, matchedCorrection],
        },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    const corrected = matched.events.find(
      (event) => event.announcementId === matchedCorrection.announcementId,
    );
    assert.ok(corrected);
    assert.equal(corrected.disclosureType, riskAlert.disclosureType);
    assert.equal(corrected.status, 'corrected');
    assert.deepEqual(corrected.provenance.claims.classification_confidence, {
      status: 'known',
      value: {
        score: 0.75,
        method: 'issuer-subject-lineage/v1',
      },
    });
    assert.deepEqual(
      corrected.history.map((revision) => revision.announcementId),
      [riskAlert.announcementId, matchedCorrection.announcementId],
    );
    const matchedRetained = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T10:30:00.000Z',
      previousSnapshot: matched,
      outcomes: [
        { sourceId: 'sse', ok: true, requestCount: 4, announcements: [] },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    assert.deepEqual(
      matchedRetained.events[0].history.map(
        (revision) => revision.provenance.claims.classification_confidence.value,
      ),
      [
        {
          score: riskAlert.confidence.classification,
          method: 'china-exchange-disclosure-title-taxonomy/v1',
        },
        {
          score: 0.75,
          method: 'issuer-subject-lineage/v1',
        },
      ],
    );

    const matchedCancellation = {
      ...matchedCorrection,
      announcementId: '600519_unclassifiable_cancellation',
      titleOriginal: '关于事项的撤回公告',
      documentUrl: 'https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-07-22/600519_unclassifiable_cancellation.pdf',
      publicationTime: { value: '2026-07-22', precision: 'day' as const },
      retrievalTime: '2026-07-22T18:00:00.000Z',
      revisionState: 'cancelled' as const,
    };
    const cancelled = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: [riskAlert, matchedCancellation],
        },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    }).events[0];
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.disclosureType, riskAlert.disclosureType);
    assert.deepEqual(
      cancelled.history.at(-1)?.provenance.claims.classification_confidence.value,
      {
        score: 0.75,
        method: 'issuer-subject-lineage/v1',
      },
    );

    const unmatchedCorrection = {
      ...matchedCorrection,
      announcementId: '600519_unmatched_correction',
      documentUrl: 'https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-07-22/600519_unmatched_correction.pdf',
      publicationTime: { value: '2026-07-22', precision: 'day' as const },
      retrievalTime: '2026-07-22T18:00:00.000Z',
      subjectKey: 'unmatched-subject',
    };
    const unmatched = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: [unmatchedCorrection],
        },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    assert.equal(unmatched.events.length, 0);
    assert.equal(validateChinaCorporateDisclosureSnapshot(unmatched), true);
    assert.deepEqual(
      unmatched.unclassifiedRevisions.map((revision) => ({
        announcementId: revision.announcementId,
        revisionState: revision.revisionState,
        lineage: revision.lineage,
        decisionCode: revision.decisionCode,
      })),
      [{
        announcementId: unmatchedCorrection.announcementId,
        revisionState: 'corrected',
        lineage: {
          status: 'partial',
          reason: 'No unique owned-category filing matched this official revision.',
        },
        decisionCode: 'UNCLASSIFIED_REVISION',
      }],
    );

    const retained = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T10:30:00.000Z',
      previousSnapshot: unmatched,
      outcomes: [
        { sourceId: 'sse', ok: true, requestCount: 4, announcements: [] },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    assert.equal(retained.unclassifiedRevisions.length, 1);
    assert.equal(
      retained.unclassifiedRevisions[0].announcementId,
      unmatchedCorrection.announcementId,
    );
  });

  it('bounds revision history, preserves its original and newest vintages, and never invents lineage', () => {
    const sse = normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt });
    const original = sse.find(
      (row) => row.disclosureType === 'share_pledge' && row.revisionState === 'original',
    );
    const correction = sse.find(
      (row) => row.disclosureType === 'share_pledge' && row.revisionState === 'corrected',
    );
    assert.ok(original);
    assert.ok(correction);

    const orphan = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: [
        { sourceId: 'sse', ok: true, requestCount: 4, announcements: [correction] },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    const orphanRevision = orphan.events[0].history[0].provenance.claims.revision;
    assert.equal(orphan.events[0].status, 'corrected');
    assert.equal(orphan.events[0].lineage.status, 'partial');
    assert.deepEqual(orphanRevision, {
      status: 'known',
      value: {
        vintageId: `sse:${correction.announcementId}`,
        sequence: 2,
        state: 'corrected',
      },
    });
    assert.equal(validateDecisionSignalProvenance(orphan.events[0].provenance).ok, true);

    const revisions = [
      original,
      ...Array.from({ length: 30 }, (_, index) => ({
        ...correction,
        announcementId: `600519_202607${String(index + 2).padStart(2, '0')}_P${String(index + 2).padStart(3, '0')}`,
        documentUrl: `https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-07-${String(index + 2).padStart(2, '0')}/600519_revision_${index + 2}.pdf`,
        publicationTime: {
          value: `2026-07-${String(index + 2).padStart(2, '0')}`,
          precision: 'day' as const,
        },
        retrievalTime: `2026-07-${String(index + 2).padStart(2, '0')}T18:00:00.000Z`,
      })),
    ];
    const fullHistory = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-08-01T19:00:00.000Z',
      outcomes: [
        { sourceId: 'sse', ok: true, requestCount: 4, announcements: revisions },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });
    const event = fullHistory.events[0];
    assert.equal(event.history.length, 20);
    assert.equal(event.history[0].announcementId, original.announcementId);
    assert.equal(event.history.at(-1)?.announcementId, revisions.at(-1)?.announcementId);
    assert.equal(event.historyTruncated, true);
    assert.match(event.id, new RegExp(`${original.announcementId}$`));
    assert.equal(event.history[0].provenance.claims.revision.value.sequence, 1);
    assert.equal(event.history.at(-1)?.provenance.claims.revision.value.sequence, 31);
    assert.equal(
      event.history.every((revision) => validateDecisionSignalProvenance(revision.provenance).ok),
      true,
    );

    const nextRevision = {
      ...correction,
      announcementId: '600519_20260801_P032',
      documentUrl: 'https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-08-01/600519_revision_32.pdf',
      publicationTime: { value: '2026-08-01', precision: 'day' as const },
      retrievalTime: '2026-08-01T20:00:00.000Z',
    };
    const rolledHistory = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-08-01T20:00:00.000Z',
      previousSnapshot: fullHistory,
      outcomes: [
        { sourceId: 'sse', ok: true, requestCount: 4, announcements: [nextRevision] },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    }).events[0];
    assert.equal(rolledHistory.history.length, 20);
    assert.equal(rolledHistory.historyTruncated, true);
    assert.equal(rolledHistory.history[0].announcementId, original.announcementId);
    assert.equal(rolledHistory.history.at(-1)?.announcementId, nextRevision.announcementId);
    assert.equal(rolledHistory.history.at(-1)?.provenance.claims.revision.value.sequence, 32);
  });

  it('degrades sources independently and retains last-good events for a failed source', () => {
    const first = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      previousSnapshot: null,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt }),
        },
        {
          sourceId: 'szse',
          ok: true,
          requestCount: 1,
          announcements: normalizeSzseAnnouncements(fixture('szse.json'), { retrievedAt }),
        },
      ],
    });
    const second = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T11:00:00.000Z',
      previousSnapshot: first,
      outcomes: [
        { sourceId: 'sse', ok: false, requestCount: 1, errorCode: 'TIMEOUT' },
        { sourceId: 'szse', ok: true, requestCount: 1, announcements: [] },
      ],
    });

    assert.equal(second.status, 'degraded');
    assert.equal(second.events.some((event) => event.exchange === 'SSE'), true);
    assert.equal(second.sources.find((source) => source.id === 'sse')?.transportStatus, 'error');
    assert.equal(second.sources.find((source) => source.id === 'sse')?.lastSuccessAt, retrievedAt);
    assert.equal(second.sources.find((source) => source.id === 'szse')?.transportStatus, 'fresh');
    assert.equal(second.sources.find((source) => source.id === 'hkex')?.launchStatus, 'blocked');

    const totalOutage = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T12:00:00.000Z',
      previousSnapshot: first,
      outcomes: [
        { sourceId: 'sse', ok: false, requestCount: 4, errorCode: 'TIMEOUT' },
        { sourceId: 'szse', ok: false, requestCount: 1, errorCode: 'TIMEOUT' },
      ],
    });
    assert.equal(totalOutage.events.length > 0, true);
    assert.equal(totalOutage.status, 'unavailable');
    assert.equal(validateChinaCorporateDisclosureSnapshot(totalOutage), false);
  });

  it('degrades consecutive empty source results and resets the counter after observed disclosures', async () => {
    assert.equal(EMPTY_RESULT_DEGRADE_AFTER, 3);
    const emptyOutcomes = [
      { sourceId: 'sse', ok: true, transportOk: true, requestCount: 4, announcements: [] },
      { sourceId: 'szse', ok: true, transportOk: true, requestCount: 1, announcements: [] },
    ];
    const first = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: emptyOutcomes,
    });
    const second = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T10:30:00.000Z',
      previousSnapshot: first,
      outcomes: emptyOutcomes,
    });
    assert.equal(first.status, 'healthy');
    assert.equal(second.status, 'healthy');
    assert.deepEqual(
      first.sources.filter((source) => source.launchStatus === 'launched')
        .map((source) => source.emptyResultCount),
      [1, 1],
    );
    assert.deepEqual(
      second.sources.filter((source) => source.launchStatus === 'launched')
        .map((source) => source.emptyResultCount),
      [2, 2],
    );

    const decisions: Array<{
      sourceId: string;
      status: string;
      reason?: string;
      emptyResultCount?: number;
    }> = [];
    const third = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse('2026-07-25T11:00:00.000Z'),
      previousSnapshot: second,
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 25, total: 0 },
            result: [],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ announceCount: 0, data: [] }), { status: 200 });
      },
    });
    assert.equal(third.status, 'degraded');
    assert.equal(third.coverageThrough, null);
    assert.deepEqual(
      third.sources.filter((source) => source.launchStatus === 'launched')
        .map((source) => ({
          contentStatus: source.contentStatus,
          errorCode: source.errorCode,
          emptyResultCount: source.emptyResultCount,
        })),
      [
        { contentStatus: 'partial', errorCode: 'COVERAGE_GAP', emptyResultCount: 3 },
        { contentStatus: 'partial', errorCode: 'COVERAGE_GAP', emptyResultCount: 3 },
      ],
    );
    assert.deepEqual(
      decisions.filter((decision) => decision.sourceId !== 'hkex')
        .map((decision) => ({
          sourceId: decision.sourceId,
          status: decision.status,
          reason: decision.reason,
          emptyResultCount: decision.emptyResultCount,
        })),
      [
        { sourceId: 'sse', status: 'degraded', reason: 'COVERAGE_GAP', emptyResultCount: 3 },
        { sourceId: 'szse', status: 'degraded', reason: 'COVERAGE_GAP', emptyResultCount: 3 },
      ],
    );

    const recovered = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T11:30:00.000Z',
      previousSnapshot: third,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          transportOk: true,
          requestCount: 4,
          announcements: normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt }),
        },
        {
          sourceId: 'szse',
          ok: true,
          transportOk: true,
          requestCount: 1,
          announcements: normalizeSzseAnnouncements(fixture('szse.json'), { retrievedAt }),
        },
      ],
    });
    assert.equal(recovered.status, 'healthy');
    assert.equal(recovered.coverageThrough, '2026-07-25');
    assert.deepEqual(
      recovered.sources.filter((source) => source.launchStatus === 'launched')
        .map((source) => ({
          contentStatus: source.contentStatus,
          errorCode: source.errorCode,
          emptyResultCount: source.emptyResultCount,
        })),
      [
        { contentStatus: 'current', errorCode: null, emptyResultCount: 0 },
        { contentStatus: 'current', errorCode: null, emptyResultCount: 0 },
      ],
    );
  });

  it('enforces response bounds and the exact metadata request budget', async () => {
    await assert.rejects(
      () => readBoundedJsonResponse(
        new Response(JSON.stringify({ payload: 'x'.repeat(256) })),
        64,
      ),
      /RESPONSE_TOO_LARGE/,
    );

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('query.sse.com.cn')) {
        const productId = new URL(url).searchParams.get('productId');
        const payload = productId === '600519' ? fixture('sse.json') : { pageHelp: { total: 0 }, result: [] };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('www.szse.cn')) {
        return new Response(JSON.stringify(fixture('szse.json')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      fetchFn,
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
    });
    assert.equal(snapshot.status, 'healthy');
    const sseCalls = calls.filter((call) => call.url.includes('query.sse.com.cn'));
    assert.equal(sseCalls.length, 4);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.maxConcurrentRequests, 2);
    assert.equal(calls.filter((call) => call.url.includes('www.szse.cn')).length, 1);
    assert.equal(calls.every((call) => call.init?.redirect === 'error'), true);
    assert.equal(calls.some((call) => /\.pdf/i.test(call.url)), false);
    const firstSseUrl = new URL(sseCalls[0].url);
    assert.equal(firstSseUrl.searchParams.get('pageHelp.pageSize'), '100');
    assert.equal(
      Date.parse(firstSseUrl.searchParams.get('endDate')!)
        - Date.parse(firstSseUrl.searchParams.get('beginDate')!),
      90 * 86_400_000,
    );

    const partialFetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (
        url.includes('query.sse.com.cn')
        && new URL(url).searchParams.get('productId') === '601318'
      ) {
        throw Object.assign(new Error('issuer request timed out'), { name: 'TimeoutError' });
      }
      return fetchFn(input, init);
    };
    const partial = await fetchChinaCorporateDisclosureSnapshot({
      fetchFn: partialFetchFn,
      now: Date.parse('2026-07-25T11:00:00.000Z'),
      previousSnapshot: snapshot,
      onDecision: () => {},
    });
    const sseState = partial.sources.find((source) => source.id === 'sse');
    assert.equal(partial.status, 'degraded');
    assert.equal(sseState?.requestCount, 4);
    assert.equal(sseState?.transportStatus, 'error');
    assert.equal(sseState?.contentStatus, 'partial');
    assert.equal(
      sseState?.lastSuccessAt,
      retrievedAt,
      'a partial transport failure must preserve the prior fully-successful timestamp',
    );
    assert.equal(partial.events.some((event) => event.exchange === 'SSE'), true);

    const saturatedCalls: Array<string> = [];
    const saturatedDecisions: Array<{ sourceId: string; reason?: string }> = [];
    const saturated = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse('2026-07-25T12:00:00.000Z'),
      previousSnapshot: snapshot,
      onDecision: (decision) => saturatedDecisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        saturatedCalls.push(url);
        if (url.includes('query.sse.com.cn')) {
          const productId = new URL(url).searchParams.get('productId');
          const payload = productId === '600519'
            ? { ...fixture('sse.json'), pageHelp: { pageNo: 1, pageSize: 100, total: 101 } }
            : { pageHelp: { pageNo: 1, pageSize: 100, total: 0 }, result: [] };
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        return new Response(JSON.stringify({ ...fixture('szse.json'), announceCount: 51 }), {
          status: 200,
        });
      },
    });
    assert.equal(saturatedCalls.length, 5);
    assert.equal(saturated.status, 'degraded');
    assert.equal(saturated.sources.find((source) => source.id === 'sse')?.transportStatus, 'fresh');
    assert.equal(saturated.sources.find((source) => source.id === 'sse')?.contentStatus, 'partial');
    assert.equal(
      saturated.sources.find((source) => source.id === 'sse')?.lastSuccessAt,
      '2026-07-25T12:00:00.000Z',
      'a complete transport that reaches the bounded page limit is still a successful collection',
    );
    assert.equal(saturated.sources.find((source) => source.id === 'szse')?.contentStatus, 'partial');
    assert.equal(
      saturatedDecisions.filter((decision) => decision.reason === 'PAGE_LIMIT_REACHED').length,
      2,
    );
  });

  it('rejects malformed HTTP-200 exchange envelopes instead of refreshing stale content', async () => {
    assert.throws(
      () => normalizeSseAnnouncements({ pageHelp: { total: 0 } }, { retrievedAt }),
      /MALFORMED_RESPONSE/,
    );
    assert.throws(
      () => normalizeSzseAnnouncements({ announceCount: 0 }, { retrievedAt }),
      /MALFORMED_RESPONSE/,
    );
    assert.throws(
      () => normalizeSseAnnouncements({
        pageHelp: { total: 1 },
        result: [{
          SECURITY_CODE: '600519',
          TITLE: '',
          URL: '/disclosure/listedinfo/announcement/c/new/2026-07-25/malformed.pdf',
          SSEDATE: '2026-07-25',
        }],
      }, { retrievedAt }),
      /MALFORMED_RESPONSE/,
    );
    assert.throws(
      () => normalizeSseAnnouncements({
        pageHelp: { total: 1 },
        result: [{
          SECURITY_CODE: '600519',
          TITLE: '贵州茅台关于股票交易异常波动的风险提示公告',
          URL: '',
          SSEDATE: '2026-07-25',
        }],
      }, { retrievedAt }),
      /MALFORMED_RESPONSE/,
    );
    assert.throws(
      () => normalizeSzseAnnouncements({
        announceCount: 1,
        data: [{
          secCode: ['300750'],
          annId: 'malformed',
          title: '',
          attachPath: '/disc/2026-07-25/malformed.pdf',
          publishTime: '2026-07-25',
        }],
      }, { retrievedAt }),
      /MALFORMED_RESPONSE/,
    );
    assert.throws(
      () => normalizeSzseAnnouncements({
        announceCount: 1,
        data: [{
          secCode: ['300750'],
          annId: 'malformed',
          title: '宁德时代关于股票交易异常波动的风险提示公告',
          attachPath: '',
          publishTime: '2026-07-25',
        }],
      }, { retrievedAt }),
      /MALFORMED_RESPONSE/,
    );

    const previousSnapshot = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: [
        {
          sourceId: 'sse',
          ok: true,
          requestCount: 4,
          announcements: normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt }),
        },
        {
          sourceId: 'szse',
          ok: true,
          requestCount: 1,
          announcements: normalizeSzseAnnouncements(fixture('szse.json'), { retrievedAt }),
        },
      ],
    });
    const malformed = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse('2026-07-25T13:00:00.000Z'),
      previousSnapshot,
      onDecision: () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({ pageHelp: { total: 0 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ announceCount: 0, data: [] }), { status: 200 });
      },
    });
    const sseState = malformed.sources.find((source) => source.id === 'sse');
    assert.equal(malformed.status, 'degraded');
    assert.equal(sseState?.transportStatus, 'error');
    assert.equal(sseState?.contentStatus, 'stale');
    assert.equal(sseState?.errorCode, 'MALFORMED_RESPONSE');
    assert.equal(malformed.events.some((event) => event.exchange === 'SSE'), true);
  });

  it('uses successful query coverage to keep a healthy quiet window current', () => {
    assert.deepEqual(
      chinaCorporateDisclosureContentMeta({
        status: 'healthy',
        coverageThrough: '2026-07-25',
        events: [],
      }),
      {
        newestItemAt: Date.parse('2026-07-25'),
        oldestItemAt: Date.parse('2026-07-25'),
      },
    );
    assert.deepEqual(
      chinaCorporateDisclosureContentMeta({
        status: 'degraded',
        coverageThrough: null,
        events: [],
        sources: [
          { id: 'sse', lastSuccessAt: '2026-07-25T11:00:00.000Z' },
          { id: 'szse', lastSuccessAt: '2026-07-25T10:00:00.000Z' },
          { id: 'hkex', lastSuccessAt: null },
        ],
      }),
      {
        newestItemAt: Date.parse('2026-07-25T11:00:00.000Z'),
        oldestItemAt: Date.parse('2026-07-25T10:00:00.000Z'),
      },
      'a degraded but successfully checked quiet window must not become STALE_CONTENT',
    );
    assert.equal(
      chinaCorporateDisclosureContentMeta({
        status: 'degraded',
        coverageThrough: null,
        events: [],
        sources: [
          { id: 'sse', lastSuccessAt: null },
          { id: 'szse', lastSuccessAt: null },
          { id: 'hkex', lastSuccessAt: null },
        ],
      }),
      null,
      'a degraded window with no successful source timestamp must remain eligible for STALE_CONTENT',
    );
  });
});
