import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDefenseIndustrialSnapshot,
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

  it('keeps WB data publishable when the SIPRI stage fails', async () => {
    const snapshot = await buildDefenseIndustrialSnapshot({
      fetchWorldBank: async () => ({
        expenditurePctGdp: { UA: { value: 34.5, year: 2024, source: 'World Bank' } },
      }),
      fetchSipri: async () => { throw new Error('portal unavailable'); },
      logger: { log() {}, warn() {} },
    });

    assert.equal(snapshot.countries.UA.expenditurePctGdp.value, 34.5);
    assert.deepEqual(snapshot.suppliers, {});
    assert.equal(snapshot.stages.worldBank.status, 'ok');
    assert.equal(snapshot.stages.sipri.status, 'error');
  });

  it('keeps last-good importer rows when another importer request fails', async () => {
    const previous = { CL: { suppliers: [{ supplierIso2: 'US', tivShare: 1 }] } };
    const snapshot = await buildDefenseIndustrialSnapshot({
      fetchWorldBank: async () => ({ expenditurePctGdp: { UA: { value: 34.5, year: 2024, source: 'World Bank' } } }),
      fetchSipri: async () => ({
        importers: { UA: { suppliers: [{ supplierIso2: 'US', tivShare: 0.8 }] } },
        failedImporters: [{ iso2: 'CL', message: 'timeout' }],
        windowEndYear: 2025,
      }),
      previousSuppliers: previous,
      logger: { log() {}, warn() {} },
    });

    assert.deepEqual(snapshot.suppliers.CL, previous.CL);
    assert.equal(snapshot.stages.sipri.status, 'partial');
    assert.equal(snapshot.stages.sipri.failedImporterCount, 1);
    assert.equal(snapshot.stages.sipri.preservedImporterCount, 1);
  });
});

describe('defense-industrial deployment wiring', () => {
  it('runs in the static-reference bundle before the 30-day TTL expires', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const bundle = readFileSync(join(root, 'scripts/seed-bundle-static-ref.mjs'), 'utf8');
    const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
    const service = registry.find((entry) => entry.service === 'seed-bundle-static-ref');

    assert.match(bundle, /label:\s*'Defense-Industrial'/);
    assert.match(bundle, /script:\s*'seed-defense-industrial\.mjs'/);
    assert.match(bundle, /seedMetaKey:\s*'military:arms-suppliers-complete'/);
    assert.match(bundle, /canonicalKey:\s*'military:arms-suppliers:complete:v1'/);
    assert.match(bundle, /intervalMs:\s*10 \* DAY/);
    assert.match(bundle, /timeoutMs:\s*1_200_000/);
    assert.ok(service.watchPatterns.includes('scripts/_defense-industrial-source.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/seed-defense-industrial.mjs'));
    const seeder = readFileSync(join(root, 'scripts/seed-defense-industrial.mjs'), 'utf8');
    assert.match(seeder, /WB_DEFENSE_INDICATORS\.map/);
    assert.match(seeder, /metaExtra:\s*supplierContentMeta/);
    assert.match(seeder, /sourceState:\s*data\.stage\?\.status/);
    assert.match(seeder, /maxContentAgeMin:\s*800 \* 24 \* 60/);
  });
});
