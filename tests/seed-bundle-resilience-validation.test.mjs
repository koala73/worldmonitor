import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, '..', 'scripts');

const EXPECTED_SECTIONS = [
  {
    label: 'External-Benchmark',
    script: 'benchmark-resilience-external.mjs',
  },
  {
    label: 'Outcome-Backtest',
    script: 'backtest-resilience-outcomes.mjs',
  },
  {
    label: 'Sensitivity-Suite',
    script: 'validate-resilience-sensitivity.mjs',
  },
];

describe('seed-bundle-resilience-validation', () => {
  let src;

  it('bundle script exists and parses', async () => {
    const bundlePath = join(scriptsDir, 'seed-bundle-resilience-validation.mjs');
    assert.ok(existsSync(bundlePath), 'bundle script must exist on disk');
    src = await readFile(bundlePath, 'utf8');
    assert.ok(src.includes("runBundle('resilience-validation'"), 'must call runBundle with correct label');
  });

  it('has exactly 3 sections with correct labels (no seedMetaKey — validation scripts are not data seeders)', async () => {
    if (!src) src = await readFile(join(scriptsDir, 'seed-bundle-resilience-validation.mjs'), 'utf8');

    for (const section of EXPECTED_SECTIONS) {
      assert.ok(src.includes(`label: '${section.label}'`), `missing label: ${section.label}`);
      assert.ok(src.includes(`script: '${section.script}'`), `missing script ref: ${section.script}`);
    }
    assert.ok(!src.includes('seedMetaKey'), 'validation bundle must NOT have seedMetaKey (no seed-meta heartbeats)');
  });

  it('all intervals use WEEK constant (weekly)', async () => {
    if (!src) src = await readFile(join(scriptsDir, 'seed-bundle-resilience-validation.mjs'), 'utf8');

    const intervalMatches = src.match(/intervalMs:\s*(.+),/g);
    assert.equal(intervalMatches.length, 3, 'must have exactly 3 intervalMs entries');
    for (const m of intervalMatches) {
      assert.ok(m.includes('WEEK'), `intervalMs must use WEEK, got: ${m}`);
    }
  });

  it('imports WEEK from _bundle-runner.mjs', async () => {
    if (!src) src = await readFile(join(scriptsDir, 'seed-bundle-resilience-validation.mjs'), 'utf8');
    assert.ok(src.includes("WEEK") && src.includes("_bundle-runner.mjs"), 'must import WEEK from _bundle-runner');
  });

  it('validate-resilience-sensitivity.mjs exists on disk', () => {
    assert.ok(
      existsSync(join(scriptsDir, 'validate-resilience-sensitivity.mjs')),
      'validate-resilience-sensitivity.mjs must exist',
    );
  });

  it('bundle runner exists on disk', () => {
    assert.ok(
      existsSync(join(scriptsDir, '_bundle-runner.mjs')),
      '_bundle-runner.mjs must exist',
    );
  });
});
