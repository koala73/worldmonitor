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
  it('runs in the static-reference bundle before the 30-day TTL expires', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const bundle = readFileSync(join(root, 'scripts/seed-bundle-static-ref.mjs'), 'utf8');
    const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
    const service = registry.find((entry) => entry.service === 'seed-bundle-static-ref');

    assert.match(bundle, /label:\s*'Arms-Suppliers'/);
    assert.match(bundle, /script:\s*'seed-defense-industrial-suppliers\.mjs'/);
    assert.match(bundle, /timeoutMs:\s*450_000/);
    assert.match(bundle, /label:\s*'Defense-Industrial'/);
    assert.match(bundle, /script:\s*'seed-defense-industrial\.mjs'/);
    assert.match(bundle, /seedMetaKey:\s*'military:arms-suppliers-complete'/);
    assert.match(bundle, /canonicalKey:\s*'military:arms-suppliers:complete:v1'/);
    assert.match(bundle, /intervalMs:\s*10 \* DAY/);
    assert.match(bundle, /maxBundleMs:\s*570_000/);
    assert.ok(service.watchPatterns.includes('scripts/_defense-industrial-source.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/seed-defense-industrial.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/seed-defense-industrial-suppliers.mjs'));
    assert.equal(service.cronSchedule, '0 3 * * *');
    const supplierSeeder = readFileSync(join(root, 'scripts/seed-defense-industrial-suppliers.mjs'), 'utf8');
    assert.match(supplierSeeder, /contentMeta:\s*supplierContentMeta/);
    assert.match(supplierSeeder, /transform:\s*buildArmsSupplierCompletion/);
    assert.match(supplierSeeder, /maxContentAgeMin:\s*800 \* 24 \* 60/);
  });
});
