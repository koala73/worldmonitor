/**
 * Semiconductor Hubs Data Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IRELAND_SEMICONDUCTOR_HUBS, type SemiconductorHub } from '../src/data/semiconductor-hubs.ts';

describe('IRELAND_SEMICONDUCTOR_HUBS', () => {
  it('contains 5 semiconductor facilities', () => {
    assert.equal(IRELAND_SEMICONDUCTOR_HUBS.length, 5);
  });

  it('all entries have required fields', () => {
    for (const hub of IRELAND_SEMICONDUCTOR_HUBS) {
      assert.ok(hub.id, 'id is required');
      assert.ok(hub.name, 'name is required');
      assert.ok(hub.company, 'company is required');
      assert.ok(typeof hub.lat === 'number', 'lat must be a number');
      assert.ok(typeof hub.lng === 'number', 'lng must be a number');
      assert.ok(typeof hub.employees === 'number', 'employees must be a number');
      assert.ok(hub.business, 'business is required');
    }
  });

  it('coordinates are within Ireland bounds', () => {
    // Ireland approx bounds: lat 51.4-55.4, lng -10.5 to -5.5
    for (const hub of IRELAND_SEMICONDUCTOR_HUBS) {
      assert.ok(hub.lat >= 51.4 && hub.lat <= 55.4, `${hub.name} lat ${hub.lat} out of Ireland bounds`);
      assert.ok(hub.lng >= -10.5 && hub.lng <= -5.5, `${hub.name} lng ${hub.lng} out of Ireland bounds`);
    }
  });

  it('Intel Leixlip is included', () => {
    const intel = IRELAND_SEMICONDUCTOR_HUBS.find(h => h.id === 'intel-leixlip');
    assert.ok(intel, 'Intel Leixlip should be included');
    assert.equal(intel?.company, 'Intel Corporation');
    assert.ok(intel?.employees >= 4000, 'Intel should have 4000+ employees');
  });

  it('Analog Devices Limerick is included', () => {
    const analog = IRELAND_SEMICONDUCTOR_HUBS.find(h => h.id === 'analog-limerick');
    assert.ok(analog, 'Analog Devices Limerick should be included');
    assert.equal(analog?.company, 'Analog Devices');
  });

  it('all IDs are unique', () => {
    const ids = IRELAND_SEMICONDUCTOR_HUBS.map(h => h.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'All IDs should be unique');
  });

  it('Tyndall National Institute is included', () => {
    const tyndall = IRELAND_SEMICONDUCTOR_HUBS.find(h => h.id === 'tyndall-cork');
    assert.ok(tyndall, 'Tyndall National Institute should be included');
    assert.equal(tyndall?.company, 'Irish Government Research Institute');
    assert.ok(tyndall?.employees >= 600, 'Tyndall should have 600+ employees');
    assert.ok(tyndall?.lat > 51 && tyndall?.lat < 52.5, 'Tyndall should be in Cork area');
  });
});
