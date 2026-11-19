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

  it('keeps SAFE bank FX settlement launch-ready until SAFE publishes the next month', () => {
    // SAFE "银行结售汇" release dates from www.safe.gov.cn/safe/sjjd/ (2022-12 is
    // not listed there). A month-end observation must stay usable until the
    // following month's release is picked up by the next daily bundle tick
    // (railway-services.json runs seed-bundle-macro at 08:00 and 09:00 UTC).
    const releases: Array<[string, string]> = [
      ['2022-01', '2022-02-18'], ['2022-02', '2022-03-18'], ['2022-03', '2022-04-22'], ['2022-04', '2022-05-17'],
      ['2022-05', '2022-06-15'], ['2022-06', '2022-07-22'], ['2022-07', '2022-08-15'], ['2022-08', '2022-09-15'],
      ['2022-09', '2022-10-28'], ['2022-10', '2022-11-15'], ['2022-11', '2022-12-15'], ['2023-01', '2023-02-15'],
      ['2023-02', '2023-03-15'], ['2023-03', '2023-04-21'], ['2023-04', '2023-05-15'], ['2023-05', '2023-06-15'],
      ['2023-06', '2023-07-21'], ['2023-07', '2023-08-15'], ['2023-08', '2023-09-15'], ['2023-09', '2023-10-20'],
      ['2023-10', '2023-11-15'], ['2023-11', '2023-12-15'], ['2023-12', '2024-01-15'], ['2024-01', '2024-02-23'],
      ['2024-02', '2024-03-15'], ['2024-03', '2024-04-18'], ['2024-04', '2024-05-17'], ['2024-05', '2024-06-17'],
      ['2024-06', '2024-07-19'], ['2024-07', '2024-08-15'], ['2024-08', '2024-09-18'], ['2024-09', '2024-10-22'],
      ['2024-10', '2024-11-15'], ['2024-11', '2024-12-16'], ['2024-12', '2025-01-14'], ['2025-01', '2025-02-18'],
      ['2025-02', '2025-03-17'], ['2025-03', '2025-04-22'], ['2025-04', '2025-05-19'], ['2025-05', '2025-06-17'],
      ['2025-06', '2025-07-22'], ['2025-07', '2025-08-15'], ['2025-08', '2025-09-19'], ['2025-09', '2025-10-22'],
      ['2025-10', '2025-11-17'], ['2025-11', '2025-12-19'], ['2025-12', '2026-01-15'], ['2026-01', '2026-02-13'],
      ['2026-02', '2026-03-16'], ['2026-03', '2026-04-15'], ['2026-04', '2026-05-18'], ['2026-05', '2026-06-15'],
      ['2026-06', '2026-07-17'], ['2026-07', '2026-08-17'], ['2026-08', '2026-09-15'], ['2026-09', '2026-10-20'],
    ];
    const releasedOn = new Map(releases);
    const nextMonth = (period: string) => {
      const [year, month] = period.split('-').map(Number);
      return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    };
    const nextDailyTickMs = 24 * 60 * 60 * 1000;
    let checked = 0;
    for (const [period] of releases) {
      const successorRelease = releasedOn.get(nextMonth(period));
      if (!successorRelease) continue;
      const pickedUpBy = Date.parse(`${successorRelease}T23:59:59Z`) + nextDailyTickMs;
      for (const isStale of [isChinaMacroObservationStale, railwayContract.isChinaMacroObservationStale]) {
        assert.equal(
          isStale('safe_bank_fx_settlement', period, pickedUpBy),
          false,
          `${period} went stale before SAFE published ${nextMonth(period)} on ${successorRelease}`,
        );
      }
      checked += 1;
    }
    assert.ok(checked >= 50);

    assert.equal(
      isChinaMacroObservationStale('safe_bank_fx_settlement', '2026-08', Date.parse('2026-10-20T08:03:59Z')),
      false,
      'the 2026-10-20 production run rejected August settlement hours before SAFE published September',
    );
    const augustEnd = chinaMacroObservationDateMs('2026-08');
    assert.ok(augustEnd);
    assert.equal(
      isChinaMacroObservationStale('safe_bank_fx_settlement', '2026-08', augustEnd + 61 * 86_400_000),
      true,
      'a skipped SAFE release must still go stale',
    );
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
    assert.doesNotMatch(seed, /afterPreservedValidationSkip/, 'a rejected publish must not stamp the completion meta');
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
