import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CANONICAL_KEY,
  BATCH_TTL,
  FRED_RATES_ACTIVATION_KEY,
} from '../scripts/seed-fred-rates.mjs';
import { FRED_TTL } from '../scripts/_fred-seeder.mjs';
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
    assert.doesNotMatch(source, /seed-economy\.mjs/);
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
      'PROXY_URL',
    ]);
    assert.ok(service.watchPatterns.includes('scripts/_fred-seeder.mjs'));
    assert.ok(!service.watchPatterns.includes('scripts/seed-economy.mjs'));
  });
  it('fails the live Railway audit unless all required variables are configured', () => {
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
    const requiredVariables = {
      FRED_API_KEY: 'configured',
      UPSTASH_REDIS_REST_URL: 'configured',
      UPSTASH_REDIS_REST_TOKEN: 'configured',
      PROXY_URL: 'configured',
    };

    for (const missing of Object.keys(requiredVariables)) {
      const variables = { ...requiredVariables };
      delete variables[missing];
      const drift = auditRailwayServiceConfig(
        { services: { 'svc-fred': liveService(variables) } },
        serviceIds,
        [fred],
      );
      assert.deepEqual(drift[0]?.missingRequiredEnv, [missing]);
    }

    assert.deepEqual(
      auditRailwayServiceConfig(
        { services: { 'svc-fred': liveService(requiredVariables) } },
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
  it('is visible in operator seed health on the same one-hour cadence', () => {
    const source = fs.readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');
    assert.match(source, /'economic:fred-rates':\s*\{\s*key:\s*'seed-meta:economic:fred-rates',\s*intervalMin:\s*60/);
  });
});
