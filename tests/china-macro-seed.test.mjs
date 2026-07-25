import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GACC_MAX_REQUESTS_PER_RUN,
  NBS_MAX_REQUESTS_PER_RUN,
  PBOC_MAX_REQUESTS_PER_RUN,
  SAFE_MAX_REQUESTS_PER_RUN,
  buildChinaMacroPillars,
  buildChinaMacroSnapshot,
  fetchChinaMacroSnapshot,
  parseNbsFaiRelease,
  parseNbsIndustrialRelease,
  parseNbsPropertyRelease,
  parseSafeReserveRelease,
  parseSafeSettlementRelease,
} from '../scripts/china-macro/adapters.mjs';
import {
  CHINA_MACRO_KEY,
  CHINA_MACRO_TTL_SECONDS,
  chinaMacroContentMeta,
  chinaMacroTransportMeta,
  recordChinaMacroCompletedRun,
  recordChinaMacroTransportFreshness,
  validateChinaMacroSnapshot,
} from '../scripts/seed-china-macro.mjs';

const fixture = (name) => readFileSync(resolve(import.meta.dirname, 'fixtures/china-macro', name), 'utf8');
const retrievalTime = '2026-07-25T14:30:00.000Z';
const now = Date.parse(retrievalTime);
const officialRoutes = new Map([
  ['https://www.stats.gov.cn/english/PressRelease/', fixture('nbs-list.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', fixture('nbs-industrial.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964158.html', fixture('nbs-fai.html')],
  ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964157.html', fixture('nbs-property.html')],
  ['https://www.safe.gov.cn/safe/sjjd/index.html', fixture('safe-list.html')],
  ['https://www.safe.gov.cn/safe/2026/0706/27661.html', fixture('safe-reserves.html')],
  ['https://www.safe.gov.cn/safe/2026/0717/27704.html', fixture('safe-settlement.html')],
]);

function officialFetch({ calls = [], overrides = new Map() } = {}) {
  return async (url) => {
    const target = String(url);
    calls.push(target);
    if (overrides.has(target)) {
      const override = overrides.get(target);
      if (override instanceof Error) throw override;
      if (override instanceof Response) return override;
      return new Response(override);
    }
    if (target === 'https://www.pbc.gov.cn/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n');
    }
    if (
      target === 'https://www.stats.gov.cn/robots.txt'
      || target === 'https://www.safe.gov.cn/robots.txt'
    ) {
      return new Response('not found', { status: 404 });
    }
    if (target === 'https://english.customs.gov.cn/robots.txt') {
      throw Object.assign(new Error('self signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      });
    }
    const body = officialRoutes.get(target);
    if (!body) throw new Error(`unexpected request ${target}`);
    return new Response(body);
  };
}

function parseOfficialFixtures() {
  return [
    parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime }),
    parseNbsFaiRelease(fixture('nbs-fai.html'), { retrievalTime }),
    parseNbsPropertyRelease(fixture('nbs-property.html'), { retrievalTime }),
    parseSafeReserveRelease(fixture('safe-reserves.html'), { retrievalTime }),
    parseSafeSettlementRelease(fixture('safe-settlement.html'), { retrievalTime }),
  ];
}

describe('China official macro source adapters', () => {
  it('parses the reviewed NBS and SAFE observations without mixing period semantics', () => {
    const [industrial, fixedAsset, property, reserves, settlement] = parseOfficialFixtures();

    assert.deepEqual(
      {
        value: industrial.value,
        pillar: industrial.pillar,
        periodKind: industrial.periodKind,
        observationPeriod: industrial.observationPeriod,
        releaseTime: industrial.releaseTime,
        direction: industrial.direction,
      },
      {
        value: 5.3,
        pillar: 'activity',
        periodKind: 'month',
        observationPeriod: '2026-06',
        releaseTime: '2026-07-16T02:00:00.000Z',
        direction: 'strengthening',
      },
    );
    assert.equal(fixedAsset.value, -5.7);
    assert.equal(fixedAsset.periodKind, 'cumulative_year');
    assert.equal(fixedAsset.direction, 'weakening');
    assert.equal(property.value, -18);
    assert.equal(property.periodKind, 'cumulative_year');
    assert.equal(reserves.value, 34_163);
    assert.equal(reserves.comparisonValue, -0.75);
    assert.equal(reserves.periodKind, 'point_in_time');
    assert.equal(reserves.direction, 'weakening');
    assert.equal(settlement.value, 20_299);
    assert.equal(settlement.unit, 'CNY 100 million');
    assert.equal(settlement.direction, 'unavailable');
    assert.equal(settlement.comparisonBasis, 'not_available');
    assert.equal(settlement.provenance.claims.derivation.status, 'not_applicable');
  });

  it('appends same-period corrections as immutable vintages and marks the old signal superseded', () => {
    const original = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime });
    const correctedHtml = fixture('nbs-industrial.html').replace('increased by 5.3%', 'increased by 5.1%');
    const corrected = parseNbsIndustrialRelease(correctedHtml, {
      retrievalTime: '2026-07-26T14:30:00.000Z',
      previousObservation: original,
    });

    assert.equal(corrected.revisionState, 'revised');
    assert.equal(corrected.revisionSequence, 2);
    assert.equal(corrected.vintages.length, 2);
    assert.equal(
      corrected.vintages[0].provenance.claims.supersession.value.state,
      'superseded',
    );
    assert.equal(
      corrected.vintages[0].provenance.claims.supersession.value.relatedSignalId,
      corrected.provenance.signalId,
    );
    assert.equal(corrected.vintages[1].value, 5.1);
  });

  it('classifies explicit official corrections and resets sequence for a new period', () => {
    const original = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime });
    const correctedHtml = fixture('nbs-industrial.html')
      .replace(
        'Industrial Production Operation in June 2026',
        'Corrected Industrial Production Operation in June 2026',
      )
      .replace('increased by 5.3%', 'increased by 5.1%');
    const corrected = parseNbsIndustrialRelease(correctedHtml, {
      retrievalTime: '2026-07-26T14:30:00.000Z',
      previousObservation: original,
    });
    assert.equal(corrected.revisionState, 'corrected');
    assert.equal(corrected.revisionSequence, 2);
    assert.equal(corrected.vintages[0].value, 5.3);
    assert.equal(corrected.vintages[1].value, 5.1);

    const nextPeriodHtml = fixture('nbs-industrial.html')
      .replaceAll('June 2026', 'July 2026')
      .replace('2026/07/16 10:00', '2026/08/16 10:00')
      .replace('increased by 5.3%', 'increased by 5.4%');
    const nextPeriod = parseNbsIndustrialRelease(nextPeriodHtml, {
      retrievalTime: '2026-08-16T14:30:00.000Z',
      previousObservation: corrected,
    });
    assert.equal(nextPeriod.observationPeriod, '2026-07');
    assert.equal(nextPeriod.revisionState, 'original');
    assert.equal(nextPeriod.revisionSequence, 1);
    assert.deepEqual(nextPeriod.vintages.map((vintage) => vintage.value), [5.3, 5.1, 5.4]);
  });

  it('starts first-seen corrected and revised releases as original lineage entries', () => {
    for (const prefix of ['Corrected', 'Revised']) {
      const firstSeen = parseNbsIndustrialRelease(
        fixture('nbs-industrial.html').replace(
          'Industrial Production Operation in June 2026',
          `${prefix} Industrial Production Operation in June 2026`,
        ),
        { retrievalTime },
      );
      assert.equal(firstSeen.revisionState, 'original');
      assert.equal(firstSeen.revisionSequence, 1);
      assert.equal(firstSeen.provenance.claims.revision.value.state, 'original');
      assert.equal(firstSeen.vintages[0].state, 'original');
    }
    for (const prefix of ['更正：', '修订：']) {
      const firstSeen = parseSafeReserveRelease(
        fixture('safe-reserves.html').replace(
          '外汇储备规模数据',
          `${prefix}外汇储备规模数据`,
        ),
        { retrievalTime },
      );
      assert.equal(firstSeen.revisionState, 'original');
      assert.equal(firstSeen.revisionSequence, 1);
      assert.equal(firstSeen.provenance.claims.revision.value.state, 'original');
      assert.equal(firstSeen.vintages[0].state, 'original');
    }
  });

  it('keeps preliminary, revised, corrected, and superseded states in one immutable lineage', () => {
    const preliminaryHtml = fixture('nbs-industrial.html').replace(
      'Industrial Production Operation in June 2026',
      'Preliminary Industrial Production Operation in June 2026',
    );
    const preliminary = parseNbsIndustrialRelease(preliminaryHtml, { retrievalTime });
    assert.equal(preliminary.revisionState, 'preliminary');
    assert.equal(preliminary.revisionSequence, 1);

    const revisedHtml = fixture('nbs-industrial.html').replace('increased by 5.3%', 'increased by 5.1%');
    const revised = parseNbsIndustrialRelease(revisedHtml, {
      retrievalTime: '2026-07-26T14:30:00.000Z',
      previousObservation: preliminary,
    });
    assert.equal(revised.revisionState, 'revised');
    assert.equal(revised.revisionSequence, 2);

    const correctedHtml = fixture('nbs-industrial.html')
      .replace(
        'Industrial Production Operation in June 2026',
        'Corrected Industrial Production Operation in June 2026',
      )
      .replace('increased by 5.3%', 'increased by 5.0%');
    const corrected = parseNbsIndustrialRelease(correctedHtml, {
      retrievalTime: '2026-07-27T14:30:00.000Z',
      previousObservation: revised,
    });
    assert.equal(corrected.revisionState, 'corrected');
    assert.equal(corrected.revisionSequence, 3);
    assert.deepEqual(
      corrected.vintages.map((vintage) => ({
        sequence: vintage.sequence,
        state: vintage.state,
        value: vintage.value,
        supersession: vintage.provenance.claims.supersession.value.state,
      })),
      [
        { sequence: 1, state: 'preliminary', value: 5.3, supersession: 'superseded' },
        { sequence: 2, state: 'revised', value: 5.1, supersession: 'superseded' },
        { sequence: 3, state: 'corrected', value: 5, supersession: 'current' },
      ],
    );
    assert.equal(corrected.vintages[0].supersededBy, revised.provenance.signalId);
    assert.equal(corrected.vintages[1].supersededBy, corrected.provenance.signalId);
    assert.equal(corrected.vintages[2].supersededBy, '');
  });

  it('keeps transport retrieval fresh without inventing a new content vintage', () => {
    const original = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime });
    const refreshed = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), {
      retrievalTime: '2026-07-26T14:30:00.000Z',
      previousObservation: original,
    });
    assert.equal(refreshed.vintages.length, 1);
    assert.equal(refreshed.revisionSequence, 1);
    assert.equal(
      refreshed.provenance.claims.retrieval_time.value.value,
      '2026-07-26T14:30:00.000Z',
    );
  });

  it('does not fabricate a revision when unrelated page markup changes', () => {
    const original = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime });
    const cosmeticallyChanged = parseNbsIndustrialRelease(
      fixture('nbs-industrial.html').replace('</body>', '<footer>Site banner changed</footer></body>'),
      {
        retrievalTime: '2026-07-26T14:30:00.000Z',
        previousObservation: original,
      },
    );
    assert.equal(cosmeticallyChanged.revisionSequence, 1);
    assert.equal(cosmeticallyChanged.vintages.length, 1);
    assert.notEqual(cosmeticallyChanged.contentHash, original.contentHash);
  });

  it('updates an older-period correction without replacing the newest current period', async () => {
    const june = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime });
    const july = parseNbsIndustrialRelease(
      fixture('nbs-industrial.html')
        .replaceAll('June 2026', 'July 2026')
        .replace('2026/07/16 10:00', '2026/08/09 10:00')
        .replace('increased by 5.3%', 'increased by 5.4%'),
      {
        retrievalTime: '2026-08-09T14:30:00.000Z',
        previousObservation: june,
      },
    );
    july.transportStatus = 'error';
    july.transportFailureReason = 'HTTP_503';
    july.provenance.claims.transport_freshness.value.state = 'error';
    july.vintages.find(
      (vintage) => vintage.vintageId === july.vintageId,
    ).provenance.claims.transport_freshness.value.state = 'error';
    const juneCorrection = parseNbsIndustrialRelease(
      fixture('nbs-industrial.html')
        .replace(
          'Industrial Production Operation in June 2026',
          'Corrected Industrial Production Operation in June 2026',
        )
        .replace('increased by 5.3%', 'increased by 5.1%'),
      {
        retrievalTime: '2026-08-13T14:30:00.000Z',
        previousObservation: july,
      },
    );
    assert.equal(juneCorrection.observationPeriod, '2026-07');
    assert.equal(juneCorrection.value, 5.4);
    assert.equal(juneCorrection.vintageId, july.vintageId);
    assert.equal(juneCorrection.retrievalTime, '2026-08-09T14:30:00.000Z');
    assert.equal(juneCorrection.transportStatus, 'fresh');
    assert.equal(juneCorrection.transportFailureReason, '');
    assert.deepEqual(
      juneCorrection.provenance.claims.transport_freshness.value,
      {
        state: 'fresh',
        assessedAt: '2026-08-13T14:30:00.000Z',
        lastSuccessAt: '2026-08-13T14:30:00.000Z',
      },
    );
    assert.deepEqual(
      juneCorrection.provenance.claims.content_freshness.value,
      {
        state: 'current',
        assessedAt: '2026-08-13T14:30:00.000Z',
        contentAsOf: '2026-07',
      },
    );
    const retainedCurrentVintage = juneCorrection.vintages.find(
      (vintage) => vintage.vintageId === juneCorrection.vintageId,
    );
    assert.deepEqual(
      retainedCurrentVintage.provenance.claims.transport_freshness.value,
      juneCorrection.provenance.claims.transport_freshness.value,
    );
    assert.deepEqual(
      retainedCurrentVintage.provenance.claims.content_freshness.value,
      juneCorrection.provenance.claims.content_freshness.value,
    );
    assert.deepEqual(
      juneCorrection.vintages.map((vintage) => [
        vintage.observationPeriod,
        vintage.sequence,
        vintage.value,
      ]),
      [
        ['2026-06', 1, 5.3],
        ['2026-07', 1, 5.4],
        ['2026-06', 2, 5.1],
      ],
    );
    assert.equal(new Set(juneCorrection.vintages.map((vintage) => vintage.vintageId)).size, 3);

    const baseline = await fetchChinaMacroSnapshot({
      now,
      readCachedFn: async () => null,
      fetchFn: officialFetch(),
      onDecision: () => {},
    });
    const generatedAt = '2026-08-13T14:30:00.000Z';
    const sourceDecisions = structuredClone(baseline.sourceDecisions);
    for (const decision of sourceDecisions) decision.checkedAt = generatedAt;
    const snapshot = buildChinaMacroSnapshot({
      observations: [
        juneCorrection,
        parseNbsFaiRelease(fixture('nbs-fai.html'), {
          retrievalTime: generatedAt,
        }),
        parseNbsPropertyRelease(fixture('nbs-property.html'), {
          retrievalTime: generatedAt,
        }),
        parseSafeReserveRelease(fixture('safe-reserves.html'), {
          retrievalTime: generatedAt,
        }),
        parseSafeSettlementRelease(fixture('safe-settlement.html'), {
          retrievalTime: generatedAt,
        }),
        ...baseline.observations.filter((observation) => !Number.isFinite(observation.value)),
      ],
      sourceDecisions,
      generatedAt,
    });
    assert.equal(snapshot.transportLastSuccessAt, generatedAt);
    assert.equal(
      chinaMacroTransportMeta(snapshot, Date.parse(generatedAt)),
      Date.parse(generatedAt),
    );
    assert.equal(validateChinaMacroSnapshot(snapshot, Date.parse(snapshot.generatedAt)), true);
  });

  it('recognizes reviewed Chinese correction markers for SAFE vintages', () => {
    const original = parseSafeReserveRelease(fixture('safe-reserves.html'), { retrievalTime });
    const corrected = parseSafeReserveRelease(
      fixture('safe-reserves.html')
        .replace('外汇储备规模数据', '更正：外汇储备规模数据')
        .replace('34163', '34160'),
      {
        retrievalTime: '2026-07-26T14:30:00.000Z',
        previousObservation: original,
      },
    );
    assert.equal(corrected.revisionState, 'corrected');
    assert.equal(corrected.revisionSequence, 2);
  });

  it('rejects future observation periods and publication after retrieval', () => {
    assert.throws(
      () => parseNbsIndustrialRelease(
        fixture('nbs-industrial.html').replaceAll('June 2026', 'June 2099'),
        { retrievalTime },
      ),
      /MALFORMED_RELEASE:TEMPORAL_ORDER/,
    );
    assert.throws(
      () => parseNbsIndustrialRelease(
        fixture('nbs-industrial.html').replace(
          '2026\/07\/16 10:00',
          '2026/07/26 10:00',
        ),
        { retrievalTime },
      ),
      /MALFORMED_RELEASE:TEMPORAL_ORDER/,
    );
  });

  it('records every host preflight and emits truthful blocked-source observations', async () => {
    const calls = [];
    const snapshot = await fetchChinaMacroSnapshot({
      now,
      readCachedFn: async (key) => {
        assert.equal(key, CHINA_MACRO_KEY);
        return null;
      },
      fetchFn: officialFetch({ calls }),
      onDecision: () => {},
    });

    assert.equal(NBS_MAX_REQUESTS_PER_RUN, 8);
    assert.equal(SAFE_MAX_REQUESTS_PER_RUN, 6);
    assert.equal(PBOC_MAX_REQUESTS_PER_RUN, 2);
    assert.equal(GACC_MAX_REQUESTS_PER_RUN, 2);
    assert.equal(calls.length, 11);
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.launchReady, true);
    assert.equal(snapshot.status, 'degraded');
    assert.equal(
      validateChinaMacroSnapshot(snapshot, now),
      true,
    );
    assert.equal(snapshot.observations.filter((item) => Number.isFinite(item.value)).length, 5);
    assert.equal(snapshot.observations.find((item) => item.seriesId === 'pboc_m2_yoy').unavailableReason, 'ROBOTS_DISALLOW');
    assert.equal(snapshot.observations.find((item) => item.seriesId === 'gacc_exports').unavailableReason, 'TLS_CERTIFICATE_ERROR');
    assert.equal(snapshot.pillars.find((item) => item.pillar === 'activity').direction, 'strengthening');
    assert.equal(snapshot.pillars.find((item) => item.pillar === 'investment_property').direction, 'weakening');
    assert.equal(snapshot.pillars.find((item) => item.pillar === 'credit_liquidity').direction, 'unavailable');
    assert.equal(snapshot.pillars.find((item) => item.pillar === 'trade').direction, 'unavailable');

    assert.deepEqual(
      snapshot.sourceDecisions.map((decision) => ({
        publisherId: decision.publisherId,
        source: decision.source,
        host: decision.host,
        status: decision.status,
        reason: decision.reason,
        checkedAt: decision.checkedAt,
        requestBudget: decision.requestBudget,
        requestCount: decision.requestCount,
        robotsStatus: decision.robotsStatus,
        redirectBehavior: decision.redirectBehavior,
        termsStatus: decision.termsStatus,
        sourceUrl: decision.sourceUrl,
      })),
      [
        {
          publisherId: 'publisher:nbs-cn',
          source: 'National Bureau of Statistics of China',
          host: 'www.stats.gov.cn',
          status: 'accepted',
          reason: 'OK',
          checkedAt: retrievalTime,
          requestBudget: 8,
          requestCount: 5,
          robotsStatus: 'no_rules_published',
          redirectBehavior: 'none',
          termsStatus: 'reviewed_2026-07-25_attribution_required',
          sourceUrl: 'https://www.stats.gov.cn/english/PressRelease/',
        },
        {
          publisherId: 'publisher:safe-cn',
          source: 'State Administration of Foreign Exchange',
          host: 'www.safe.gov.cn',
          status: 'accepted',
          reason: 'OK',
          checkedAt: retrievalTime,
          requestBudget: 6,
          requestCount: 4,
          robotsStatus: 'no_rules_published',
          redirectBehavior: 'none',
          termsStatus: 'reviewed_2026-07-25_facts_only_attribution_required',
          sourceUrl: 'https://www.safe.gov.cn/safe/sjjd/index.html',
        },
        {
          publisherId: 'publisher:pboc-cn',
          source: 'People’s Bank of China',
          host: 'www.pbc.gov.cn',
          status: 'blocked',
          reason: 'ROBOTS_DISALLOW',
          checkedAt: retrievalTime,
          requestBudget: 2,
          requestCount: 1,
          robotsStatus: 'disallow_all',
          redirectBehavior: 'none',
          termsStatus: 'not_evaluated_robots_blocked',
          sourceUrl: 'https://www.pbc.gov.cn/',
        },
        {
          publisherId: 'publisher:gacc-cn',
          source: 'General Administration of Customs of China',
          host: 'english.customs.gov.cn',
          status: 'blocked',
          reason: 'TLS_CERTIFICATE_ERROR',
          checkedAt: retrievalTime,
          requestBudget: 2,
          requestCount: 1,
          robotsStatus: 'unavailable_tls',
          redirectBehavior: 'none',
          termsStatus: 'reviewed_all_rights_reserved_chinese_authoritative',
          sourceUrl: 'https://english.customs.gov.cn/',
        },
      ],
    );
    const callsByHost = calls.reduce((byHost, url) => {
      const host = new URL(url).host;
      (byHost[host] ??= []).push(url);
      return byHost;
    }, {});
    assert.equal(callsByHost['www.stats.gov.cn']?.length, 5);
    assert.equal(callsByHost['www.safe.gov.cn']?.length, 4);
    assert.equal(callsByHost['www.pbc.gov.cn']?.length, 1);
    assert.equal(callsByHost['english.customs.gov.cn']?.length, 1);
  });

  it('retries a transient throttle once within the host budget and honors Retry-After', async () => {
    const calls = [];
    const delegate = officialFetch({ calls });
    const industrialUrl = 'https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html';
    let throttled = false;
    const startedAt = Date.now();
    const snapshot = await fetchChinaMacroSnapshot({
      now,
      readCachedFn: async () => null,
      fetchFn: async (url, init) => {
        calls.push(String(url));
        if (String(url) === industrialUrl && !throttled) {
          throttled = true;
          return new Response('throttled', {
            status: 429,
            headers: { 'Retry-After': '0.05' },
          });
        }
        return delegate(url, init);
      },
      onDecision: () => {},
    });
    assert.ok(Date.now() - startedAt >= 40);
    assert.equal(
      snapshot.sourceDecisions.find((decision) => decision.host === 'www.stats.gov.cn').requestCount,
      6,
    );
  });

  it('retries an HTTP 408 timeout once within the host budget', async () => {
    const delegate = officialFetch();
    const listingUrl = 'https://www.safe.gov.cn/safe/sjjd/index.html';
    let timedOut = false;
    const snapshot = await fetchChinaMacroSnapshot({
      now,
      readCachedFn: async () => null,
      fetchFn: async (url, init) => {
        if (String(url) === listingUrl && !timedOut) {
          timedOut = true;
          return new Response('timeout', { status: 408 });
        }
        return delegate(url, init);
      },
      onDecision: () => {},
    });
    assert.equal(
      snapshot.sourceDecisions.find((decision) => decision.host === 'www.safe.gov.cn').requestCount,
      5,
    );
  });

  it('does not retry permanent schema failures', async () => {
    const calls = [];
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          calls,
          overrides: new Map([
            ['https://www.stats.gov.cn/english/PressRelease/', '<html>no reviewed release links</html>'],
          ]),
        }),
        onDecision: () => {},
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:SCHEMA_DRIFT/,
    );
    assert.equal(
      calls.filter((url) => url === 'https://www.stats.gov.cn/english/PressRelease/').length,
      1,
    );
  });

  it('bounds declared and chunked official response bodies', async () => {
    const previous = buildChinaMacroSnapshot({
      observations: parseOfficialFixtures(),
      sourceDecisions: [],
      generatedAt: retrievalTime,
    });
    const declared = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-07-26T14:30:00.000Z'),
      readCachedFn: async () => previous,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.safe.gov.cn/safe/sjjd/index.html', new Response('too large', {
            headers: { 'Content-Length': String(3 * 1024 * 1024) },
          })],
        ]),
      }),
      onDecision: () => {},
    });
    assert.equal(
      declared.sourceDecisions.find((decision) => decision.host === 'www.safe.gov.cn').reason,
      'RESPONSE_TOO_LARGE',
    );
    assert.equal(
      declared.observations.find((observation) => observation.seriesId === 'safe_fx_reserves')
        .transportFailureReason,
      'RESPONSE_TOO_LARGE',
    );

    const chunk = new Uint8Array(1024 * 1024);
    const decisions = [];
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          overrides: new Map([
            ['https://www.stats.gov.cn/english/PressRelease/', new Response(new ReadableStream({
              start(controller) {
                controller.enqueue(chunk);
                controller.enqueue(chunk);
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              },
            }))],
          ]),
        }),
        onDecision: (decision) => decisions.push(decision),
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:RESPONSE_TOO_LARGE/,
    );
    assert.equal(
      decisions.find((decision) => decision.host === 'www.stats.gov.cn').reason,
      'RESPONSE_TOO_LARGE',
    );
  });

  it('records followed redirects for accepted and blocked candidate hosts', async () => {
    const redirected = (location) => new Response(null, {
      status: 302,
      headers: { Location: location },
    });
    const snapshot = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-07-26T14:30:00.000Z'),
      readCachedFn: async () => null,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.stats.gov.cn/english/PressRelease/', redirected('/english/PressRelease/?redirected=1')],
          ['https://www.stats.gov.cn/english/PressRelease/?redirected=1', fixture('nbs-list.html')],
          ['https://www.safe.gov.cn/safe/sjjd/index.html', redirected('/safe/sjjd/index.html?redirected=1')],
          ['https://www.safe.gov.cn/safe/sjjd/index.html?redirected=1', fixture('safe-list.html')],
          ['https://www.pbc.gov.cn/robots.txt', redirected('/robots.txt?redirected=1')],
          ['https://www.pbc.gov.cn/robots.txt?redirected=1', 'User-agent: *\nDisallow: /\n'],
          ['https://english.customs.gov.cn/robots.txt', redirected('/robots.txt?redirected=1')],
          ['https://english.customs.gov.cn/robots.txt?redirected=1', 'User-agent: *\nAllow: /\n'],
        ]),
      }),
      onDecision: () => {},
    });
    assert.deepEqual(
      snapshot.sourceDecisions.map((decision) => [decision.host, decision.redirectBehavior]),
      [
        ['www.stats.gov.cn', 'followed'],
        ['www.safe.gov.cn', 'followed'],
        ['www.pbc.gov.cn', 'followed'],
        ['english.customs.gov.cn', 'followed'],
      ],
    );
  });

  it('rejects cross-origin listing links and redirects before fetching them', async () => {
    const calls = [];
    const maliciousListing = fixture('nbs-list.html').replace(
      /href="[^"]+"([^>]*>Industrial Production Operation)/,
      'href="http://127.0.0.1/private"$1',
    );
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          calls,
          overrides: new Map([
            ['https://www.stats.gov.cn/english/PressRelease/', maliciousListing],
          ]),
        }),
        onDecision: () => {},
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:UNAPPROVED_URL/,
    );
    assert.ok(!calls.some((url) => url.startsWith('http://127.0.0.1')));

    const decisions = [];
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          overrides: new Map([
            ['https://www.stats.gov.cn/english/PressRelease/', new Response(null, {
              status: 302,
              headers: { Location: 'http://127.0.0.1/private' },
            })],
          ]),
        }),
        onDecision: (decision) => decisions.push(decision),
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:REDIRECT_REJECTED_UNAPPROVED_URL/,
    );
    const nbs = decisions.find((decision) => decision.host === 'www.stats.gov.cn');
    assert.equal(nbs.redirectBehavior, 'rejected');
    assert.equal(nbs.reason, 'REDIRECT_REJECTED_UNAPPROVED_URL');
  });

  it('evaluates only the wildcard robots group', async () => {
    const snapshot = await fetchChinaMacroSnapshot({
      now,
      readCachedFn: async () => null,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.pbc.gov.cn/robots.txt', [
            'User-agent: *',
            'Disallow:',
            '',
            'User-agent: ExampleBot',
            'Disallow: /',
          ].join('\n')],
        ]),
      }),
      onDecision: () => {},
    });
    const pboc = snapshot.sourceDecisions.find((decision) => decision.host === 'www.pbc.gov.cn');
    assert.equal(pboc.robotsStatus, 'allows_candidate_paths');
    assert.equal(pboc.reason, 'SOURCE_CONTRACT_NOT_LAUNCHED');
  });

  it('checks accepted-source robots live and fails closed on a wildcard ban', async () => {
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          overrides: new Map([
            ['https://www.stats.gov.cn/robots.txt', 'User-agent: *\nDisallow: /\n'],
          ]),
        }),
        onDecision: () => {},
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:ROBOTS_DISALLOW/,
    );

    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          overrides: new Map([
            ['https://www.stats.gov.cn/robots.txt', [
              'User-agent: *',
              'Disallow:',
              '',
              'User-agent: WorldMonitor',
              'Disallow: /',
            ].join('\n')],
          ]),
        }),
        onDecision: () => {},
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:ROBOTS_DISALLOW/,
    );

    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          overrides: new Map([
            ['https://www.stats.gov.cn/robots.txt', [
              'User-agent: *',
              'Disallow: /english/PressRelease/',
              'Allow: /english/PressRelease/public/',
            ].join('\n')],
          ]),
        }),
        onDecision: () => {},
      }),
      /NBS_REQUIRED_SOURCE_UNAVAILABLE:ROBOTS_DISALLOW/,
    );
  });

  it('does not follow NBS or SAFE redirects into robots-blocked paths', async () => {
    const cases = [
      {
        source: 'NBS',
        robotsUrl: 'https://www.stats.gov.cn/robots.txt',
        releaseUrl: 'https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html',
        blockedUrl: 'https://www.stats.gov.cn/english/PressRelease/private/blocked.html',
        disallow: '/english/PressRelease/private/',
      },
      {
        source: 'SAFE',
        robotsUrl: 'https://www.safe.gov.cn/robots.txt',
        releaseUrl: 'https://www.safe.gov.cn/safe/2026/0706/27661.html',
        blockedUrl: 'https://www.safe.gov.cn/safe/private/blocked.html',
        disallow: '/safe/private/',
      },
    ];
    for (const testCase of cases) {
      const calls = [];
      await assert.rejects(
        fetchChinaMacroSnapshot({
          now,
          readCachedFn: async () => null,
          fetchFn: officialFetch({
            calls,
            overrides: new Map([
              [testCase.robotsUrl, `User-agent: WorldMonitor\nDisallow: ${testCase.disallow}\n`],
              [testCase.releaseUrl, new Response(null, {
                status: 302,
                headers: { Location: testCase.blockedUrl },
              })],
            ]),
          }),
          onDecision: () => {},
        }),
        new RegExp(`${testCase.source}_REQUIRED_SOURCE_UNAVAILABLE:ROBOTS_DISALLOW`),
      );
      assert.ok(!calls.includes(testCase.blockedUrl));
    }
  });

  it('publishes current failure status while preserving last-good required observations', async () => {
    const previous = buildChinaMacroSnapshot({
      observations: parseOfficialFixtures(),
      sourceDecisions: [],
      generatedAt: retrievalTime,
    });
    const rateLimited = Object.assign(new Error('HTTP_429'), { status: 429 });
    const snapshot = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-07-26T14:30:00.000Z'),
      readCachedFn: async () => previous,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', rateLimited],
        ]),
      }),
      onDecision: () => {},
    });

    const preserved = snapshot.observations.find(
      (item) => item.seriesId === 'nbs_industrial_value_added_yoy',
    );
    assert.equal(preserved.value, 5.3);
    assert.equal(preserved.retrievalTime, retrievalTime);
    assert.equal(preserved.transportStatus, 'error');
    assert.equal(preserved.transportFailureReason, 'HTTP_429');
    assert.equal(preserved.provenance.claims.transport_freshness.value.state, 'error');
    assert.equal(
      preserved.provenance.claims.transport_freshness.value.lastSuccessAt,
      retrievalTime,
    );
    assert.equal(
      snapshot.sourceDecisions.find((decision) => decision.host === 'www.stats.gov.cn').status,
      'blocked',
    );
    assert.equal(snapshot.launchReady, true);
    assert.equal(snapshot.status, 'degraded');
    assert.equal(
      validateChinaMacroSnapshot(snapshot, Date.parse('2026-07-26T14:30:00.000Z')),
      true,
    );

    const repeated = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-07-27T14:30:00.000Z'),
      readCachedFn: async () => snapshot,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', rateLimited],
        ]),
      }),
      onDecision: () => {},
    });
    assert.equal(repeated.transportLastSuccessAt, retrievalTime);
    assert.equal(
      validateChinaMacroSnapshot(repeated, Date.parse('2026-07-27T14:30:00.000Z')),
      true,
    );

    const asymmetric = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-07-27T14:30:00.000Z'),
      readCachedFn: async () => snapshot,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.safe.gov.cn/safe/sjjd/index.html', '<html>schema drift</html>'],
        ]),
      }),
      onDecision: () => {},
    });
    assert.equal(asymmetric.transportLastSuccessAt, '2026-07-26T14:30:00.000Z');
    assert.equal(
      validateChinaMacroSnapshot(asymmetric, Date.parse('2026-07-27T14:30:00.000Z')),
      true,
    );
  });

  it('fails closed when a required source has no valid last-good observation', async () => {
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    await assert.rejects(
      fetchChinaMacroSnapshot({
        now,
        readCachedFn: async () => null,
        fetchFn: officialFetch({
          overrides: new Map([
            ['https://www.stats.gov.cn/english/PressRelease/202607/t20260717_1964159.html', timeout],
          ]),
        }),
        onDecision: () => {},
      }),
      (error) => (
        error.nonRetryable === true
        && /NBS_REQUIRED_SOURCE_UNAVAILABLE:TIMEOUT/.test(error.message)
      ),
    );
  });

  it('preserves SAFE last-good values when a partial listing drifts', async () => {
    const previous = buildChinaMacroSnapshot({
      observations: parseOfficialFixtures(),
      sourceDecisions: [],
      generatedAt: retrievalTime,
    });
    const snapshot = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-07-26T14:30:00.000Z'),
      readCachedFn: async () => previous,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.safe.gov.cn/safe/sjjd/index.html', '<a href="/safe/only-reserves">外汇储备规模数据</a>'],
        ]),
      }),
      onDecision: () => {},
    });
    const settlement = snapshot.observations.find(
      (item) => item.seriesId === 'safe_bank_fx_settlement',
    );
    assert.equal(settlement.value, 20_299);
    assert.equal(settlement.transportStatus, 'error');
    assert.equal(settlement.transportFailureReason, 'SCHEMA_DRIFT');
    assert.equal(
      validateChinaMacroSnapshot(snapshot, Date.parse('2026-07-26T14:30:00.000Z')),
      true,
    );
  });

  it('preserves stale last-good values with separate error and content-stale status', async () => {
    const previous = buildChinaMacroSnapshot({
      observations: parseOfficialFixtures(),
      sourceDecisions: [],
      generatedAt: retrievalTime,
    });
    const snapshot = await fetchChinaMacroSnapshot({
      now: Date.parse('2026-09-20T14:30:00.000Z'),
      readCachedFn: async () => previous,
      fetchFn: officialFetch({
        overrides: new Map([
          ['https://www.stats.gov.cn/english/PressRelease/', new Error('HTTP_429')],
        ]),
      }),
      onDecision: () => {},
    });
    const preserved = snapshot.observations.find(
      (item) => item.seriesId === 'nbs_industrial_value_added_yoy',
    );
    assert.equal(preserved.value, 5.3);
    assert.equal(preserved.stale, true);
    assert.equal(preserved.unavailableReason, 'STALE_OBSERVATION');
    assert.equal(preserved.direction, 'unavailable');
    assert.equal(preserved.transportStatus, 'error');
    assert.equal(preserved.provenance.claims.transport_freshness.value.state, 'error');
    assert.equal(preserved.provenance.claims.content_freshness.value.state, 'stale');
    assert.equal(snapshot.launchReady, false);
    assert.equal(snapshot.status, 'degraded');
  });

  it('anchors content health to the oldest required official observation', () => {
    const snapshot = buildChinaMacroSnapshot({
      observations: parseOfficialFixtures(),
      sourceDecisions: [],
      generatedAt: retrievalTime,
    });
    assert.equal(snapshot.contentObservationDate, '2026-06');
    const meta = chinaMacroContentMeta(snapshot);
    assert.equal(meta.newestItemAt, Date.parse('2026-06-30T23:59:59.000Z'));
    assert.equal(meta.oldestItemAt, meta.newestItemAt);
  });

  it('records recovered transport before stale content fails canonical validation', async () => {
    const staleContentNow = Date.parse('2027-01-25T14:30:00.000Z');
    const snapshot = await fetchChinaMacroSnapshot({
      now: staleContentNow,
      readCachedFn: async () => null,
      fetchFn: officialFetch(),
      onDecision: () => {},
    });
    assert.equal(snapshot.launchReady, false);
    assert.equal(validateChinaMacroSnapshot(snapshot, staleContentNow), false);

    const writes = [];
    await recordChinaMacroTransportFreshness(
      snapshot,
      async (...args) => { writes.push(args); },
      staleContentNow,
    );
    assert.deepEqual(writes, [[
      'economic',
      'china-macro-transport',
      5,
      'china-macro-required-official-sources-v2',
      CHINA_MACRO_TTL_SECONDS,
      staleContentNow,
    ]]);

    await assert.rejects(
      recordChinaMacroTransportFreshness(
        {
          generatedAt: snapshot.generatedAt,
          transportLastSuccessAt: snapshot.transportLastSuccessAt,
        },
        async (...args) => { writes.push(args); },
        staleContentNow,
      ),
      /structurally valid official transport snapshot/,
    );
    assert.equal(writes.length, 1);

    const completionWrites = [];
    await recordChinaMacroCompletedRun(
      snapshot,
      async (...args) => { completionWrites.push(args); },
      staleContentNow,
    );
    assert.deepEqual(completionWrites, [[
      'economic',
      'china-macro-complete',
      5,
      'china-macro-required-official-sources-v2',
      CHINA_MACRO_TTL_SECONDS,
      staleContentNow,
    ]]);
  });

  it('keeps pillar aggregation fail-closed for incomparable or mixed official signals', () => {
    const observations = parseOfficialFixtures();
    const fixedAsset = observations.find(
      (observation) => observation.seriesId === 'nbs_fixed_asset_investment_yoy',
    );
    const property = observations.find(
      (observation) => observation.seriesId === 'nbs_real_estate_investment_yoy',
    );
    assert.equal(
      buildChinaMacroPillars(observations).find(
        (pillar) => pillar.pillar === 'investment_property',
      ).reason,
      'CONSISTENT_AVAILABLE_OBSERVATIONS',
    );

    const incomparable = structuredClone(observations);
    incomparable.find(
      (observation) => observation.seriesId === property.seriesId,
    ).observationPeriod = '2026-05';
    assert.deepEqual(
      buildChinaMacroPillars(incomparable).find(
        (pillar) => pillar.pillar === 'investment_property',
      ),
      {
        pillar: 'investment_property',
        direction: 'unavailable',
        reason: 'INCOMPARABLE_PERIOD_OR_BASIS',
        observationIds: [fixedAsset.seriesId, property.seriesId],
      },
    );

    const mixed = structuredClone(observations);
    mixed.find(
      (observation) => observation.seriesId === property.seriesId,
    ).direction = 'strengthening';
    assert.equal(
      buildChinaMacroPillars(mixed).find(
        (pillar) => pillar.pillar === 'investment_property',
      ).reason,
      'MIXED_OFFICIAL_SIGNALS',
    );
  });

  it('rejects partial, malformed, future-dated, or provenance-free snapshots at the publish boundary', async () => {
    const snapshot = await fetchChinaMacroSnapshot({
      now,
      readCachedFn: async () => null,
      fetchFn: officialFetch(),
      onDecision: () => {},
    });
    assert.equal(validateChinaMacroSnapshot(snapshot, now), true);

    const withoutProvenance = structuredClone(snapshot);
    withoutProvenance.observations[0].provenance = null;
    assert.equal(validateChinaMacroSnapshot(withoutProvenance, now), false);

    const missingCore = structuredClone(snapshot);
    missingCore.observations = missingCore.observations.filter(
      (item) => item.seriesId !== 'safe_bank_fx_settlement',
    );
    assert.equal(validateChinaMacroSnapshot(missingCore, now), false);

    const falseReady = structuredClone(snapshot);
    falseReady.status = 'ready';
    assert.equal(validateChinaMacroSnapshot(falseReady, now), false);

    const falsePillar = structuredClone(snapshot);
    falsePillar.pillars.find((pillar) => pillar.pillar === 'trade').direction = 'strengthening';
    assert.equal(validateChinaMacroSnapshot(falsePillar, now), false);

    const wrongCountry = structuredClone(snapshot);
    wrongCountry.countryCode = 'US';
    wrongCountry.observations.forEach((observation) => { observation.geography = 'US'; });
    assert.equal(validateChinaMacroSnapshot(wrongCountry, now), false);

    const malformedDecision = structuredClone(snapshot);
    malformedDecision.sourceDecisions[0].requestBudget = 999;
    assert.equal(validateChinaMacroSnapshot(malformedDecision, now), false);

    const zeroRequestDecision = structuredClone(snapshot);
    zeroRequestDecision.sourceDecisions[0].requestCount = 0;
    assert.equal(validateChinaMacroSnapshot(zeroRequestDecision, now), false);

    const optionalRequiredDecision = structuredClone(snapshot);
    optionalRequiredDecision.sourceDecisions[0].optional = true;
    assert.equal(validateChinaMacroSnapshot(optionalRequiredDecision, now), false);

    const stalePolicyReview = structuredClone(snapshot);
    stalePolicyReview.sourceDecisions[0].termsStatus = 'reviewed_attribution_required';
    assert.equal(validateChinaMacroSnapshot(stalePolicyReview, now), false);

    const unreviewedPath = structuredClone(snapshot);
    unreviewedPath.sourceDecisions[0].sourceUrl = 'https://www.stats.gov.cn/not-reviewed';
    assert.equal(validateChinaMacroSnapshot(unreviewedPath, now), false);

    const futureTransport = structuredClone(snapshot);
    futureTransport.transportLastSuccessAt = '2099-01-01T00:00:00.000Z';
    assert.equal(validateChinaMacroSnapshot(futureTransport, now), false);
    assert.equal(chinaMacroTransportMeta(futureTransport, now), null);

    const impossibleFirstRevision = structuredClone(snapshot);
    const firstObservation = impossibleFirstRevision.observations[0];
    firstObservation.revisionState = 'corrected';
    firstObservation.provenance.claims.revision.value.state = 'corrected';
    const firstVintage = firstObservation.vintages.find(
      (vintage) => vintage.vintageId === firstObservation.vintageId,
    );
    firstVintage.state = 'corrected';
    firstVintage.provenance.claims.revision.value.state = 'corrected';
    assert.equal(validateChinaMacroSnapshot(impossibleFirstRevision, now), false);

    const mismatchedVintage = structuredClone(snapshot);
    mismatchedVintage.observations[0].vintages[0].sourceUrl = 'https://www.stats.gov.cn/english/PressRelease/';
    assert.equal(validateChinaMacroSnapshot(mismatchedVintage, now), false);

    const coherentlyMismatchedVintage = structuredClone(snapshot);
    const activeVintage = coherentlyMismatchedVintage.observations[0].vintages[0];
    activeVintage.retrievalTime = '2026-07-25T13:30:00.000Z';
    activeVintage.provenance.claims.retrieval_time.value.value = activeVintage.retrievalTime;
    activeVintage.provenance.claims.transport_freshness.value.assessedAt = activeVintage.retrievalTime;
    activeVintage.provenance.claims.transport_freshness.value.lastSuccessAt = activeVintage.retrievalTime;
    activeVintage.provenance.claims.content_freshness.value.assessedAt = activeVintage.retrievalTime;
    assert.equal(validateChinaMacroSnapshot(coherentlyMismatchedVintage, now), false);

    const crossSeriesVintage = structuredClone(snapshot);
    const reassigned = crossSeriesVintage.observations[1].vintages[0];
    reassigned.seriesId = 'nbs_real_estate_investment_yoy';
    assert.equal(validateChinaMacroSnapshot(crossSeriesVintage, now), false);

    for (const malformedSet of [
      snapshot.observations.filter((observation) => observation.seriesId !== 'gacc_imports'),
      [...snapshot.observations, structuredClone(snapshot.observations.at(-1))],
      [...snapshot.observations, {
        ...structuredClone(snapshot.observations.at(-1)),
        seriesId: 'bogus_official_series',
      }],
    ]) {
      const malformed = structuredClone(snapshot);
      malformed.observations = malformedSet;
      assert.equal(validateChinaMacroSnapshot(malformed, now), false);
    }

    const falseAttribution = structuredClone(snapshot);
    const nbs = falseAttribution.observations[0];
    const safePublisher = falseAttribution.observations.find(
      (observation) => observation.seriesId === 'safe_fx_reserves',
    ).provenance.claims.publisher;
    nbs.sourceUrl = 'https://www.safe.gov.cn/safe/2026/0706/27661.html';
    nbs.provenance.claims.publisher = structuredClone(safePublisher);
    nbs.provenance.claims.source_url.value = nbs.sourceUrl;
    nbs.vintages.at(-1).sourceUrl = nbs.sourceUrl;
    nbs.vintages.at(-1).provenance.claims.publisher = structuredClone(safePublisher);
    nbs.vintages.at(-1).provenance.claims.source_url.value = nbs.sourceUrl;
    assert.equal(validateChinaMacroSnapshot(falseAttribution, now), false);

    const fabricatedBlocked = structuredClone(snapshot);
    const pboc = fabricatedBlocked.observations.find(
      (observation) => observation.seriesId === 'pboc_m2_yoy',
    );
    Object.assign(pboc, {
      value: 99,
      observationPeriod: '2026-06',
      releaseTime: '2026-07-10T00:00:00.000Z',
      retrievalTime,
      unavailableReason: '',
      transportStatus: 'fresh',
      transportFailureReason: '',
    });
    assert.equal(validateChinaMacroSnapshot(fabricatedBlocked, now), false);

    const acceptedWithError = structuredClone(snapshot);
    const acceptedNbs = acceptedWithError.observations[0];
    acceptedNbs.transportStatus = 'error';
    acceptedNbs.transportFailureReason = 'HTTP_503';
    acceptedNbs.provenance.claims.transport_freshness.value.state = 'error';
    acceptedNbs.vintages.at(-1).provenance.claims.transport_freshness.value.state = 'error';
    assert.equal(validateChinaMacroSnapshot(acceptedWithError, now), false);

    for (const field of ['contentObservationDate', 'latestObservationDate']) {
      const malformed = structuredClone(snapshot);
      malformed[field] = '2099-01';
      assert.equal(validateChinaMacroSnapshot(malformed, now), false);
    }

    const corrected = parseNbsIndustrialRelease(
      fixture('nbs-industrial.html').replace('increased by 5.3%', 'increased by 5.1%'),
      {
        retrievalTime,
        sourceUrl: snapshot.observations[0].sourceUrl,
        previousObservation: snapshot.observations[0],
      },
    );
    const correctedSnapshot = structuredClone(snapshot);
    correctedSnapshot.observations[0] = corrected;
    assert.equal(validateChinaMacroSnapshot(correctedSnapshot, now), true);
    const historicalPeriodKind = structuredClone(correctedSnapshot);
    historicalPeriodKind.observations[0].vintages[0].periodKind = 'quarter';
    assert.equal(validateChinaMacroSnapshot(historicalPeriodKind, now), false);
    const twoCurrent = structuredClone(correctedSnapshot);
    const oldVintage = twoCurrent.observations[0].vintages[0];
    oldVintage.supersededBy = '';
    oldVintage.provenance.claims.supersession = {
      status: 'known',
      value: { state: 'current' },
    };
    assert.equal(validateChinaMacroSnapshot(twoCurrent, now), false);

    const splitTransport = structuredClone(snapshot);
    const nextDay = '2026-07-26T14:30:00.000Z';
    splitTransport.generatedAt = nextDay;
    splitTransport.transportLastSuccessAt = nextDay;
    const nbsDecision = splitTransport.sourceDecisions.find(
      (decision) => decision.publisherId === 'publisher:nbs-cn',
    );
    nbsDecision.checkedAt = nextDay;
    const safeDecision = splitTransport.sourceDecisions.find(
      (decision) => decision.publisherId === 'publisher:safe-cn',
    );
    safeDecision.checkedAt = nextDay;
    safeDecision.status = 'blocked';
    safeDecision.reason = 'HTTP_503';
    safeDecision.requestCount = 2;
    for (const observation of splitTransport.observations) {
      if (observation.seriesId.startsWith('nbs_')) {
        observation.retrievalTime = nextDay;
        observation.provenance.claims.retrieval_time.value.value = nextDay;
        observation.vintages.at(-1).retrievalTime = nextDay;
        observation.vintages.at(-1).provenance.claims.retrieval_time.value.value = nextDay;
      }
      if (observation.seriesId.startsWith('safe_')) {
        observation.transportStatus = 'error';
        observation.transportFailureReason = 'HTTP_503';
      }
    }
    assert.equal(
      validateChinaMacroSnapshot(splitTransport, Date.parse(nextDay)),
      false,
    );
  });
});
