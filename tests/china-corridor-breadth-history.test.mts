import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_KEY,
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_LIMIT,
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_MAX_PRIOR_AGE_SECONDS,
  CHINA_CORRIDOR_DIRECTIONAL_HISTORY_TTL_SECONDS,
  compareChinaCorridorDirectionalSnapshots,
  mergeChinaCorridorDirectionalHistory,
  persistChinaCorridorDirectionalSnapshot,
  readChinaCorridorDirectionalHistory,
  selectPriorChinaCorridorDirectionalSnapshot,
  type ChinaCorridorDirectionalSnapshot,
} from '../server/worldmonitor/economic/v1/china-corridor-breadth-history';

function snapshot(index: number): ChinaCorridorDirectionalSnapshot {
  return {
    schemaVersion: 3,
    generatedAt: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
    corridorIds: ['china-yangtze-river-delta'],
    familyKeys: ['china-yangtze-river-delta:port'],
    directionalFamilies: ['port'],
    directionalSelectorKeys: ['china-yangtze-river-delta:port:port1188'],
    strengtheningFamilies: ['port'],
    weakeningFamilies: [],
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
    const current = {
      ...snapshot(23),
      directionalFamilies: [],
      directionalSelectorKeys: [],
      strengtheningFamilies: [],
      weakeningFamilies: [],
    };
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

  it('excludes a directional availability transition instead of publishing activity', () => {
    const prior = snapshot(0);
    const current = {
      ...snapshot(1),
      directionalFamilies: [],
      strengtheningFamilies: [],
      weakeningFamilies: [],
    };

    assert.deepEqual(compareChinaCorridorDirectionalSnapshots(current, prior), {
      value: null,
      priorValue: 1,
      exclusion: 'directional_observations_not_available',
    });

    const currentWithAnotherFamily = {
      ...snapshot(1),
      directionalFamilies: ['port', 'trade'] as ChinaCorridorDirectionalSnapshot['directionalFamilies'],
      directionalSelectorKeys: [
        'china-yangtze-river-delta:port:port1188',
        'china-yangtze-river-delta:trade:ccfi',
      ],
      strengtheningFamilies: ['port', 'trade'] as ChinaCorridorDirectionalSnapshot['strengtheningFamilies'],
      weakeningFamilies: [],
      familyKeys: [
        'china-yangtze-river-delta:port',
        'china-yangtze-river-delta:trade',
      ],
    };
    const priorWithAnotherFamily = {
      ...snapshot(0),
      directionalFamilies: ['port', 'trade'] as ChinaCorridorDirectionalSnapshot['directionalFamilies'],
      directionalSelectorKeys: [
        'china-yangtze-river-delta:port:port1188',
        'china-yangtze-river-delta:trade:ccfi',
      ],
      strengtheningFamilies: ['port'] as ChinaCorridorDirectionalSnapshot['strengtheningFamilies'],
      weakeningFamilies: ['trade'] as ChinaCorridorDirectionalSnapshot['weakeningFamilies'],
      familyKeys: [
        'china-yangtze-river-delta:port',
        'china-yangtze-river-delta:trade',
      ],
    };

    assert.deepEqual(
      compareChinaCorridorDirectionalSnapshots(
        currentWithAnotherFamily,
        priorWithAnotherFamily,
      ),
      {
        value: 2,
        priorValue: 0,
        exclusion: null,
      },
    );

    const priorDirectionalDrift = {
      ...priorWithAnotherFamily,
      directionalFamilies: ['port'] as ChinaCorridorDirectionalSnapshot['directionalFamilies'],
      directionalSelectorKeys: ['china-yangtze-river-delta:port:port1188'],
      strengtheningFamilies: ['port'] as ChinaCorridorDirectionalSnapshot['strengtheningFamilies'],
      weakeningFamilies: [],
      familyKeys: [
        'china-yangtze-river-delta:port',
        'china-yangtze-river-delta:trade',
      ],
    };
    assert.deepEqual(
      compareChinaCorridorDirectionalSnapshots(
        currentWithAnotherFamily,
        priorDirectionalDrift,
      ),
      {
        value: null,
        priorValue: 1,
        exclusion: 'directional_family_set_changed',
      },
    );
  });

  it('rejects priors older than the corridor freshness budget at the boundary', () => {
    const current = {
      ...snapshot(0),
      generatedAt: '2026-07-04T00:00:00.000Z',
    };
    const atBoundary = {
      ...snapshot(1),
      generatedAt: new Date(
        Date.parse(current.generatedAt)
          - CHINA_CORRIDOR_DIRECTIONAL_HISTORY_MAX_PRIOR_AGE_SECONDS * 1000,
      ).toISOString(),
    };
    const beyondBoundary = {
      ...snapshot(2),
      generatedAt: new Date(
        Date.parse(current.generatedAt)
          - (CHINA_CORRIDOR_DIRECTIONAL_HISTORY_MAX_PRIOR_AGE_SECONDS + 1) * 1000,
      ).toISOString(),
    };

    assert.deepEqual(
      selectPriorChinaCorridorDirectionalSnapshot(current, [beyondBoundary, atBoundary]),
      atBoundary,
    );
    assert.equal(
      selectPriorChinaCorridorDirectionalSnapshot(current, [beyondBoundary]),
      null,
    );
  });
});
