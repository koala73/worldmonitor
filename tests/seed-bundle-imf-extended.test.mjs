import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, '..', 'scripts');

const bundleSource = readFileSync(join(scriptsDir, 'seed-bundle-imf-extended.mjs'), 'utf8');

const EXPECTED_ENTRIES = [
  { label: 'IMF-Macro', script: 'seed-imf-macro.mjs', seedMetaKey: 'economic:imf-macro' },
  { label: 'IMF-Growth', script: 'seed-imf-growth.mjs', seedMetaKey: 'economic:imf-growth' },
  { label: 'IMF-Labor', script: 'seed-imf-labor.mjs', seedMetaKey: 'economic:imf-labor' },
  { label: 'IMF-External', script: 'seed-imf-external.mjs', seedMetaKey: 'economic:imf-external' },
];

describe('seed-bundle-imf-extended', () => {
  it('contains all IMF extended seeder entries', () => {
    for (const entry of EXPECTED_ENTRIES) {
      assert.ok(bundleSource.includes(entry.label), `Missing label: ${entry.label}`);
      assert.ok(bundleSource.includes(entry.script), `Missing script: ${entry.script}`);
      assert.ok(bundleSource.includes(entry.seedMetaKey), `Missing seedMetaKey: ${entry.seedMetaKey}`);
    }
  });

  it('all referenced scripts exist on disk', () => {
    for (const entry of EXPECTED_ENTRIES) {
      assert.ok(existsSync(join(scriptsDir, entry.script)), `Missing script file: ${entry.script}`);
    }
  });

  it('uses 30 * DAY cadence for all entries', () => {
    const intervalMatches = bundleSource.match(/intervalMs:\s*30\s*\*\s*DAY/g) ?? [];
    assert.equal(intervalMatches.length, EXPECTED_ENTRIES.length);
  });
});
