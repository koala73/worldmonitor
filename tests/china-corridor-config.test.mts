import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_LOGISTICS_CORRIDORS,
  CHINA_LOGISTICS_CORRIDOR_IDS,
  findCorridorsForSourceSelector,
  resolveCorridorForPoint,
} from '../shared/china-logistics-corridors';

describe('China logistics corridor configuration (#5578)', () => {
  it('publishes four reviewed corridors with stable IDs, boundaries, nodes, and signal families', () => {
    assert.deepEqual(CHINA_LOGISTICS_CORRIDOR_IDS, [
      'china-yangtze-river-delta',
      'china-greater-bay-area',
      'china-bohai-rim',
      'china-western-land-sea-corridor',
    ]);

    for (const corridor of CHINA_LOGISTICS_CORRIDORS) {
      assert.ok(corridor.description.length > 40, `${corridor.id} needs a reviewed description`);
      assert.ok(corridor.boundary.length >= 4, `${corridor.id} needs a closed map boundary`);
      assert.deepEqual(corridor.boundary[0], corridor.boundary.at(-1), `${corridor.id} boundary must close`);
      assert.ok(corridor.nodes.some((node) => node.type === 'industrial'));
      assert.deepEqual(
        [...corridor.signalFamilies].sort(),
        ['aviation', 'hazard', 'port', 'power_energy', 'strategic_industry', 'trade'],
      );
      for (const node of corridor.nodes) {
        assert.match(node.id, /^china-node:/);
        assert.ok(Number.isFinite(node.lat));
        assert.ok(Number.isFinite(node.lon));
        assert.ok(node.sourceOwner.length > 0);
        assert.equal(
          resolveCorridorForPoint(node),
          corridor.id,
          `${node.id} must remain inside only its reviewed corridor boundary`,
        );
      }
    }
  });

  it('maps only exact reviewed provider selectors and never display text', () => {
    assert.deepEqual(findCorridorsForSourceSelector('port', 'port1188'), [
      'china-yangtze-river-delta',
    ]);
    assert.deepEqual(findCorridorsForSourceSelector('port', 'port474'), [
      'china-greater-bay-area',
    ]);
    assert.deepEqual(findCorridorsForSourceSelector('aviation', 'PVG'), [
      'china-yangtze-river-delta',
    ]);
    assert.deepEqual(findCorridorsForSourceSelector('aviation', 'CTU'), [
      'china-western-land-sea-corridor',
    ]);
    assert.deepEqual(findCorridorsForSourceSelector('port', 'port1071'), [
      'china-western-land-sea-corridor',
    ]);

    assert.deepEqual(findCorridorsForSourceSelector('port', 'Shanghai'), []);
    assert.deepEqual(findCorridorsForSourceSelector('aviation', 'Hong Kong International'), []);
    assert.deepEqual(findCorridorsForSourceSelector('port', 'port-does-not-exist'), []);
  });

  it('rejects nearby, cross-boundary, and ambiguous coordinate assignments', () => {
    assert.equal(
      resolveCorridorForPoint({ lat: 31.23, lon: 121.47 }),
      'china-yangtze-river-delta',
    );
    assert.equal(
      resolveCorridorForPoint({ lat: 22.31, lon: 114.17 }),
      'china-greater-bay-area',
    );
    assert.equal(
      resolveCorridorForPoint({ lat: 39.90, lon: 116.40 }),
      'china-bohai-rim',
    );
    assert.equal(
      resolveCorridorForPoint({ lat: 30.57, lon: 104.07 }),
      'china-western-land-sea-corridor',
    );

    assert.equal(resolveCorridorForPoint({ lat: 25.5, lon: 115.0 }), null);
    assert.equal(resolveCorridorForPoint({ lat: 35.0, lon: 113.0 }), null);
    assert.equal(resolveCorridorForPoint({ lat: 21.0285, lon: 105.8542 }), null);
    assert.equal(resolveCorridorForPoint({ lat: 23.8103, lon: 90.4125 }), null);
    assert.equal(resolveCorridorForPoint({ lat: Number.NaN, lon: 121 }), null);
  });

  it('keeps provider selector ownership collision-free', () => {
    const claims = new Map<string, string>();
    for (const corridor of CHINA_LOGISTICS_CORRIDORS) {
      for (const selector of corridor.sourceSelectors) {
        const key = `${selector.family}:${selector.id}`;
        assert.equal(claims.get(key), undefined, `${key} is claimed by multiple corridors`);
        claims.set(key, corridor.id);
      }
    }
  });
});
