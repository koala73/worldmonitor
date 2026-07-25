import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_CORRIDOR_SOURCE_KEYS,
  composeChinaCorridorSnapshot,
  loadChinaCorridorRawSnapshots,
  projectChinaCorridorWireResponse,
} from '../server/worldmonitor/supply-chain/v1/get-china-corridor-control-towers.ts';
import { validateChinaCorridorProvenanceForSurface } from '../shared/china-corridor-control-towers.ts';

const ASSESSED_AT = '2026-07-25T12:00:00.000Z';

describe('China corridor API/cache composition (#5578)', () => {
  it('reads every audited source and health key with per-key failure isolation', async () => {
    const calls: string[] = [];
    const snapshots = await loadChinaCorridorRawSnapshots(async (key, raw) => {
      calls.push(key);
      assert.equal(raw, true);
      if (key === CHINA_CORRIDOR_SOURCE_KEYS.aviation) throw new Error('provider read failed');
      return { key };
    });

    assert.deepEqual(calls.sort(), Object.values(CHINA_CORRIDOR_SOURCE_KEYS).sort());
    assert.equal(snapshots.aviation, null);
    assert.deepEqual(snapshots.portwatchMeta, { key: CHINA_CORRIDOR_SOURCE_KEYS.portwatchMeta });
  });

  it('keeps unaffected families useful when one provider cache read fails', async () => {
    const values = new Map<string, unknown>([
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchChina, {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai', tankerCalls30d: 8 }],
      }],
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchMeta, { fetchedAt: Date.parse('2026-07-25T11:30:00.000Z') }],
    ]);
    const response = await composeChinaCorridorSnapshot(ASSESSED_AT, async (key) => {
      if (key === CHINA_CORRIDOR_SOURCE_KEYS.aviation) throw new Error('aviation unavailable');
      return values.get(key) ?? null;
    });

    const yrd = response.corridors.find((corridor) => corridor.id === 'china-yangtze-river-delta');
    const port = yrd?.conditions.find((condition) => condition.family === 'port');
    assert.equal(port?.availability, 'partial');
    assert.equal(port?.sourceSignals.some((signal) => signal.selectorId === 'port1188' && signal.availability === 'available'), true);
    assert.equal(yrd?.conditions.find((condition) => condition.family === 'aviation')?.availability, 'unavailable');
    assert.equal(yrd?.availability, 'partial');
  });

  it('serializes canonical API JSON and reports total upstream unavailability honestly', async () => {
    const response = await composeChinaCorridorSnapshot(ASSESSED_AT, async () => null);
    const wire = projectChinaCorridorWireResponse(response);
    const parsed = JSON.parse(wire.payloadJson);

    assert.equal(wire.generatedAt, ASSESSED_AT);
    assert.equal(wire.upstreamUnavailable, true);
    assert.equal(parsed.corridors.length, 4);
    assert.equal(parsed.corridors.every((corridor: { availability: string }) =>
      corridor.availability === 'unavailable'), true);
    assert.equal(
      parsed.corridors.every((corridor: { conditions: Array<{ sourceSignals: unknown[] }> }) =>
        corridor.conditions.every((condition) => condition.sourceSignals.length > 0)),
      true,
    );
    assert.deepEqual(
      validateChinaCorridorProvenanceForSurface(parsed, 'ui'),
      parsed,
    );
  });
});
