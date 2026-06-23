import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSensorFusionSnapshot } from '../src/services/sensor-fusion.ts';

const emptyLayers = {
  flights: false,
  military: false,
  ais: false,
  satellites: false,
  webcams: false,
  natural: false,
  fires: false,
  weather: false,
  weatherRadar: false,
};

describe('sensor fusion snapshot', () => {
  it('summarizes live fused layers and tracked object counts', () => {
    const snapshot = buildSensorFusionSnapshot({
      aircraftPositions: [{ lat: 1, lon: 2 }],
      military: {
        flights: [{ lat: 3, lon: 4 }, { lat: 5, lon: 6 }],
        flightClusters: [],
        vessels: [{ lat: 7, lon: 8 }],
        vesselClusters: [],
      },
      earthquakes: [{ location: { latitude: 1, longitude: 2 } }],
      thermalEscalation: { clusters: [{ id: 'hot-zone' }] },
      imageryScenes: [{ id: 'scene-1' }, { id: 'scene-2' }],
    } as any, {
      ...emptyLayers,
      flights: true,
      military: true,
      ais: true,
      satellites: true,
      natural: true,
      fires: true,
    });

    assert.equal(snapshot.liveLayers, 6);
    assert.equal(snapshot.trackedObjects, 8);
    assert.equal(snapshot.layers.find(layer => layer.id === 'aircraft')?.count, 3);
    assert.equal(snapshot.layers.find(layer => layer.id === '3d-reconstruction')?.status, 'planned');
  });

  it('marks enabled but empty feeds as ready instead of live', () => {
    const snapshot = buildSensorFusionSnapshot({}, {
      ...emptyLayers,
      satellites: true,
      weather: true,
    });

    assert.equal(snapshot.layers.find(layer => layer.id === 'satellites')?.status, 'ready');
    assert.equal(snapshot.layers.find(layer => layer.id === 'weather')?.status, 'ready');
    assert.equal(snapshot.liveLayers, 1); // the base globe is always live
  });
});
