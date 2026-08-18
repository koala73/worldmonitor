import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildArmsSupplierCompletion,
  buildSipriSupplierSnapshot,
  buildWorldBankIndustrialSnapshot,
  fetchSipriSupplierDependencies,
  mapSipriEntityToIso2,
  selectSweepImporters,
  SIPRI_SWEEP_HORIZON_MS,
  parseSipriSupplierCsv,
  parseWbIndicatorPage,
} from '../scripts/_defense-industrial-source.mjs';

const wbFixture = JSON.parse(readFileSync(new URL('./fixtures/defense-industrial/wb-ms-mil.json', import.meta.url), 'utf8'));
const sipriFixture = readFileSync(new URL('./fixtures/defense-industrial/sipri-importer.csv', import.meta.url), 'utf8');

describe('defense-industrial source parsing', () => {
  it('keeps the two newest real-country WB observations and drops aggregates', () => {
    const parsed = parseWbIndicatorPage(wbFixture, 'MS.MIL.XPND.GD.ZS');

    assert.deepEqual(parsed.UA, {
      value: 34.5,
      year: 2024,
      previousValue: 36.7,
      previousYear: 2023,
      source: 'World Bank',
    });
    assert.equal(parsed.WL, undefined);
  });

  it('parses the current SIPRI CSV format into bounded supplier shares and HHI', () => {
    const parsed = parseSipriSupplierCsv(sipriFixture, { importerIso2: 'UA', windowStartYear: 2021, windowEndYear: 2025 });

    assert.deepEqual(parsed.suppliers, [
      { supplierIso2: 'US', tivShare: 0.9615 },
      { supplierIso2: 'TR', tivShare: 0.0371 },
    ]);
    assert.equal(parsed.supplierHhi, 0.9259);
    assert.equal(parsed.mappingCoverage, 0.9986);
    assert.equal(parsed.unmappedCount, 1);
    assert.deepEqual(parsed.window, { startYear: 2021, endYear: 2025 });
  });

  it('uses the canonical country resolver for non-standard portal entity names', () => {
    assert.equal(mapSipriEntityToIso2('Turkiye'), 'TR');
    assert.equal(mapSipriEntityToIso2('Chile', 'CHE'), 'CL');
    assert.equal(mapSipriEntityToIso2('Marshall Islands', 'MAR'), 'MH');
    assert.equal(mapSipriEntityToIso2('North Macedonia', 'MAC'), 'MK');
    assert.equal(mapSipriEntityToIso2('unknown supplier(s)'), null);
  });

  it('rejects malformed quoted SIPRI CSV instead of publishing partial rows', () => {
    assert.throws(
      () => parseSipriSupplierCsv('Supplier,2021-2025\n"United States,10', {
        importerIso2: 'UA',
        windowStartYear: 2021,
        windowEndYear: 2025,
      }),
      /SIPRI CSV parse failed/,
    );
  });

  it('rejects an empty SIPRI catalog instead of refreshing the completion marker', async () => {
    const responses = [new Response('2025'), new Response('[]')];
    await assert.rejects(
      () => fetchSipriSupplierDependencies({ fetchFn: async () => responses.shift(), delayMs: 0 }),
      /mapped only 0 importers/,
    );
  });

  it('builds the World Bank snapshot without waiting on SIPRI', async () => {
    const snapshot = await buildWorldBankIndustrialSnapshot({
      fetchWorldBank: async () => ({
        expenditurePctGdp: { UA: { value: 34.5, year: 2024, source: 'World Bank' } },
      }),
      now: () => new Date('2026-08-13T00:00:00.000Z'),
    });

    assert.equal(snapshot.countries.UA.expenditurePctGdp.value, 34.5);
    assert.equal(snapshot.stage.status, 'ok');
    assert.equal(snapshot.fetchedAt, '2026-08-13T00:00:00.000Z');
  });

  it('keeps the original timestamp when a failed importer uses its last-good row', async () => {
    const previousSnapshot = {
      fetchedAt: '2026-07-01T00:00:00.000Z',
      importers: { CL: { suppliers: [{ supplierIso2: 'US', tivShare: 1 }] } },
    };
    const snapshot = await buildSipriSupplierSnapshot({
      fetchSipri: async () => ({
        importers: { UA: { suppliers: [{ supplierIso2: 'US', tivShare: 0.8 }] } },
        failedImporters: [{ iso2: 'CL', message: 'timeout' }],
        windowEndYear: 2025,
      }),
      previousSnapshot,
      minimumCompleteImporterCount: 1,
      now: () => new Date('2026-08-13T00:00:00.000Z'),
    });

    assert.equal(snapshot.importers.UA.fetchedAt, '2026-08-13T00:00:00.000Z');
    assert.equal(snapshot.importers.UA.retained, false);
    assert.equal(snapshot.importers.CL.fetchedAt, '2026-07-01T00:00:00.000Z');
    assert.equal(snapshot.importers.CL.retained, true);
    assert.equal(snapshot.stage.status, 'partial');
    assert.equal(snapshot.stage.failedImporterCount, 1);
    assert.equal(snapshot.stage.preservedImporterCount, 1);
    assert.deepEqual(buildArmsSupplierCompletion(snapshot), {});
  });

  it('rejects an all-empty complete SIPRI cohort and does not create a completion marker', async () => {
    await assert.rejects(
      () => buildSipriSupplierSnapshot({
        fetchSipri: async () => ({ importers: {}, failedImporters: [], windowEndYear: 2025 }),
        minimumCompleteImporterCount: 1,
      }),
      /holds only 0 positive importer rows/,
    );

    assert.deepEqual(buildArmsSupplierCompletion({
      fetchedAt: '2026-08-13T00:00:00.000Z',
      stage: { status: 'error', windowEndYear: 2025 },
    }), {});
  });
});

describe('defense-industrial deployment wiring', () => {
  it('runs on a scheduled bundle before the 30-day TTL expires', () => {
    // The two SIPRI seeders live in DIFFERENT bundles since #6806. Suppliers is
    // the 450s member that consumed leftover's budget on every tick, so it moved
    // to seed-bundle-static-ref-heavy; Defense-Industrial is 100s and stayed.
    // Both still have to be wired to a cron and a watch-path closure, which is
    // what this asserts — one seeder unwired is a silent 30-day TTL expiry.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const light = readFileSync(join(root, 'scripts/seed-bundle-static-ref.mjs'), 'utf8');
    const heavy = readFileSync(join(root, 'scripts/seed-bundle-static-ref-heavy.mjs'), 'utf8');
    const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
    const lightService = registry.find((entry) => entry.service === 'seed-bundle-static-ref');
    const heavyService = registry.find((entry) => entry.service === 'seed-bundle-static-ref-heavy');

    assert.match(heavy, /label:\s*'Arms-Suppliers'/);
    assert.match(heavy, /script:\s*'seed-defense-industrial-suppliers\.mjs'/);
    assert.match(heavy, /timeoutMs:\s*370_000/);
    assert.match(heavy, /seedMetaKey:\s*'military:arms-suppliers-complete'/);
    assert.match(heavy, /canonicalKey:\s*'military:arms-suppliers:complete:v1'/);
    assert.match(heavy, /intervalMs:\s*14 \* DAY/);
    assert.match(heavy, /maxBundleMs:\s*570_000/);

    assert.match(light, /label:\s*'Defense-Industrial'/);
    assert.match(light, /script:\s*'seed-defense-industrial\.mjs'/);
    assert.match(light, /maxBundleMs:\s*570_000/);

    // Both seeders import _defense-industrial-source.mjs, so BOTH closures need
    // it. Dropping it from either side ships a service that cannot redeploy when
    // the shared source changes.
    for (const service of [lightService, heavyService]) {
      assert.ok(service, 'both SIPRI bundles must be registered');
      assert.ok(service.watchPatterns.includes('scripts/_defense-industrial-source.mjs'));
    }
    assert.ok(lightService.watchPatterns.includes('scripts/seed-defense-industrial.mjs'));
    assert.ok(heavyService.watchPatterns.includes('scripts/seed-defense-industrial-suppliers.mjs'));
    assert.equal(lightService.cronSchedule, '0 3 * * *');
    assert.equal(heavyService.cronSchedule, '0 4 * * *');

    const supplierSeeder = readFileSync(join(root, 'scripts/seed-defense-industrial-suppliers.mjs'), 'utf8');
    assert.match(supplierSeeder, /contentMeta:\s*supplierContentMeta/);
    assert.match(supplierSeeder, /transform:\s*buildArmsSupplierCompletion/);
    assert.match(supplierSeeder, /maxContentAgeMin:\s*800 \* 24 \* 60/);
  });
});

describe('SIPRI importer fan-out fits its fetch deadline (#6799, #6806)', () => {
  // This gate existed and PASSED while production failed every run, because it
  // was calibrated on a latency that had drifted. It asserted
  // (200 / 8) * 10.6s = 265s < 390s and went green; the real run took 390.9s and
  // exited 75. Re-measured 2026-08-18 against atbackend.sipri.org: mean 31.8s,
  // p90 37.3s per importer POST -- 3x the modelled figure.
  //
  // The lesson is in the shape of the assertions below, not just the number. A
  // hardcoded latency constant is a snapshot of one afternoon; when it drifts,
  // this gate goes green precisely when it matters most. So it now pins BOTH
  // directions: the chunk must fit, AND the whole-catalog pass must not -- the
  // second is what stops someone "simplifying" the sweep away and restoring the
  // original bug behind a green test.

  const SIPRI_LATENCY_P90_S = 37.3;  // measured 2026-08-18, was modelled at 10.6
  const MAPPED_IMPORTERS = 200;      // 385 catalog entries, ~185 unmapped non-state actors
  const RAILWAY_CONTAINER_KILL_S = 600;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  const readNumber = (src, re, label) => {
    const m = re.exec(src);
    assert.ok(m, `${label} must be declared`);
    // Numeric separators are idiomatic in this repo (270_000); Number() returns
    // NaN on them, and a NaN comparison fails OPEN in the wrong direction.
    const value = Number(String(m[1]).replace(/_/g, ''));
    assert.ok(Number.isFinite(value), `${label} did not parse to a number: ${m[1]}`);
    return value;
  };

  it('one chunk fits the fetch deadline at measured p90 latency', () => {
    const seeder = readFileSync(join(root, 'scripts/seed-defense-industrial-suppliers.mjs'), 'utf8');
    const source = readFileSync(join(root, 'scripts/_defense-industrial-source.mjs'), 'utf8');

    const deadlineS = readNumber(seeder, /fetchPhaseTimeoutMs:\s*(\d+)\s*\*\s*1000/, 'fetchPhaseTimeoutMs') ;
    const chunk = readNumber(source, /export const SIPRI_SWEEP_CHUNK = (\d+);/, 'SIPRI_SWEEP_CHUNK');
    const concurrency = readNumber(source, /^\s*concurrency = (\d+),$/m, 'default concurrency');

    // ~30s for getMaxYear + getAllCountriesTrimmed before any importer POST.
    const chunkS = Math.ceil(chunk / concurrency) * SIPRI_LATENCY_P90_S + 30;
    assert.ok(
      chunkS < deadlineS,
      `a ${chunk}-importer chunk needs ${Math.round(chunkS)}s at p90 ${SIPRI_LATENCY_P90_S}s `
      + `and concurrency ${concurrency}, but fetchPhaseTimeoutMs is ${deadlineS}s.`,
    );
  });

  it('the soft budget stops work BEFORE the hard deadline discards it', () => {
    // fetchPhaseTimeoutMs aborts the whole phase and throws away every row already
    // fetched. The soft budget has to bite first or it is decorative.
    const seeder = readFileSync(join(root, 'scripts/seed-defense-industrial-suppliers.mjs'), 'utf8');
    const source = readFileSync(join(root, 'scripts/_defense-industrial-source.mjs'), 'utf8');
    const deadlineMs = readNumber(seeder, /fetchPhaseTimeoutMs:\s*(\d+)\s*\*\s*1000/, 'fetchPhaseTimeoutMs') * 1000;
    const softMs = readNumber(source, /export const SIPRI_SWEEP_SOFT_BUDGET_MS = ([\d_]+);/, 'SIPRI_SWEEP_SOFT_BUDGET_MS');
    assert.ok(
      softMs < deadlineMs,
      `soft budget ${softMs}ms must be under fetchPhaseTimeoutMs ${deadlineMs}ms, or the phase `
      + 'is aborted before it can return partial progress and the tick advances the sweep by nothing.',
    );
  });

  it('a WHOLE-CATALOG pass provably does not fit, which is why the sweep chunks', () => {
    // The counterweight. If someone raises the chunk to cover the catalog, or
    // drops the slice entirely, this fails and says why.
    const source = readFileSync(join(root, 'scripts/_defense-industrial-source.mjs'), 'utf8');
    const concurrency = readNumber(source, /^\s*concurrency = (\d+),$/m, 'default concurrency');
    const chunk = readNumber(source, /export const SIPRI_SWEEP_CHUNK = (\d+);/, 'SIPRI_SWEEP_CHUNK');

    const fullPassS = (MAPPED_IMPORTERS / concurrency) * SIPRI_LATENCY_P90_S;
    assert.ok(
      fullPassS > RAILWAY_CONTAINER_KILL_S,
      `a full ${MAPPED_IMPORTERS}-importer pass is ${Math.round(fullPassS)}s at concurrency ${concurrency}. `
      + 'If that now fits Railway\'s 600s container kill, the sweep may be unnecessary — re-measure and simplify deliberately.',
    );
    assert.ok(
      chunk < MAPPED_IMPORTERS,
      `SIPRI_SWEEP_CHUNK ${chunk} covers the whole ${MAPPED_IMPORTERS}-importer catalog, so every tick `
      + `attempts a pass that needs ${Math.round(fullPassS)}s inside a 600s container. That is the #6799 bug.`,
    );
  });

  it('actually runs the requests in parallel up to that concurrency', async () => {
    // The arithmetic above is worthless if the pool silently serialises.
    let inFlight = 0;
    let peak = 0;
    // Real ISO2-mappable names, or the catalog fails the >=150 importer floor
    // before any request is made and this measures nothing.
    // Real ISO2-mappable names, and the EntityId keyed to the NAME rather than
    // the index: a repeated name carrying two ids trips the mapping-collision
    // guard and the run throws before issuing a single request.
    const names = ['Ukraine', 'Poland', 'Japan', 'Egypt', 'India', 'Brazil', 'Norway', 'Chile'];
    const catalog = Array.from({ length: 160 }, (_, i) => ({
      EntityId: 1000 + (i % names.length),
      Name: names[i % names.length],
    }));
    const fetchFn = async (url) => {
      if (String(url).includes('getMaxYear')) return new Response('2025');
      if (String(url).includes('getAllCountriesTrimmed')) return new Response(JSON.stringify(catalog));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ bytes: '' }));
    };
    await fetchSipriSupplierDependencies({ fetchFn, delayMs: 0 }).catch(() => {});
    assert.ok(peak > 1, `expected parallel requests, saw peak in-flight ${peak}`);
  });
});


describe('SIPRI chunked sweep (#6806)', () => {
  const NOW = Date.parse('2026-08-18T04:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const row = (endYear, fetchedAtMs) => ({ window: { endYear }, fetchedAt: iso(fetchedAtMs) });
  const candidates = [{ iso2: 'FR' }, { iso2: 'DE' }, { iso2: 'JP' }, { iso2: 'BR' }];

  const DAY = 24 * 3600_000;

  it('selects only rows outside the horizon, oldest first, and never a current one', () => {
    const previous = {
      importers: {
        FR: row(2025, NOW - 1 * DAY),   // current -> must NOT be selected
        DE: row(2025, NOW - 16 * DAY),  // outside the 10d horizon
        JP: row(2025, NOW - 12 * DAY),  // outside, but newer than DE
        // BR absent entirely
      },
    };
    const picked = selectSweepImporters(candidates, previous, 2025, NOW).map((c) => c.iso2);
    // BR first (never fetched = infinite age), then oldest-to-newest. FR omitted.
    assert.deepEqual(picked, ['BR', 'DE', 'JP']);
  });

  it('a fully current catalog selects NOTHING, which is what lets a sweep finish', () => {
    // The inverse of the livelock: if every row is current the sweep is done.
    // An earlier draft filtered on `age > 0` instead of `age > horizon`, so this
    // returned all four and the completion marker could never be written.
    const previous = {
      importers: Object.fromEntries(candidates.map((c) => [c.iso2, row(2025, NOW - 1 * DAY)])),
    };
    assert.deepEqual(selectSweepImporters(candidates, previous, 2025, NOW), []);
  });

  it('treats a new SIPRI window as invalidating every row, which is the annual re-sweep', () => {
    const previous = {
      importers: {
        FR: row(2025, NOW - 60_000),
        DE: row(2025, NOW - 60_000),
      },
    };
    // Rows are minutes old but hold the PREVIOUS window.
    const picked = selectSweepImporters([{ iso2: 'FR' }, { iso2: 'DE' }], previous, 2026, NOW);
    assert.equal(picked.length, 2, 'a window rollover must re-sweep the whole catalog');
  });

  it('the horizon is the boundary: just past selects, just inside does not', () => {
    const stale = { importers: { FR: row(2025, NOW - SIPRI_SWEEP_HORIZON_MS - 60_000) } };
    assert.equal(selectSweepImporters([{ iso2: 'FR' }], stale, 2025, NOW).length, 1);
    const fresh = { importers: { FR: row(2025, NOW - SIPRI_SWEEP_HORIZON_MS + 60_000) } };
    assert.equal(selectSweepImporters([{ iso2: 'FR' }], fresh, 2025, NOW).length, 0);
  });

  it('the horizon stays between the sweep duration and the refresh interval', () => {
    // Both bounds are livelocks, in opposite directions, and neither shows up as
    // a test failure elsewhere:
    //   horizon <= sweep duration -> the head of a sweep expires before its tail
    //     lands, unfetched never hits 0, the marker never advances, the section
    //     is due forever.
    //   horizon >= refresh interval -> when the section next comes due every row
    //     still reads current, the sweep selects nothing and "completes"
    //     instantly without fetching. Silent staleness behind a green marker.
    const horizonDays = SIPRI_SWEEP_HORIZON_MS / DAY;
    // ~40 importers actually land per tick once the soft budget and SIPRI's
    // retries are accounted for -- NOT the 56 chunk ceiling. Sizing this off the
    // ceiling would understate the sweep and hide a horizon that is too short.
    const IMPORTERS_PER_TICK = 40;
    const CHUNKS_PER_SWEEP = Math.ceil(200 / IMPORTERS_PER_TICK);   // ~5 ticks
    const TICKS_PER_DAY = 2 / 3;                                    // Arms leads 2 of 3 rotation days
    const sweepDays = CHUNKS_PER_SWEEP / TICKS_PER_DAY;             // ~7.5
    const intervalDays = 14;                                        // seed-bundle-static-ref-heavy section
    assert.ok(
      horizonDays > sweepDays,
      `horizon ${horizonDays}d must exceed the ~${sweepDays.toFixed(1)}d a sweep takes, or it never completes`,
    );
    assert.ok(
      horizonDays < intervalDays,
      `horizon ${horizonDays}d must be under the ${intervalDays}d refresh interval, or the next sweep is a no-op`,
    );
  });

  it('a mid-sweep tick retains untouched rows and withholds the completion marker', async () => {
    // THE core guarantee. If a chunk marked the refresh complete, the completion
    // marker would advance, the section would stop being due, and the ~144
    // importers this tick did not touch would never be revisited.
    const previous = {
      fetchedAt: iso(NOW - 48 * 3600_000),
      importers: {
        FR: { suppliers: [{ iso2: 'US', share: 1 }], window: { endYear: 2025 }, fetchedAt: iso(NOW - 48 * 3600_000) },
        DE: { suppliers: [{ iso2: 'US', share: 1 }], window: { endYear: 2025 }, fetchedAt: iso(NOW - 48 * 3600_000) },
      },
    };
    const snapshot = await buildSipriSupplierSnapshot({
      previousSnapshot: previous,
      minimumCompleteImporterCount: 1,
      now: () => new Date(NOW),
      fetchSipri: async () => ({
        importers: { FR: { suppliers: [{ iso2: 'FR', share: 1 }], window: { endYear: 2025 } } },
        failedImporters: [],
        windowEndYear: 2025,
        sweep: { catalogCount: 2, attempted: 1, fetched: 1, unfetched: 1 },
      }),
    });

    assert.equal(snapshot.stage.status, 'partial', 'an unfinished sweep must not read as complete');
    assert.deepEqual(buildArmsSupplierCompletion(snapshot), {}, 'no completion marker mid-sweep');
    // The untouched row survives with its ORIGINAL timestamp, so the next tick
    // can still see that it is the stale one.
    assert.equal(snapshot.importers.DE.retained, true);
    assert.equal(snapshot.importers.DE.fetchedAt, iso(NOW - 48 * 3600_000));
    assert.equal(snapshot.importers.FR.retained, false);
    assert.equal(snapshot.importers.FR.fetchedAt, iso(NOW));
    assert.equal(snapshot.stage.sweep.remaining, 1);
  });

  it('the final tick of a sweep completes it and writes the marker', async () => {
    const previous = {
      importers: { FR: { suppliers: [], window: { endYear: 2025 }, fetchedAt: iso(NOW - 3600_000) } },
    };
    const snapshot = await buildSipriSupplierSnapshot({
      previousSnapshot: previous,
      minimumCompleteImporterCount: 1,
      now: () => new Date(NOW),
      fetchSipri: async () => ({
        importers: { DE: { suppliers: [{ iso2: 'US', share: 1 }], window: { endYear: 2025 } } },
        failedImporters: [],
        windowEndYear: 2025,
        sweep: { catalogCount: 2, attempted: 1, fetched: 1, unfetched: 0 },
      }),
    });
    assert.equal(snapshot.stage.status, 'ok');
    assert.deepEqual(buildArmsSupplierCompletion(snapshot), { completedAt: iso(NOW), windowEndYear: 2025 });
    assert.equal(Object.keys(snapshot.importers).length, 2, 'the merged snapshot carries both');
  });

  it('the record floor judges the MERGED snapshot, not one chunk', async () => {
    // A slice is smaller than the floor by design; applying the floor per-tick
    // would reject every healthy sweep tick.
    const previous = {
      importers: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`X${i}`, { suppliers: [], window: { endYear: 2025 }, fetchedAt: iso(NOW - 3600_000) }]),
      ),
    };
    const snapshot = await buildSipriSupplierSnapshot({
      previousSnapshot: previous,
      minimumCompleteImporterCount: 25,
      now: () => new Date(NOW),
      fetchSipri: async () => ({
        importers: { FR: { suppliers: [], window: { endYear: 2025 } } },
        failedImporters: [],
        windowEndYear: 2025,
        sweep: { catalogCount: 31, attempted: 1, fetched: 1, unfetched: 30 },
      }),
    });
    assert.equal(Object.keys(snapshot.importers).length, 31);
    assert.equal(snapshot.stage.status, 'partial');
  });

  it('the soft budget returns partial progress instead of losing the tick', async () => {
    let served = 0;
    const names = ['Ukraine', 'Poland', 'Japan', 'Egypt', 'India', 'Brazil', 'Norway', 'Chile'];
    const catalog = Array.from({ length: 160 }, (_, i) => ({
      EntityId: 1000 + (i % names.length),
      Name: names[i % names.length],
    }));
    let clock = 0;
    const fetchFn = async (url) => {
      if (String(url).includes('getMaxYear')) return new Response('2025');
      if (String(url).includes('getAllCountriesTrimmed')) return new Response(JSON.stringify(catalog));
      served += 1;
      clock += 10_000;   // 10s of virtual time per importer POST
      return new Response(JSON.stringify({ bytes: '' }));
    };
    const result = await fetchSipriSupplierDependencies({
      fetchFn,
      delayMs: 0,
      softBudgetMs: 30_000,
      now: () => clock,
    });
    assert.ok(served > 0, 'the tick must still do useful work');
    assert.ok(result.sweep.unfetched > 0, 'and report what it left behind');
    assert.ok(
      served < 8,
      `the soft budget must stop the pool early; it served ${served} importers past a 30s budget`,
    );
  });
});
