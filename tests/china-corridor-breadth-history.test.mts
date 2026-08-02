import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY,
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT,
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_TTL_SECONDS,
  mergeChinaCorridorDirectionalHistory,
  persistChinaCorridorDirectionalSnapshot,
  readChinaCorridorDirectionalHistory,
  type ChinaCorridorDirectionalSnapshot,
} from '../server/worldmonitor/economic/v1/china-corridor-breadth-history';

function snapshot(index: number): ChinaCorridorDirectionalSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
    corridorIds: ['china-yangtze-river-delta'],
    familyKeys: ['china-yangtze-river-delta:port'],
    directionalFamilies: ['port'],
  };
}

describe('China corridor breadth snapshot history (#6068)', () => {
  it('reads only validated, newest-first snapshots from the bounded contract', async () => {
    const valid = snapshot(1);
    const history = await readChinaCorridorDirectionalHistory(async (key, limit) => {
      assert.equal(key, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY);
      assert.equal(limit, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT);
      return {
        status: 'hit',
        value: [
          { ...valid, generatedAt: 'not-a-timestamp' },
          snapshot(0),
          valid,
          valid,
          { ...valid, directionalFamilies: ['hazard'] },
        ],
      };
    });

    assert.deepEqual(history, [valid, snapshot(0)]);
  });

  it('deduplicates by generatedAt and enforces count plus TTL retention on write', async () => {
    const existing = Array.from(
      { length: CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT + 3 },
      (_, index) => snapshot(index),
    );
    const current = { ...snapshot(23), directionalFamilies: [] };
    const merged = mergeChinaCorridorDirectionalHistory(current, existing);
    assert.equal(merged.length, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT);
    assert.deepEqual(merged[0], current);
    assert.equal(new Set(merged.map((item) => item.generatedAt)).size, merged.length);

    let written: unknown = null;
    await persistChinaCorridorDirectionalSnapshot(
      current,
      async (key, value, limit, ttlSeconds) => {
        assert.equal(key, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY);
        assert.equal(limit, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT);
        assert.equal(ttlSeconds, CHINA_CORRIDOR_DIRECTIONAL_HISTORY_TTL_SECONDS);
        written = value;
        return true;
      },
    );
    assert.deepEqual(written, current);
  });

  it('does not make a writer replace the history it is extending', async () => {
    let stored = [snapshot(0)];
    const write = async (
      _key: string,
      value: unknown,
      limit: number,
    ) => {
      stored = mergeChinaCorridorDirectionalHistory(
        value as ChinaCorridorDirectionalSnapshot,
        stored,
      ).slice(0, limit);
      return true;
    };

    await persistChinaCorridorDirectionalSnapshot(snapshot(1), write);
    await persistChinaCorridorDirectionalSnapshot(snapshot(2), write);

    assert.deepEqual(
      stored.map((item) => item.generatedAt),
      [snapshot(2), snapshot(1), snapshot(0)].map((item) => item.generatedAt),
    );
  });
});
