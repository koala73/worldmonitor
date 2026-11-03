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
  fetchWppStage,
  parseIlostatWorkforceCsv,
  parseWorldBankEducation,
  parseWppCapability,
  validateDemographicsStageCoverage,
} from '../scripts/_demographics-capability-source.mjs';
import { readSectionFreshness } from '../scripts/_bundle-runner.mjs';
import {
  DEMOGRAPHICS_CAPABILITY_SEED_OPTIONS,
  demographicsCapabilityAfterPublish,
  fetchDemographicsCapability,
  recordDemographicsCapabilityCompletedRun,
} from '../scripts/seed-demographics-capability.mjs';
import { runSeed } from '../scripts/_seed-utils.mjs';
import { resolveSourceOrigin } from '../scripts/source-origin.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/demographics-capability/${name}`, import.meta.url), 'utf8');
const repoFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function wppResponse(url, currentYear = 2026) {
  const requestUrl = String(url);
  const locations = requestUrl.match(/\/locations\/([^/]+)\//)?.[1].split(',').map(Number) || [];
  const shared = { variantId: 4, sexId: 3 };
  const rows = requestUrl.includes('/indicators/70/')
    ? locations.flatMap((locationId) => [
      { ...shared, locationId, indicatorId: 70, ageId: 40, timeLabel: currentYear, value: 1_000_000 },
      { ...shared, locationId, indicatorId: 70, ageId: 40, timeLabel: currentYear + 10, value: 900_000 },
    ])
    : locations.flatMap((locationId) => [
      { ...shared, locationId, indicatorId: 67, ageId: 188, timeLabel: currentYear, value: 40 },
      { ...shared, locationId, indicatorId: 84, ageId: 1005, timeLabel: currentYear, value: 20 },
      { ...shared, locationId, indicatorId: 86, ageId: 1015, timeLabel: currentYear, value: 50 },
    ]);
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

  it('preserves the original source of each ILOSTAT dimension without inferring observation quality', () => {
    const occupation = fixture('ilostat-occupation.csv');
    const economic = fixture('ilostat-economic.csv');
    const original = parseIlostatWorkforceCsv(occupation, economic).countries.DE;
    for (const metric of ['craftTradesEmploymentPeople', 'plantMachineOperatorsEmploymentPeople', 'trainedIndustrialWorkforcePeople']) {
      assert.equal(original[metric].source, 'ILOSTAT: LFS - EU Labour Force Survey');
      assert.equal(original[metric].year, 2025);
    }
    assert.equal(original.manufacturingEmploymentSharePercent.source, 'ILOSTAT: ILO - Modelled Estimates');
    const survey = parseIlostatWorkforceCsv(occupation, economic.replaceAll('ILO - Modelled Estimates', 'LFS - EU Labour Force Survey')).countries.DE;
    assert.deepEqual(survey.manufacturingEmploymentSharePercent, {
      ...original.manufacturingEmploymentSharePercent,
      source: 'ILOSTAT: LFS - EU Labour Force Survey',
    });
    const statusChanged = parseIlostatWorkforceCsv(occupation, economic.replaceAll(',A,NB,', ',Z,NB,')).countries.DE;
    assert.deepEqual(statusChanged, original, 'OBS_STATUS is not a supplied quality classification');
    assert.deepEqual(Object.keys(original.manufacturingEmploymentSharePercent).sort(), ['source', 'value', 'year']);
  });

  it('keeps blank or missing ILOSTAT SOURCE generic and preserves measured zero', () => {
    const occupation = fixture('ilostat-occupation.csv').replaceAll('LFS - EU Labour Force Survey', '').replace('2025,4602.43,', '2025,0,');
    const economic = fixture('ilostat-economic.csv').replaceAll('ILO - Modelled Estimates', '').replace('2025,7604.915,', '2025,0,');
    const result = parseIlostatWorkforceCsv(occupation, economic).countries.DE;
    assert.deepEqual(result.craftTradesEmploymentPeople, { value: 0, year: 2025, source: 'ILOSTAT' });
    assert.deepEqual(result.manufacturingEmploymentSharePercent, { value: 0, year: 2025, source: 'ILOSTAT' });
    const withoutSource = (csv) => csv.split('\n').map((line) => line.slice(0, line.lastIndexOf(','))).join('\n');
    assert.deepEqual(parseIlostatWorkforceCsv(withoutSource(occupation), withoutSource(economic)).countries.DE, result);
  });

  it('preserves explicit ILOSTAT status and identifies the inputs of derived values', () => {
    const occupation = fixture('ilostat-occupation.csv').replace('2025,4602.43,,', '2025,4602.43,I,');
    const economic = fixture('ilostat-economic.csv').replace('2025,7604.915,,', '2025,7604.915,E,');
    const result = parseIlostatWorkforceCsv(occupation, economic).countries.DE;
    assert.equal(result.craftTradesEmploymentPeople.sourceStatus, 'ILOSTAT status: Imputation');
    assert.equal(result.plantMachineOperatorsEmploymentPeople.sourceStatus, undefined);
    assert.equal(result.trainedIndustrialWorkforcePeople.sourceStatus, 'ILOSTAT input statuses: Imputation; Not supplied');
    assert.equal(result.manufacturingEmploymentSharePercent.sourceStatus, 'ILOSTAT input statuses: Not supplied; Estimate');
    assert.equal(result.craftTradesEmploymentPeople.source, 'ILOSTAT: LFS - EU Labour Force Survey');
    assert.equal(result.trainedIndustrialWorkforcePeople.value, 6_947_994);
    assert.equal(result.manufacturingEmploymentSharePercent.value, 18.009972);
    const blank = parseIlostatWorkforceCsv(fixture('ilostat-occupation.csv'), fixture('ilostat-economic.csv')).countries.DE;
    assert.equal(blank.craftTradesEmploymentPeople.sourceStatus, undefined);
    assert.equal(blank.manufacturingEmploymentSharePercent.sourceStatus, undefined);
    const unknown = parseIlostatWorkforceCsv(occupation.replace('2025,4602.43,I,', '2025,4602.43,Q,'), economic).countries.DE;
    assert.equal(unknown.craftTradesEmploymentPeople.sourceStatus, 'ILOSTAT status: Code Q');
  });

  it('preserves World Bank forecasts and incomplete status coverage in a STEM cohort', () => {
    const rows = JSON.parse(fixture('world-bank.json'));
    rows['SE.TER.ENRR'][0].obs_status = 'F';
    rows['SE.TER.GRAD.EN.ZS'][0].obs_status = 'F';
    const result = parseWorldBankEducation(rows).countries.DE;
    assert.equal(result.tertiaryEnrollmentGrossPercent.sourceStatus, 'World Bank status: Forecast');
    assert.equal(result.stemGraduatesSharePercent.sourceStatus, 'World Bank input statuses: Forecast; Not supplied');
    assert.equal(result.researchersPerMillion.sourceStatus, undefined);
  });

  it('selects an older common source/year instead of combining mismatched ILOSTAT rows', () => {
    const changeLatestSecondSource = (csv, code) => csv.split('\n').map((line) => (
      line.includes(`,${code},2025,`) ? `${line.slice(0, line.lastIndexOf(','))},Different survey` : line
    )).join('\n');
    const occupation = changeLatestSecondSource(fixture('ilostat-occupation.csv'), 'OCU_ISCO08_8');
    const economic = changeLatestSecondSource(fixture('ilostat-economic.csv'), 'ECO_AGGREGATE_MAN');
    const result = parseIlostatWorkforceCsv(occupation, economic).countries.DE;
    assert.equal(result.trainedIndustrialWorkforcePeople.year, 2024);
    assert.equal(result.trainedIndustrialWorkforcePeople.value, 7_056_336);
    assert.equal(result.trainedIndustrialWorkforcePeople.source, 'ILOSTAT: LFS - EU Labour Force Survey');
    assert.equal(result.manufacturingEmploymentSharePercent.year, 2024);
    assert.equal(result.manufacturingEmploymentSharePercent.source, 'ILOSTAT: ILO - Modelled Estimates');
    const noOlderRows = (csv) => csv.split('\n').filter((line) => !line.includes(',2024,')).join('\n');
    assert.equal(parseIlostatWorkforceCsv(noOlderRows(occupation), noOlderRows(economic)).countries.DE, undefined);
  });

  it('rejects competing complete same-year sources without a row-order preference', () => {
    const addAlternative = (csv) => `${csv.trim()}\n${csv.split('\n').filter((line) => line.includes(',DEU,') && line.includes(',2025,')).map((line) => `${line.slice(0, line.lastIndexOf(','))},Alternative survey`).join('\n')}\n`;
    const occupation = addAlternative(fixture('ilostat-occupation.csv'));
    const economic = addAlternative(fixture('ilostat-economic.csv'));
    const result = parseIlostatWorkforceCsv(occupation, economic).countries.DE;
    assert.equal(result.trainedIndustrialWorkforcePeople.year, 2024);
    assert.equal(result.manufacturingEmploymentSharePercent.year, 2024);
    const reverseRows = (csv) => { const [header, ...rows] = csv.trim().split('\n'); return `${header}\n${rows.reverse().join('\n')}\n`; };
    assert.deepEqual(parseIlostatWorkforceCsv(reverseRows(occupation), reverseRows(economic)).countries.DE, result);
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

  it('recovers after two consecutive HTTP 502 responses from one WPP page', async () => {
    const targetPage = '/indicators/67,84,86/locations/100,104,';
    let targetPageRequests = 0;
    const result = await fetchWppStage({
      currentYear: 2026,
      fetchImpl: async (url) => {
        if (String(url).includes(targetPage)) {
          targetPageRequests += 1;
          if (targetPageRequests <= 2) return new Response('Bad Gateway', { status: 502 });
        }
        return wppResponse(url);
      },
    });

    assert.equal(targetPageRequests, 3);
    const recordCount = Object.keys(result.countries).length;
    assert.ok(recordCount >= 229);
    assert.equal(validateDemographicsStageCoverage(result.countries, 'wpp').medianAgeYears, recordCount);
  });

  it('identifies the exact WPP page when its HTTP failure is exhausted', async () => {
    const failedPage = '/indicators/70/locations/288,292,';
    let failedPageRequests = 0;
    await assert.rejects(
      fetchWppStage({
        currentYear: 2026,
        fetchImpl: async (url) => {
          if (String(url).includes(failedPage)) {
            failedPageRequests += 1;
            return new Response('Bad Gateway', { status: 502 });
          }
          return wppResponse(url);
        },
      }),
      (error) => {
        assert.match(error.message, /HTTP 502/);
        assert.match(error.message, new RegExp(failedPage));
        return true;
      },
    );
    assert.equal(failedPageRequests, 4);
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

  it('preserves stage coverage and only attests fully fresh completion', async () => {
    const writes = [];
    const writeMetadata = async (...args) => {
      writes.push(args);
    };
    const completeResult = await demographicsCapabilityAfterPublish(previous);
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
    await recordDemographicsCapabilityCompletedRun(previous, writeMetadata, 1_755_500_000_222);
    assert.deepEqual(writes, [[
      'demographics',
      'capability-complete',
      1,
      'demographics-capability-v1',
      30 * 24 * 60 * 60,
      1_755_500_000_222,
    ]]);

    const partialWrites = [];
    const partial = structuredClone(previous);
    partial.stages.education.status = 'retained';
    const partialResult = await demographicsCapabilityAfterPublish(partial);
    assert.equal(partialResult.completionState, 'DEGRADED');
    await recordDemographicsCapabilityCompletedRun(partial, async (...args) => {
      partialWrites.push(args);
    }, 1_755_500_000_222);
    assert.equal(partialWrites.length, 0);
  });
});

describe('demographics completion ordering through runSeed', () => {
  for (const scenario of ['complete', 'retained', 'metadata-failure']) {
    it(`keeps the interval gate honest for a ${scenario} publish`, async () => {
      const canonicalKey = DEMOGRAPHICS_CAPABILITY_KEY;
      const freshnessMetaKey = 'seed-meta:demographics:capability';
      const completionMetaKey = 'seed-meta:demographics:capability-complete';
      const originalFetch = globalThis.fetch;
      const originalExit = process.exit;
      const originalNow = Date.now;
      const envNames = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WM_BUNDLE_COMPLETION_META_KEY'];
      const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
      const originalListeners = new Set(process.rawListeners('SIGTERM'));
      const redis = new Map();
      const writes = [];
      let now = Date.parse('2026-10-23T03:01:29.000Z');
      const previousCompletion = JSON.stringify({ fetchedAt: now - 86_400_000, recordCount: 150 });
      redis.set(completionMetaKey, previousCompletion);
      const payload = buildDemographicsPayload(Object.fromEntries(['wpp', 'education', 'ilostat'].map((name) => [name, {
        status: 'fulfilled',
        value: { countries: { DE: { fixtureMetric: { value: 1, year: 2026, source: name } } }, fetchedAt: new Date(now).toISOString(), newestObservationYear: 2026 },
      }])), null);
      payload.countries = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`country-${index}`, structuredClone(payload.countries.DE)]));
      if (scenario === 'retained') payload.stages.wpp.status = 'retained';

      process.env.UPSTASH_REDIS_REST_URL = 'https://demographics-test.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
      delete process.env.WM_BUNDLE_COMPLETION_META_KEY;
      Date.now = () => now;
      process.exit = (code) => { throw Object.assign(new Error(`test exit ${code}`), { exitCode: code }); };
      globalThis.fetch = async (url, options = {}) => {
        const request = new URL(url);
        assert.equal(request.origin, 'https://demographics-test.invalid');
        if (request.pathname.startsWith('/get/')) {
          return Response.json({ result: redis.get(decodeURIComponent(request.pathname.slice(5))) ?? null });
        }
        const [command, key, value] = JSON.parse(options.body);
        if (command === 'SET') {
          if (scenario === 'metadata-failure' && key === freshnessMetaKey) {
            return Response.json({ error: 'fixture metadata failure' }, { status: 403 });
          }
          writes.push(key);
          redis.set(key, value);
          now += 222;
        } else if (command === 'DEL') redis.delete(key);
        return Response.json({ result: command === 'SET' ? 'OK' : 1 });
      };

      try {
        const run = runSeed('demographics', 'capability', canonicalKey, async () => payload, DEMOGRAPHICS_CAPABILITY_SEED_OPTIONS);
        await assert.rejects(run, scenario === 'metadata-failure'
          ? /freshness metadata write failed before completion/
          : (error) => error.exitCode === 0);
        const freshness = await readSectionFreshness({ canonicalKey, freshnessMetaKey, completionMetaKey, requireCanonical: true }, async (key) => {
          const value = redis.get(key);
          return value ? JSON.parse(value) : null;
        });
        if (scenario === 'complete') {
          const meta = JSON.parse(redis.get(freshnessMetaKey));
          const completion = JSON.parse(redis.get(completionMetaKey));
          assert.ok(writes.indexOf(completionMetaKey) > writes.indexOf(freshnessMetaKey));
          assert.ok(completion.fetchedAt >= meta.fetchedAt);
          assert.deepEqual(freshness, { fetchedAt: meta.fetchedAt });
        } else {
          assert.equal(writes.includes(completionMetaKey), false);
          assert.equal(redis.get(completionMetaKey), previousCompletion);
          assert.equal(freshness, null);
          if (scenario === 'retained') {
            assert.equal(JSON.parse(redis.get(freshnessMetaKey)).coverage.status, 'partial');
          }
        }
      } finally {
        globalThis.fetch = originalFetch;
        process.exit = originalExit;
        Date.now = originalNow;
        for (const [name, value] of Object.entries(originalEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        for (const listener of process.rawListeners('SIGTERM')) {
          if (!originalListeners.has(listener)) process.removeListener('SIGTERM', listener);
        }
      }
    });
  }
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
