import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasHealthyCanadaRoadSource,
  loadCanadaRoadSourcesCore,
  unionCanadaRoadRecords,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
} from '../src/services/canada-roads-core';

const CANADA_ROAD_SOURCES: readonly CanadaRoadSourceDescriptor[] = [
  { key: 'canadaRoads', source: 'ontario-511', jurisdiction: 'ON', onDemand: false },
  { key: 'albertaRoads', source: 'alberta-511', jurisdiction: 'AB', onDemand: false },
  { key: 'torontoRoads', source: 'toronto-roads', jurisdiction: 'Toronto', onDemand: true },
  { key: 'bcOpen511', source: 'bc-open511', jurisdiction: 'BC', onDemand: true },
];

function road(id: string, source = ''): CanadaRoadRecord {
  return {
    id,
    lat: 43.65,
    lon: -79.38,
    severity: 'Moderate',
    eventType: 'CONSTRUCTION',
    isFullClosure: false,
    lanesAffected: null,
    headline: id,
    description: id,
    jurisdiction: '',
    source,
  };
}

test('loads hydrated and missing sources independently and preserves valid empty data', async () => {
  const hydrated = new Map<string, unknown>([
    ['canadaRoads', { records: [] }],
    ['albertaRoads', { records: [road('ab-1')] }],
  ]);
  const onDemand: string[] = [];
  const result = await loadCanadaRoadSourcesCore(CANADA_ROAD_SOURCES, {
    getHydrated: (key) => hydrated.get(key),
    fetchMissing: async (descriptor) => {
      onDemand.push(descriptor.key);
      return descriptor.key === 'torontoRoads'
        ? { records: [{ ...road('to-1'), district: 'Toronto and East York', currImpact: 'High' }] }
        : { records: [road('bc-1')] };
    },
  });

  assert.deepEqual(onDemand, ['torontoRoads', 'bcOpen511']);
  assert.deepEqual(result.states, {
    canadaRoads: 'empty',
    albertaRoads: 'available',
    torontoRoads: 'available',
    bcOpen511: 'available',
  });
  assert.deepEqual(result.records?.map(({ source, id }) => `${source}:${id}`), [
    'alberta-511:ab-1',
    'toronto-roads:to-1',
    'bc-open511:bc-1',
  ]);
  assert.equal(result.records?.[1]?.district, 'Toronto and East York');
  assert.equal(result.records?.[1]?.currImpact, 'High');
});

test('one failed tier source does not discard successful siblings', async () => {
  const result = await loadCanadaRoadSourcesCore(CANADA_ROAD_SOURCES, {
    getHydrated: (key) => key === 'albertaRoads' ? { records: [] } : undefined,
    fetchMissing: async (descriptor) => {
      if (descriptor.key === 'torontoRoads') return { records: [road('to-2')] };
      if (descriptor.key === 'bcOpen511') throw new Error('BC unavailable');
      throw new Error('Ontario unavailable');
    },
  });

  assert.equal(result.states.canadaRoads, 'unavailable');
  assert.equal(result.states.albertaRoads, 'empty');
  assert.equal(result.states.torontoRoads, 'available');
  assert.equal(result.states.bcOpen511, 'unavailable');
  assert.deepEqual(result.records?.map(({ id }) => id), ['to-2']);
});

test('authoritative hydrated empty does not refetch the on-demand source', async () => {
  let onDemandCalls = 0;
  const result = await loadCanadaRoadSourcesCore(CANADA_ROAD_SOURCES, {
    getHydrated: (key) => ({ records: key === 'torontoRoads' ? [] : [road(key)] }),
    fetchMissing: async () => {
      onDemandCalls += 1;
      return undefined;
    },
  });

  assert.equal(onDemandCalls, 0);
  assert.equal(result.states.torontoRoads, 'empty');
});

test('malformed and unavailable sources remain distinct', async () => {
  const result = await loadCanadaRoadSourcesCore(CANADA_ROAD_SOURCES, {
    getHydrated: (key) => key === 'canadaRoads' ? { unexpected: true } : undefined,
    fetchMissing: async () => { throw new Error('unavailable'); },
  });

  assert.deepEqual(result.states, {
    canadaRoads: 'malformed',
    albertaRoads: 'unavailable',
    torontoRoads: 'unavailable',
    bcOpen511: 'unavailable',
  });
  assert.equal(result.records, null);
});

test('corrupt record arrays are malformed rather than available or unavailable', async () => {
  for (const corrupt of [{}, null, 7]) {
    const result = await loadCanadaRoadSourcesCore([CANADA_ROAD_SOURCES[0]!], {
      getHydrated: () => ({ records: [corrupt] }),
      fetchMissing: async () => undefined,
    });
    assert.deepEqual(result.states, { canadaRoads: 'malformed' });
    assert.equal(result.records, null);
  }
});

test('corrupt optional record fields are malformed before map rendering', async () => {
  for (const corrupt of [
    { ...road('bad-source'), source: { bad: true } },
    { ...road('bad-centroid'), centroid: ['bad', null] },
    { ...road('bad-path'), path: [[-123, 49], [null, 50]] },
    { ...road('bad-time'), lastUpdated: Number.NaN },
  ]) {
    const result = await loadCanadaRoadSourcesCore([CANADA_ROAD_SOURCES[0]!], {
      getHydrated: () => ({ records: [corrupt] }),
      fetchMissing: async () => undefined,
    });
    assert.deepEqual(result.states, { canadaRoads: 'malformed' });
    assert.equal(result.records, null);
  }
});

test('only available and authoritative empty states count as healthy', () => {
  assert.equal(hasHealthyCanadaRoadSource({
    canadaRoads: 'unavailable',
    albertaRoads: 'malformed',
  }), false);
  assert.equal(hasHealthyCanadaRoadSource({
    canadaRoads: 'unavailable',
    albertaRoads: 'empty',
  }), true);
});

test('deduplicates by source and id, not by id alone', () => {
  const first = { ...road('shared', 'ontario-511'), jurisdiction: 'ON' };
  const duplicate = { ...road('shared', 'ontario-511'), jurisdiction: 'ON' };
  const sibling = { ...road('shared', 'alberta-511'), jurisdiction: 'AB' };
  assert.deepEqual(
    unionCanadaRoadRecords([first], [duplicate, sibling])?.map(({ source }) => source),
    ['ontario-511', 'alberta-511'],
  );
});
