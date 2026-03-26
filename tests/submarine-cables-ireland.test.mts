/**
 * Tests for IRELAND_SUBMARINE_CABLES and IRELAND_LANDING_STATIONS (FR #174)
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  IRELAND_SUBMARINE_CABLES,
  IRELAND_LANDING_STATIONS,
  CABLE_COLORS,
  CABLE_DESTINATION_LABELS,
} from '../src/config/variants/ireland/data/submarine-cables.ts';

describe('IRELAND_SUBMARINE_CABLES', () => {
  it('has at least 10 cables', () => {
    assert.ok(IRELAND_SUBMARINE_CABLES.length >= 10, `Expected at least 10 cables, got ${IRELAND_SUBMARINE_CABLES.length}`);
  });

  it('all cables have required fields', () => {
    for (const cable of IRELAND_SUBMARINE_CABLES) {
      assert.ok(cable.id, `Cable missing id`);
      assert.ok(cable.name, `Cable ${cable.id} missing name`);
      assert.ok(cable.route, `Cable ${cable.id} missing route`);
      assert.ok(cable.destination, `Cable ${cable.id} missing destination`);
      assert.ok(cable.path.length >= 2, `Cable ${cable.id} path should have at least 2 points`);
      assert.ok(cable.landingPoints.length >= 1, `Cable ${cable.id} should have at least 1 landing point`);
      assert.ok(cable.operator, `Cable ${cable.id} missing operator`);
      assert.ok(cable.rfs !== undefined, `Cable ${cable.id} missing rfs`);
      assert.ok(cable.status, `Cable ${cable.id} missing status`);
    }
  });

  it('all cable IDs are unique', () => {
    const ids = IRELAND_SUBMARINE_CABLES.map(c => c.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'All cable IDs should be unique');
  });

  it('all cables have valid destination', () => {
    const validDestinations = ['transatlantic', 'uk', 'europe', 'planned'];
    for (const cable of IRELAND_SUBMARINE_CABLES) {
      assert.ok(validDestinations.includes(cable.destination), `Cable ${cable.id} has invalid destination: ${cable.destination}`);
    }
  });

  it('all cables have valid status', () => {
    const validStatuses = ['active', 'under-construction', 'planned'];
    for (const cable of IRELAND_SUBMARINE_CABLES) {
      assert.ok(validStatuses.includes(cable.status), `Cable ${cable.id} has invalid status: ${cable.status}`);
    }
  });

  it('path coordinates are valid [lng, lat] pairs', () => {
    for (const cable of IRELAND_SUBMARINE_CABLES) {
      for (const point of cable.path) {
        assert.equal(point.length, 2, `Cable ${cable.id} has invalid path point`);
        const [lng, lat] = point;
        assert.ok(lng >= -180 && lng <= 180, `Cable ${cable.id} has invalid longitude: ${lng}`);
        assert.ok(lat >= -90 && lat <= 90, `Cable ${cable.id} has invalid latitude: ${lat}`);
      }
    }
  });

  it('has at least one transatlantic cable', () => {
    const transatlantic = IRELAND_SUBMARINE_CABLES.filter(c => c.destination === 'transatlantic');
    assert.ok(transatlantic.length >= 1, 'Should have at least one transatlantic cable');
  });

  it('has at least one UK cable', () => {
    const uk = IRELAND_SUBMARINE_CABLES.filter(c => c.destination === 'uk');
    assert.ok(uk.length >= 1, 'Should have at least one UK cable');
  });
});

describe('IRELAND_LANDING_STATIONS', () => {
  it('has at least 3 landing stations', () => {
    assert.ok(IRELAND_LANDING_STATIONS.length >= 3, `Expected at least 3 landing stations, got ${IRELAND_LANDING_STATIONS.length}`);
  });

  it('all stations have required fields', () => {
    for (const station of IRELAND_LANDING_STATIONS) {
      assert.ok(station.id, `Station missing id`);
      assert.ok(station.city, `Station ${station.id} missing city`);
      assert.ok(station.lat, `Station ${station.id} missing lat`);
      assert.ok(station.lng, `Station ${station.id} missing lng`);
      assert.ok(station.cableIds.length >= 1, `Station ${station.id} should have at least 1 cable`);
    }
  });

  it('all station IDs are unique', () => {
    const ids = IRELAND_LANDING_STATIONS.map(s => s.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'All station IDs should be unique');
  });

  it('all cableIds reference valid cables', () => {
    const cableIds = new Set(IRELAND_SUBMARINE_CABLES.map(c => c.id));
    for (const station of IRELAND_LANDING_STATIONS) {
      for (const cableId of station.cableIds) {
        assert.ok(cableIds.has(cableId), `Station ${station.id} references invalid cable: ${cableId}`);
      }
    }
  });

  it('has Dublin landing station', () => {
    const dublin = IRELAND_LANDING_STATIONS.find(s => s.city === 'Dublin');
    assert.ok(dublin, 'Should have a Dublin landing station');
  });
});

describe('CABLE_COLORS', () => {
  it('has all destination colors', () => {
    assert.ok(CABLE_COLORS.transatlantic, 'Missing transatlantic color');
    assert.ok(CABLE_COLORS.uk, 'Missing uk color');
    assert.ok(CABLE_COLORS.europe, 'Missing europe color');
    assert.ok(CABLE_COLORS.planned, 'Missing planned color');
  });

  it('colors are valid RGB arrays', () => {
    for (const [key, color] of Object.entries(CABLE_COLORS)) {
      assert.equal(color.length, 3, `Color ${key} should have 3 components`);
      for (const val of color) {
        assert.ok(val >= 0 && val <= 255, `Color ${key} has invalid RGB value: ${val}`);
      }
    }
  });
});

describe('CABLE_DESTINATION_LABELS', () => {
  it('has all destination labels', () => {
    assert.ok(CABLE_DESTINATION_LABELS.transatlantic, 'Missing transatlantic label');
    assert.ok(CABLE_DESTINATION_LABELS.uk, 'Missing uk label');
    assert.ok(CABLE_DESTINATION_LABELS.europe, 'Missing europe label');
    assert.ok(CABLE_DESTINATION_LABELS.planned, 'Missing planned label');
  });
});
