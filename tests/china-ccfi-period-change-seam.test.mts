import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accumulateHistory,
  parseSseIndexResponse,
} from '../scripts/seed-supply-chain-trade.mjs';
import { buildChinaCorridorSourceBundle } from '../server/worldmonitor/supply-chain/v1/china-corridor-source-adapters.ts';
import { buildChinaActivityNowcastInputs } from '../server/worldmonitor/economic/v1/get-china-activity-nowcast';
import type {
  ChinaCorridorControlTowerResponse,
  CorridorSourceSignal,
} from '../shared/china-corridor-control-towers';

// The CCFI period change crosses three modules that are otherwise only ever tested
// against hand-built fixtures: the seeder writes the payload, the corridor adapter
// reads it, and the nowcast reads the adapter's metrics. Every one of those suites
// stays green if a field is renamed on ONE side of a seam, while production freight
// dies fail-closed and silently. This test drives the real functions end to end so
// the field names have to agree (#6066).

const ASSESSED_AT = '2026-07-25T12:00:00.000Z';
const EVALUATED_AT = '2026-07-25T12:00:00.000Z';
const FRESH_META = { fetchedAt: Date.parse('2026-07-25T11:30:00.000Z') };

function sseEnvelope(
  overrides: Record<string, unknown> = {},
  dataOverrides: Record<string, unknown> = {},
) {
  return {
    data: {
      currentDate: '2026-07-25',
      lastDate: '2026-07-18',
      ...dataOverrides,
      lineDataList: [{
        dataItemTypeName: 'CCFI_T',
        currentContent: 1072.16,
        lastContent: 1054.38,
        percentage: 1.69,
        ...overrides,
      }],
    },
  };
}

// Run the real seeder parser, then hand its output to the real corridor adapter
// exactly as the published `supply_chain:shipping:v2` payload would.
function corridorsFromSse(
  overrides: Record<string, unknown> = {},
  dataOverrides: Record<string, unknown> = {},
): ChinaCorridorControlTowerResponse {
  const indices = accumulateHistory(parseSseIndexResponse(
    sseEnvelope(overrides, dataOverrides),
    'CCFI',
    'CCFI_T',
    'CCFI - China Container Freight',
    'index',
  ), { indices: [] });

  const bundle = buildChinaCorridorSourceBundle({
    shipping: { indices, fetchedAt: '2026-07-25T11:00:00.000Z' },
    shippingMeta: FRESH_META,
  } as never, ASSESSED_AT);

  return {
    generatedAt: ASSESSED_AT,
    corridors: [{
      id: 'china-yangtze-river-delta',
      name: 'Yangtze River Delta',
      description: 'Seam fixture corridor.',
      boundary: [],
      nodes: [],
      availability: 'partial',
      conditions: [{
        family: 'trade',
        providerId: 'provider:trade',
        availability: 'available',
        reason: null,
        sourceSignals: bundle.families.trade.signals as CorridorSourceSignal[],
        provenance: null,
      }],
    }],
  };
}

function freightObservation(
  overrides: Record<string, unknown> = {},
  dataOverrides: Record<string, unknown> = {},
) {
  return buildChinaActivityNowcastInputs({
    evaluatedAt: EVALUATED_AT,
    macro: { unavailable: true, indicators: [] } as never,
    corridors: corridorsFromSse(overrides, dataOverrides),
    marketValues: new Map<string, unknown>(),
  }).proxyObservations.find((item) => item.seriesId === 'ccfi_freight_rate_change');
}

describe('CCFI period change: seeder -> corridor adapter -> nowcast seam (#6066)', () => {
  it('carries a publisher-reported change across every hop', () => {
    const freight = freightObservation();
    assert.equal(freight?.value, 1.69);
    const provenance = freight?.provenance as Record<string, unknown>;
    assert.equal(provenance.periodChangeBasis, 'publisher_reported');
    assert.equal(provenance.currentLevel, 1072.16);
    assert.equal(provenance.priorPeriodLevel, 1054.38);
    assert.equal(provenance.priorPeriodDate, '2026-07-18');
    assert.equal(provenance.exclusion, undefined);
  });

  it('carries a change derived from two published levels when SSE omits its percentage', () => {
    const freight = freightObservation({ percentage: undefined });
    // (1072.16 - 1054.38) / 1054.38 * 100
    assert.ok(
      freight?.value !== null && Math.abs((freight?.value as number) - 1.6863) < 1e-3,
      `expected ~1.6863, got ${freight?.value}`,
    );
    assert.equal(
      (freight?.provenance as Record<string, unknown>).periodChangeBasis,
      'derived_from_prior_period_level',
    );
  });

  it('carries an explicitly published unchanged week rather than dropping it', () => {
    const freight = freightObservation({
      currentContent: 1054.38,
      lastContent: 1054.38,
      percentage: 0,
    });
    assert.equal(freight?.value, 0);
    assert.equal((freight?.provenance as Record<string, unknown>).exclusion, undefined);
  });

  it('excludes freight with its exact reason when SSE ships a level with no prior', () => {
    const freight = freightObservation({ lastContent: undefined, percentage: undefined });
    assert.equal(freight?.value, null);
    const provenance = freight?.provenance as Record<string, unknown>;
    assert.equal(provenance.exclusion, 'missing_comparable_prior');
    // The level still crosses the seam; only the change is withheld.
    assert.equal(provenance.currentLevel, 1072.16);
    assert.equal(provenance.priorPeriodLevel, null);
  });

  it('excludes freight when the legacy fabricable change is the only change present', () => {
    // SSE publishes neither a percentage nor a prior, so the seeder's legacy
    // `changePct` fabricates a flat 0. It must not reach the nowcast as a move.
    const indices = parseSseIndexResponse(
      sseEnvelope({ lastContent: undefined, percentage: undefined }),
      'CCFI', 'CCFI_T', 'CCFI - China Container Freight', 'index',
    );
    assert.equal(indices[0]?.changePct, 0, 'legacy field still fabricates');
    assert.equal(indices[0]?.periodChangePct, null, 'decision field fails closed');

    const freight = freightObservation({ lastContent: undefined, percentage: undefined });
    assert.equal(freight?.value, null);
  });

  it('fails closed through history and adapter seams when SSE omits a real date', () => {
    const freight = freightObservation({}, { currentDate: 'N/A' });
    assert.equal(freight?.value, null);
    assert.equal(freight?.stale, true);
    assert.equal(
      (freight?.provenance as Record<string, unknown>).exclusion,
      'source_signal_stale',
    );
  });
});
