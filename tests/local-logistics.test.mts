import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocalLogisticsBriefItems,
  buildLocalLogisticsSnapshot,
  rankLocalLogisticsNodes,
} from '../src/services/local-logistics.ts';

const NOW = new Date('2026-03-29T19:00:00.000Z');

function makePlace(overrides = {}) {
  return {
    id: 'place-home',
    name: 'Home',
    lat: 35.994,
    lon: -78.8986,
    radiusKm: 40,
    tags: ['home'],
    priority: 10,
    notes: '',
    offlinePinned: true,
    primary: true,
    source: 'manual',
    sortIndex: 1,
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...overrides,
  };
}

function makeNode(overrides = {}) {
  return {
    id: 'fuel-1',
    category: 'fuel',
    name: 'Fuel Stop',
    lat: 35.99,
    lon: -78.9,
    distanceKm: 5,
    source: 'OpenStreetMap',
    freshness: 'fresh',
    status: 'unknown',
    hazardCompatibility: 'general',
    fetchedAt: NOW,
    ...overrides,
  };
}

test('rankLocalLogisticsNodes prioritizes viable nodes before nearer unknown nodes', () => {
  const ranked = rankLocalLogisticsNodes([
    makeNode({ id: 'fuel-unknown', category: 'fuel', distanceKm: 2, status: 'unknown' }),
    makeNode({ id: 'hospital-open', category: 'hospital', distanceKm: 6, status: 'open' }),
    makeNode({ id: 'water-limited', category: 'water', distanceKm: 4, status: 'limited' }),
  ]);

  assert.deepEqual(
    ranked.map((node) => node.id),
    ['hospital-open', 'water-limited', 'fuel-unknown'],
  );
});

test('buildLocalLogisticsSnapshot preserves place identity and derives category coverage', () => {
  const snapshot = buildLocalLogisticsSnapshot(
    makePlace(),
    [
      makeNode({ id: 'hospital-1', category: 'hospital' }),
      makeNode({ id: 'fuel-1', category: 'fuel' }),
      makeNode({ id: 'water-1', category: 'water' }),
    ],
    { fetchedAt: NOW, source: 'network' },
  );

  assert.equal(snapshot.placeId, 'place-home');
  assert.equal(snapshot.placeName, 'Home');
  assert.deepEqual(snapshot.categories, ['fuel', 'hospital', 'water']);
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.isStale, false);
});

test('buildLocalLogisticsBriefItems yields concise place-brief entries', () => {
  const snapshot = buildLocalLogisticsSnapshot(
    makePlace(),
    [
      makeNode({ id: 'hospital-1', category: 'hospital', name: 'Duke Hospital', distanceKm: 3.2, status: 'open' }),
      makeNode({ id: 'pharmacy-1', category: 'pharmacy', name: '24h Pharmacy', distanceKm: 1.4, status: 'limited' }),
      makeNode({ id: 'fuel-1', category: 'fuel', name: 'Fuel Depot', distanceKm: 5.8, status: 'unknown' }),
    ],
    { fetchedAt: NOW, source: 'network' },
  );

  const items = buildLocalLogisticsBriefItems(snapshot, 2);

  assert.equal(items.length, 2);
  assert.match(items[0]?.label ?? '', /Hospital|Pharmacy|Fuel/);
  assert.match(items[0]?.value ?? '', /km/);
});
