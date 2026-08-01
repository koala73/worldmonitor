import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { validateDecisionSignalProvenance } from '../shared/decision-signal-provenance';
import {
  CHINA_CORPORATE_DISCLOSURE_MAX_NETWORK_MS,
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
  resolveChinaExchangeEdgeEgress,
} from '../scripts/china-corporate-disclosures/adapters.mjs';
import {
  CHINA_CORPORATE_DISCLOSURE_SZSE_FAILURE_META_KEY,
  buildChinaCorporateDisclosureSeedSnapshot,
  chinaCorporateDisclosureContentMeta,
  recordSzseTransportFailure,
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
      assert.ok(contract.maxRequestsPerRun > 0 && contract.maxRequestsPerRun <= 8);
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
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.transportRecoverySuccessRuns, 2);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.maxRequestsPerRun, 8);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.maxDirectRequestsPerRun, 4);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.maxProxyRequestsPerRun, 4);
    assert.equal(
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.fallbackPolicy,
      'direct_then_proxy_on_transport_failure',
    );
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.proxyEnvironmentVariable, 'SSE_PROXY_URL');
    assert.equal(hkex.preflight.reachable, true);
    assert.equal(hkex.admissionDecision, 'rejected');
    assert.equal(hkex.blockedReason, 'TERMS_PROHIBIT_AUTOMATED_ACCESS');
    assert.match(hkex.termsUrl, /^https:/);
  });

  it('keeps the worst-case network budget below the Railway section timeout', () => {
    const bundleSource = readFileSync(
      resolve(import.meta.dirname, '../scripts/seed-bundle-market-backup.mjs'),
      'utf8',
    );
    const timeoutMatch = /label:\s*'China-Corporate-Disclosures'[^\n]*timeoutMs:\s*([\d_]+)/u
      .exec(bundleSource);
    assert.ok(timeoutMatch, 'China disclosure bundle section must declare timeoutMs');
    const sectionTimeoutMs = Number(timeoutMatch[1].replaceAll('_', ''));

    assert.equal(CHINA_CORPORATE_DISCLOSURE_MAX_NETWORK_MS, 119_250);
    assert.ok(
      sectionTimeoutMs - CHINA_CORPORATE_DISCLOSURE_MAX_NETWORK_MS >= 20_000,
      'network attempts must leave at least 20s for startup, parsing, publication, and shutdown',
    );
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
    assert.equal(
      classifyDisclosureTitle('董事会秘书工作细则'),
      null,
      'routine governance rules are not market-moving disclosure events',
    );
    assert.equal(
      classifyDisclosureTitle('修订公司制度'),
      null,
      'routine system revisions remain outside the owned event taxonomy',
    );
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

  it('requires two consecutive successful runs before transport recovery is stable', async () => {
    const announcements = {
      sse: normalizeSseAnnouncements(fixture('sse.json'), { retrievedAt }),
      szse: normalizeSzseAnnouncements(fixture('szse.json'), { retrievedAt }),
    };
    const successfulOutcomes = [
      {
        sourceId: 'sse',
        ok: true,
        transportOk: true,
        requestCount: 4,
        announcements: announcements.sse,
      },
      {
        sourceId: 'szse',
        ok: true,
        transportOk: true,
        requestCount: 2,
        transportPath: 'proxy',
        fallbackReason: 'ETIMEDOUT',
        announcements: announcements.szse,
      },
    ];
    const healthy = buildChinaCorporateDisclosureSnapshot({
      generatedAt: retrievedAt,
      outcomes: successfulOutcomes,
    });
    const failedAt = '2026-07-25T10:30:00.000Z';
    const failed = buildChinaCorporateDisclosureSnapshot({
      generatedAt: failedAt,
      previousSnapshot: healthy,
      outcomes: [
        successfulOutcomes[0],
        {
          sourceId: 'szse',
          ok: false,
          requestCount: 3,
          errorCode: 'HTTP_522',
          transportPath: 'proxy',
          fallbackReason: 'ETIMEDOUT',
          proxyFailureReason: 'HTTP_522',
        },
      ],
    });
    const recoveryFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('query.sse.com.cn')) {
        const productId = new URL(url).searchParams.get('productId');
        return new Response(JSON.stringify(
          productId === '600519'
            ? fixture('sse.json')
            : { pageHelp: { pageNo: 1, pageSize: 100, total: 0 }, result: [] },
        ), { status: 200 });
      }
      return new Response(JSON.stringify(fixture('szse.json')), { status: 200 });
    };
    const legacyFailed = structuredClone(failed);
    for (const source of legacyFailed.sources) {
      delete source.transportReliability;
    }
    const legacyRecovery = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T10:45:00.000Z',
      previousSnapshot: legacyFailed,
      outcomes: successfulOutcomes,
    });
    assert.equal(
      legacyRecovery.sources.find((source) => source.id === 'szse')
        ?.transportReliability.status,
      'recovering',
    );
    const firstRecoveryAt = '2026-07-25T11:00:00.000Z';
    const firstRecoveryDecisions: Array<Record<string, unknown>> = [];
    const firstRecovery = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(firstRecoveryAt),
      previousSnapshot: healthy,
      previousTransportFailures: {
        szse: {
          checkedAt: failedAt,
          errorCode: 'HTTP_522',
        },
      },
      fetchFn: recoveryFetch,
      onDecision: (decision) => firstRecoveryDecisions.push(decision),
    });
    const firstRecoverySzse = firstRecovery.sources.find((source) => source.id === 'szse');

    assert.equal(firstRecovery.status, 'degraded');
    assert.equal(firstRecovery.coverageThrough, null);
    assert.equal(firstRecoverySzse?.transportStatus, 'fresh');
    assert.equal(firstRecoverySzse?.contentStatus, 'current');
    assert.deepEqual(firstRecoverySzse?.transportReliability, {
      status: 'recovering',
      consecutiveSuccesses: 1,
      consecutiveFailures: 0,
      lastFailureAt: failedAt,
      lastFailureReason: 'HTTP_522',
    });
    assert.deepEqual(
      firstRecoveryDecisions.find((decision) => decision.sourceId === 'szse'),
      {
        sourceId: 'szse',
        status: 'degraded',
        requestCount: 1,
        reason: 'TRANSPORT_RECOVERING',
        emptyResultCount: 0,
        transportPath: 'direct',
        reliabilityStatus: 'recovering',
        requiredRecoverySuccesses: 2,
        consecutiveTransportSuccesses: 1,
        consecutiveTransportFailures: 0,
        lastTransportFailureAt: failedAt,
        lastTransportFailureReason: 'HTTP_522',
        checkedAt: firstRecoveryAt,
      },
    );

    const secondRecoveryAt = '2026-07-25T11:30:00.000Z';
    const secondRecoveryDecisions: Array<Record<string, unknown>> = [];
    const secondRecovery = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(secondRecoveryAt),
      previousSnapshot: firstRecovery,
      fetchFn: recoveryFetch,
      onDecision: (decision) => secondRecoveryDecisions.push(decision),
    });
    const stableSzse = secondRecovery.sources.find((source) => source.id === 'szse');

    assert.equal(secondRecovery.status, 'healthy');
    assert.equal(secondRecovery.coverageThrough, secondRecoveryAt.slice(0, 10));
    assert.deepEqual(stableSzse?.transportReliability, {
      status: 'stable',
      consecutiveSuccesses: 2,
      consecutiveFailures: 0,
      lastFailureAt: failedAt,
      lastFailureReason: 'HTTP_522',
    });
    assert.deepEqual(
      secondRecoveryDecisions.find((decision) => decision.sourceId === 'szse'),
      {
        sourceId: 'szse',
        status: 'accepted',
        requestCount: 1,
        emptyResultCount: 0,
        transportPath: 'direct',
        reliabilityStatus: 'stable',
        requiredRecoverySuccesses: 2,
        consecutiveTransportSuccesses: 2,
        consecutiveTransportFailures: 0,
        lastTransportFailureAt: failedAt,
        lastTransportFailureReason: 'HTTP_522',
        checkedAt: secondRecoveryAt,
      },
    );
  });

  it('persists and replays an SZSE failure rejected by last-good validation', async () => {
    const failedAt = '2026-07-25T10:30:00.000Z';
    const writeCalls: unknown[][] = [];
    const recorded = await recordSzseTransportFailure(
      {
        sources: [{
          id: 'szse',
          transportStatus: 'error',
          checkedAt: failedAt,
          errorCode: 'HTTP_522',
        }],
      },
      async (...args: unknown[]) => {
        writeCalls.push(args);
      },
    );

    assert.equal(recorded, true);
    assert.deepEqual(writeCalls, [[
      'market',
      'china-corporate-disclosures-szse-failure',
      0,
      'china-official-exchange-szse-failure-v1',
      259_200,
      Date.parse(failedAt),
      null,
      { errorCode: 'HTTP_522', consecutiveFailures: 1 },
    ]]);
    assert.equal(
      await recordSzseTransportFailure(
        { sources: [{ id: 'szse', transportStatus: 'fresh' }] },
        async () => {
          throw new Error('writer must not run for a successful source');
        },
      ),
      false,
    );
    assert.equal(
      CHINA_CORPORATE_DISCLOSURE_SZSE_FAILURE_META_KEY,
      'seed-meta:market:china-corporate-disclosures-szse-failure',
    );

    const previousSnapshot = { schemaVersion: 1, sources: [] };
    const reads: Array<[string, { strict: boolean }]> = [];
    let fetchInput: Record<string, unknown> | undefined;
    const result = await buildChinaCorporateDisclosureSeedSnapshot({
      readSnapshot: async (key: string, options: { strict: boolean }) => {
        reads.push([key, options]);
        return key === CHINA_CORPORATE_DISCLOSURE_KEY
          ? previousSnapshot
          : {
              fetchedAt: Date.parse(failedAt),
              errorCode: 'HTTP_522',
              consecutiveFailures: 3,
            };
      },
      fetchSnapshot: async (input: Record<string, unknown>) => {
        fetchInput = input;
        return { status: 'degraded' };
      },
    });

    assert.deepEqual(result, { status: 'degraded' });
    assert.deepEqual(reads, [
      [CHINA_CORPORATE_DISCLOSURE_KEY, { strict: true }],
      [CHINA_CORPORATE_DISCLOSURE_SZSE_FAILURE_META_KEY, { strict: true }],
    ]);
    assert.deepEqual(fetchInput, {
      previousSnapshot,
      previousTransportFailures: {
        szse: {
          checkedAt: failedAt,
          errorCode: 'HTTP_522',
          consecutiveFailures: 3,
        },
      },
    });

    const continuedOutage = buildChinaCorporateDisclosureSnapshot({
      generatedAt: '2026-07-25T11:00:00.000Z',
      previousSnapshot,
      previousTransportFailures: fetchInput?.previousTransportFailures,
      outcomes: [
        { sourceId: 'sse', ok: false, requestCount: 4, errorCode: 'TIMEOUT' },
        { sourceId: 'szse', ok: false, requestCount: 4, errorCode: 'HTTP_522' },
      ],
    });
    assert.equal(
      continuedOutage.sources.find((source) => source.id === 'szse')
        ?.transportReliability.consecutiveFailures,
      4,
    );
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

  it('falls back to a bounded proxy request when the direct SZSE transport fails', async () => {
    const directCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxyCalls: Array<{
      url: string;
      proxyConfig: Record<string, unknown>;
      options: Record<string, unknown>;
    }> = [];
    const decisions: Array<{
      sourceId: string;
      status: string;
      requestCount: number;
      transportPath?: string;
      fallbackReason?: string;
    }> = [];

    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input, init) => {
        const url = String(input);
        directCalls.push({ url, init });
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), {
            code: 'UND_ERR_CONNECT_TIMEOUT',
          }),
        });
      },
      proxyRequestFn: async (input, proxyConfig, options) => {
        proxyCalls.push({
          url: String(input),
          proxyConfig,
          options,
        });
        return {
          buffer: Buffer.from(JSON.stringify(fixture('szse.json'))),
          status: 200,
          contentType: 'application/json',
        };
      },
    });

    assert.equal(snapshot.status, 'healthy');
    assert.equal(directCalls.filter((call) => call.url.includes('www.szse.cn')).length, 1);
    assert.equal(proxyCalls.length, 1);
    assert.match(proxyCalls[0].url, /^https:\/\/www\.szse\.cn\/api\/disc\/announcement\/annList/);
    assert.deepEqual(proxyCalls[0].proxyConfig, {
      host: 'proxy.test',
      port: 443,
      auth: 'proxy-user:proxy-secret',
      tls: true,
    });
    assert.equal(proxyCalls[0].options.method, 'POST');
    assert.equal(
      proxyCalls[0].options.maxResponseBytes,
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxResponseBytes,
    );
    assert.deepEqual(
      JSON.parse(String(proxyCalls[0].options.body)),
      {
        seDate: ['2026-04-26', '2026-07-25'],
        channelCode: ['listedNotice_disc'],
        stock: ['300750'],
        pageSize: 50,
        pageNum: 1,
      },
    );

    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(szse?.transportStatus, 'fresh');
    assert.equal(szse?.contentStatus, 'current');
    assert.equal(szse?.requestCount, 2);
    assert.equal(szse?.transportPath, 'proxy');
    assert.equal(szse?.fallbackReason, 'UND_ERR_CONNECT_TIMEOUT');
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxRequestsPerRun, 4);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxDirectRequestsPerRun, 1);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxProxyRequestsPerRun, 2);
    assert.equal(
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxRequestsPerRun,
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxDirectRequestsPerRun
        + OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxProxyRequestsPerRun
        + OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxEdgeRequestsPerRun,
    );
    assert.equal(
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.fallbackPolicy,
      'direct_then_proxy_then_edge_on_transport_failure',
    );

    const szseDecision = decisions.find((decision) => decision.sourceId === 'szse');
    assert.deepEqual(szseDecision, {
      sourceId: 'szse',
      status: 'accepted',
      requestCount: 2,
      emptyResultCount: 0,
      transportPath: 'proxy',
      fallbackReason: 'UND_ERR_CONNECT_TIMEOUT',
      proxyExitPorts: [443],
      proxyExitRotated: false,
      reliabilityStatus: 'stable',
      requiredRecoverySuccesses: 2,
      consecutiveTransportSuccesses: 1,
      consecutiveTransportFailures: 0,
      checkedAt: retrievedAt,
    });
    assert.doesNotMatch(JSON.stringify(decisions), /proxy-user|proxy-secret/);
  });

  it('falls back to the bounded China proxy route for each failed SSE issuer request', async () => {
    const proxyCalls: Array<{
      url: string;
      port: number;
      options: Record<string, unknown>;
    }> = [];
    const decisions: Array<Record<string, unknown>> = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'cn.decodo.com:30001:proxy-user:proxy-secret',
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
          });
        }
        return new Response(JSON.stringify(fixture('szse.json')), { status: 200 });
      },
      proxyRequestFn: async (input, proxyConfig, options) => {
        const url = String(input);
        proxyCalls.push({ url, port: proxyConfig.port, options });
        const productId = new URL(url).searchParams.get('productId');
        const payload = productId === '600519'
          ? fixture('sse.json')
          : { pageHelp: { pageNo: 1, pageSize: 100, total: 0 }, result: [] };
        return {
          buffer: Buffer.from(JSON.stringify(payload)),
          status: 200,
          contentType: 'application/json',
        };
      },
    });

    assert.equal(snapshot.status, 'healthy');
    assert.equal(proxyCalls.length, 4);
    assert.deepEqual(proxyCalls.map((call) => call.port), [30001, 30001, 30001, 30001]);
    assert.equal(
      proxyCalls.every((call) => call.url.startsWith('https://query.sse.com.cn/')),
      true,
    );
    assert.equal(
      proxyCalls.every(
        (call) => call.options.maxResponseBytes
          === OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.sse.maxResponseBytes,
      ),
      true,
    );
    assert.equal(proxyCalls.every((call) => call.options.timeoutMs === 12_000), true);

    const sse = snapshot.sources.find((source) => source.id === 'sse');
    assert.equal(sse?.transportStatus, 'fresh');
    assert.equal(sse?.contentStatus, 'current');
    assert.equal(sse?.requestCount, 8);
    assert.equal(sse?.transportPath, 'proxy');
    assert.equal(sse?.fallbackReason, 'ETIMEDOUT');
    assert.deepEqual(
      decisions.find((decision) => decision.sourceId === 'sse'),
      {
        sourceId: 'sse',
        status: 'accepted',
        requestCount: 8,
        emptyResultCount: 0,
        transportPath: 'proxy',
        fallbackReason: 'ETIMEDOUT',
        proxyExitPorts: [30001, 30001, 30001, 30001],
        proxyExitRotated: false,
        reliabilityStatus: 'stable',
        requiredRecoverySuccesses: 1,
        consecutiveTransportSuccesses: 1,
        consecutiveTransportFailures: 0,
        checkedAt: retrievedAt,
      },
    );
    assert.doesNotMatch(JSON.stringify({ snapshot, decisions }), /proxy-user|proxy-secret/);
  });

  it('retries one transient proxy transport failure before degrading SZSE coverage', async () => {
    const transientProxyErrorCodes = [
      'EAI_AGAIN',
      'ECONNABORTED',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'EPIPE',
      'ERR_SOCKET_CLOSED',
      'ERR_STREAM_PREMATURE_CLOSE',
      'ERR_TLS_HANDSHAKE_TIMEOUT',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ];
    const transientProxyErrors = [
      ...transientProxyErrorCodes.map((code) => Object.assign(new Error(code), { code })),
      Object.assign(new Error('Proxy CONNECT: HTTP/1.1 502 Bad Gateway'), { status: 502 }),
      new Error('CONNECT tunnel timeout'),
      new TypeError('fetch failed'),
    ];

    for (const transientProxyError of transientProxyErrors) {
      let proxyCalls = 0;
      const decisions: Array<Record<string, unknown>> = [];
      const snapshot = await fetchChinaCorporateDisclosureSnapshot({
        now: Date.parse(retrievedAt),
        previousSnapshot: null,
        proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
        onDecision: (decision) => decisions.push(decision),
        fetchFn: async (input) => {
          const url = String(input);
          if (url.includes('query.sse.com.cn')) {
            return new Response(JSON.stringify({
              pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
              result: [],
            }), { status: 200 });
          }
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
          });
        },
        proxyRequestFn: async () => {
          proxyCalls += 1;
          if (proxyCalls === 1) throw transientProxyError;
          return {
            buffer: Buffer.from(JSON.stringify(fixture('szse.json'))),
            status: 200,
            contentType: 'application/json',
          };
        },
      });

      const szse = snapshot.sources.find((source) => source.id === 'szse');
      assert.equal(snapshot.status, 'healthy');
      assert.equal(proxyCalls, 2);
      assert.equal(szse?.transportStatus, 'fresh');
      assert.equal(szse?.contentStatus, 'current');
      assert.equal(szse?.requestCount, 3);
      assert.equal(szse?.transportPath, 'proxy');
      assert.equal(szse?.fallbackReason, 'ETIMEDOUT');
      assert.deepEqual(
        decisions.find((decision) => decision.sourceId === 'szse'),
        {
          sourceId: 'szse',
          status: 'accepted',
          requestCount: 3,
          emptyResultCount: 0,
          transportPath: 'proxy',
          fallbackReason: 'ETIMEDOUT',
          proxyExitPorts: [443, 443],
          proxyExitRotated: false,
          reliabilityStatus: 'stable',
          requiredRecoverySuccesses: 2,
          consecutiveTransportSuccesses: 1,
          consecutiveTransportFailures: 0,
          checkedAt: retrievedAt,
        },
      );
    }
  });

  it('uses a distinct Decodo sticky gateway port for each proxy attempt', async () => {
    const proxyPorts: number[] = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'gate.decodo.com:10001:proxy-user:proxy-secret',
      onDecision: () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      proxyRequestFn: async (_input, proxyConfig) => {
        proxyPorts.push(proxyConfig.port);
        if (proxyPorts.length === 1) {
          throw Object.assign(new Error('Proxy upstream timeout'), { status: 522 });
        }
        return {
          buffer: Buffer.from(JSON.stringify(fixture('szse.json'))),
          status: 200,
          contentType: 'application/json',
        };
      },
    });

    assert.deepEqual(proxyPorts, [10001, 10002]);
    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(szse?.transportStatus, 'fresh');
    assert.equal(szse?.requestCount, 3);
    assert.equal(szse?.transportPath, 'proxy');
    assert.doesNotMatch(JSON.stringify(snapshot), /proxy-user|proxy-secret/);
  });

  it('uses the authenticated edge egress after direct and proxy transports are exhausted', async () => {
    let proxyCalls = 0;
    const edgeCalls: Array<{ url: string; init?: RequestInit }> = [];
    const decisions: Array<Record<string, unknown>> = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
      edgeEgress: {
        url: 'https://api.example.test/api/internal/china-exchange-egress',
        secret: 'edge-relay-secret',
      },
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      proxyRequestFn: async () => {
        proxyCalls += 1;
        throw Object.assign(new Error('Proxy upstream timeout'), { status: 522 });
      },
      edgeRequestFn: async (input, init) => {
        edgeCalls.push({ url: String(input), init });
        return new Response(JSON.stringify(fixture('szse.json')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(snapshot.status, 'healthy');
    assert.equal(proxyCalls, 2);
    assert.equal(edgeCalls.length, 1);
    assert.equal(
      edgeCalls[0].url,
      'https://api.example.test/api/internal/china-exchange-egress',
    );
    assert.equal(
      new Headers(edgeCalls[0].init?.headers).get('Authorization'),
      'Bearer edge-relay-secret',
    );
    assert.deepEqual(
      JSON.parse(String(edgeCalls[0].init?.body)),
      {
        seDate: ['2026-04-26', '2026-07-25'],
        channelCode: ['listedNotice_disc'],
        stock: ['300750'],
        pageSize: 50,
        pageNum: 1,
      },
    );
    assert.equal(szse?.transportStatus, 'fresh');
    assert.equal(szse?.contentStatus, 'current');
    assert.equal(szse?.requestCount, 4);
    assert.equal(szse?.transportPath, 'edge');
    assert.equal(szse?.fallbackReason, 'ETIMEDOUT');
    assert.equal(szse?.proxyFailureReason, 'HTTP_522');
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxRequestsPerRun, 4);
    assert.equal(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxEdgeRequestsPerRun, 1);
    assert.equal(
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxRequestsPerRun,
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxDirectRequestsPerRun
        + OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxProxyRequestsPerRun
        + OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxEdgeRequestsPerRun,
    );
    assert.equal(
      OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.fallbackPolicy,
      'direct_then_proxy_then_edge_on_transport_failure',
    );
    assert.deepEqual(
      decisions.find((decision) => decision.sourceId === 'szse'),
      {
        sourceId: 'szse',
        status: 'accepted',
        requestCount: 4,
        emptyResultCount: 0,
        transportPath: 'edge',
        fallbackReason: 'ETIMEDOUT',
        proxyFailureReason: 'HTTP_522',
        proxyExitPorts: [443, 443],
        proxyExitRotated: false,
        reliabilityStatus: 'stable',
        requiredRecoverySuccesses: 2,
        consecutiveTransportSuccesses: 1,
        consecutiveTransportFailures: 0,
        checkedAt: retrievedAt,
      },
    );
    assert.doesNotMatch(JSON.stringify(decisions), /proxy-secret|edge-relay-secret/);
  });

  it('preserves only allowlisted bounded edge error reasons', async () => {
    const cases = [
      {
        name: 'timeout',
        body: JSON.stringify({ error: 'upstream_timeout' }),
        expected: 'upstream_timeout',
      },
      {
        name: 'fetch failure',
        body: JSON.stringify({ error: 'upstream_fetch_failed' }),
        expected: 'upstream_fetch_failed',
      },
      {
        name: 'oversized upstream response',
        body: JSON.stringify({ error: 'upstream_response_too_large' }),
        expected: 'upstream_response_too_large',
      },
      {
        name: 'unknown JSON error',
        body: JSON.stringify({
          error: 'untrusted_edge_error',
          detail: 'edge-response-secret',
        }),
        expected: 'HTTP_502',
      },
      {
        name: 'malformed JSON error',
        body: 'not-json edge-response-secret',
        expected: 'HTTP_502',
      },
      {
        name: 'oversized internal error envelope',
        body: JSON.stringify({
          error: 'upstream_fetch_failed',
          detail: `${'x'.repeat(
            OFFICIAL_EXCHANGE_SOURCE_CONTRACTS.szse.maxResponseBytes,
          )}edge-response-secret`,
        }),
        expected: 'HTTP_502',
      },
    ];

    for (const testCase of cases) {
      const decisions: Array<Record<string, unknown>> = [];
      const snapshot = await fetchChinaCorporateDisclosureSnapshot({
        now: Date.parse(retrievedAt),
        previousSnapshot: null,
        proxyUrl: '',
        edgeEgress: {
          url: 'https://api.example.test/api/internal/china-exchange-egress',
          secret: 'edge-relay-secret',
        },
        onDecision: (decision) => decisions.push(decision),
        fetchFn: async (input) => {
          const url = String(input);
          if (url.includes('query.sse.com.cn')) {
            return new Response(JSON.stringify({
              pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
              result: [],
            }), { status: 200 });
          }
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
          });
        },
        edgeRequestFn: async () => new Response(testCase.body, {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      });

      const szse = snapshot.sources.find((source) => source.id === 'szse');
      assert.equal(szse?.requestCount, 2, testCase.name);
      assert.equal(szse?.transportPath, 'edge', testCase.name);
      assert.equal(szse?.fallbackReason, 'ETIMEDOUT', testCase.name);
      assert.equal(szse?.edgeFailureReason, testCase.expected, testCase.name);
      assert.equal(szse?.errorCode, testCase.expected, testCase.name);
      assert.doesNotMatch(
        JSON.stringify({ snapshot, decisions }),
        /edge-relay-secret|edge-response-secret|untrusted_edge_error/,
        testCase.name,
      );
    }
  });

  it('logs bounded edge routing identifiers without persisting the response body', async () => {
    const decisions: Array<Record<string, unknown>> = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: '',
      edgeEgress: {
        url: 'https://api.example.test/api/internal/china-exchange-egress',
        secret: 'edge-relay-secret',
      },
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      edgeRequestFn: async () => new Response(
        '<html>intermediary-response-secret</html>',
        {
          status: 502,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'CF-Ray': 'abc123def456-CDG',
            'Server': 'cloudflare',
            'X-Vercel-Id': 'iad1::sfo1::request_123',
          },
        },
      ),
    });

    const szseDecision = decisions.find((decision) => decision.sourceId === 'szse');
    assert.deepEqual(szseDecision?.edgeFailureDiagnostic, {
      contentType: 'text/html',
      server: 'cloudflare',
      cfRay: 'abc123def456-CDG',
      vercelId: 'iad1::sfo1::request_123',
    });
    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal('edgeFailureDiagnostic' in (szse ?? {}), false);
    assert.doesNotMatch(
      JSON.stringify({ snapshot, decisions }),
      /edge-relay-secret|intermediary-response-secret/,
    );
  });

  it('rotates to a fresh sticky exit when the origin blocks the first one', async () => {
    const proxyPorts: number[] = [];
    const decisions: Array<Record<string, unknown>> = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'gate.decodo.com:10001:proxy-user:proxy-secret',
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      // SZSE answers THROUGH the tunnel with 403 -- the exit IP is blocked, which
      // is the one failure a different sticky session can fix.
      proxyRequestFn: async (_input, proxyConfig) => {
        proxyPorts.push(proxyConfig.port);
        if (proxyPorts.length === 1) {
          return { buffer: Buffer.from('blocked'), status: 403, contentType: 'text/html' };
        }
        return {
          buffer: Buffer.from(JSON.stringify(fixture('szse.json'))),
          status: 200,
          contentType: 'application/json',
        };
      },
    });

    assert.deepEqual(proxyPorts, [10001, 10002]);
    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(szse?.transportStatus, 'fresh');
    assert.equal(szse?.transportPath, 'proxy');
    const decision = decisions.find((entry) => entry.sourceId === 'szse');
    assert.deepEqual(decision?.proxyExitPorts, [10001, 10002]);
    assert.equal(decision?.proxyExitRotated, true);
    assert.doesNotMatch(JSON.stringify({ snapshot, decisions }), /proxy-user|proxy-secret/);
  });

  it('does not rotate exits when the gateway itself rejects the tunnel', async () => {
    const proxyPorts: number[] = [];
    const decisions: Array<Record<string, unknown>> = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'gate.decodo.com:10001:proxy-user:proxy-secret',
      edgeEgress: null,
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      // A CONNECT-layer 403: the gateway itself refuses the tunnel (provider
      // policy block), not the origin refusing the exit IP. Both collapse to
      // HTTP_403, but only the origin case is fixable by a fresh sticky
      // session -- so this must NOT consume the second bounded request.
      proxyRequestFn: async (_input, proxyConfig) => {
        proxyPorts.push(proxyConfig.port);
        throw Object.assign(new Error('Proxy CONNECT: HTTP/1.1 403 Forbidden'), {
          status: 403,
          proxyConnect: true,
        });
      },
    });

    assert.deepEqual(proxyPorts, [10001]);
    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(szse?.proxyFailureReason, 'HTTP_403');
    const decision = decisions.find((entry) => entry.sourceId === 'szse');
    assert.deepEqual(decision?.proxyExitPorts, [10001]);
    assert.equal(decision?.proxyExitRotated, false);
  });

  it('reports edge routing diagnostics for an interstitial that returns a 2xx status', async () => {
    const decisions: Array<Record<string, unknown>> = [];
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: '',
      edgeEgress: {
        url: 'https://api.example.test/api/internal/china-exchange-egress',
        secret: 'edge-relay-secret',
      },
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      // A 200 HTML challenge page: it passes the status check and only fails
      // later in the JSON parser, so the diagnostic cannot ride on that error.
      edgeRequestFn: async () => new Response(
        '<html>intermediary-response-secret</html>',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'CF-Ray': 'abc123def456-CDG',
            'Server': 'cloudflare',
          },
        },
      ),
    });

    const decision = decisions.find((entry) => entry.sourceId === 'szse');
    assert.equal(decision?.edgeFailureReason, 'MALFORMED_RESPONSE');
    assert.deepEqual(decision?.edgeFailureDiagnostic, {
      contentType: 'text/html',
      server: 'cloudflare',
      cfRay: 'abc123def456-CDG',
    });
    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal('edgeFailureDiagnostic' in (szse ?? {}), false);
    assert.doesNotMatch(
      JSON.stringify({ snapshot, decisions }),
      /edge-relay-secret|intermediary-response-secret/,
    );
  });

  it('drops intermediary routing identifiers that fail the allowlist', async () => {
    const runWithEdgeHeaders = async (headers: Record<string, string>) => {
      const decisions: Array<Record<string, unknown>> = [];
      const snapshot = await fetchChinaCorporateDisclosureSnapshot({
        now: Date.parse(retrievedAt),
        previousSnapshot: null,
        proxyUrl: '',
        edgeEgress: {
          url: 'https://api.example.test/api/internal/china-exchange-egress',
          secret: 'edge-relay-secret',
        },
        onDecision: (decision) => decisions.push(decision),
        fetchFn: async (input) => {
          const url = String(input);
          if (url.includes('query.sse.com.cn')) {
            return new Response(JSON.stringify({
              pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
              result: [],
            }), { status: 200 });
          }
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
          });
        },
        edgeRequestFn: async () => new Response(
          '<html>intermediary-response-secret</html>',
          {
            status: 502,
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
          },
        ),
      });
      return {
        decision: decisions.find((decision) => decision.sourceId === 'szse'),
        serialized: JSON.stringify({ snapshot, decisions }),
      };
    };

    const rejectedCfRay = 'not-a-valid-ray';
    // Allowlisted charset, but 102 characters -- rejected on length alone.
    const rejectedVercelId = `iad1::${'x'.repeat(96)}`;

    // A rejected identifier is dropped on its own; an allowlisted sibling in the
    // same response still survives, so the guards must reject per field rather
    // than pass the whole header set through or withhold all of it.
    const partial = await runWithEdgeHeaders({
      Server: 'vercel',
      'CF-Ray': rejectedCfRay,
      'X-Vercel-Id': rejectedVercelId,
    });
    assert.deepEqual(partial.decision?.edgeFailureDiagnostic, {
      contentType: 'text/html',
      server: 'vercel',
    });
    assert.doesNotMatch(partial.serialized, /not-a-valid-ray|xxxxxxxx/);

    // Nothing allowlisted: every identifier is dropped, but the bounded
    // contentType still reports -- an unrecognised intermediary is exactly the
    // case where "did this come from our handler?" needs an answer.
    const none = await runWithEdgeHeaders({
      Server: 'nginx',
      'CF-Ray': rejectedCfRay,
      'X-Vercel-Id': rejectedVercelId,
    });
    assert.deepEqual(none.decision?.edgeFailureDiagnostic, { contentType: 'text/html' });
    assert.doesNotMatch(none.serialized, /nginx|not-a-valid-ray|xxxxxxxx/);
  });

  it('retains last-good SZSE data and all transport reasons after edge failure', async () => {
    const healthy = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      onDecision: () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        return new Response(JSON.stringify(fixture('szse.json')), { status: 200 });
      },
    });
    const decisions: Array<Record<string, unknown>> = [];
    let proxyCalls = 0;
    let edgeCalls = 0;

    const degradedAt = '2026-07-25T11:00:00.000Z';
    const degraded = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(degradedAt),
      previousSnapshot: healthy,
      proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
      edgeEgress: {
        url: 'https://api.example.test/api/internal/china-exchange-egress',
        secret: 'edge-relay-secret',
      },
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        });
      },
      proxyRequestFn: async () => {
        proxyCalls += 1;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('proxy DNS failed'), { code: 'EAI_AGAIN' }),
        });
      },
      edgeRequestFn: async () => {
        edgeCalls += 1;
        return new Response(JSON.stringify({
          error: 'upstream_fetch_failed',
          detail: 'edge-response-secret',
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const szse = degraded.sources.find((source) => source.id === 'szse');
    assert.equal(degraded.status, 'degraded');
    assert.equal(szse?.transportStatus, 'error');
    assert.equal(szse?.contentStatus, 'stale');
    assert.equal(szse?.lastSuccessAt, retrievedAt);
    assert.equal(proxyCalls, 2);
    assert.equal(edgeCalls, 1);
    assert.equal(szse?.requestCount, 4);
    assert.equal(szse?.transportPath, 'edge');
    assert.equal(szse?.fallbackReason, 'ECONNRESET');
    assert.equal(szse?.proxyFailureReason, 'EAI_AGAIN');
    assert.equal(szse?.edgeFailureReason, 'upstream_fetch_failed');
    assert.equal(szse?.errorCode, 'upstream_fetch_failed');
    assert.deepEqual(szse?.transportReliability, {
      status: 'degraded',
      consecutiveSuccesses: 0,
      consecutiveFailures: 1,
      lastFailureAt: degradedAt,
      lastFailureReason: 'upstream_fetch_failed',
    });
    assert.deepEqual(
      decisions.find((decision) => decision.sourceId === 'szse'),
      {
        sourceId: 'szse',
        status: 'degraded',
        requestCount: 4,
        reason: 'upstream_fetch_failed',
        emptyResultCount: 0,
        transportPath: 'edge',
        fallbackReason: 'ECONNRESET',
        proxyFailureReason: 'EAI_AGAIN',
        edgeFailureReason: 'upstream_fetch_failed',
        edgeFailureDiagnostic: { contentType: 'application/json' },
        proxyExitPorts: [443, 443],
        proxyExitRotated: false,
        reliabilityStatus: 'degraded',
        requiredRecoverySuccesses: 2,
        consecutiveTransportSuccesses: 0,
        consecutiveTransportFailures: 1,
        lastTransportFailureAt: degradedAt,
        lastTransportFailureReason: 'upstream_fetch_failed',
        checkedAt: degradedAt,
      },
    );
    const withoutProvenance = (events: typeof healthy.events) => JSON.parse(
      JSON.stringify(events, (key, value) => (key === 'provenance' ? undefined : value)),
    );
    assert.deepEqual(
      withoutProvenance(degraded.events.filter((event) => event.exchange === 'SZSE')),
      withoutProvenance(healthy.events.filter((event) => event.exchange === 'SZSE')),
    );
    assert.doesNotMatch(
      JSON.stringify({ degraded, decisions }),
      /proxy-user|proxy-secret|edge-relay-secret|edge-response-secret/,
    );
  });

  it('pins edge egress to the canonical endpoint for Railway production', () => {
    assert.equal(resolveChinaExchangeEdgeEgress({}), null);
    assert.equal(resolveChinaExchangeEdgeEgress({
      RAILWAY_ENVIRONMENT: 'production',
    }), null);
    assert.deepEqual(resolveChinaExchangeEdgeEgress({
      RAILWAY_ENVIRONMENT_NAME: 'production',
      RELAY_SHARED_SECRET: 'relay-secret',
    }), {
      url: 'https://api.worldmonitor.app/api/internal/china-exchange-egress',
      secret: 'relay-secret',
    });
    assert.equal(resolveChinaExchangeEdgeEgress({
      CHINA_EXCHANGE_EDGE_URL: 'https://preview.example.test/api/internal/china-exchange-egress',
      RELAY_SHARED_SECRET: 'relay-secret',
    }), null);
    assert.deepEqual(resolveChinaExchangeEdgeEgress({
      RAILWAY_ENVIRONMENT: 'production',
      CHINA_EXCHANGE_EDGE_URL: 'https://attacker.example/internal-egress',
      RELAY_SHARED_SECRET: 'relay-secret',
    }), {
      url: 'https://api.worldmonitor.app/api/internal/china-exchange-egress',
      secret: 'relay-secret',
    });
  });

  it('does not retry a non-transport SZSE proxy rejection', async () => {
    let proxyCalls = 0;
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
      onDecision: () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
        });
      },
      proxyRequestFn: async () => {
        proxyCalls += 1;
        throw Object.assign(
          new Error('Proxy CONNECT: HTTP/1.1 407 Proxy Authentication Required'),
          { status: 407 },
        );
      },
    });

    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(snapshot.status, 'degraded');
    assert.equal(proxyCalls, 1);
    assert.equal(szse?.transportStatus, 'error');
    assert.equal(szse?.requestCount, 2);
    assert.equal(szse?.transportPath, 'proxy');
    assert.equal(szse?.fallbackReason, 'ETIMEDOUT');
    assert.equal(szse?.proxyFailureReason, 'HTTP_407');
    assert.equal(szse?.errorCode, 'HTTP_407');
  });

  it('keeps last-good SZSE data and records both transport failures when the proxy also fails', async () => {
    const healthy = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      onDecision: () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        return new Response(JSON.stringify(fixture('szse.json')), { status: 200 });
      },
    });
    const decisions: Array<Record<string, unknown>> = [];
    let proxyCalls = 0;

    const degraded = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse('2026-07-25T11:00:00.000Z'),
      previousSnapshot: healthy,
      proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
      onDecision: (decision) => decisions.push(decision),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        });
      },
      proxyRequestFn: async () => {
        proxyCalls += 1;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('proxy DNS failed'), { code: 'EAI_AGAIN' }),
        });
      },
    });

    const szse = degraded.sources.find((source) => source.id === 'szse');
    assert.equal(degraded.status, 'degraded');
    assert.equal(szse?.transportStatus, 'error');
    assert.equal(szse?.contentStatus, 'stale');
    assert.equal(szse?.lastSuccessAt, retrievedAt);
    assert.equal(proxyCalls, 2);
    assert.equal(szse?.requestCount, 3);
    assert.equal(szse?.transportPath, 'proxy');
    assert.equal(szse?.fallbackReason, 'ECONNRESET');
    assert.equal(szse?.proxyFailureReason, 'EAI_AGAIN');
    assert.equal(szse?.errorCode, 'FETCH_FAILED');
    const withoutProvenance = (events: typeof healthy.events) => JSON.parse(
      JSON.stringify(events, (key, value) => (key === 'provenance' ? undefined : value)),
    );
    assert.deepEqual(
      withoutProvenance(degraded.events.filter((event) => event.exchange === 'SZSE')),
      withoutProvenance(healthy.events.filter((event) => event.exchange === 'SZSE')),
    );
    assert.doesNotMatch(JSON.stringify(decisions), /proxy-user|proxy-secret/);
  });

  it('does not proxy malformed SZSE responses', async () => {
    let proxyCalls = 0;
    const snapshot = await fetchChinaCorporateDisclosureSnapshot({
      now: Date.parse(retrievedAt),
      previousSnapshot: null,
      proxyUrl: 'https://proxy-user:proxy-secret@proxy.test:443',
      onDecision: () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('query.sse.com.cn')) {
          return new Response(JSON.stringify({
            pageHelp: { pageNo: 1, pageSize: 100, total: 0 },
            result: [],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      proxyRequestFn: async () => {
        proxyCalls += 1;
        return {
          buffer: Buffer.from(JSON.stringify(fixture('szse.json'))),
          status: 200,
          contentType: 'application/json',
        };
      },
    });

    const szse = snapshot.sources.find((source) => source.id === 'szse');
    assert.equal(proxyCalls, 0);
    assert.equal(szse?.transportStatus, 'error');
    assert.equal(szse?.errorCode, 'MALFORMED_RESPONSE');
    assert.equal(szse?.requestCount, 1);
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
