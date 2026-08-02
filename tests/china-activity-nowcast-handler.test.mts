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

function corridorSnapshot(): ChinaCorridorControlTowerResponse {
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
        condition('power_energy', [
          signal('energy', 'power_energy', { hasJodiOil: true }),
        ]),
      ],
    }],
  };
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
      corridors: corridorSnapshot(),
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
      inputs.proxyObservations.find((item) => item.seriesId === 'china_energy_demand_change')?.value,
      null,
    );
    assert.equal(
      inputs.proxyObservations.find((item) => item.seriesId === 'corridor_activity_breadth_change')?.value,
      null,
    );
  });

  it('reads market inputs in one raw batch and produces an inspectable agreement response', async () => {
    const reads: Array<{ keys: string[]; raw: boolean | undefined }> = [];
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => corridorSnapshot(),
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
    assert.equal(response.confidence.eligibleFamilies, 5);
    assert.equal(response.historicalEvaluation.available, false);
    assert.match(response.historicalEvaluation.reason, /historical proxy ledger/i);
    // Freight is no longer structurally missing: it is included whenever the
    // Shanghai Shipping Exchange contract publishes a period change (#6066).
    assert.deepEqual(
      response.missingInputs.map((item) => item.family),
      ['energy', 'corridor'],
    );
    assert.equal(
      response.contributions.find((item) => item.family === 'freight')?.direction,
      'strengthening',
    );
  });

  it('excludes freight with its exact reason when only a CCFI level is published (#6066)', () => {
    const levelOnly = corridorSnapshot();
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
    const unavailable = corridorSnapshot();
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
      const mutated = corridorSnapshot();
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
    const flat = corridorSnapshot();
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
      getCorridors: async () => corridorSnapshot(),
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
      getCorridors: async () => corridorSnapshot(),
      readMarketBatch: async () => marketValues(),
    });
    assert.equal(unchanged.state, 'insufficient_data');
    assert.equal(projectChinaActivityNowcastWireResponse(unchanged).upstreamUnavailable, false);
  });
});

// #6060 — the production failure was activity-nowcast `unavailable` with
// `insufficient_data` and these four missing input diagnostics:
//
//   freight  / ccfi_freight_rate_change        : missing_directional_value
//   maritime / portwatch_tanker_calls_trend    : marked_stale
//   energy   / china_energy_demand_change      : missing_directional_value
//   corridor / corridor_activity_breadth_change: missing_directional_value
//
// That refusal is correct and must stay correct. These tests pin the
// fail-closed contract so a future "make the nowcast available again" change
// cannot buy availability with a forward fill, an interpolation, or a neutral
// substitution.
describe('China activity nowcast fail-closed contract (#6060)', () => {
  // The energy proxy carries a documented 30-day publication lag, so a
  // same-day observation is excluded as `lag_not_elapsed` before the
  // directional check is ever reached. Production reported
  // `missing_directional_value`, which means the lag HAD elapsed there —
  // reproduce that by backdating energy to 40 days before evaluation: past
  // the 30-day lag, inside the 90-day comparison window, and well inside the
  // 210-day freshness budget.
  const ENERGY_OBSERVED_AT = '2026-06-15T10:00:00.000Z';

  function staleCorridorSnapshot(): ChinaCorridorControlTowerResponse {
    // Exactly what a China PortWatch payload older than the corridor adapter's
    // 72h content budget produces: transport is fine, the content is not.
    const base = corridorSnapshot();
    return {
      ...base,
      corridors: base.corridors.map((corridor) => ({
        ...corridor,
        conditions: corridor.conditions.map((item) => {
          if (item.family === 'port') {
            return {
              ...item,
              sourceSignals: item.sourceSignals.map((source) => ({
                ...source,
                contentFreshness: 'stale' as const,
              })),
            };
          }
          if (item.family === 'trade') {
            // #6066 (landed as #6074) taught the adapter to read a published
            // CCFI period change and added one to the shared fixture. The
            // 2026-08-02 audit predates that: CCFI published a level only, so
            // freight was excluded. Strip the change back out here — otherwise
            // this test silently stops reproducing the incident it is named for.
            return {
              ...item,
              sourceSignals: item.sourceSignals.map((source) => {
                const { periodChangePct: _dropped, ...levelOnly } = source.metrics;
                return { ...source, metrics: levelOnly };
              }),
            };
          }
          if (item.family === 'power_energy') {
            return {
              ...item,
              sourceSignals: item.sourceSignals.map((source) => ({
                ...source,
                observationTime: ENERGY_OBSERVED_AT,
                releaseTime: '2026-06-15T10:10:00.000Z',
                retrievalTime: '2026-06-15T10:15:00.000Z',
              })),
            };
          }
          return item;
        }),
      })),
    };
  }

  it('excludes content-stale PortWatch rather than forward-filling it', async () => {
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => staleCorridorSnapshot(),
      readMarketBatch: async () => marketValues(),
    });

    const maritime = response.contributions
      .find((item) => item.seriesId === 'portwatch_tanker_calls_trend');
    assert.equal(maritime?.included, false);
    assert.equal(maritime?.exclusionReason, 'marked_stale');
    assert.equal(maritime?.direction, null, 'a stale observation has no direction');
    assert.equal(
      maritime?.transformedValue,
      null,
      'stale content is dropped, never carried forward or zeroed',
    );
    // The raw upstream number is still visible for diagnosis; what must not
    // happen is that number becoming a contribution.
    assert.equal(maritime?.rawValue, 1.5);
    assert.equal(response.comparisonWindow.forwardFill, false);
    assert.equal(response.comparisonWindow.interpolate, false);
    assert.equal(
      response.missingInputs.some((input) =>
        input.family === 'maritime'
        && input.seriesId === 'portwatch_tanker_calls_trend'
        && input.reason === 'marked_stale'),
      true,
    );
  });

  it('reproduces the audit diagnostics: every missing family and its exact reason', async () => {
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => staleCorridorSnapshot(),
      readMarketBatch: async () => marketValues(),
    });

    assert.deepEqual(
      response.missingInputs.filter((input) => [
        'freight', 'maritime', 'energy', 'corridor',
      ].includes(input.family)),
      [
        {
          family: 'freight',
          seriesId: 'ccfi_freight_rate_change',
          reason: 'missing_directional_value',
        },
        {
          family: 'maritime',
          seriesId: 'portwatch_tanker_calls_trend',
          reason: 'marked_stale',
        },
        {
          family: 'energy',
          seriesId: 'china_energy_demand_change',
          reason: 'missing_directional_value',
        },
        {
          family: 'corridor',
          seriesId: 'corridor_activity_breadth_change',
          reason: 'missing_directional_value',
        },
      ],
      'each unavailable family names its own series and its own reason',
    );
  });

  it('stays insufficient below three non-flat proxy families', async () => {
    // Two non-flat families survive (commodity + market); the maritime family
    // is content-stale and aviation is flat.
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => {
        const base = staleCorridorSnapshot();
        return {
          ...base,
          corridors: base.corridors.map((corridor) => ({
            ...corridor,
            conditions: corridor.conditions.map((item) => (
              item.family === 'aviation'
                ? {
                    ...item,
                    // One normal and one disrupted hub nets to exactly zero.
                    sourceSignals: [
                      signal('aviation:pvg', 'aviation', { providerStatus: 'normal' }),
                      signal('aviation:hkg', 'aviation', { providerStatus: 'disruption' }),
                    ],
                  }
                : item
            )),
          })),
        };
      },
      readMarketBatch: async () => marketValues(),
    });

    const nonFlatFamilies = new Set(
      response.contributions
        .filter((item) => item.included && item.direction !== 'unchanged')
        .map((item) => item.family),
    );
    assert.equal(nonFlatFamilies.size, 2);
    assert.equal(response.state, 'insufficient_data');
    assert.equal(response.confidence.level, 'insufficient');
    assert.match(response.confidence.reason, /At least 3 non-flat proxy families are required; 2 are eligible\./);

    // An eligible-but-flat family is counted as coverage but never as a
    // direction — that is the distinction the >=3 gate rests on.
    const aviation = response.contributions
      .find((item) => item.seriesId === 'aviation_hub_disruption_balance');
    assert.equal(aviation?.included, true);
    assert.equal(aviation?.direction, 'unchanged');
    assert.equal(nonFlatFamilies.has('aviation'), false);
  });

  it('leaves unavailable once three non-flat families are restored', async () => {
    // Same inputs, PortWatch content back inside its budget: maritime rejoins
    // commodity and market, and the deterministic method can conclude.
    const response = await composeChinaActivityNowcastSnapshot(EVALUATED_AT, {
      getMacro: async () => macroSnapshot() as never,
      getCorridors: async () => corridorSnapshot(),
      readMarketBatch: async () => marketValues(),
    });

    const nonFlatFamilies = new Set(
      response.contributions
        .filter((item) => item.included && item.direction !== 'unchanged')
        .map((item) => item.family),
    );
    assert.equal(nonFlatFamilies.size >= 3, true);
    assert.notEqual(response.state, 'insufficient_data');
    assert.equal(response.state, 'agreement');
    assert.notEqual(response.confidence.level, 'insufficient');
    assert.equal(
      response.missingInputs.some((input) => input.family === 'maritime'),
      false,
      'a fresh PortWatch observation is no longer a missing input',
    );
    // Energy and corridor remain structurally unpublished — recovery for those
    // is tracked in #6067 and #6068, and the nowcast must never manufacture
    // them to reach three. Freight is no longer on that list: #6066 (landed as
    // #6074) made the adapter read a published CCFI period change, so the
    // shared fixture now supplies a real directional freight move.
    assert.deepEqual(
      response.missingInputs.map((input) => input.family),
      ['energy', 'corridor'],
    );
    assert.equal(
      response.contributions.find((item) => item.seriesId === 'ccfi_freight_rate_change')?.included,
      true,
      'freight recovered via #6066 and must stay a real contribution',
    );
  });
});
