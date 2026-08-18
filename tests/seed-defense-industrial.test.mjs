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
      /returned only 0 positive importer rows/,
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
    assert.match(heavy, /timeoutMs:\s*450_000/);
    assert.match(heavy, /seedMetaKey:\s*'military:arms-suppliers-complete'/);
    assert.match(heavy, /canonicalKey:\s*'military:arms-suppliers:complete:v1'/);
    assert.match(heavy, /intervalMs:\s*10 \* DAY/);
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

describe('SIPRI importer fan-out fits its fetch deadline (#6799)', () => {
  // The seeder POSTs once per mapped importer. SIPRI answers in ~10.6s whatever
  // the payload, so the wall time is (importers / concurrency) * latency and
  // has to land inside fetchPhaseTimeoutMs. At concurrency 4 it did not: ~200
  // importers took ~547s against a 390s deadline, so the phase burned the whole
  // deadline and exited 75 every run — which then starved every later section
  // of seed-bundle-static-ref out of its 570s budget.

  const OBSERVED_SIPRI_LATENCY_S = 10.6; // measured 2026-08-16 against live SIPRI
  const MAPPED_IMPORTERS = 200;          // 385 catalog entries, ~185 unmapped non-state actors
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('the configured concurrency leaves the fetch phase inside its deadline', () => {
    const seeder = readFileSync(join(root, 'scripts/seed-defense-industrial-suppliers.mjs'), 'utf8');
    const deadline = /fetchPhaseTimeoutMs:\s*([\d.]+)\s*\*\s*60\s*\*\s*1000/.exec(seeder);
    assert.ok(deadline, 'the supplier seeder must declare fetchPhaseTimeoutMs');
    const deadlineS = Number(deadline[1]) * 60;

    const source = readFileSync(join(root, 'scripts/_defense-industrial-source.mjs'), 'utf8');
    const declared = /^\s*concurrency = (\d+),$/m.exec(source);
    assert.ok(declared, 'the SIPRI fan-out must declare a default concurrency');
    const concurrency = Number(declared[1]);

    const worstCaseS = (MAPPED_IMPORTERS / concurrency) * OBSERVED_SIPRI_LATENCY_S;
    assert.ok(
      worstCaseS < deadlineS,
      `concurrency ${concurrency} needs ${Math.round(worstCaseS)}s for ${MAPPED_IMPORTERS} importers `
      + `at ${OBSERVED_SIPRI_LATENCY_S}s each, but fetchPhaseTimeoutMs is ${deadlineS}s. `
      + 'The phase cannot finish, so it burns the full deadline and exits 75 every run.',
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
