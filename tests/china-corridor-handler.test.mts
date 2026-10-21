import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_CORRIDOR_SOURCE_KEYS,
  composeChinaCorridorSnapshot,
  composeUnavailableChinaCorridorSnapshot,
  loadChinaCorridorRawSnapshots,
  projectChinaCorridorWireResponse,
  resolveChinaCorridorSnapshot,
} from '../server/worldmonitor/supply-chain/v1/get-china-corridor-control-towers.ts';
import {
  parseChinaCorridorWirePayload,
  validateChinaCorridorProvenanceForSurface,
} from '../shared/china-corridor-control-towers.ts';

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

  it('pipelines the default audited source reads in one batch', async () => {
    const calls: Array<{ keys: string[]; raw: boolean | undefined }> = [];
    const snapshots = await loadChinaCorridorRawSnapshots(undefined, async (keys, raw) => {
      calls.push({ keys, raw });
      return new Map([
        [CHINA_CORRIDOR_SOURCE_KEYS.portwatchChina, { ports: [] }],
        [CHINA_CORRIDOR_SOURCE_KEYS.portwatchMeta, { fetchedAt: 1 }],
      ]);
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.keys.sort(), Object.values(CHINA_CORRIDOR_SOURCE_KEYS).sort());
    assert.equal(calls[0]?.raw, true);
    assert.deepEqual(snapshots.portwatchChina, { ports: [] });
    assert.equal(snapshots.aviation, null);
  });

  it('fails closed when the batch source read itself fails', async () => {
    const snapshots = await loadChinaCorridorRawSnapshots(undefined, async () => {
      throw new Error('pipeline unavailable');
    });

    assert.equal(
      Object.values(snapshots).every((value) => value === null),
      true,
    );
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
    assert.ok(response);

    const yrd = response.corridors.find((corridor) => corridor.id === 'china-yangtze-river-delta');
    const port = yrd?.conditions.find((condition) => condition.family === 'port');
    assert.equal(port?.availability, 'partial');
    assert.equal(port?.sourceSignals.some((signal) => signal.selectorId === 'port1188' && signal.availability === 'available'), true);
    assert.equal(yrd?.conditions.find((condition) => condition.family === 'aviation')?.availability, 'unavailable');
    assert.equal(yrd?.availability, 'partial');
  });

  it('returns null instead of positively caching an all-unavailable composition', async () => {
    const response = await composeChinaCorridorSnapshot(ASSESSED_AT, async () => null);
    assert.equal(response, null);
  });

  it('does not repeat the batch source read after an all-unavailable cache miss', async () => {
    let batchReads = 0;
    const response = await resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      async (_key, _ttlSeconds, fetcher) => fetcher(),
      undefined,
      async () => {
        batchReads++;
        return new Map();
      },
    );

    assert.equal(batchReads, 1);
    assert.equal(
      response.corridors.every((corridor) => corridor.availability === 'unavailable'),
      true,
    );
  });

  it('coalesces concurrent all-unavailable cache misses before the source batch', async () => {
    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    let cacheReads = 0;
    let batchReads = 0;
    const cache = async (
      _key: string,
      _ttlSeconds: number,
      fetcher: () => Promise<Awaited<ReturnType<typeof composeChinaCorridorSnapshot>>>,
    ) => {
      cacheReads++;
      await cacheGate;
      return fetcher();
    };
    const readBatch = async () => {
      batchReads++;
      return new Map<string, unknown>();
    };

    const first = resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      cache,
      undefined,
      readBatch,
    );
    const second = resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      cache,
      undefined,
      readBatch,
    );
    releaseCache();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(cacheReads, 1);
    assert.equal(batchReads, 1);
    assert.deepEqual(secondResponse, firstResponse);
  });

  it('does not coalesce resolutions with different assessment timestamps', async () => {
    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    let cacheReads = 0;
    const cache = async (
      _key: string,
      _ttlSeconds: number,
      fetcher: () => Promise<Awaited<ReturnType<typeof composeChinaCorridorSnapshot>>>,
    ) => {
      cacheReads++;
      await cacheGate;
      return fetcher();
    };
    const readBatch = async () => new Map<string, unknown>();
    const laterAssessedAt = '2026-07-25T13:00:00.000Z';

    const first = resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      cache,
      undefined,
      readBatch,
    );
    const second = resolveChinaCorridorSnapshot(
      laterAssessedAt,
      cache,
      undefined,
      readBatch,
    );
    releaseCache();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(cacheReads, 2);
    assert.equal(firstResponse.generatedAt, ASSESSED_AT);
    assert.equal(secondResponse.generatedAt, laterAssessedAt);
  });

  it('recomposes a cache-null result from current source seeds', async () => {
    const values = new Map<string, unknown>([
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchChina, {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai', tankerCalls30d: 8 }],
      }],
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchMeta, {
        fetchedAt: Date.parse('2026-07-25T11:30:00.000Z'),
      }],
    ]);
    let batchReads = 0;
    const response = await resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      async () => null,
      undefined,
      async (keys) => {
        batchReads++;
        assert.deepEqual(keys.sort(), Object.values(CHINA_CORRIDOR_SOURCE_KEYS).sort());
        return values;
      },
    );

    assert.equal(batchReads, 1);
    const yrdPort = response.corridors
      .find((corridor) => corridor.id === 'china-yangtze-river-delta')
      ?.conditions.find((condition) => condition.family === 'port');
    assert.equal(yrdPort?.sourceSignals.some((signal) =>
      signal.selectorId === 'port1188' && signal.availability === 'available'), true);
  });

  it('does not preserve a legacy positive cache entry with total unavailability', async () => {
    const values = new Map<string, unknown>([
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchChina, {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai', tankerCalls30d: 8 }],
      }],
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchMeta, {
        fetchedAt: Date.parse('2026-07-25T11:30:00.000Z'),
      }],
    ]);
    const response = await resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      async () => composeUnavailableChinaCorridorSnapshot(ASSESSED_AT),
      async (key) => values.get(key) ?? null,
    );

    const yrdPort = response.corridors
      .find((corridor) => corridor.id === 'china-yangtze-river-delta')
      ?.conditions.find((condition) => condition.family === 'port');
    assert.equal(yrdPort?.sourceSignals.some((signal) =>
      signal.selectorId === 'port1188' && signal.availability === 'available'), true);
  });

  it('recomposes from current seeds when the aggregate cache read throws', async () => {
    const values = new Map<string, unknown>([
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchChina, {
        fetchedAt: '2026-07-25T11:00:00.000Z',
        ports: [{ portId: 'port1188', portName: 'Shanghai', tankerCalls30d: 8 }],
      }],
      [CHINA_CORRIDOR_SOURCE_KEYS.portwatchMeta, {
        fetchedAt: Date.parse('2026-07-25T11:30:00.000Z'),
      }],
    ]);
    const response = await resolveChinaCorridorSnapshot(
      ASSESSED_AT,
      async () => {
        throw new Error('aggregate cache unavailable');
      },
      async (key) => values.get(key) ?? null,
    );

    const yrdPort = response.corridors
      .find((corridor) => corridor.id === 'china-yangtze-river-delta')
      ?.conditions.find((condition) => condition.family === 'port');
    assert.equal(yrdPort?.sourceSignals.some((signal) =>
      signal.selectorId === 'port1188' && signal.availability === 'available'), true);
  });

  it('serializes canonical API JSON and reports total upstream unavailability honestly', () => {
    const response = composeUnavailableChinaCorridorSnapshot(ASSESSED_AT);
    const wire = projectChinaCorridorWireResponse(response);
    const parsed = parseChinaCorridorWirePayload(wire.payloadJson);

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

  it('rejects an empty client payload instead of dropping canonical fail-closed towers', () => {
    assert.throws(
      () => parseChinaCorridorWirePayload('{"generatedAt":"","corridors":[]}'),
      /Invalid China corridor control-tower response/,
    );
    assert.throws(
      () => parseChinaCorridorWirePayload(
        '{"generatedAt":"2026-07-25T12:00:00.000Z","corridors":[{"id":"china-yangtze-river-delta","conditions":[]}]}',
      ),
      /Invalid China corridor control-tower response/,
    );
  });
});
