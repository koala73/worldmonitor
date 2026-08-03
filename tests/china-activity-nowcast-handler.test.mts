import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_ACTIVITY_NOWCAST_MARKET_KEYS,
  CHINA_ACTIVITY_NOWCAST_TTL_SECONDS,
  buildChinaActivityNowcastInputs,
  composeChinaActivityNowcastSnapshot,
  projectChinaActivityNowcastWireResponse,
  resolveChinaActivityNowcastSnapshot,
} from '../server/worldmonitor/economic/v1/get-china-activity-nowcast';
import {
  evaluateChinaActivityNowcast,
  parseChinaActivityNowcastWirePayload,
  type ChinaActivityComparisonState,
} from '../shared/china-activity-nowcast';
import type {
  ChinaCorridorControlTowerResponse,
  ChinaCorridorCondition,
  CorridorSourceSignal,
} from '../shared/china-corridor-control-towers';

const EVALUATED_AT = '2026-07-25T12:00:00.000Z';

function macroSnapshot() {
  return {
    countryCode: 'CN',
    generatedAt: EVALUATED_AT,
    status: 'available',
    launchReady: true,
    contentObservationDate: '2026-06',
    latestObservationDate: '2026-06',
    indicators: [{
      id: 'nbs_industrial_value_added_yoy',
      label: 'Industrial value added, year over year',
      category: 'activity',
      value: 6.8,
      hasValue: true,
      priorValue: 0,
      hasPriorValue: false,
      unit: '%',
      observationDate: '2026-06',
      source: 'National Bureau of Statistics of China',
      sourceUrl: 'https://www.stats.gov.cn/english/PressRelease/',
      stale: false,
      unavailableReason: '',
      contextOnly: false,
      geography: 'CN',
      seasonalAdjustment: 'not_seasonally_adjusted',
      periodKind: 'month',
      observationPeriod: '2026-06',
      releaseTime: '2026-07-17T02:00:00.000Z',
      retrievalTime: '2026-07-17T02:05:00.000Z',
      direction: 'strengthening',
      directionReason: 'POSITIVE_PERIOD_COMPARISON',
      comparisonBasis: 'year_over_year',
      comparisonValue: 0.4,
      hasComparisonValue: true,
      revisionState: 'original',
      vintageId: 'nbs_industrial_value_added_yoy:2026-06:r1',
      revisionSequence: 1,
      provenanceJson: JSON.stringify({
        familyId: 'china_macro_official_numeric_observation',
        signalId: 'signal:nbs-industrial-2026-06-r1',
      }),
      vintages: [],
      transportStatus: 'fresh',
      transportFailureReason: '',
    }],
    sourceDecisions: [],
    releaseEvents: [],
    unavailable: false,
    schemaVersion: 2,
    pillars: [],
  };
}

function signal(
  id: string,
  family: CorridorSourceSignal['family'],
  metrics: CorridorSourceSignal['metrics'],
): CorridorSourceSignal {
  return {
    id,
    family,
    selectorId: id,
    availability: 'available',
    publisher: {
      id: `publisher:${family}`,
      name: `Reviewed ${family} publisher`,
      type: 'official',
    },
    sourceUrl: `https://example.test/${family}`,
    sourceScope: 'national',
    observationTime: '2026-07-25T10:00:00.000Z',
    observationTimePrecision: 'instant',
    releaseTime: '2026-07-25T10:10:00.000Z',
    releaseTimePrecision: 'instant',
    retrievalTime: '2026-07-25T10:15:00.000Z',
    retrievalTimePrecision: 'instant',
    revision: null,
    transportFreshness: 'fresh',
    contentFreshness: 'current',
    summary: `${family} signal`,
    metrics,
  };
}

function condition(
  family: CorridorSourceSignal['family'],
  sourceSignals: CorridorSourceSignal[],
): ChinaCorridorCondition {
  return {
    family,
    providerId: `provider:${family}`,
    availability: 'available',
    reason: null,
    sourceSignals,
    provenance: {
      contractVersion: 'decision-signal-provenance/v1',
      familyId: 'china_logistics_corridor_observation',
      signalId: `signal:${family}`,
      source: {
        publisher: { id: `publisher:${family}`, name: family, type: 'official' },
        url: `https://example.test/${family}`,
      },
      claims: {},
    } as never,
  };
}

// The energy family's own coverage clock (latest source observation across the
// spine) is deliberately unrelated to the demand series' period, so fixtures
// keep the two independent.
const ENERGY_COVERAGE_OBSERVATION_TIME = '2026-07-01T00:00:00.000Z';

function energySignal(
  metrics: CorridorSourceSignal['metrics'],
  observationTime: string = ENERGY_COVERAGE_OBSERVATION_TIME,
): CorridorSourceSignal {
  return {
    ...signal('energy', 'power_energy', metrics),
    observationTime,
    observationTimePrecision: 'month',
  };
}

/** `undefined` in `overrides` omits that metric entirely. */
function publishedDemandChangeMetrics(
  overrides: Record<string, string | number | boolean | null | undefined> = {},
): CorridorSourceSignal['metrics'] {
  const merged: Record<string, string | number | boolean | null | undefined> = {
    hasJodiOil: true,
    hasEmber: true,
    demandPeriodEnd: '2026-04-30T23:59:59.999Z',
    demandChangePercent: 3.4,
    demandChangeBasis: 'year_over_year',
    demandChangeUnit: '% change',
    demandChangeCurrentMonth: '2026-04',
    demandChangePriorMonth: '2025-04',
    demandChangePeriodEnd: '2026-04-30T23:59:59.999Z',
    demandChangePriorPeriodEnd: '2025-04-30T23:59:59.999Z',
    demandChangeProductCount: 4,
    demandChangeProducts: '["diesel","fuelOil","gasoline","jet"]',
    demandChangeCurrentDemandKbd: 103.4,
    demandChangePriorDemandKbd: 100,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as CorridorSourceSignal['metrics'];
}

/**
 * Coverage booleans plus the demand series' published period end — the shape
 * the spine emits when the month is due but no change was observed for it.
 */
function coverageOnlyMetrics(
  overrides: CorridorSourceSignal['metrics'] = {},
): CorridorSourceSignal['metrics'] {
  return {
    hasJodiOil: true,
    demandPeriodEnd: '2026-04-30T23:59:59.999Z',
    ...overrides,
  };
}

function corridorSnapshot(
  energy: CorridorSourceSignal,
): ChinaCorridorControlTowerResponse {
  return {
    generatedAt: EVALUATED_AT,
    corridors: [{
      id: 'china-yangtze-river-delta',
      name: 'Yangtze River Delta',
      description: 'Reviewed fixture corridor.',
      boundary: [],
      nodes: [],
      availability: 'partial',
      conditions: [
        condition('port', [
          signal('port:shanghai', 'port', { trendDelta: 2 }),
          signal('port:ningbo', 'port', { trendDelta: 1 }),
        ]),
        condition('aviation', [
          signal('aviation:pvg', 'aviation', { providerStatus: 'normal' }),
          signal('aviation:hkg', 'aviation', { providerStatus: 'disruption' }),
          signal('aviation:can', 'aviation', { providerStatus: 'normal' }),
        ]),
        condition('trade', [
          {
            ...signal('ccfi', 'trade', {
              currentValue: 1072.16,
              periodChangePct: 1.69,
              periodChangeBasis: 'publisher_reported',
              priorPeriodValue: 1054.38,
              priorPeriodDate: '2026-07-18',
              unit: 'index',
            }),
            selectorId: 'supply_chain:shipping:v2:CCFI',
          },
        ]),
        condition('power_energy', [energy]),
      ],
    }],
  };
}

function energyInputs(corridors: ChinaCorridorControlTowerResponse) {
  return buildChinaActivityNowcastInputs({
    evaluatedAt: EVALUATED_AT,
    macro: macroSnapshot() as never,
    corridors,
    marketValues: marketValues(),
  });
}

/** The observation as emitted by the adapter, before the evaluator filters it. */
function energyObservation(corridors: ChinaCorridorControlTowerResponse) {
  return energyInputs(corridors).proxyObservations
    .find((item) => item.seriesId === 'china_energy_demand_change');
}

function energyContribution(corridors: ChinaCorridorControlTowerResponse) {
  return evaluateChinaActivityNowcast({
    evaluatedAt: EVALUATED_AT,
    ...energyInputs(corridors),
  }).contributions.find((item) => item.seriesId === 'china_energy_demand_change');
}

function marketValues() {
  return new Map<string, unknown>([
    [CHINA_ACTIVITY_NOWCAST_MARKET_KEYS.commodities, {
      quotes: [
        { symbol: 'HG=F', change: 2.2 },
        { symbol: 'ALI=F', change: 0.8 },
      ],
    }],
    [CHINA_ACTIVITY_NOWCAST_MARKET_KEYS.commoditiesMeta, {
      fetchedAt: Date.parse('2026-07-25T10:30:00.000Z'),
    }],
    [CHINA_ACTIVITY_NOWCAST_MARKET_KEYS.stockIndex, {
      available: true,
      code: 'CN',
      symbol: '000001.SS',
      indexName: 'SSE Composite',
      price: 3355,
      weekChangePercent: 1.67,
      currency: 'CNY',
      fetchedAt: '2026-07-25T10:30:00.000Z',
    }],
  ]);
}

describe('China activity nowcast cache/API composition (#5579)', () => {
  it('adapts official, corridor, commodity, and market contracts without inventing unavailable changes', () => {
    const inputs = buildChinaActivityNowcastInputs({
      evaluatedAt: EVALUATED_AT,
      macro: macroSnapshot() as never,
      corridors: corridorSnapshot(energySignal(publishedDemandChangeMetrics())),
      marketValues: marketValues(),
    });

    assert.equal(inputs.officialObservations[0]?.vintageId, 'nbs_industrial_value_added_yoy:2026-06:r1');
    assert.equal(inputs.officialObservations[0]?.direction, 'strengthening');
    assert.deepEqual(
      inputs.proxyObservations.filter((item) => item.value !== null).map((item) => item.seriesId),
      [
        'portwatch_tanker_calls_trend',
        'aviation_hub_disruption_balance',
        'ccfi_freight_rate_change',
        'china_energy_demand_change',
        'china_input_commodity_change',
        'sse_composite_week_change',
      ],
    );
    const freight = inputs.proxyObservations
      .find((item) => item.seriesId === 'ccfi_freight_rate_change');
    assert.equal(freight?.value, 1.69);
    assert.deepEqual(freight?.provenance, {
      sourceSignalIds: ['ccfi'],
      publishers: [{ id: 'publisher:trade', name: 'Reviewed trade publisher', type: 'official' }],
      sourceUrls: ['https://example.test/trade'],
      observationTimes: ['2026-07-25T10:00:00.000Z'],
      currentLevel: 1072.16,
      priorPeriodLevel: 1054.38,
      priorPeriodDate: '2026-07-18',
      periodChangeBasis: 'publisher_reported',
    });
    assert.equal(
      inputs.proxyObservations.find((item) => item.seriesId === 'corridor_activity_breadth_change')?.value,
      null,
    );
  });

  it('publishes the observed energy-demand change and keeps coverage-only signals excluded (#6067)', () => {
    const published = energyContribution(
      corridorSnapshot(energySignal(publishedDemandChangeMetrics())),
    );
    assert.equal(published?.included, true);
    assert.equal(published?.rawValue, 3.4);
    assert.equal(published?.transformedValue, 3.4);
    assert.equal(published?.direction, 'strengthening');
    assert.equal(published?.exclusionReason, null);
    // The change carries its own period end, not the spine's latest source time.
    assert.equal(published?.observedAt, '2026-04-30T23:59:59.999Z');
    assert.equal(published?.alignedAt, '2026-05-30T23:59:59.999Z');
    const provenance = published?.provenance as Record<string, unknown>;
    assert.equal(provenance.demandChangeBasis, 'year_over_year');
    assert.equal(provenance.periodEnd, '2026-04-30T23:59:59.999Z');
    assert.equal(provenance.priorPeriodEnd, '2025-04-30T23:59:59.999Z');
    assert.equal(provenance.observationPeriod, '2026-04');
    assert.equal(provenance.priorObservationPeriod, '2025-04');
    assert.equal(provenance.demandChangeUnit, '% change');
    assert.deepEqual(provenance.products, ['diesel', 'fuelOil', 'gasoline', 'jet']);
    assert.equal(provenance.currentDemandKbd, 103.4);
    assert.equal(provenance.priorDemandKbd, 100);
    assert.equal(provenance.exclusion, undefined);

    const weakening = energyContribution(corridorSnapshot(energySignal(
      publishedDemandChangeMetrics({
        demandChangePercent: -2.1,
        demandChangeCurrentDemandKbd: 97.9,
      }),
    )));
    assert.equal(weakening?.included, true);
    assert.equal(weakening?.direction, 'weakening');

    const coverageOnly = energyContribution(corridorSnapshot(
      energySignal(coverageOnlyMetrics({ hasMix: true, hasJodiGas: true, hasEmber: true })),
    ));
    assert.equal(coverageOnly?.included, false);
    assert.equal(coverageOnly?.rawValue, null);
    assert.equal(coverageOnly?.exclusionReason, 'missing_directional_value');
    assert.equal(
      (coverageOnly?.provenance as Record<string, unknown>).exclusion,
      'directional_demand_change_not_published',
    );
  });

  it('keeps the three-family floor honest when energy coverage has no direction (#6067)', () => {
    const directionalSeries = new Set([
      'portwatch_tanker_calls_trend',
      'ccfi_freight_rate_change',
      'china_energy_demand_change',
    ]);
    const selectFloor = (corridors: ChinaCorridorControlTowerResponse) => {
      const inputs = energyInputs(corridors);
      return {
        officialObservations: inputs.officialObservations,
        proxyObservations: inputs.proxyObservations
          .filter((item) => directionalSeries.has(item.seriesId)),
      };
    };

    const coverageOnly = selectFloor(corridorSnapshot(energySignal(coverageOnlyMetrics())));
    const withheld = evaluateChinaActivityNowcast({ evaluatedAt: EVALUATED_AT, ...coverageOnly });
    assert.equal(withheld.state, 'insufficient_data');
    assert.equal(withheld.confidence.eligibleFamilies, 2);
    assert.match(withheld.confidence.reason, /3 non-flat proxy families/i);

    const published = selectFloor(corridorSnapshot(energySignal(publishedDemandChangeMetrics())));
    const restored = evaluateChinaActivityNowcast({ evaluatedAt: EVALUATED_AT, ...published });
    assert.equal(restored.state, 'agreement');
    assert.equal(restored.confidence.eligibleFamilies, 3);
  });

  it('keeps lag_not_elapsed and missing_directional_value distinguishable (#6067)', () => {
    // Both reasons must be true statements about the DEMAND SERIES, so both are
    // measured against its own period end. The family's coverage clock is
    // deliberately varied in the opposite direction throughout this test: if
    // the reason ever tracked coverage instead, these assertions invert.
    const coverageOnly = (demandPeriodEnd: string, coverageObservedAt: string) =>
      energyContribution(corridorSnapshot(energySignal(
        { hasJodiOil: true, demandPeriodEnd },
        coverageObservedAt,
      )));

    // The demand month ended 5 days ago: its change is genuinely not due yet.
    // Stale coverage must not turn that into a claim the value was withheld.
    assert.equal(
      coverageOnly('2026-07-20T23:59:59.999Z', '2026-01-01T00:00:00.000Z')?.exclusionReason,
      'lag_not_elapsed',
    );

    // The demand month ended ~3 months ago: it is due, and nothing was
    // published. Fresh coverage must not excuse that as a pending lag.
    assert.equal(
      coverageOnly('2026-04-30T23:59:59.999Z', '2026-07-24T00:00:00.000Z')?.exclusionReason,
      'missing_directional_value',
    );

    // The exact boundary: 30 days and one millisecond after the period end is
    // elapsed; exactly 30 days is not.
    assert.equal(
      coverageOnly('2026-06-25T11:59:59.999Z', ENERGY_COVERAGE_OBSERVATION_TIME)?.exclusionReason,
      'missing_directional_value',
    );
    assert.equal(
      coverageOnly('2026-06-25T12:00:00.001Z', ENERGY_COVERAGE_OBSERVATION_TIME)?.exclusionReason,
      'lag_not_elapsed',
    );

    // A published change whose own period end is inside the lag window is still
    // a lag exclusion — publishing a value must not skip the lag rule.
    const publishedInLagWindow = energyContribution(corridorSnapshot(energySignal(
      publishedDemandChangeMetrics({
        demandChangeCurrentMonth: '2026-06',
        demandChangePriorMonth: '2025-06',
        demandChangePeriodEnd: '2026-06-30T23:59:59.999Z',
        demandChangePriorPeriodEnd: '2025-06-30T23:59:59.999Z',
      }),
      '2026-04-01T00:00:00.000Z',
    )));
    assert.equal(publishedInLagWindow?.rawValue, 3.4);
    assert.equal(publishedInLagWindow?.exclusionReason, 'lag_not_elapsed');
  });

  it('never turns an energy coverage boolean into a contribution (#6067)', () => {
    // Each case is chosen so that dropping the guard under test WOULD produce
    // an included, directional contribution — an inert case proves nothing.
    const mutations: Array<{
      label: string;
      signal: CorridorSourceSignal;
      reason?: string;
    }> = [
      { label: 'coverage true', signal: energySignal(coverageOnlyMetrics()) },
      { label: 'coverage false', signal: energySignal(coverageOnlyMetrics({ hasJodiOil: false })) },
      {
        label: 'every coverage flag',
        signal: energySignal(coverageOnlyMetrics({
          hasMix: true, hasJodiGas: true, hasIeaStocks: true, hasEmber: true,
        })),
      },
      // Truthy non-boolean coverage shapes must not be read as a change either.
      { label: 'numeric coverage', signal: energySignal(coverageOnlyMetrics({ hasJodiOil: 1 })) },
      { label: 'string coverage', signal: energySignal(coverageOnlyMetrics({ hasJodiOil: 'true' })) },
      { label: 'negative coverage', signal: energySignal(coverageOnlyMetrics({ hasEmber: -1 })) },
      // A partially published change is not a published change. Each of these
      // would otherwise land inside the comparison window and be included.
      {
        label: 'percentage without a period end',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangePeriodEnd: undefined,
        })),
      },
      {
        label: 'percentage without a basis',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangeBasis: undefined,
        })),
      },
      {
        label: 'percentage without a period label',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangeCurrentMonth: undefined,
        })),
      },
      {
        label: 'period end without a percentage',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangePercent: undefined,
        })),
      },
      {
        label: 'non-numeric percentage',
        signal: energySignal(publishedDemandChangeMetrics({ demandChangePercent: 'up' })),
      },
      {
        label: 'volume unit on percentage',
        signal: energySignal(publishedDemandChangeMetrics({ demandChangeUnit: 'kbd' })),
      },
      {
        label: 'too-small product basket',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangeProductCount: 2,
          demandChangeProducts: '["diesel","gasoline"]',
        })),
      },
      {
        label: 'implausible percentage',
        signal: energySignal(publishedDemandChangeMetrics({ demandChangePercent: 51 })),
      },
      {
        label: 'arithmetic mismatch',
        signal: energySignal(publishedDemandChangeMetrics({ demandChangeCurrentDemandKbd: 104 })),
      },
      {
        label: 'period label/timestamp mismatch',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangeCurrentMonth: '2026-03',
          demandChangePeriodEnd: '2026-04-30T23:59:59.999Z',
        })),
      },
      {
        label: 'unparseable period end',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangePeriodEnd: 'not-a-timestamp',
        })),
      },
      {
        // An epoch number is not the published period-end contract; accepting
        // one would let an unrelated numeric metric date the observation.
        label: 'epoch-number period end',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangePeriodEnd: Date.parse('2026-04-30T23:59:59.999Z'),
        })),
      },
      {
        // The signal envelope is coherent, but the change claims a period that
        // ended after the snapshot was retrieved — it cannot have existed yet.
        // The family must still report the missing direction rather than
        // disappearing behind an incoherently dated observation.
        label: 'period end after retrieval',
        signal: {
          ...energySignal(publishedDemandChangeMetrics({
            demandChangeCurrentMonth: '2026-06',
            demandChangePriorMonth: '2025-06',
            demandChangePeriodEnd: '2026-06-30T23:59:59.999Z',
            demandChangePriorPeriodEnd: '2025-06-30T23:59:59.999Z',
          }), '2026-05-01T00:00:00.000Z'),
          releaseTime: '2026-05-15T00:00:00.000Z',
          retrievalTime: '2026-05-15T00:00:00.000Z',
        },
        reason: 'missing_directional_value',
      },
      {
        // Released after retrieval is an incoherent envelope.
        label: 'released after retrieval',
        signal: {
          ...energySignal(publishedDemandChangeMetrics()),
          releaseTime: '2026-07-25T10:20:00.000Z',
          retrievalTime: '2026-07-25T10:15:00.000Z',
        },
      },
      {
        // Retrieved after the evaluation instant would be a look-ahead.
        label: 'retrieved after evaluation',
        signal: {
          ...energySignal(publishedDemandChangeMetrics()),
          releaseTime: '2026-07-26T10:10:00.000Z',
          retrievalTime: '2026-07-26T10:15:00.000Z',
        },
      },
      {
        // An undated snapshot must not be read as "retrieved now" — that would
        // manufacture freshness the source never claimed.
        label: 'no retrieval timestamp',
        signal: {
          ...energySignal(publishedDemandChangeMetrics()),
          releaseTime: null,
          retrievalTime: null,
        },
      },
      {
        // A seasonal comparison wearing the reviewed name is not the reviewed
        // comparison.
        label: 'non-reviewed basis',
        signal: energySignal(publishedDemandChangeMetrics({
          demandChangeBasis: 'month_over_month',
        })),
      },
    ];

    for (const { label, signal: energy, reason } of mutations) {
      const corridors = corridorSnapshot(energy);
      // Assert on the ADAPTER's own output, not only the evaluated
      // contribution: several of these shapes are also caught by the
      // evaluator's generic timestamp filter, so a contribution-only assertion
      // would pass even with the adapter's guard deleted.
      // Refusal takes one of two truthful shapes: an observation carrying an
      // explicit "not published" provenance, or — when the envelope is too
      // incoherent to date at all — no observation of this series.
      const observation = energyObservation(corridors);
      assert.equal(
        observation === undefined || observation.value === null,
        true,
        `${label} must not be published as a value by the adapter`,
      );
      if (observation !== undefined) {
        assert.equal(
          (observation.provenance as Record<string, unknown>).exclusion,
          'directional_demand_change_not_published',
          `${label} must be published as an explicit refusal`,
        );
      }

      const contribution = energyContribution(corridors);
      assert.equal(
        contribution?.included,
        false,
        `${label} must not become a contribution`,
      );
      assert.equal(contribution?.rawValue, null, `${label} must not become a value`);
      assert.equal(contribution?.direction, null, `${label} must not become a direction`);
      if (reason !== undefined) {
        assert.equal(
          contribution?.exclusionReason,
          reason,
          `${label} must be reported as ${reason}`,
        );
      }
    }
  });

  it('reads market inputs in one raw batch and produces an inspectable agreement response', async () => {
    const reads: Array<{ keys: string[]; raw: boolean | undefined }> = [];
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => corridorSnapshot(energySignal(publishedDemandChangeMetrics())),
      readMarketBatch: async (keys, raw) => {
        reads.push({ keys, raw });
        return marketValues();
      },
    });

    assert.deepEqual(reads, [{
      keys: Object.values(CHINA_ACTIVITY_NOWCAST_MARKET_KEYS),
      raw: true,
    }]);
    assert.equal(response.state, 'agreement');
    assert.equal(response.comparisonWindow.days, 210);
    // Neither freight (#6066) nor energy (#6067) is structurally missing any
    // more; only the corridor breadth change still has no comparable prior.
    assert.equal(response.confidence.eligibleFamilies, 6);
    assert.equal(response.historicalEvaluation.available, false);
    assert.match(response.historicalEvaluation.reason, /historical proxy ledger/i);
    assert.deepEqual(
      response.missingInputs.map((item) => item.family),
      ['corridor'],
    );

    // Withholding the change puts energy back among the missing families —
    // the restoration is driven by the published value, not by the fixture.
    const coverageOnly = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => corridorSnapshot(energySignal(coverageOnlyMetrics())),
      readMarketBatch: async () => marketValues(),
    });
    assert.equal(coverageOnly.confidence.eligibleFamilies, 5);
    assert.deepEqual(
      coverageOnly.missingInputs.map((item) => item.family),
      ['energy', 'corridor'],
    );
    assert.equal(
      response.contributions.find((item) => item.family === 'freight')?.direction,
      'strengthening',
    );
  });

  it('keeps a delayed monthly energy observation inside the live source window', async () => {
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => corridorSnapshot(energySignal(publishedDemandChangeMetrics({
        demandChangeCurrentMonth: '2026-01',
        demandChangePriorMonth: '2025-01',
        demandChangePeriodEnd: '2026-01-31T23:59:59.999Z',
        demandChangePriorPeriodEnd: '2025-01-31T23:59:59.999Z',
      }))),
      readMarketBatch: async () => marketValues(),
    });

    assert.equal(response.comparisonWindow.days, 210);
    assert.equal(
      response.contributions.find((item) => item.seriesId === 'china_energy_demand_change')?.included,
      true,
    );
  });

  it('excludes freight with its exact reason when only a CCFI level is published (#6066)', () => {
    const levelOnly = corridorSnapshot(energySignal(coverageOnlyMetrics()));
    const trade = levelOnly.corridors[0]!.conditions
      .find((item) => item.family === 'trade')!;
    trade.sourceSignals[0]!.metrics = { currentValue: 1072.16, unit: 'index' };

    const inputs = buildChinaActivityNowcastInputs({
      evaluatedAt: EVALUATED_AT,
      macro: macroSnapshot() as never,
      corridors: levelOnly,
      marketValues: marketValues(),
    });
    const freight = inputs.proxyObservations
      .find((item) => item.seriesId === 'ccfi_freight_rate_change');
    assert.equal(freight?.value, null);
    assert.equal(
      (freight?.provenance as Record<string, unknown>).exclusion,
      'missing_comparable_prior',
    );
    assert.equal((freight?.provenance as Record<string, unknown>).currentLevel, 1072.16);
  });

  it('names an unavailable CCFI signal instead of claiming a missing prior (#6066)', () => {
    const unavailable = corridorSnapshot(energySignal(coverageOnlyMetrics()));
    const signal = unavailable.corridors[0]!.conditions
      .find((item) => item.family === 'trade')!.sourceSignals[0]!;
    signal.availability = 'unavailable';
    signal.metrics = {};

    const freight = buildChinaActivityNowcastInputs({
      evaluatedAt: EVALUATED_AT,
      macro: macroSnapshot() as never,
      corridors: unavailable,
      marketValues: marketValues(),
    }).proxyObservations.find((item) => item.seriesId === 'ccfi_freight_rate_change');
    assert.equal(freight?.value, null);
    assert.equal(
      (freight?.provenance as Record<string, unknown>).exclusion,
      'source_signal_unavailable',
    );
  });

  it('never lets a CCFI level or a fabricable display change become a freight move (#6066)', () => {
    // Each mutation is a metrics shape a weakened guard would happily read as a
    // directional change. The published `periodChangePct` is the only input that
    // may produce one.
    const mutations: Array<[string, CorridorSourceSignal['metrics']]> = [
      ['level only', { currentValue: 1072.16, unit: 'index' }],
      ['legacy fabricated flat change', { currentValue: 1072.16, changePct: 0 }],
      ['legacy non-flat display change', { currentValue: 1072.16, changePct: 1.69 }],
      ['prior level without a published change', {
        currentValue: 1072.16,
        priorPeriodValue: 1054.38,
      }],
      ['basis asserted without a change', {
        currentValue: 1072.16,
        periodChangeBasis: 'publisher_reported',
      }],
      ['non-finite change', { currentValue: 1072.16, periodChangePct: Number.NaN }],
      ['stringified change', { currentValue: 1072.16, periodChangePct: '1.69' as never }],
      ['boolean change', { currentValue: 1072.16, periodChangePct: true }],
    ];

    for (const [label, metrics] of mutations) {
      const mutated = corridorSnapshot(energySignal(coverageOnlyMetrics()));
      mutated.corridors[0]!.conditions
        .find((item) => item.family === 'trade')!.sourceSignals[0]!.metrics = metrics;
      const inputs = buildChinaActivityNowcastInputs({
        evaluatedAt: EVALUATED_AT,
        macro: macroSnapshot() as never,
        corridors: mutated,
        marketValues: marketValues(),
      });
      const freight = inputs.proxyObservations
        .find((item) => item.seriesId === 'ccfi_freight_rate_change');
      assert.equal(freight?.value, null, label);
      assert.equal(
        (freight?.provenance as Record<string, unknown>).exclusion,
        'missing_comparable_prior',
        label,
      );
    }

    // The guard is not vacuous: an explicit published zero is a real unchanged
    // week and must survive it.
    const flat = corridorSnapshot(energySignal(coverageOnlyMetrics()));
    flat.corridors[0]!.conditions
      .find((item) => item.family === 'trade')!.sourceSignals[0]!.metrics = {
        currentValue: 1072.16,
        periodChangePct: 0,
        periodChangeBasis: 'publisher_reported',
      };
    const flatFreight = buildChinaActivityNowcastInputs({
      evaluatedAt: EVALUATED_AT,
      macro: macroSnapshot() as never,
      corridors: flat,
      marketValues: marketValues(),
    }).proxyObservations.find((item) => item.seriesId === 'ccfi_freight_rate_change');
    assert.equal(flatFreight?.value, 0);
    assert.equal((flatFreight?.provenance as Record<string, unknown>).exclusion, undefined);
  });

  it('does not positively cache an insufficient response and preserves truthful degradation', async () => {
    let cacheFetcherResult: ChinaActivityComparisonState | 'null' = 'null';
    const response = await resolveChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => ({ ...macroSnapshot(), unavailable: true, indicators: [] }) as never,
      getCorridors: async () => ({ generatedAt: EVALUATED_AT, corridors: [] }),
      readMarketBatch: async () => new Map(),
    }, async (_key, ttlSeconds, fetcher) => {
      assert.equal(ttlSeconds, CHINA_ACTIVITY_NOWCAST_TTL_SECONDS);
      const value = await fetcher();
      cacheFetcherResult = value?.state ?? 'null';
      return value;
    });

    assert.equal(cacheFetcherResult, 'null');
    assert.equal(response.state, 'insufficient_data');
    assert.equal(response.confidence.level, 'insufficient');
    assert.equal(response.contributions.every((item) =>
      item.direction === null && item.included === false), true);
  });

  it('isolates rejected dependencies and distinguishes partial from total upstream loss', async () => {
    const partial = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => {
        throw new Error('corridor transport unavailable');
      },
      readMarketBatch: async () => marketValues(),
    });
    assert.equal(partial.state, 'insufficient_data');
    assert.equal(projectChinaActivityNowcastWireResponse(partial).upstreamUnavailable, false);
    assert.equal(partial.official?.vintageId, 'nbs_industrial_value_added_yoy:2026-06:r1');

    const total = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => {
        throw new Error('macro transport unavailable');
      },
      getCorridors: async () => {
        throw new Error('corridor transport unavailable');
      },
      readMarketBatch: async () => {
        throw new Error('market transport unavailable');
      },
    });
    assert.equal(total.state, 'insufficient_data');
    assert.equal(projectChinaActivityNowcastWireResponse(total).upstreamUnavailable, true);
    assert.equal(total.contributions.every((item) => !item.included), true);
  });

  it('serializes the canonical API payload and reports upstream unavailability honestly', async () => {
    const available = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => corridorSnapshot(energySignal(publishedDemandChangeMetrics())),
      readMarketBatch: async () => marketValues(),
    });
    const availableWire = projectChinaActivityNowcastWireResponse(available);
    assert.equal(availableWire.generatedAt, EVALUATED_AT);
    assert.equal(availableWire.methodVersion, 'china-activity-nowcast/v1');
    assert.equal(availableWire.comparisonState, 'agreement');
    assert.equal(availableWire.upstreamUnavailable, false);
    assert.deepEqual(parseChinaActivityNowcastWirePayload(availableWire.payloadJson), available);

    const unavailable = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => ({ ...macroSnapshot(), unavailable: true, indicators: [] }) as never,
      getCorridors: async () => ({ generatedAt: EVALUATED_AT, corridors: [] }),
      readMarketBatch: async () => new Map(),
    });
    assert.equal(projectChinaActivityNowcastWireResponse(unavailable).upstreamUnavailable, true);

    const unchanged = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => ({
        ...macroSnapshot(),
        indicators: macroSnapshot().indicators.map((indicator) => ({
          ...indicator,
          direction: 'unchanged',
        })),
      }) as never,
      getCorridors: async () => corridorSnapshot(energySignal(publishedDemandChangeMetrics())),
      readMarketBatch: async () => marketValues(),
    });
    assert.equal(unchanged.state, 'insufficient_data');
    assert.equal(projectChinaActivityNowcastWireResponse(unchanged).upstreamUnavailable, false);
  });
});
