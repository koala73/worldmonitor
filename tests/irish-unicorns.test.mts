/**
 * Irish Unicorns Data Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IRISH_UNICORNS, type IrishUnicorn } from '../src/data/irish-unicorns.ts';

describe('IRISH_UNICORNS', () => {
  it('contains at least 8 companies', () => {
    assert.ok(IRISH_UNICORNS.length >= 8, `Expected at least 8 companies, got ${IRISH_UNICORNS.length}`);
  });

  it('all entries have required fields', () => {
    for (const company of IRISH_UNICORNS) {
      assert.ok(company.id, 'id is required');
      assert.ok(company.name, 'name is required');
      assert.ok(company.location, 'location is required');
      assert.ok(typeof company.lat === 'number', 'lat must be a number');
      assert.ok(typeof company.lng === 'number', 'lng must be a number');
      assert.ok(['unicorn', 'high-growth', 'emerging'].includes(company.category), 'category must be valid');
      assert.ok(company.sector, 'sector is required');
      assert.ok(typeof company.founded === 'number', 'founded must be a number');
    }
  });

  it('coordinates are within Ireland bounds', () => {
    // Ireland approx bounds: lat 51.4-55.4, lng -10.5 to -5.5
    for (const company of IRISH_UNICORNS) {
      assert.ok(company.lat >= 51.4 && company.lat <= 55.4, `${company.name} lat ${company.lat} out of Ireland bounds`);
      assert.ok(company.lng >= -10.5 && company.lng <= -5.5, `${company.name} lng ${company.lng} out of Ireland bounds`);
    }
  });

  it('includes Intercom as unicorn', () => {
    const intercom = IRISH_UNICORNS.find(c => c.name === 'Intercom');
    assert.ok(intercom, 'Intercom should be included');
    assert.equal(intercom?.category, 'unicorn');
  });

  it('includes Flipdish as unicorn', () => {
    const flipdish = IRISH_UNICORNS.find(c => c.name === 'Flipdish');
    assert.ok(flipdish, 'Flipdish should be included');
    assert.equal(flipdish?.category, 'unicorn');
  });

  it('includes Workvivo from Cork', () => {
    const workvivo = IRISH_UNICORNS.find(c => c.name === 'Workvivo');
    assert.ok(workvivo, 'Workvivo should be included');
    assert.equal(workvivo?.location, 'Cork');
  });

  it('includes companies from both Dublin and Cork', () => {
    const dublinCompanies = IRISH_UNICORNS.filter(c => c.location === 'Dublin');
    const corkCompanies = IRISH_UNICORNS.filter(c => c.location === 'Cork');
    assert.ok(dublinCompanies.length > 0, 'Should have Dublin companies');
    assert.ok(corkCompanies.length > 0, 'Should have Cork companies');
  });

  it('has all three categories represented', () => {
    const unicorns = IRISH_UNICORNS.filter(c => c.category === 'unicorn');
    const highGrowth = IRISH_UNICORNS.filter(c => c.category === 'high-growth');
    const emerging = IRISH_UNICORNS.filter(c => c.category === 'emerging');
    assert.ok(unicorns.length > 0, 'Should have unicorn companies');
    assert.ok(highGrowth.length > 0, 'Should have high-growth companies');
    assert.ok(emerging.length > 0, 'Should have emerging companies');
  });

  it('all IDs are unique', () => {
    const ids = IRISH_UNICORNS.map(c => c.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'All IDs should be unique');
  });
});
