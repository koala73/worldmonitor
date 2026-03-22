/**
 * Ireland Tech HQs Data Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IRELAND_TECH_HQS, type IrelandTechHQ } from '../src/data/tech-hqs-ireland.ts';

describe('IRELAND_TECH_HQS', () => {
  it('contains at least 10 tech company HQs', () => {
    assert.ok(IRELAND_TECH_HQS.length >= 10, `Expected at least 10 HQs, got ${IRELAND_TECH_HQS.length}`);
  });

  it('all entries have required fields', () => {
    for (const hq of IRELAND_TECH_HQS) {
      assert.ok(hq.id, 'id is required');
      assert.ok(hq.company, 'company is required');
      assert.ok(['emea-hq', 'european-hq', 'intl-hq'].includes(hq.type), 'type must be valid');
      assert.ok(hq.location, 'location is required');
      assert.ok(typeof hq.lat === 'number', 'lat must be a number');
      assert.ok(typeof hq.lng === 'number', 'lng must be a number');
    }
  });

  it('coordinates are within Ireland bounds', () => {
    // Ireland approx bounds: lat 51.4-55.4, lng -10.5 to -5.5
    for (const hq of IRELAND_TECH_HQS) {
      assert.ok(hq.lat >= 51.4 && hq.lat <= 55.4, `${hq.company} lat ${hq.lat} out of Ireland bounds`);
      assert.ok(hq.lng >= -10.5 && hq.lng <= -5.5, `${hq.company} lng ${hq.lng} out of Ireland bounds`);
    }
  });

  it('includes Google EMEA HQ', () => {
    const google = IRELAND_TECH_HQS.find(hq => hq.company === 'Google');
    assert.ok(google, 'Google should be included');
    assert.equal(google?.type, 'emea-hq');
  });

  it('includes Meta HQ', () => {
    const meta = IRELAND_TECH_HQS.find(hq => hq.company.includes('Meta'));
    assert.ok(meta, 'Meta should be included');
  });

  it('includes Apple Cork', () => {
    const apple = IRELAND_TECH_HQS.find(hq => hq.company === 'Apple');
    assert.ok(apple, 'Apple should be included');
    assert.equal(apple?.location, 'Cork');
  });

  it('includes Microsoft Dublin', () => {
    const microsoft = IRELAND_TECH_HQS.find(hq => hq.company === 'Microsoft');
    assert.ok(microsoft, 'Microsoft should be included');
  });

  it('includes Stripe Dublin', () => {
    const stripe = IRELAND_TECH_HQS.find(hq => hq.company === 'Stripe');
    assert.ok(stripe, 'Stripe should be included');
  });

  it('all IDs are unique', () => {
    const ids = IRELAND_TECH_HQS.map(hq => hq.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'All IDs should be unique');
  });

  it('all HQs have employee counts', () => {
    for (const hq of IRELAND_TECH_HQS) {
      assert.ok(hq.employees && hq.employees > 0, `${hq.company} should have employee count`);
    }
  });
});
