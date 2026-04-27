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
  // PR 3A §net-imports denominator. Must appear BEFORE Sovereign-Wealth
  // in the bundle so the SWF seeder reads freshly-written re-export
  // share data in the same cron tick. Updated to match the current
  // bundle ordering; moving this entry breaks the SWF denominator math.
  { label: 'Reexport-Share', script: 'seed-recovery-reexport-share.mjs', seedMetaKey: 'resilience:recovery:reexport-share' },
  { label: 'Sovereign-Wealth', script: 'seed-sovereign-wealth.mjs', seedMetaKey: 'resilience:recovery:sovereign-wealth' },
];

describe('seed-bundle-resilience-recovery', () => {
  it(`has exactly ${EXPECTED_ENTRIES.length} entries`, () => {
    const labelMatches = bundleSource.match(/label:\s*'[^']+'/g) ?? [];
    assert.equal(labelMatches.length, EXPECTED_ENTRIES.length,
      `Expected ${EXPECTED_ENTRIES.length} entries, found ${labelMatches.length}. ` +
      `If you added a new seeder, update EXPECTED_ENTRIES above.`);
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
    assert.equal(intervalMatches.length, EXPECTED_ENTRIES.length,
      `Expected all ${EXPECTED_ENTRIES.length} entries to use 30 * DAY interval`);
  });

  it('imports runBundle and DAY from _bundle-runner.mjs', () => {
    assert.ok(bundleSource.includes("from './_bundle-runner.mjs'"), 'Missing import from _bundle-runner.mjs');
    assert.ok(bundleSource.includes('runBundle'), 'Missing runBundle import');
    assert.ok(bundleSource.includes('DAY'), 'Missing DAY import');
  });

  // Plan 2026-04-24-003: Reexport-Share became Comtrade-backed; 60s
  // timeout is no longer enough. Guard against a revert / accidental
  // restore of the pre-Comtrade timeout.
  it('Reexport-Share entry has timeoutMs >= 180_000', () => {
    // Match only the Reexport-Share entry's object body, not the full
    // file, to avoid cross-entry timeout leakage.
    const entryMatch = bundleSource.match(/\{[^}]*label:\s*'Reexport-Share'[^}]*\}/);
    assert.ok(entryMatch, 'Could not locate Reexport-Share entry');
    const timeoutMatch = entryMatch[0].match(/timeoutMs:\s*([\d_]+)/);
    assert.ok(timeoutMatch, 'Reexport-Share entry missing timeoutMs');
    const timeoutMs = Number(timeoutMatch[1].replace(/_/g, ''));
    assert.ok(timeoutMs >= 180_000,
      `Reexport-Share timeoutMs must be >= 180_000 (Comtrade + retry can take 2-3min); got ${timeoutMs}`);
  });

  it('Reexport-Share runs BEFORE Sovereign-Wealth in bundle ordering', () => {
    const reexportIdx = bundleSource.indexOf("label: 'Reexport-Share'");
    const swfIdx = bundleSource.indexOf("label: 'Sovereign-Wealth'");
    assert.ok(reexportIdx >= 0, 'Reexport-Share not in bundle');
    assert.ok(swfIdx >= 0, 'Sovereign-Wealth not in bundle');
    assert.ok(reexportIdx < swfIdx,
      `Reexport-Share must run before Sovereign-Wealth (so SWF seeder reads a freshly-written re-export share key)`);
  });
});
