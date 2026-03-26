/**
 * Ireland Data Centers Data Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IRELAND_DATA_CENTERS, type IrelandDataCenter } from '../src/config/variants/ireland/data/data-centers.ts';

describe('IRELAND_DATA_CENTERS', () => {
  it('contains at least 10 data center facilities', () => {
    assert.ok(IRELAND_DATA_CENTERS.length >= 10, `Expected at least 10 facilities, got ${IRELAND_DATA_CENTERS.length}`);
  });

  it('all entries have required fields', () => {
    for (const dc of IRELAND_DATA_CENTERS) {
      assert.ok(dc.id, 'id is required');
      assert.ok(dc.name, 'name is required');
      assert.ok(dc.operator, 'operator is required');
      assert.ok(dc.location, 'location is required');
      assert.ok(typeof dc.lat === 'number', 'lat must be a number');
      assert.ok(typeof dc.lng === 'number', 'lng must be a number');
      assert.ok(['operational', 'under-construction', 'planned'].includes(dc.status), 'status must be valid');
    }
  });

  it('coordinates are within Ireland bounds', () => {
    // Ireland approx bounds: lat 51.4-55.4, lng -10.5 to -5.5
    for (const dc of IRELAND_DATA_CENTERS) {
      assert.ok(dc.lat >= 51.4 && dc.lat <= 55.4, `${dc.name} lat ${dc.lat} out of Ireland bounds`);
      assert.ok(dc.lng >= -10.5 && dc.lng <= -5.5, `${dc.name} lng ${dc.lng} out of Ireland bounds`);
    }
  });

  it('includes Google data center', () => {
    const google = IRELAND_DATA_CENTERS.find(dc => dc.operator.includes('Google'));
    assert.ok(google, 'Google data center should be included');
  });

  it('includes Meta data center', () => {
    const meta = IRELAND_DATA_CENTERS.find(dc => dc.operator.includes('Meta'));
    assert.ok(meta, 'Meta data center should be included');
  });

  it('includes Microsoft Azure data center', () => {
    const microsoft = IRELAND_DATA_CENTERS.find(dc => dc.operator.includes('Microsoft'));
    assert.ok(microsoft, 'Microsoft Azure data center should be included');
  });

  it('includes AWS data center', () => {
    const aws = IRELAND_DATA_CENTERS.find(dc => dc.operator.includes('Amazon'));
    assert.ok(aws, 'AWS data center should be included');
  });

  it('includes Equinix data center', () => {
    const equinix = IRELAND_DATA_CENTERS.find(dc => dc.operator.includes('Equinix'));
    assert.ok(equinix, 'Equinix data center should be included');
  });

  it('all IDs are unique', () => {
    const ids = IRELAND_DATA_CENTERS.map(dc => dc.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'All IDs should be unique');
  });

  it('all facilities have valid status', () => {
    const validStatuses = ['operational', 'under-construction', 'planned'];
    for (const dc of IRELAND_DATA_CENTERS) {
      assert.ok(validStatuses.includes(dc.status), `${dc.name} should have valid status (got: ${dc.status})`);
    }
  });
});
