import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scriptSrc = readFileSync('scripts/railway-set-watch-paths.mjs', 'utf8');

describe('railway-set-watch-paths regulatory cron sync', () => {
  it('declares seed-regulatory-actions as a required seed service', () => {
    assert.match(scriptSrc, /REQUIRED_SEED_SERVICES = new Set\(\['seed-regulatory-actions'\]\)/);
    assert.match(scriptSrc, /Missing required seed service\(s\):/);
  });

  it('defines the expected 2-hour cron schedule for seed-regulatory-actions', () => {
    assert.match(scriptSrc, /EXPECTED_CRON_SCHEDULES = new Map\(\[\s*\['seed-regulatory-actions', '0 \*\/2 \* \* \*'\]/s);
  });

  it('queries and updates cronSchedule via serviceInstanceUpdate', () => {
    assert.match(scriptSrc, /node \{ watchPatterns startCommand cronSchedule \}/);
    assert.match(scriptSrc, /input\.cronSchedule = expectedCronSchedule/);
  });

  it('continues to derive watch patterns from the seed name', () => {
    assert.match(scriptSrc, /function buildExpectedPatterns\(serviceName\)/);
    assert.match(scriptSrc, /const scriptFile = `scripts\/\$\{serviceName\}\.mjs`/);
  });
});
