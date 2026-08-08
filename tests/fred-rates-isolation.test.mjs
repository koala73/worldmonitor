import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CANONICAL_KEY,
  BATCH_TTL,
  FRED_RATES_ACTIVATION_KEY,
} from '../scripts/seed-fred-rates.mjs';
import { FRED_TTL } from '../scripts/seed-economy.mjs';
import { auditRailwayServiceConfig } from '../scripts/audit-railway-watch-paths.mjs';

describe('FRED/rates seeder isolation', () => {
  it('has a FRED-owned canonical key and TTL', () => {
    assert.equal(CANONICAL_KEY, 'economic:fred:batch:v1');
    assert.equal(BATCH_TTL, FRED_TTL);
    assert.equal(FRED_RATES_ACTIVATION_KEY, 'seed-activated:economic:fred-rates:v1');
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
    assert.deepEqual(service?.requiredEnv, [
      'FRED_API_KEY',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ]);
  });
  it('fails the live Railway audit when either mandatory Redis variable is missing', () => {
    const registry = JSON.parse(fs.readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
    const fred = registry.find((item) => item.service === 'seed-fred-rates');
    assert.ok(fred);

    const liveService = (variables) => ({
      source: { repo: 'koala73/worldmonitor', rootDirectory: 'scripts' },
      build: { watchPatterns: fred.watchPatterns },
      deploy: { cronSchedule: fred.cronSchedule, startCommand: 'node seed-fred-rates.mjs' },
      variables,
    });
    const serviceIds = new Map([['seed-fred-rates', 'svc-fred']]);

    for (const [variables, missing] of [
      [{ FRED_API_KEY: 'configured', UPSTASH_REDIS_REST_TOKEN: 'configured' }, 'UPSTASH_REDIS_REST_URL'],
      [{ FRED_API_KEY: 'configured', UPSTASH_REDIS_REST_URL: 'configured' }, 'UPSTASH_REDIS_REST_TOKEN'],
    ]) {
      const drift = auditRailwayServiceConfig(
        { services: { 'svc-fred': liveService(variables) } },
        serviceIds,
        [fred],
      );
      assert.deepEqual(drift[0]?.missingRequiredEnv, [missing]);
    }

    assert.deepEqual(
      auditRailwayServiceConfig(
        { services: { 'svc-fred': liveService({
          FRED_API_KEY: 'configured',
          UPSTASH_REDIS_REST_URL: 'configured',
          UPSTASH_REDIS_REST_TOKEN: 'configured',
        }) } },
        serviceIds,
        [fred],
      ),
      [],
    );
  });
  it('writes its durable activation marker only from runSeed afterPublish', () => {
    const source = fs.readFileSync(new URL('../scripts/seed-fred-rates.mjs', import.meta.url), 'utf8');
    assert.match(source, /afterPublish:\s*markFredRatesActivated/);
    assert.match(source, /\['SET',\s*FRED_RATES_ACTIVATION_KEY,\s*'1',\s*'NX'\]/);
  });
});
