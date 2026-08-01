/**
 * Geographic coverage health gate (#5957, epic #5948).
 *
 * Before this test, coverage gaps (a keyCountry in shared/geography.js with
 * zero dedicated local sources or zero default-on path) were found by manual
 * audit of feeds.ts — nothing failed CI. This locks the audit into CI:
 *
 *   1. shared/source-geography.json stays in sync with the feed catalog
 *      (every mapped name resolves, every ISO2 is known)
 *   2. strategic floors hold (UA/PL/TW/PK ≥ 1 EN default-on local source)
 *   3. the zeroDefaultOnAllowlist in shared/geo-coverage-policy.json matches
 *      reality EXACTLY — both directions: undocumented new gaps fail, and so
 *      do stale entries once a pack lands default-on local coverage
 *
 * Run the human-readable report with: npm run report:geo-coverage
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeGeoCoverage,
  evaluateGeoCoverage,
  formatGeoCoverageHuman,
  loadGeoCoverageInputs,
  validateSourceGeography,
} from '../scripts/geo-coverage-health.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let inputs: Awaited<ReturnType<typeof loadGeoCoverageInputs>>;

before(async () => {
  inputs = await loadGeoCoverageInputs(repoRoot);
});

after(() => {
  inputs.cleanup();
});

describe('geographic coverage health (#5957)', () => {
  it('source-geography map is in sync with the catalog and geography model', () => {
    assert.deepEqual(validateSourceGeography(inputs), []);
  });

  it('policy references only real keyCountries', () => {
    const known = new Set(inputs.keyCountries.map((c) => c.iso2));
    for (const iso2 of Object.keys(inputs.policy.floors)) {
      assert.ok(known.has(iso2), `floors: "${iso2}" is not a keyCountry in shared/geography.js`);
    }
    for (const iso2 of Object.keys(inputs.policy.zeroDefaultOnAllowlist)) {
      assert.ok(known.has(iso2), `zeroDefaultOnAllowlist: "${iso2}" is not a keyCountry in shared/geography.js`);
    }
  });

  it('strategic floors hold (UA/PL/TW/PK ≥ 1 EN default-on local source)', () => {
    const rows = computeGeoCoverage(inputs);
    for (const row of rows) {
      assert.ok(
        row.defaultOnSources.length >= row.floor,
        `${row.iso2}: ${row.defaultOnSources.length} default-on local source(s), below floor ${row.floor}`,
      );
    }
  });

  it('every keyCountry has a default-on local source or a documented exception', () => {
    const rows = computeGeoCoverage(inputs);
    const { violations } = evaluateGeoCoverage(rows);
    assert.deepEqual(violations, [], `coverage violations:\n${violations.join('\n')}`);
  });

  it('report renders for ops/product review', () => {
    const rows = computeGeoCoverage(inputs);
    const { violations } = evaluateGeoCoverage(rows);
    const report = formatGeoCoverageHuman({
      rows,
      regions: inputs.regions,
      violations,
      catalogSize: inputs.catalogSize,
      defaultEnabledSize: inputs.defaultEnabledSize,
      policy: inputs.policy,
    });
    assert.ok(report.includes('Geographic coverage health'));
    assert.ok(report.includes('UA'));
    assert.ok(report.includes('Violations: 0'));
  });
});
