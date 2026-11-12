import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANADA_ROAD_SOURCES,
  hasHealthyCanadaRoadSource,
  loadCanadaRoadSourcesCore,
  recordsFromPayload,
  unionCanadaRoadRecords,
  type CanadaRoadRecord,
} from '../src/services/canada-roads-core';
import { isReportableCanadaRoad } from '../src/services/canada-road-report';
import { normalize511Record } from '../scripts/lib/provincial-511.mjs';

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
      if (descriptor.key === 'torontoRoads') {
        return { records: [{ ...road('to-1'), district: 'Toronto and East York', currImpact: 'High' }] };
      }
      if (descriptor.key === 'manitobaRoads') return { records: [road('mb-1')] };
      return { records: [road('bc-1')] };
    },
  });

  assert.deepEqual(onDemand, ['manitobaRoads', 'torontoRoads', 'bcOpen511']);
  assert.deepEqual(result.states, {
    canadaRoads: 'empty',
    albertaRoads: 'available',
    manitobaRoads: 'available',
    torontoRoads: 'available',
    bcOpen511: 'available',
  });
  assert.deepEqual(result.records?.map(({ source, id }) => `${source}:${id}`), [
    'alberta-511:ab-1',
    'manitoba-511:mb-1',
    'toronto-roads:to-1',
    'bc-open511:bc-1',
  ]);
  const toronto = result.records?.find((record) => record.source === 'toronto-roads');
  assert.equal(toronto?.district, 'Toronto and East York');
  assert.equal(toronto?.currImpact, 'High');
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
  assert.equal(result.states.manitobaRoads, 'unavailable');
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
    manitobaRoads: 'unavailable',
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
    { ...road('bad-location'), locationDescription: 42 },
    { ...road('bad-conditions'), roadConditions: ['No Report', null] },
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

function placeholderRoad(overrides: Partial<CanadaRoadRecord> = {}): CanadaRoadRecord {
  return {
    ...road('hwy-40', 'alberta-511'),
    kind: 'event',
    roadwayName: 'HWY-40',
    headline: 'HWY-40',
    description: '',
    eventType: 'event',
    severity: 'None',
    lanesAffected: 'No Data',
    ...overrides,
  };
}

test('hides placeholder-only No Data and No Report records across road feeds', () => {
  for (const { source } of CANADA_ROAD_SOURCES) {
    for (const kind of ['event', 'alert', 'condition'] as const) {
      for (const placeholder of ['No Data', 'No Report', ' no report. ', 'NO DATA']) {
        const record = placeholderRoad({ source, kind, lanesAffected: placeholder });
        assert.equal(isReportableCanadaRoad(record), false, `${source} ${kind}: ${placeholder}`);
      }
    }
  }
});

test('recognizes placeholders in report fields without treating a road name as a report', () => {
  for (const field of ['headline', 'description', 'eventType', 'type', 'severity', 'lanesAffected', 'currImpact'] as const) {
    assert.equal(isReportableCanadaRoad(placeholderRoad({ lanesAffected: null, [field]: 'No Report' })), false, field);
  }
  assert.equal(isReportableCanadaRoad(placeholderRoad({
    headline: ' hwy-40 ', description: 'Unknown', eventType: 'Road Conditions',
    type: 'condition', currImpact: 'N/A', district: 'Calgary',
  })), false);
});

test('keeps incidents, closures, and meaningful conditions despite a placeholder in another field', () => {
  const reports: Partial<CanadaRoadRecord>[] = [
    { isFullClosure: true },
    { severity: 'Extreme' },
    { severity: 'Severe' },
    { severity: 'Moderate' },
    { severity: 'Minor' },
    { eventType: 'Accident' },
    { eventType: 'Construction' },
    { type: 'ROADWORK' },
    { headline: 'Bridge closed for repairs' },
    { description: 'Collision ahead' },
    { kind: 'condition', description: 'Icy sections' },
    { kind: 'condition', description: 'Bare and dry' },
    { kind: 'condition', description: 'No report of injuries. Road blocked.' },
    { lanesAffected: 'One lane closed', description: 'No Report' },
    { currImpact: 'Major', description: 'No Data' },
  ];
  for (const report of reports) {
    assert.equal(isReportableCanadaRoad(placeholderRoad(report)), true, JSON.stringify(report));
  }
});

test('does not hide a record just because severity is None or Unknown', () => {
  for (const severity of ['None', 'Unknown', '']) {
    assert.equal(isReportableCanadaRoad(placeholderRoad({ severity, lanesAffected: null })), true);
  }
});

test('filters normalized Ontario conditions without mistaking a location for a report', () => {
  for (const roadwayName of ['627', undefined]) {
    for (const conditions of [['No Report'], ['No Data'], ['No Report', 'Bare and dry'], ['Icy sections']]) {
      const record = normalize511Record({
        RoadwayName: roadwayName,
        LocationDescription: 'From Highway 17 to Pukaskwa Park',
        Condition: conditions,
      }, { kind: 'condition', jurisdiction: 'ON' });
      assert.deepEqual(recordsFromPayload({ records: [record] }), [record]);
      assert.equal(isReportableCanadaRoad(record), conditions.some(value => !/^No /.test(value)), JSON.stringify(conditions));
      assert.deepEqual(record.roadConditions, conditions);
      assert.equal(record.locationDescription, 'From Highway 17 to Pukaskwa Park');
      assert.equal(isReportableCanadaRoad({ ...record, isFullClosure: true }), true);
      assert.equal(isReportableCanadaRoad({ ...record, description: 'Collision ahead' }), true);
      assert.equal(isReportableCanadaRoad({ ...record, severity: 'Severe' }), true);
    }
  }
});
