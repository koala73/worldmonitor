import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateDecisionSignalProvenance } from '../shared/decision-signal-provenance';
import { validateChinaCorridorProvenanceForSurface } from '../shared/china-corridor-control-towers.ts';
import {
  composeChinaCorridorControlTowers,
  type ChinaCorridorSourceBundle,
  type CorridorSourceSignal,
} from '../server/worldmonitor/supply-chain/v1/china-corridor-control-towers';

const ASSESSED_AT = '2026-07-25T12:00:00Z';

function signal(
  overrides: Partial<CorridorSourceSignal> & Pick<CorridorSourceSignal, 'id' | 'family' | 'selectorId'>,
): CorridorSourceSignal {
  return {
    availability: 'available',
    publisher: {
      id: 'publisher:test-source',
      name: 'Test source',
      type: 'unknown',
    },
    sourceUrl: 'https://example.test/source',
    sourceScope: 'node',
    observationTime: '2026-07-25T11:00:00Z',
    observationTimePrecision: 'instant',
    releaseTime: null,
    releaseTimePrecision: 'unknown',
    retrievalTime: '2026-07-25T11:05:00Z',
    retrievalTimePrecision: 'instant',
    revision: null,
    transportFreshness: 'fresh',
    contentFreshness: 'current',
    summary: 'Observed source condition',
    metrics: {},
    ...overrides,
  };
}

function sourceBundle(): ChinaCorridorSourceBundle {
  return {
    assessedAt: ASSESSED_AT,
    families: {
      port: {
        providerId: 'portwatch',
        signals: [
          signal({
            id: 'signal:portwatch:port1188:2026-07-25',
            family: 'port',
            selectorId: 'port1188',
            metrics: { tankerCalls30d: 14, anomalySignal: false },
          }),
          signal({
            id: 'signal:portwatch:port474:2026-07-25',
            family: 'port',
            selectorId: 'port474',
            metrics: { tankerCalls30d: 9 },
          }),
        ],
      },
      aviation: {
        providerId: 'aviationstack',
        signals: [
          signal({
            id: 'signal:aviation:PVG:2026-07-25T11:00Z',
            family: 'aviation',
            selectorId: 'PVG',
            summary: 'PVG operating signal available',
          }),
        ],
      },
      hazard: {
        providerId: 'china-hazards',
        signals: [
          signal({
            id: 'signal:hko:warning:2026-07-25T11:00Z',
            family: 'hazard',
            selectorId: 'hazard:hko-warnings',
            sourceScope: 'regional',
            summary: 'Hong Kong Observatory warning feed available',
          }),
        ],
      },
      power_energy: {
        providerId: 'china-energy-spine',
        signals: [
          signal({
            id: 'signal:energy-spine:CN:2026-07-25',
            family: 'power_energy',
            selectorId: 'energy:spine:v1:CN',
            sourceScope: 'national',
          }),
        ],
      },
      strategic_industry: {
        providerId: 'un-comtrade-strategic-products',
        signals: [
          signal({
            id: 'signal:comtrade:156:strategic:2026-06',
            family: 'strategic_industry',
            selectorId: 'comtrade:reporter:156:strategic-products',
            sourceScope: 'national',
            observationTime: '2025-12-31T23:59:59Z',
            observationTimePrecision: 'year',
          }),
        ],
      },
      trade: {
        providerId: 'china-trade-signals',
        signals: [
          signal({
            id: 'signal:ccfi:2026-07-25',
            family: 'trade',
            selectorId: 'supply_chain:shipping:v2:CCFI',
            sourceScope: 'national',
          }),
        ],
      },
    },
  };
}

describe('China corridor control-tower composition (#5578)', () => {
  it('composes reviewed selectors without producing an opaque risk score', () => {
    const response = composeChinaCorridorControlTowers(sourceBundle());
    assert.equal(response.corridors.length, 4);
    assert.equal('riskScore' in response, false);
    assert.doesNotMatch(JSON.stringify(response), /"riskScore"|"normal":true/);

    const yrd = response.corridors.find((corridor) => corridor.id === 'china-yangtze-river-delta');
    assert.ok(yrd);
    assert.equal(yrd.conditions.find((condition) => condition.family === 'port')?.availability, 'available');
    assert.deepEqual(
      yrd.conditions.find((condition) => condition.family === 'port')?.sourceSignals.map((item) => item.selectorId),
      ['port1188'],
    );

    for (const corridor of response.corridors) {
      for (const condition of corridor.conditions) {
        if (condition.provenance === null) continue;
        const result = validateDecisionSignalProvenance(condition.provenance);
        assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
        assert.equal(condition.provenance.familyId, 'composed_corridor_condition');
      }
    }
  });

  it('keeps missing inputs explicitly unavailable without invented zero or normal values', () => {
    const bundle = sourceBundle();
    bundle.families.aviation = {
      providerId: 'aviationstack',
      reason: 'provider cache missing',
      signals: [],
    };

    const response = composeChinaCorridorControlTowers(bundle);
    for (const corridor of response.corridors) {
      const aviation = corridor.conditions.find((condition) => condition.family === 'aviation');
      assert.ok(aviation);
      assert.equal(aviation.availability, 'unavailable');
      assert.equal(aviation.provenance, null);
      assert.deepEqual(aviation.sourceSignals, []);
      assert.equal(aviation.reason, 'provider cache missing');
    }
    assert.doesNotMatch(JSON.stringify(response), /"delayMinutes":0|"status":"normal"/);
  });

  it('degrades only the missing provider family and keeps partial corridors useful', () => {
    const bundle = sourceBundle();
    bundle.families.hazard = {
      providerId: 'china-hazards',
      reason: 'hazard cache read failed',
      signals: [],
    };

    const response = composeChinaCorridorControlTowers(bundle);
    const gba = response.corridors.find((corridor) => corridor.id === 'china-greater-bay-area');
    assert.ok(gba);
    assert.equal(gba.availability, 'partial');
    assert.equal(
      gba.conditions.find((condition) => condition.family === 'hazard')?.availability,
      'unavailable',
    );
    assert.equal(
      gba.conditions.find((condition) => condition.family === 'port')?.availability,
      'available',
    );
    assert.equal(
      gba.conditions.find((condition) => condition.family === 'trade')?.availability,
      'available',
    );
  });

  it('does not leak a provider gap into corridors that do not depend on it', () => {
    const bundle = sourceBundle();
    const hongKong = bundle.families.port.signals.find((item) => item.selectorId === 'port474');
    assert.ok(hongKong);
    hongKong.availability = 'unavailable';
    hongKong.observationTime = null;
    hongKong.observationTimePrecision = 'unknown';
    hongKong.contentFreshness = 'unavailable';
    bundle.families.port.reason = 'One reviewed port is unavailable';

    const response = composeChinaCorridorControlTowers(bundle);
    const yrdPort = response.corridors
      .find((corridor) => corridor.id === 'china-yangtze-river-delta')
      ?.conditions.find((condition) => condition.family === 'port');
    const gbaPort = response.corridors
      .find((corridor) => corridor.id === 'china-greater-bay-area')
      ?.conditions.find((condition) => condition.family === 'port');

    assert.equal(yrdPort?.availability, 'available');
    assert.equal(yrdPort?.reason, null);
    assert.equal(gbaPort?.availability, 'unavailable');
  });

  it('preserves stale transport and stale content independently', () => {
    const bundle = sourceBundle();
    const portSignal = bundle.families.port.signals[0];
    assert.ok(portSignal);
    portSignal.transportFreshness = 'stale';
    portSignal.contentFreshness = 'current';

    const response = composeChinaCorridorControlTowers(bundle);
    const yrd = response.corridors.find((corridor) => corridor.id === 'china-yangtze-river-delta');
    const condition = yrd?.conditions.find((item) => item.family === 'port');
    assert.equal(condition?.availability, 'stale');
    assert.equal(
      condition?.provenance?.claims.transport_freshness.status === 'known'
        ? condition.provenance.claims.transport_freshness.value.state
        : null,
      'stale',
    );
    assert.equal(
      condition?.provenance?.claims.content_freshness.status === 'known'
        ? condition.provenance.claims.content_freshness.value.state
        : null,
      'current',
    );
  });

  it('does not assign free text or unknown selectors to a corridor', () => {
    const bundle = sourceBundle();
    bundle.families.port.signals.push(
      signal({
        id: 'signal:portwatch:unknown',
        family: 'port',
        selectorId: 'Shanghai',
      }),
      signal({
        id: 'signal:portwatch:cross-boundary',
        family: 'port',
        selectorId: 'port-does-not-exist',
      }),
    );

    const response = composeChinaCorridorControlTowers(bundle);
    const allSignalIds = response.corridors.flatMap((corridor) =>
      corridor.conditions.flatMap((condition) => condition.sourceSignals.map((item) => item.id)));
    assert.equal(allSignalIds.includes('signal:portwatch:unknown'), false);
    assert.equal(allSignalIds.includes('signal:portwatch:cross-boundary'), false);
  });

  it('does not mislabel multiple records from one publisher as multi-source corroboration', () => {
    const bundle = sourceBundle();
    bundle.families.port.signals.push(
      signal({
        id: 'signal:portwatch:ningbo-zhoushan',
        family: 'port',
        selectorId: 'port2027',
      }),
    );

    const response = composeChinaCorridorControlTowers(bundle);
    const condition = response.corridors
      .find((corridor) => corridor.id === 'china-yangtze-river-delta')
      ?.conditions.find((item) => item.family === 'port');
    const corroboration = condition?.provenance?.claims.corroboration;

    assert.equal(corroboration?.status, 'known');
    assert.equal(corroboration?.status === 'known' ? corroboration.value.state : null, 'single_source');
    assert.equal(corroboration?.status === 'known' ? corroboration.value.sourceSignalIds.length : 0, 1);
    assert.equal(condition?.sourceSignals.length, 2);
  });

  it('preserves the selected source observation precision in composed provenance', () => {
    const response = composeChinaCorridorControlTowers(sourceBundle());
    const observation = response.corridors[0]?.conditions
      .find((condition) => condition.family === 'strategic_industry')
      ?.provenance?.claims.observation_time;

    assert.equal(observation?.status, 'known');
    assert.deepEqual(
      observation?.status === 'known' ? observation.value : null,
      { role: 'observation', value: '2025', precision: 'year' },
    );
  });

  it('fails closed when a usable source observation lacks a provenance timestamp', () => {
    const bundle = sourceBundle();
    const portSignal = bundle.families.port.signals[0];
    assert.ok(portSignal);
    portSignal.observationTime = null;
    portSignal.observationTimePrecision = 'unknown';

    const response = composeChinaCorridorControlTowers(bundle);
    const condition = response.corridors
      .find((corridor) => corridor.id === 'china-yangtze-river-delta')
      ?.conditions.find((item) => item.family === 'port');

    assert.equal(condition?.availability, 'partial');
    assert.equal(condition?.provenance, null);
    assert.equal(
      condition?.reason,
      'Source observations lack the timestamps required for a composed provenance envelope.',
    );
  });

  it('localizes provenance construction failures to the affected condition', () => {
    const bundle = sourceBundle();
    const portSignal = bundle.families.port.signals[0];
    assert.ok(portSignal);
    portSignal.transportFreshness = 'invalid' as CorridorSourceSignal['transportFreshness'];

    const response = composeChinaCorridorControlTowers(bundle);
    const yrd = response.corridors.find((corridor) =>
      corridor.id === 'china-yangtze-river-delta');
    const port = yrd?.conditions.find((condition) => condition.family === 'port');
    const trade = yrd?.conditions.find((condition) => condition.family === 'trade');

    assert.equal(port?.availability, 'partial');
    assert.equal(port?.provenance, null);
    assert.match(port?.reason ?? '', /provenance failed validation/i);
    assert.equal(trade?.availability, 'available');
    assert.ok(trade?.provenance);
  });

  it('localizes surface-adapter validation failures to the affected condition', () => {
    const response = composeChinaCorridorControlTowers(sourceBundle());
    const yrd = response.corridors.find((corridor) =>
      corridor.id === 'china-yangtze-river-delta');
    const port = yrd?.conditions.find((condition) => condition.family === 'port');
    assert.ok(port?.provenance);
    (port.provenance as { familyId: string }).familyId = 'unknown-family';

    const validated = validateChinaCorridorProvenanceForSurface(response, 'api');
    const validatedYrd = validated.corridors.find((corridor) =>
      corridor.id === 'china-yangtze-river-delta');
    const validatedPort = validatedYrd?.conditions.find((condition) => condition.family === 'port');
    const validatedTrade = validatedYrd?.conditions.find((condition) => condition.family === 'trade');

    assert.equal(validatedPort?.availability, 'partial');
    assert.equal(validatedPort?.provenance, null);
    assert.match(validatedPort?.reason ?? '', /provenance failed validation/i);
    assert.equal(validatedTrade?.availability, 'available');
    assert.ok(validatedTrade?.provenance);
    assert.equal(validatedYrd?.availability, 'partial');
  });
});
