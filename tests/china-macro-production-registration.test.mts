import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import {
  CHINA_MACRO_MAX_CONTENT_AGE_MIN,
  CHINA_MACRO_MAX_TRANSPORT_AGE_MIN,
  CHINA_MACRO_PROVENANCE_FAMILY,
  CHINA_MACRO_PUBLISHER_IDS,
  CHINA_MACRO_REQUIRED_SERIES,
  CHINA_MACRO_SCHEMA_VERSION,
  CHINA_MACRO_SERIES_CONTRACT,
  CHINA_MACRO_SERIES_MAX_AGE_DAYS,
  chinaMacroObservationDateMs,
  isChinaMacroObservationStale,
} from '../shared/china-macro-contract.js';
import * as railwayContract from '../scripts/_china-macro-contract.mjs';
import { CHINA_COVERAGE_ENTRIES } from '../scripts/china-coverage-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('China macro production registration', () => {
  it('keeps the Railway-local contract mirror in exact parity with the shared runtime', () => {
    assert.equal(railwayContract.CHINA_MACRO_CACHE_KEY, BOOTSTRAP_CACHE_KEYS.chinaMacro);
    assert.equal(railwayContract.CHINA_MACRO_SCHEMA_VERSION, CHINA_MACRO_SCHEMA_VERSION);
    assert.equal(railwayContract.CHINA_MACRO_PROVENANCE_FAMILY, CHINA_MACRO_PROVENANCE_FAMILY);
    assert.equal(railwayContract.CHINA_MACRO_MAX_TRANSPORT_AGE_MIN, CHINA_MACRO_MAX_TRANSPORT_AGE_MIN);
    assert.equal(railwayContract.CHINA_MACRO_MAX_CONTENT_AGE_MIN, CHINA_MACRO_MAX_CONTENT_AGE_MIN);
    assert.deepEqual(railwayContract.CHINA_MACRO_REQUIRED_SERIES, CHINA_MACRO_REQUIRED_SERIES);
    assert.deepEqual(railwayContract.CHINA_MACRO_SERIES_MAX_AGE_DAYS, CHINA_MACRO_SERIES_MAX_AGE_DAYS);
    assert.deepEqual(railwayContract.CHINA_MACRO_PUBLISHER_IDS, CHINA_MACRO_PUBLISHER_IDS);
    assert.deepEqual(railwayContract.CHINA_MACRO_SERIES_CONTRACT, CHINA_MACRO_SERIES_CONTRACT);
    for (const value of ['2026-06', '2026-06-30', 'invalid', '']) {
      assert.equal(
        railwayContract.chinaMacroObservationDateMs(value),
        chinaMacroObservationDateMs(value),
      );
    }
    for (const [seriesId, maxAgeDays] of Object.entries(CHINA_MACRO_SERIES_MAX_AGE_DAYS)) {
      const observedAt = chinaMacroObservationDateMs('2026-06');
      assert.ok(observedAt);
      for (const now of [observedAt, observedAt + maxAgeDays * 86_400_000 + 1]) {
        assert.equal(
          railwayContract.isChinaMacroObservationStale(seriesId, '2026-06', now),
          isChinaMacroObservationStale(seriesId, '2026-06', now),
        );
      }
    }
  });

  it('schedules both seeders in the Railway macro bundle', () => {
    const source = read('scripts/seed-bundle-macro.mjs');
    assert.match(
      source,
      /\{ label: 'China-Macro', script: 'seed-china-macro\.mjs', seedMetaKey: 'economic:china-macro', freshnessMetaKey: 'seed-meta:economic:china-macro-transport', completionMetaKey: 'seed-meta:economic:china-macro-complete', canonicalKey: CHINA_MACRO_CACHE_KEY, requireCanonical: true, intervalMs: 36 \* HOUR, timeoutMs: 240_000 \}/,
    );
    assert.match(source, /script:\s*'seed-china-release-calendar\.mjs'/);
  });

  it('activates both predeclared China coverage lanes with content-age anchoring', () => {
    const macro = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'macro.china-snapshot');
    assert.ok(macro);
    assert.equal(macro.ownerIssue, 5574);
    assert.equal(macro.launchStatus, 'launched');
    assert.equal(macro.transport.maxAgeMin, CHINA_MACRO_MAX_TRANSPORT_AGE_MIN);
    assert.equal(macro.content.key, BOOTSTRAP_CACHE_KEYS.chinaMacro);
    assert.equal(macro.content.maxAgeMin, CHINA_MACRO_MAX_CONTENT_AGE_MIN);
    assert.deepEqual(macro.content.probe.timestampPaths, [['contentObservationDate']]);

    const calendar = CHINA_COVERAGE_ENTRIES.find((entry) => entry.id === 'macro.china-release-calendar');
    assert.ok(calendar);
    assert.equal(calendar.launchStatus, 'launched');
    assert.deepEqual(calendar.content.probe.timestampPaths, [['generatedAt']]);
  });

  it('registers bootstrap, health, seed-health, cache-key, and slow gateway surfaces', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.chinaMacro, 'economic:china:macro:v2');
    assert.equal(BOOTSTRAP_CACHE_KEYS.chinaReleaseCalendar, 'economic:china:release-calendar:v1');
    assert.match(read('api/health.js'), /chinaMacro:\s*\{ key: 'seed-meta:economic:china-macro-transport'/);
    assert.match(read('api/health.js'), new RegExp(`chinaMacro:\\s*\\{[^\\n]*maxStaleMin:\\s*${CHINA_MACRO_MAX_TRANSPORT_AGE_MIN.toLocaleString('en-US').replace(',', '_')}`));
    assert.match(read('api/seed-health.js'), /'economic:china-macro':\s*\{ key: 'seed-meta:economic:china-macro-transport'/);
    assert.match(read('server/_shared/cache-keys.ts'), /CHINA_MACRO_KEY\s*=\s*BOOTSTRAP_CACHE_KEYS\.chinaMacro/);
    assert.match(read('server/gateway.ts'), /'\/api\/economic\/v1\/get-china-macro-snapshot':\s*'slow'/);
  });

  it('keeps request, fetch, lock, and bundle timeouts in a safe sequential order', () => {
    const seed = read('scripts/seed-china-macro.mjs');
    assert.match(seed, /lockTtlMs:\s*210_000/);
    assert.match(seed, /fetchPhaseTimeoutMs:\s*150_000/);
    assert.match(
      seed,
      /const fetchAndRecordTransport = async \(\) => \{[\s\S]*await fetchChinaMacroSnapshot\(\);[\s\S]*await recordChinaMacroTransportFreshness\(snapshot\);[\s\S]*runSeed\('economic', 'china-macro', CHINA_MACRO_KEY, fetchAndRecordTransport,/,
      'transport freshness must be recorded after fetch and before canonical validation',
    );
    assert.match(seed, /afterPublish:\s*async \(data\) => recordChinaMacroCompletedRun\(data\)/);
    assert.match(seed, /afterPreservedValidationSkip:\s*async \(data\) => recordChinaMacroCompletedRun\(data\)/);
    const bundle = read('scripts/seed-bundle-macro.mjs');
    assert.match(bundle, /China-Macro[\s\S]*timeoutMs:\s*240_000/);
    assert.ok(150_000 < 210_000);
    assert.ok(210_000 < 240_000);
  });

  it('exposes the snapshot through the economic MCP cache tool and public API path', () => {
    const source = read('api/mcp/registry/cache-tools.ts');
    assert.match(source, /BOOTSTRAP_CACHE_KEYS\.chinaMacro/);
    assert.match(source, /BOOTSTRAP_CACHE_KEYS\.chinaReleaseCalendar/);
    assert.match(source, /GET \/api\/economic\/v1\/get-china-macro-snapshot/);
  });
});
