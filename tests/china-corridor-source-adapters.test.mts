import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildChinaCorridorSourceBundle } from '../server/worldmonitor/supply-chain/v1/china-corridor-source-adapters.ts';

const ASSESSED_AT = '2026-07-25T12:00:00.000Z';
const FRESH_META = { fetchedAt: Date.parse('2026-07-25T11:30:00.000Z') };

describe('China corridor source adapters (#5578)', () => {
  it('preserves missing PortWatch metrics instead of manufacturing zero values', () => {
    const bundle = buildChinaCorridorSourceBundle({
      portwatchChina: {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai' }],
      },
      portwatchMeta: FRESH_META,
    }, ASSESSED_AT);

    const signal = bundle.families.port.signals[0];
    assert.equal(signal?.selectorId, 'port1188');
    assert.deepEqual(signal?.metrics, {});
    assert.equal(JSON.stringify(signal).includes('"tankerCalls30d":0'), false);
  });

  it('does not turn omitted or failed aviation coverage into normal operations', () => {
    const bundle = buildChinaCorridorSourceBundle({
      aviation: {
        coverage: [
          { iata: 'PVG', status: 'normal', flightCount: 24, updatedAt: Date.parse('2026-07-25T11:00:00.000Z') },
          { iata: 'HKG', status: 'omitted', flightCount: 0, updatedAt: Date.parse('2026-07-25T11:00:00.000Z') },
          { iata: 'PEK', status: 'failed', flightCount: 0, updatedAt: Date.parse('2026-07-25T11:00:00.000Z') },
        ],
      },
      aviationMeta: FRESH_META,
    }, ASSESSED_AT);

    const byAirport = new Map(bundle.families.aviation.signals.map((signal) => [signal.selectorId, signal]));
    assert.equal(byAirport.get('PVG')?.availability, 'available');
    assert.equal(byAirport.get('HKG')?.availability, 'unavailable');
    assert.equal(byAirport.get('HKG')?.contentFreshness, 'unavailable');
    assert.equal(byAirport.get('PEK')?.availability, 'unavailable');
    assert.equal(byAirport.get('PEK')?.metrics.flightCount, undefined);
  });

  it('assigns hazards only through reviewed coordinates and the explicit HKO scope', () => {
    const bundle = buildChinaCorridorSourceBundle({
      westernPacificCyclones: {
        dataAvailable: true,
        latestObservationAt: Date.parse('2026-07-25T10:00:00.000Z'),
        events: [
          {
            id: 'inside-gba',
            title: '<script>unsafe source title</script>',
            lat: 22.5,
            lon: 114.0,
            date: Date.parse('2026-07-25T10:00:00.000Z'),
            sourceName: 'HKO',
          },
          {
            id: 'outside-reviewed-boundaries',
            title: 'Nearby but unassigned',
            lat: 35,
            lon: 113,
            date: Date.parse('2026-07-25T10:00:00.000Z'),
            sourceName: 'GDACS',
          },
          {
            id: 'hanoi',
            title: 'Hanoi event must not be assigned to the western corridor',
            lat: 21.0285,
            lon: 105.8542,
            date: Date.parse('2026-07-25T10:00:00.000Z'),
            sourceName: 'GDACS',
          },
          {
            id: 'dhaka',
            title: 'Dhaka event must not be assigned to the western corridor',
            lat: 23.8103,
            lon: 90.4125,
            date: Date.parse('2026-07-25T10:00:00.000Z'),
            sourceName: 'GDACS',
          },
        ],
      },
      westernPacificCyclonesMeta: FRESH_META,
      hkoWarnings: {
        dataAvailable: true,
        latestObservationAt: Date.parse('2026-07-25T10:30:00.000Z'),
        warnings: [],
      },
      hkoWarningsMeta: FRESH_META,
    }, ASSESSED_AT);

    const signals = bundle.families.hazard.signals;
    assert.deepEqual(
      signals.find((signal) => signal.selectorId === 'hazard:event:inside-gba')?.corridorIds,
      ['china-greater-bay-area'],
    );
    assert.equal(signals.some((signal) => signal.selectorId === 'hazard:event:outside-reviewed-boundaries'), false);
    assert.equal(signals.some((signal) => signal.selectorId === 'hazard:event:hanoi'), false);
    assert.equal(signals.some((signal) => signal.selectorId === 'hazard:event:dhaka'), false);
    assert.equal(signals.find((signal) => signal.selectorId === 'hazard:hko-warnings')?.corridorIds, undefined);
    const gbaCoverage = signals.find((signal) =>
      signal.selectorId === 'hazard:western-pacific-coverage:china-greater-bay-area');
    const westernCoverage = signals.find((signal) =>
      signal.selectorId === 'hazard:western-pacific-coverage:china-western-land-sea-corridor');
    assert.deepEqual(gbaCoverage?.corridorIds, ['china-greater-bay-area']);
    assert.equal(gbaCoverage?.metrics.reviewedEventCount, 1);
    assert.deepEqual(westernCoverage?.corridorIds, ['china-western-land-sea-corridor']);
    assert.equal(westernCoverage?.metrics.reviewedEventCount, 0);
  });

  it('keeps transport and content freshness independent', () => {
    const bundle = buildChinaCorridorSourceBundle({
      portwatchChina: {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai', tankerCalls30d: 12 }],
      },
      portwatchMeta: { fetchedAt: Date.parse('2026-07-20T11:00:00.000Z') },
    }, ASSESSED_AT);

    const signal = bundle.families.port.signals[0];
    assert.equal(signal?.transportFreshness, 'stale');
    assert.equal(signal?.contentFreshness, 'current');
  });

  it('preserves energy source precision and rejects malformed numeric timestamps', () => {
    const annual = buildChinaCorridorSourceBundle({
      energySpine: {
        updatedAt: Number.MAX_VALUE,
        sources: { mixYear: 2024 },
        coverage: { hasMix: true },
      },
      energySpineMeta: FRESH_META,
    }, ASSESSED_AT).families.power_energy.signals[0];
    assert.equal(annual?.observationTime, '2024-12-31T23:59:59Z');
    assert.equal(annual?.observationTimePrecision, 'year');
    assert.equal(annual?.contentFreshness, 'stale');

    const monthly = buildChinaCorridorSourceBundle({
      energySpine: {
        updatedAt: Number.MAX_VALUE,
        sources: { mixYear: 2024, jodiOilMonth: '2026-02' },
        coverage: { hasMix: true, hasJodiOil: true },
      },
      energySpineMeta: FRESH_META,
    }, ASSESSED_AT).families.power_energy.signals[0];
    assert.equal(monthly?.observationTime, '2026-02-01T00:00:00.000Z');
    assert.equal(monthly?.observationTimePrecision, 'month');
    assert.equal(monthly?.contentFreshness, 'current');
  });

  it('omits synthetic Comtrade YoY and CCFI change fields', () => {
    const bundle = buildChinaCorridorSourceBundle({
      comtrade: {
        flows: [{
          reporterCode: '156',
          cmdCode: '8541',
          year: 2024,
          tradeValueUsd: 100,
          yoyChange: 0,
        }],
      },
      comtradeMeta: FRESH_META,
      shipping: {
        indices: [{
          indexId: 'CCFI',
          currentValue: 900,
          previousValue: 900,
          changePct: 0,
          unit: 'index',
          history: [{ date: '2026-07-18', value: 900 }],
        }],
      },
      shippingMeta: FRESH_META,
    }, ASSESSED_AT);

    const strategic = bundle.families.strategic_industry.signals[0];
    const ccfi = bundle.families.trade.signals.find((signal) =>
      signal.selectorId === 'supply_chain:shipping:v2:CCFI');
    assert.equal(strategic?.metrics.yoyChange, undefined);
    assert.equal(strategic?.contentFreshness, 'stale');
    const comtrade = bundle.families.trade.signals.find((signal) =>
      signal.selectorId === 'comtrade:reporter:156');
    assert.equal(comtrade?.contentFreshness, 'stale');
    assert.equal(ccfi?.metrics.changePct, undefined);
    assert.equal(ccfi?.metrics.currentValue, 900);
  });
});
