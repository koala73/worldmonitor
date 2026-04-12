import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, '..', 'scripts');

const bundleSource = readFileSync(join(scriptsDir, 'seed-bundle-resilience-recovery.mjs'), 'utf8');

const EXPECTED_ENTRIES = [
  { label: 'Fiscal-Space', script: 'seed-recovery-fiscal-space.mjs', seedMetaKey: 'resilience:recovery:fiscal-space' },
  { label: 'Reserve-Adequacy', script: 'seed-recovery-reserve-adequacy.mjs', seedMetaKey: 'resilience:recovery:reserve-adequacy' },
  { label: 'External-Debt', script: 'seed-recovery-external-debt.mjs', seedMetaKey: 'resilience:recovery:external-debt' },
  { label: 'Import-HHI', script: 'seed-recovery-import-hhi.mjs', seedMetaKey: 'resilience:recovery:import-hhi' },
  { label: 'Fuel-Stocks', script: 'seed-recovery-fuel-stocks.mjs', seedMetaKey: 'resilience:recovery:fuel-stocks' },
];

describe('seed-bundle-resilience-recovery', () => {
  it('has exactly 5 entries', () => {
    const labelMatches = bundleSource.match(/label:\s*'[^']+'/g) ?? [];
    assert.equal(labelMatches.length, 5, `Expected 5 entries, found ${labelMatches.length}`);
  });

  for (const entry of EXPECTED_ENTRIES) {
    it(`contains entry for ${entry.label}`, () => {
      assert.ok(bundleSource.includes(entry.label), `Missing label: ${entry.label}`);
      assert.ok(bundleSource.includes(entry.script), `Missing script: ${entry.script}`);
      assert.ok(bundleSource.includes(entry.seedMetaKey), `Missing seedMetaKey: ${entry.seedMetaKey}`);
    });

    it(`script ${entry.script} exists on disk`, () => {
      const scriptPath = join(scriptsDir, entry.script);
      assert.ok(existsSync(scriptPath), `Script not found: ${scriptPath}`);
    });
  }

  it('all entries use 30 * DAY interval', () => {
    const intervalMatches = bundleSource.match(/intervalMs:\s*30\s*\*\s*DAY/g) ?? [];
    assert.equal(intervalMatches.length, 5, `Expected all 5 entries to use 30 * DAY interval`);
  });

  it('imports runBundle and DAY from _bundle-runner.mjs', () => {
    assert.ok(bundleSource.includes("from './_bundle-runner.mjs'"), 'Missing import from _bundle-runner.mjs');
    assert.ok(bundleSource.includes('runBundle'), 'Missing runBundle import');
    assert.ok(bundleSource.includes('DAY'), 'Missing DAY import');
  });
});
