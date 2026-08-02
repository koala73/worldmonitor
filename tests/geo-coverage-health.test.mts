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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeGeoCoverage,
  evaluateGeoCoverage,
  formatGeoCoverageHuman,
  getEnglishDefaultEnabledSources,
  loadGeoCoverageInputs,
  validateGeoCoveragePolicy,
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
    assert.deepEqual(validateGeoCoveragePolicy(inputs), []);
  });

  it('filters default-enabled sources by EN reachability', () => {
    const fakeFeeds = {
      FULL_FEEDS: {
        test: [
          { name: 'English', url: 'https://example.com/en' },
          { name: 'French', url: 'https://example.com/fr', lang: 'fr' },
          { name: 'Explicit English', url: 'https://example.com/en-2', lang: 'en' },
        ],
      },
      INTEL_SOURCES: [{ name: 'Unlabeled Intel', url: 'https://example.com/intel' }],
      getAllDefaultEnabledSources: () => new Set(['English', 'French', 'Explicit English', 'Unlabeled Intel']),
    };
    assert.deepEqual([...getEnglishDefaultEnabledSources(fakeFeeds)], [
      'English',
      'Explicit English',
      'Unlabeled Intel',
    ]);
  });

  it('reports policy keys that are not keyCountries', () => {
    const malformed = {
      ...inputs,
      policy: {
        ...inputs.policy,
        floors: { ...inputs.policy.floors, ZZ: 1 },
        zeroDefaultOnAllowlist: {
          ...inputs.policy.zeroDefaultOnAllowlist,
          YY: 'not a keyCountry',
        },
      },
    };
    assert.deepEqual(validateGeoCoveragePolicy(malformed), [
      'geo-coverage-policy.json: floors key "ZZ" is not a keyCountry in shared/geography.js',
      'geo-coverage-policy.json: zeroDefaultOnAllowlist key "YY" is not a keyCountry in shared/geography.js',
    ]);
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

  it('counts only EN-reachable default-on local sources', () => {
    const rows = computeGeoCoverage(inputs);
    const byIso = new Map(rows.map((row) => [row.iso2, row]));
    for (const iso2 of ['AR', 'CD', 'SD']) {
      const row = byIso.get(iso2);
      assert.ok(row, `${iso2} must remain a keyCountry coverage row`);
      assert.deepEqual(row.defaultOnSources, [], `${iso2} has no EN-reachable default-on local source`);
      assert.equal(row.allowlistReason !== null, true, `${iso2} must document its EN reachability gap`);
    }

    const { violations } = evaluateGeoCoverage(rows);
    assert.deepEqual(violations, [], 'known EN reachability gaps must be allowlisted');
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

  it('covers every policy status and renders failure details', () => {
    const rows = [
      { iso2: 'UA', regions: ['test'], catalogSources: [], defaultOnSources: [], floor: 1, allowlistReason: null },
      { iso2: 'ZZ', regions: ['test'], catalogSources: [], defaultOnSources: [], floor: 0, allowlistReason: null },
      { iso2: 'KR', regions: ['test'], catalogSources: ['Local'], defaultOnSources: ['Local'], floor: 0, allowlistReason: 'locale-gated' },
      { iso2: 'GB', regions: ['test'], catalogSources: [], defaultOnSources: [], floor: 0, allowlistReason: 'wires-only' },
      { iso2: 'PL', regions: ['test'], catalogSources: ['Local'], defaultOnSources: ['Local'], floor: 0, allowlistReason: null },
    ];
    const evaluated = evaluateGeoCoverage(rows);
    assert.deepEqual(evaluated.rows.map((row) => row.status), [
      'FLOOR-BREACH',
      'GAP-UNDOCUMENTED',
      'ALLOWLIST-STALE',
      'ALLOWLISTED',
      'OK',
    ]);
    assert.equal(evaluated.violations.length, 3);

    const report = formatGeoCoverageHuman({
      rows: evaluated.rows,
      regions: [{ id: 'test', label: 'Test', keyCountries: rows.map((row) => row.iso2) }],
      violations: evaluated.violations,
      catalogSize: 5,
      defaultEnabledSize: 2,
      policy: { floors: { UA: 1 }, zeroDefaultOnAllowlist: { GB: 'wires-only' } },
    });
    for (const status of ['FLOOR-BREACH', 'GAP-UNDOCUMENTED', 'ALLOWLIST-STALE', 'ALLOWLISTED', 'OK']) {
      assert.ok(report.includes(status), `report must include ${status}`);
    }
    assert.match(report, /VIOLATIONS \(3\):/);
  });

  it('CLI emits parseable JSON and cleans its temporary bundle', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'geo-coverage-cli-test-'));
    try {
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/geo-coverage-report.mjs'), '--json'],
        {
          cwd: repoRoot,
          env: { ...process.env, TMPDIR: tempRoot },
          encoding: 'utf8',
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.violations, []);
      assert.deepEqual(readdirSync(tempRoot), [], 'CLI must clean its temporary bundle before exiting');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
