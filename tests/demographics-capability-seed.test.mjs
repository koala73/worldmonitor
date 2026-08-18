import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { __testing__ as healthTesting } from '../api/health.js';
import {
  DEMOGRAPHICS_CAPABILITY_KEY,
  DEMOGRAPHICS_CAPABILITY_TTL_SECONDS,
  buildDemographicsPayload,
  demographicsContentMeta,
  demographicsStageCoverageMeta,
  parseIlostatWorkforceCsv,
  parseWorldBankEducation,
  parseWppCapability,
  validateDemographicsStageCoverage,
} from '../scripts/_demographics-capability-source.mjs';
import { readSectionFreshness } from '../scripts/_bundle-runner.mjs';
import {
  demographicsCapabilityAfterPublish,
  fetchDemographicsCapability,
} from '../scripts/seed-demographics-capability.mjs';
import { resolveSourceOrigin } from '../scripts/source-origin.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/demographics-capability/${name}`, import.meta.url), 'utf8');
const repoFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('demographics capability source parsers (#6437)', () => {
  it('parses real WPP JSON without turning null into zero', () => {
    const raw = JSON.parse(fixture('wpp.json'));
    const result = parseWppCapability(raw.demographics, raw.workingAge, { currentYear: 2026 });
    assert.equal(result.countries.DE.medianAgeYears.value, 45.69019);
    assert.equal(result.countries.DE.workingAgePopulationPeople.value, 51_775_142);
    assert.equal(result.countries.DE.workingAgePopulationProjected10yPeople.value, 47_232_903);
    assert.equal(result.countries.US.medianAgeYears.value, 38.712831, 'later null row must not overwrite a real value');
    assert.equal(result.newestObservationYear, 2026, 'the +10 projection must not advance the source freshness clock');
  });

  it('computes STEM only from a complete, bounded same-year World Bank/UIS cohort', () => {
    const result = parseWorldBankEducation(JSON.parse(fixture('world-bank.json')));
    assert.equal(result.countries.DE.tertiaryEnrollmentGrossPercent.value, 76.709686);
    assert.equal(result.countries.US.tertiaryEnrollmentGrossPercent.value, 125.5, 'gross enrollment can validly exceed 100 percent');
    assert.equal(result.countries.DE.researchersPerMillion.value, 5926.07432);
    assert.deepEqual(result.countries.DE.stemGraduatesSharePercent, {
      value: 35.3088,
      year: 2018,
      source: 'UNESCO UIS via World Bank WDI',
    });
    assert.equal(result.countries.US?.stemGraduatesSharePercent, undefined, 'different years and nulls must not be combined');
  });

  it('normalizes ILOSTAT UNIT_MULT counts to persons and requires common years', () => {
    const result = parseIlostatWorkforceCsv(fixture('ilostat-occupation.csv'), fixture('ilostat-economic.csv'));
    assert.equal(result.countries.DE.craftTradesEmploymentPeople.value, 4_602_430);
    assert.equal(result.countries.DE.plantMachineOperatorsEmploymentPeople.value, 2_345_564);
    assert.equal(result.countries.DE.trainedIndustrialWorkforcePeople.value, 6_947_994);
    assert.equal(result.countries.DE.manufacturingEmploymentSharePercent.value, 18.009972);
    assert.equal(result.countries.US?.trainedIndustrialWorkforcePeople, undefined, 'occupation groups from different years must not be combined');
    assert.equal(result.countries.US?.manufacturingEmploymentSharePercent, undefined, 'economic rows from different years must not be divided');
  });

  it('rejects an HTTP-200 stage that loses a required metric family', () => {
    const countries = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [
      `C${index}`,
      {
        craftTradesEmploymentPeople: { value: 1 },
        plantMachineOperatorsEmploymentPeople: { value: 1 },
        trainedIndustrialWorkforcePeople: { value: 2 },
      },
    ]));
    assert.throws(
      () => validateDemographicsStageCoverage(countries, 'ilostat'),
      /manufacturingEmploymentSharePercent coverage too small/,
    );
    for (const country of Object.values(countries)) {
      country.manufacturingEmploymentSharePercent = { value: 10 };
    }
    assert.equal(validateDemographicsStageCoverage(countries, 'ilostat').trainedIndustrialWorkforcePeople, 150);
  });
});

describe('demographics partial-stage publication', () => {
  const previous = {
    version: 1,
    generatedAt: '2026-07-01T00:00:00.000Z',
    stages: {
      wpp: { status: 'fresh', fetchedAt: '2026-07-01T00:00:00.000Z', recordCount: 1, newestObservationYear: 2026 },
      education: { status: 'fresh', fetchedAt: '2026-06-01T00:00:00.000Z', recordCount: 1, newestObservationYear: 2024 },
      ilostat: { status: 'fresh', fetchedAt: '2026-05-01T00:00:00.000Z', recordCount: 1, newestObservationYear: 2025 },
    },
    countries: {
      DE: {
        ageStructure: { medianAgeYears: { value: 45, year: 2026, source: 'old WPP' } },
        education: { tertiaryEnrollmentGrossPercent: { value: 75, year: 2023, source: 'old WDI' } },
        industrialWorkforce: { trainedIndustrialWorkforcePeople: { value: 7_000_000, year: 2025, source: 'old ILO' } },
      },
    },
  };

  it('marks a failed first-publish stage unavailable without inventing its section', () => {
    const payload = buildDemographicsPayload({
      wpp: { status: 'fulfilled', value: { countries: { DE: { medianAgeYears: { value: 46, year: 2026, source: 'new WPP' } } }, fetchedAt: '2026-08-18T00:00:00.000Z', newestObservationYear: 2026 } },
      education: { status: 'rejected', reason: new Error('WB unavailable') },
      ilostat: { status: 'fulfilled', value: { countries: { DE: { trainedIndustrialWorkforcePeople: { value: 7_100_000, year: 2025, source: 'new ILO' } } }, fetchedAt: '2026-08-18T00:00:02.000Z', newestObservationYear: 2025 } },
    }, null, { generatedAt: '2026-08-18T00:00:03.000Z' });

    assert.deepEqual(payload.stages.education, {
      status: 'unavailable',
      fetchedAt: null,
      recordCount: 0,
      newestObservationYear: null,
    });
    assert.equal(payload.stages.wpp.status, 'fresh');
    assert.equal(payload.stages.ilostat.status, 'fresh');
    assert.equal(payload.countries.DE.education, undefined);
    assert.equal(payload.countries.DE.ageStructure.medianAgeYears.value, 46);
    assert.equal(payload.countries.DE.industrialWorkforce.trainedIndustrialWorkforcePeople.value, 7_100_000);
  });

  it('publishes healthy stages and retains only a failed stage with its original fetchedAt', () => {
    const payload = buildDemographicsPayload({
      wpp: { status: 'fulfilled', value: { countries: { DE: { medianAgeYears: { value: 46, year: 2026, source: 'new WPP' } } }, fetchedAt: '2026-08-18T00:00:00.000Z', newestObservationYear: 2026 } },
      education: { status: 'rejected', reason: new Error('WB unavailable') },
      ilostat: { status: 'fulfilled', value: { countries: { DE: { trainedIndustrialWorkforcePeople: { value: 7_100_000, year: 2025, source: 'new ILO' } } }, fetchedAt: '2026-08-18T00:00:02.000Z', newestObservationYear: 2025 } },
    }, previous, { generatedAt: '2026-08-18T00:00:03.000Z' });

    assert.equal(payload.stages.wpp.status, 'fresh');
    assert.equal(payload.stages.education.status, 'retained');
    assert.equal(payload.stages.education.fetchedAt, '2026-06-01T00:00:00.000Z');
    assert.equal(payload.countries.DE.education.tertiaryEnrollmentGrossPercent.value, 75);
    assert.equal(payload.countries.DE.ageStructure.medianAgeYears.value, 46);
  });

  it('fails closed when every stage fails and no safe previous stage exists', () => {
    const failures = Object.fromEntries(
      ['wpp', 'education', 'ilostat'].map((name) => [name, { status: 'rejected', reason: new Error('offline') }]),
    );
    assert.throws(() => buildDemographicsPayload(failures, null), /all demographics stages failed/i);
  });

  it('preserves the existing canonical snapshot when every stage fails', () => {
    const failures = Object.fromEntries(
      ['wpp', 'education', 'ilostat'].map((name) => [name, { status: 'rejected', reason: new Error('offline') }]),
    );
    assert.throws(
      () => buildDemographicsPayload(failures, previous),
      /preserving the existing canonical snapshot/i,
    );
  });

  it('times out one stage without blocking healthy stage publication', async () => {
    let timedOutSignal;
    const freshStage = (section, value, newestObservationYear) => ({
      countries: { DE: { [section]: value } },
      fetchedAt: '2026-08-18T00:00:00.000Z',
      newestObservationYear,
    });
    const payload = await fetchDemographicsCapability({
      now: new Date('2026-08-18T00:00:01.000Z'),
      readPrevious: async () => previous,
      stageTimeoutMs: 5,
      stageFetchers: {
        wpp: ({ signal }) => new Promise((_, reject) => {
          timedOutSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        education: async () => freshStage(
          'tertiaryEnrollmentGrossPercent',
          { value: 80, year: 2024, source: 'new WDI' },
          2024,
        ),
        ilostat: async () => freshStage(
          'trainedIndustrialWorkforcePeople',
          { value: 7_100_000, year: 2025, source: 'new ILO' },
          2025,
        ),
      },
    });

    assert.equal(timedOutSignal.aborted, true);
    assert.equal(payload.stages.wpp.status, 'retained');
    assert.equal(payload.stages.education.status, 'fresh');
    assert.equal(payload.stages.ilostat.status, 'fresh');
    assert.equal(payload.countries.DE.ageStructure.medianAgeYears.value, 45);
  });

  it('settles stage work before propagating a prior-snapshot read failure', async () => {
    let completedStages = 0;
    const stage = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completedStages += 1;
      return { countries: { DE: { metric: { value: 1, year: 2025, source: 'test' } } } };
    };
    await assert.rejects(
      fetchDemographicsCapability({
        readPrevious: async () => { throw new Error('Redis read failed'); },
        stageTimeoutMs: 50,
        stageFetchers: { wpp: stage, education: stage, ilostat: stage },
      }),
      /Redis read failed/,
    );
    assert.equal(completedStages, 3);
  });

  it('uses a 30-day key contract and observation-year content metadata', () => {
    assert.equal(DEMOGRAPHICS_CAPABILITY_KEY, 'demographics:capability:v1');
    assert.equal(DEMOGRAPHICS_CAPABILITY_TTL_SECONDS, 30 * 24 * 60 * 60);
    const meta = demographicsContentMeta(previous);
    assert.equal(meta.newestItemAt, Date.UTC(2024, 11, 31), 'oldest stage latest-year controls whole-stack freshness');
  });

  it('marks retained or unavailable stages as partial producer coverage', () => {
    assert.deepEqual(demographicsStageCoverageMeta(previous), {
      status: 'complete',
      completedPages: 3,
      failedPages: 0,
      completionRatio: 1,
      rejectedCount: 0,
    });
    const partial = structuredClone(previous);
    partial.stages.education.status = 'retained';
    assert.deepEqual(demographicsStageCoverageMeta(partial), {
      status: 'partial',
      completedPages: 2,
      failedPages: 1,
      completionRatio: 2 / 3,
      rejectedCount: 0,
    });
  });

  it('stamps the completion marker only after a fully fresh three-stage publish', async () => {
    const writes = [];
    const completeResult = await demographicsCapabilityAfterPublish(previous, async (...args) => {
      writes.push(args);
    }, 1_755_500_000_000);
    assert.deepEqual(completeResult, {
      completionState: 'OK',
      freshnessMetaPatch: {
        coverage: {
          status: 'complete',
          completedPages: 3,
          failedPages: 0,
          completionRatio: 1,
          rejectedCount: 0,
        },
      },
    });
    assert.deepEqual(writes, [[
      'demographics',
      'capability-complete',
      1,
      'demographics-capability-v1',
      30 * 24 * 60 * 60,
      1_755_500_000_000,
    ]]);

    const partialWrites = [];
    const partial = structuredClone(previous);
    partial.stages.education.status = 'retained';
    const partialResult = await demographicsCapabilityAfterPublish(partial, async (...args) => {
      partialWrites.push(args);
    }, 1_755_500_000_000);
    assert.equal(partialResult.completionState, 'DEGRADED');
    assert.equal(partialWrites.length, 0);
  });
});

describe('demographics production registration', () => {
  it('registers strict data and seed-meta health with the issue cutover', () => {
    assert.equal(healthTesting.STANDALONE_KEYS.demographicsCapability, 'demographics:capability:v1');
    assert.deepEqual(healthTesting.SEED_META.demographicsCapability, {
      key: 'seed-meta:demographics:capability',
      maxStaleMin: 36000,
      minRecordCount: 150,
      cutover: { mode: 'expiring-ack', fromKey: null, issue: 6437, status: 'EMPTY' },
    });
    assert.match(repoFile('api/seed-health.js'), /'demographics:capability':\s*\{ key: 'seed-meta:demographics:capability', intervalMin: 18000, minRecordCount: 150 \}/);
  });

  it('surfaces a retained source stage as COVERAGE_PARTIAL health', () => {
    const name = 'demographicsCapability';
    const dataKey = healthTesting.STANDALONE_KEYS[name];
    const metaKey = healthTesting.SEED_META[name].key;
    const now = Date.parse('2026-08-18T12:00:00.000Z');
    const entry = healthTesting.classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 1024]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: 200,
        newestItemAt: Date.parse('2025-12-31T00:00:00.000Z'),
        oldestItemAt: Date.parse('2018-01-01T00:00:00.000Z'),
        maxContentAgeMin: 5 * 365 * 24 * 60,
        coverage: {
          status: 'partial',
          completedPages: 2,
          failedPages: 1,
          completionRatio: 2 / 3,
          rejectedCount: 0,
        },
      })]]),
      keyMetaErrors: new Map(),
      now,
    });
    assert.equal(entry.status, 'COVERAGE_PARTIAL');
    assert.equal(entry.coverage.status, 'partial');
  });

  it('does not let a partial publish satisfy the 20-day interval gate', async () => {
    const now = Date.now();
    const section = {
      freshnessMetaKey: 'seed-meta:demographics:capability',
      completionMetaKey: 'seed-meta:demographics:capability-complete',
      canonicalKey: 'demographics:capability:v1',
      requireCanonical: true,
    };
    const partial = await readSectionFreshness(section, async (key) => {
      if (key === 'demographics:capability:v1') return { _seed: { fetchedAt: now } };
      if (key === 'seed-meta:demographics:capability') return { fetchedAt: now };
      return null;
    });
    assert.equal(partial, null);

    const complete = await readSectionFreshness(section, async (key) => {
      if (key === 'demographics:capability:v1') return { _seed: { fetchedAt: now } };
      if (key === 'seed-meta:demographics:capability') return { fetchedAt: now };
      if (key === 'seed-meta:demographics:capability-complete') return { fetchedAt: now };
      return null;
    });
    assert.deepEqual(complete, { fetchedAt: now });
  });

  it('fits the fifth member in the static-reference bundle and watches its runtime closure', () => {
    const bundle = repoFile('scripts/seed-bundle-static-ref.mjs');
    assert.match(
      bundle,
      /label: 'Demographics-Capability'[\s\S]*freshnessMetaKey: 'seed-meta:demographics:capability'[\s\S]*completionMetaKey: 'seed-meta:demographics:capability-complete'[\s\S]*requireCanonical: true[\s\S]*intervalMs: 20 \* DAY[\s\S]*timeoutMs: 65_000/,
    );
    const service = JSON.parse(repoFile('scripts/railway-services.json'))
      .find((entry) => entry.service === 'seed-bundle-static-ref');
    for (const path of [
      'scripts/_demographics-capability-source.mjs',
      'scripts/seed-demographics-capability.mjs',
      'scripts/shared/iso3-to-iso2.json',
      'scripts/shared/un-to-iso2.json',
    ]) assert.ok(service.watchPatterns.includes(path), `static-ref must watch ${path}`);
  });

  it('classifies the ILO source catalog origin as International', () => {
    assert.equal(resolveSourceOrigin({ provider: 'ILOSTAT', hosts: ['sdmx.ilo.org'] }), null);
  });
});
