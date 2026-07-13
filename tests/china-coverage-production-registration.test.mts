import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bundle = readFileSync(resolve(root, 'scripts/seed-bundle-health.mjs'), 'utf8');
const runbook = readFileSync(resolve(root, 'docs/railway-seed-consolidation-runbook.md'), 'utf8');
const cacheKeys = readFileSync(resolve(root, 'server/_shared/cache-keys.ts'), 'utf8');
const seedHealth = readFileSync(resolve(root, 'api/seed-health.js'), 'utf8');

describe('China coverage production registration', () => {
  it('runs the compact evaluator in the hourly Railway health bundle', () => {
    assert.match(bundle, /script:\s*'seed-china-coverage-health\.mjs'/);
    assert.match(bundle, /seedMetaKey:\s*'health:china-coverage'/);
    assert.match(runbook, /China Coverage \(hourly\)/);
  });

  it('registers the compact summary key in shared and Edge health inventories', () => {
    assert.match(cacheKeys, /CHINA_COVERAGE_HEALTH_KEY\s*=\s*'health:china-coverage:v1'/);
    assert.match(seedHealth, /'health:china-coverage'.*seed-meta:health:china-coverage/);
    assert.match(seedHealth, /seed-activated:health:china-coverage/);
  });

  it('keeps the audit read-only unless the dedicated seeder is invoked', () => {
    const audit = readFileSync(resolve(root, 'scripts/audit-china-coverage.mjs'), 'utf8');
    assert.doesNotMatch(audit, /runSeed|writeExtraKey|\['SET'/);
    assert.match(audit, /--json/);
  });
});
