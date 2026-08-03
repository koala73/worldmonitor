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

  // #6060: the gate must age CONTENT, not retrieval. The seeder force-refetches
  // each country once its cache passes MAX_CACHE_AGE_MS (168h); that refetch
  // resets `fetchedAt` while returning an unchanged upstream `asof`. Ageing
  // `fetchedAt` admits a frozen observation for one budget window out of every
  // cache lifetime — the same conflation this issue exists to end, one layer
  // below the health alarm.
  it('reads the content clock, so a refetch of frozen upstream data stays stale', () => {
    const bundle = buildChinaCorridorSourceBundle({
      portwatchChina: {
        // Retrieved seconds ago ...
        fetchedAt: '2026-07-25T11:59:00.000Z',
        // ... but upstream has not advanced in 120h, past the 72h budget.
        asof: '2026-07-19',
        contentAsOfChangedAt: Date.parse('2026-07-20T12:00:00.000Z'),
        ports: [{ portId: 'port1188', portName: 'Shanghai', trendDelta: 2 }],
      },
      portwatchMeta: FRESH_META,
    }, ASSESSED_AT);

    const signal = bundle.families.port.signals[0];
    assert.equal(
      signal?.contentFreshness,
      'stale',
      'a fresh retrieval of frozen upstream content is not current',
    );
    assert.equal(signal?.observationTime, '2026-07-20T12:00:00.000Z');
  });

  it('still ages fetchedAt for legacy payloads with no content clock', () => {
    const bundle = buildChinaCorridorSourceBundle({
      portwatchChina: {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai', trendDelta: 2 }],
      },
      portwatchMeta: FRESH_META,
    }, ASSESSED_AT);
    assert.equal(bundle.families.port.signals[0]?.contentFreshness, 'current');
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
    // The seeder published no comparable prior, so no period change is exposed
    // even though the legacy display field fabricates a flat 0 (#6066).
    assert.equal(ccfi?.metrics.periodChangePct, undefined);
    assert.equal(ccfi?.metrics.periodChangeBasis, undefined);
    assert.equal(ccfi?.metrics.priorPeriodValue, undefined);
  });

  it('does not use shipping retrieval time as an undated CCFI observation', () => {
    const ccfi = buildChinaCorridorSourceBundle({
      shipping: {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        indices: [{
          indexId: 'CCFI',
          currentValue: 900,
          history: [{ date: '2026-02-30', value: 900 }],
        }],
      },
      shippingMeta: FRESH_META,
    }, ASSESSED_AT).families.trade.signals.find((signal) =>
      signal.selectorId === 'supply_chain:shipping:v2:CCFI');

    assert.equal(ccfi?.observationTime, null);
    assert.equal(ccfi?.observationTimePrecision, 'unknown');
    assert.equal(ccfi?.availability, 'stale');
    assert.equal(ccfi?.contentFreshness, 'timestamp_unknown');
  });

  it('exposes the published CCFI period change with its basis and prior period (#6066)', () => {
    const signalFor = (index: Record<string, unknown>) =>
      buildChinaCorridorSourceBundle({
        shipping: { indices: [{ indexId: 'CCFI', unit: 'index', ...index }] },
        shippingMeta: FRESH_META,
      }, ASSESSED_AT).families.trade.signals.find((signal) =>
        signal.selectorId === 'supply_chain:shipping:v2:CCFI');

    const published = signalFor({
      currentValue: 1072.16,
      previousValue: 1054.38,
      changePct: 1.69,
      periodChangePct: 1.69,
      periodChangeBasis: 'publisher_reported',
      priorPeriodValue: 1054.38,
      priorPeriodDate: '2026-07-11',
      history: [{ date: '2026-07-18', value: 1072.16 }],
    });
    assert.equal(published?.metrics.periodChangePct, 1.69);
    assert.equal(published?.metrics.periodChangeBasis, 'publisher_reported');
    assert.equal(published?.metrics.priorPeriodValue, 1054.38);
    assert.equal(published?.metrics.priorPeriodDate, '2026-07-11');
    assert.equal(published?.metrics.changePct, undefined);

    // An explicit unchanged week is a real directional observation, not a gap.
    const flat = signalFor({
      currentValue: 900,
      periodChangePct: 0,
      periodChangeBasis: 'publisher_reported',
      history: [{ date: '2026-07-18', value: 900 }],
    });
    assert.equal(flat?.metrics.periodChangePct, 0);

    // A non-finite change is never carried through as evidence.
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, '1.69', null]) {
      const rejected = signalFor({
        currentValue: 900,
        periodChangePct: invalid,
        history: [{ date: '2026-07-18', value: 900 }],
      });
      assert.equal(rejected?.metrics.periodChangePct, undefined, String(invalid));
      assert.equal(rejected?.metrics.currentValue, 900, String(invalid));
    }
  });
});
