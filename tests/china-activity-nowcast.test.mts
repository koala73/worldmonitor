import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_ACTIVITY_NOWCAST_METHOD_VERSION,
  CHINA_ACTIVITY_PROXY_REGISTRY,
  backtestChinaActivityNowcast,
  evaluateChinaActivityNowcast,
  parseChinaActivityNowcastWirePayload,
  type ChinaActivityOfficialObservation,
  type ChinaActivityProxyObservation,
} from '../shared/china-activity-nowcast';

const EVALUATED_AT = '2026-07-25T12:00:00.000Z';

function official(
  overrides: Partial<ChinaActivityOfficialObservation> = {},
): ChinaActivityOfficialObservation {
  return {
    seriesId: 'nbs_industrial_value_added_yoy',
    label: 'Industrial value added, year over year',
    vintageId: 'nbs_industrial_value_added_yoy:2026-06:r1',
    observationPeriod: '2026-06',
    periodEnd: '2026-06-30T23:59:59.000Z',
    releaseTime: '2026-07-17T02:00:00.000Z',
    retrievalTime: '2026-07-17T02:05:00.000Z',
    direction: 'strengthening',
    value: 6.8,
    unit: '%',
    available: true,
    stale: false,
    provenance: {
      familyId: 'china_macro_official_numeric_observation',
      signalId: 'signal:nbs-industrial-2026-06-r1',
    },
    ...overrides,
  };
}

function proxy(
  seriesId: string,
  value = 1,
  overrides: Partial<ChinaActivityProxyObservation> = {},
): ChinaActivityProxyObservation {
  return {
    seriesId,
    observationId: `${seriesId}:2026-07-24`,
    observedAt: '2026-07-25T10:00:00.000Z',
    releasedAt: '2026-07-25T10:30:00.000Z',
    retrievedAt: '2026-07-25T10:35:00.000Z',
    value,
    priorValue: null,
    available: true,
    stale: false,
    structuralBreak: false,
    provenance: {
      publisherId: `publisher:${seriesId}`,
      sourceUrl: `https://example.test/${seriesId}`,
    },
    ...overrides,
  };
}

const directionalDefinitions = [
  CHINA_ACTIVITY_PROXY_REGISTRY[0]!,
  CHINA_ACTIVITY_PROXY_REGISTRY[1]!,
  CHINA_ACTIVITY_PROXY_REGISTRY[2]!,
  CHINA_ACTIVITY_PROXY_REGISTRY[4]!,
] as const;

function directionalProxies(direction = 1): ChinaActivityProxyObservation[] {
  return directionalDefinitions.map((definition) =>
    proxy(definition.id, direction));
}

describe('China activity nowcast method contract (#5579)', () => {
  it('publishes a reviewed, inspectable registry for every required proxy family', () => {
    assert.deepEqual(
      CHINA_ACTIVITY_PROXY_REGISTRY.map((definition) => definition.family),
      ['freight', 'maritime', 'aviation', 'energy', 'commodity', 'corridor', 'market'],
    );
    assert.equal(
      new Set(CHINA_ACTIVITY_PROXY_REGISTRY.map((definition) => definition.id)).size,
      CHINA_ACTIVITY_PROXY_REGISTRY.length,
    );
    for (const definition of CHINA_ACTIVITY_PROXY_REGISTRY) {
      assert.ok(definition.decisionRationale.length >= 40, `${definition.id} rationale`);
      assert.ok(definition.unit.length > 0, `${definition.id} unit`);
      assert.ok(definition.frequency.length > 0, `${definition.id} frequency`);
      assert.ok(definition.lagRule.description.length >= 20, `${definition.id} lag`);
      assert.ok(definition.freshnessBudgetMinutes > 0, `${definition.id} freshness`);
      assert.equal(definition.alignment.forwardFill, false);
      assert.equal(definition.alignment.interpolate, false);
      assert.ok(definition.source.publisherId.startsWith('publisher:'));
      assert.ok(definition.source.provenance.length >= 20);
      assert.match(definition.source.url, /^https:/);
    }
  });

  it('classifies agreement without emitting an unexplained aggregate score', () => {
    const result = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official()],
      proxyObservations: directionalProxies(1),
    });

    assert.equal(result.methodVersion, CHINA_ACTIVITY_NOWCAST_METHOD_VERSION);
    assert.equal(result.state, 'agreement');
    assert.equal(result.official?.vintageId, 'nbs_industrial_value_added_yoy:2026-06:r1');
    assert.equal(result.contributions.filter((item) => item.included).length, 4);
    assert.equal(result.missingInputs.length, 3);
    assert.ok(!('score' in result));
    assert.ok(result.contributions.every((item) => 'transformedValue' in item));
    assert.ok(result.contributions.every((item) => item.registry.decisionRationale.length > 0));
  });

  it('distinguishes proxy-leading, official-leading, mixed, and insufficient states', () => {
    const proxyLeading = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official()],
      proxyObservations: directionalProxies(-1),
    });
    assert.equal(proxyLeading.state, 'proxy_leading_divergence');

    const officialLeading = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official({
        periodEnd: '2026-07-25T10:15:00.000Z',
        releaseTime: '2026-07-25T10:20:00.000Z',
        retrievalTime: '2026-07-25T10:25:00.000Z',
      })],
      proxyObservations: directionalProxies(-1),
    });
    assert.equal(officialLeading.state, 'official_leading_divergence');

    const mixed = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official()],
      proxyObservations: directionalProxies(1).map((item, index) => ({
        ...item,
        value: index % 2 === 0 ? 1 : -1,
      })),
    });
    assert.equal(mixed.state, 'mixed_signals');

    const insufficient = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official()],
      proxyObservations: directionalProxies(1).slice(0, 2),
    });
    assert.equal(insufficient.state, 'insufficient_data');
    assert.equal(insufficient.confidence.level, 'insufficient');
    assert.match(insufficient.confidence.reason, /3 non-flat proxy families/i);
  });

  it('selects only the official vintage and proxy records available at evaluation time', () => {
    const firstVintage = official({
      vintageId: 'nbs_industrial_value_added_yoy:2026-06:r1',
      direction: 'strengthening',
      retrievalTime: '2026-07-17T02:05:00.000Z',
    });
    const laterRevision = official({
      vintageId: 'nbs_industrial_value_added_yoy:2026-06:r2',
      direction: 'weakening',
      releaseTime: '2026-07-26T02:00:00.000Z',
      retrievalTime: '2026-07-26T02:05:00.000Z',
    });
    const futureProxy = proxy(CHINA_ACTIVITY_PROXY_REGISTRY[0]!.id, -1, {
      observationId: 'future-record',
      retrievedAt: '2026-07-26T01:05:00.000Z',
    });
    const result = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [firstVintage, laterRevision],
      proxyObservations: [...directionalProxies(1), futureProxy],
    });

    assert.equal(result.official?.vintageId, firstVintage.vintageId);
    assert.equal(result.state, 'agreement');
    assert.ok(result.audit.excludedFutureObservationIds.includes('future-record'));
  });

  it('never forward-fills, interpolates, or converts stale and structurally broken inputs to neutral', () => {
    const stale = proxy(CHINA_ACTIVITY_PROXY_REGISTRY[0]!.id, 1, {
      stale: true,
    });
    const old = proxy(CHINA_ACTIVITY_PROXY_REGISTRY[1]!.id, 1, {
      observedAt: '2025-01-01T00:00:00.000Z',
      releasedAt: '2025-01-02T00:00:00.000Z',
      retrievedAt: '2025-01-02T00:05:00.000Z',
    });
    const broken = proxy(CHINA_ACTIVITY_PROXY_REGISTRY[2]!.id, 1, {
      structuralBreak: true,
    });
    const result = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      comparisonWindowDays: 90,
      officialObservations: [official()],
      proxyObservations: [stale, old, broken],
    });

    assert.equal(result.state, 'insufficient_data');
    assert.deepEqual(
      result.contributions.slice(0, 3).map((item) => item.exclusionReason),
      ['marked_stale', 'outside_comparison_window_no_fill', 'structural_break'],
    );
    assert.ok(result.contributions.slice(0, 3).every((item) => item.direction === null));
  });

  it('applies a documented lag before checking the comparison window', () => {
    const energy = CHINA_ACTIVITY_PROXY_REGISTRY.find((item) => item.family === 'energy')!;
    const result = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      comparisonWindowDays: 90,
      officialObservations: [official()],
      proxyObservations: [
        proxy(energy.id, 1, {
          observedAt: '2026-04-21T10:00:00.000Z',
          releasedAt: '2026-04-21T10:30:00.000Z',
          retrievedAt: '2026-04-21T10:35:00.000Z',
        }),
      ],
    });

    const contribution = result.contributions.find((item) => item.family === 'energy');
    assert.equal(contribution?.included, true);
    assert.equal(contribution?.alignedAt, '2026-05-21T10:00:00.000Z');
  });

  it('explains non-directional official releases without claiming missing inputs', () => {
    const result = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official({ direction: 'unchanged' })],
      proxyObservations: directionalProxies(1),
    });

    assert.equal(result.state, 'insufficient_data');
    assert.equal(result.confidence.eligibleFamilies, 4);
    assert.match(result.confidence.reason, /official vintage is unchanged/i);
  });

  it('reports leave-one-family-out sensitivity when a family can change the conclusion', () => {
    const result = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official()],
      proxyObservations: CHINA_ACTIVITY_PROXY_REGISTRY.slice(0, 3).map((definition, index) =>
        proxy(definition.id, index < 2 ? 1 : -1)),
    });

    assert.equal(result.state, 'agreement');
    assert.ok(result.sensitivity.some((item) => item.changesConclusion));
    assert.ok(result.sensitivity.every((item) => item.stateWithoutFamily.length > 0));
  });

  it('backtests point-in-time evaluations with coverage and directional agreement', () => {
    const evaluationTimes = [
      '2026-01-15T12:00:00.000Z',
      '2026-02-15T12:00:00.000Z',
      '2026-03-15T12:00:00.000Z',
    ];
    const officialHistory = [
      official({
        vintageId: 'industrial:2026-01:r1',
        observationPeriod: '2026-01',
        periodEnd: '2026-01-31T23:59:59.000Z',
        releaseTime: '2026-02-10T02:00:00.000Z',
        retrievalTime: '2026-02-10T02:05:00.000Z',
        direction: 'strengthening',
      }),
      official({
        vintageId: 'industrial:2026-02:r1',
        observationPeriod: '2026-02',
        periodEnd: '2026-02-28T23:59:59.000Z',
        releaseTime: '2026-03-10T02:00:00.000Z',
        retrievalTime: '2026-03-10T02:05:00.000Z',
        direction: 'weakening',
      }),
    ];
    const proxyHistory = directionalDefinitions.flatMap((definition) => [
      proxy(definition.id, 1, {
        observationId: `${definition.id}:2026-02`,
        observedAt: '2026-02-15T10:00:00.000Z',
        releasedAt: '2026-02-15T10:30:00.000Z',
        retrievedAt: '2026-02-15T10:35:00.000Z',
      }),
      proxy(definition.id, 1, {
        observationId: `${definition.id}:2026-03`,
        observedAt: '2026-03-15T10:00:00.000Z',
        releasedAt: '2026-03-15T10:30:00.000Z',
        retrievedAt: '2026-03-15T10:35:00.000Z',
      }),
    ]);
    const result = backtestChinaActivityNowcast({
      evaluationTimes,
      officialObservations: officialHistory,
      proxyObservations: proxyHistory,
    });

    assert.equal(result.noLookahead, true);
    assert.equal(result.attempted, 3);
    assert.equal(result.evaluated, 2);
    assert.equal(result.coverage, 2 / 3);
    assert.equal(result.directionalAgreement, 0.5);
    assert.deepEqual(result.rows.map((row) => row.officialVintageId), [
      null,
      'industrial:2026-01:r1',
      'industrial:2026-02:r1',
    ]);
  });

  it('rejects wire payloads whose method or nested shape is not reproducible', () => {
    const response = evaluateChinaActivityNowcast({
      evaluatedAt: EVALUATED_AT,
      officialObservations: [official()],
      proxyObservations: directionalProxies(1),
    });
    assert.deepEqual(parseChinaActivityNowcastWirePayload(JSON.stringify(response)), response);
    assert.throws(
      () => parseChinaActivityNowcastWirePayload(JSON.stringify({
        ...response,
        methodVersion: 'china-activity-nowcast/v999',
      })),
      /Invalid China activity nowcast response/,
    );
    assert.throws(
      () => parseChinaActivityNowcastWirePayload(JSON.stringify({
        ...response,
        contributions: [{ injected: true }],
      })),
      /Invalid China activity nowcast response/,
    );
    assert.throws(
      () => parseChinaActivityNowcastWirePayload(JSON.stringify({
        ...response,
        comparisonWindow: {
          ...response.comparisonWindow,
          startsAt: response.evaluatedAt,
        },
      })),
      /Invalid China activity nowcast response/,
    );
    assert.throws(
      () => parseChinaActivityNowcastWirePayload(JSON.stringify({
        ...response,
        confidence: {
          ...response.confidence,
          level: 'high',
          reason: 'tampered',
        },
        sensitivity: response.sensitivity.map((item) => ({
          ...item,
          stateWithoutFamily: response.state,
          changesConclusion: false,
        })),
      })),
      /Invalid China activity nowcast response/,
    );
    const tamperedRegistry = structuredClone(response);
    tamperedRegistry.contributions[0]!.registry = {
      ...tamperedRegistry.contributions[0]!.registry,
      source: {
        ...tamperedRegistry.contributions[0]!.registry.source,
        url: 'javascript:alert(1)',
      },
    };
    assert.equal(
      parseChinaActivityNowcastWirePayload(
        JSON.stringify(tamperedRegistry),
      ).contributions[0]!.registry.source.url,
      CHINA_ACTIVITY_PROXY_REGISTRY[0]!.source.url,
    );
    assert.throws(
      () => parseChinaActivityNowcastWirePayload(JSON.stringify({
        ...response,
        sensitivity: [{ family: 'freight' }],
      })),
      /Invalid China activity nowcast response/,
    );
  });
});
