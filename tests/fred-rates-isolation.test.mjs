import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CANONICAL_KEY, BATCH_TTL } from '../scripts/seed-fred-rates.mjs';
import { FRED_TTL } from '../scripts/seed-economy.mjs';

describe('FRED/rates seeder isolation', () => {
  it('has a FRED-owned canonical key and TTL', () => {
    assert.equal(CANONICAL_KEY, 'economic:fred:batch:v1');
    assert.equal(BATCH_TTL, FRED_TTL);
  });
  it('does not require EIA configuration', () => {
    const source = fs.readFileSync(new URL('../scripts/seed-fred-rates.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /EIA_API_KEY/);
    assert.match(source, /FRED_API_KEY/);
  });
  it('is independently scheduled in the Railway registry', () => {
    const registry = JSON.parse(fs.readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
    const service = registry.find((item) => item.service === 'seed-fred-rates');
    assert.equal(service?.entry, 'scripts/seed-fred-rates.mjs');
    assert.equal(service?.cronSchedule, '0 * * * *');
    assert.deepEqual(service?.requiredEnv, ['FRED_API_KEY']);
  });
});
