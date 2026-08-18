import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createGetDemographicsCapability,
  normalizeDemographicsCountryCode,
  toDemographicsCapabilityResponse,
} from '../server/worldmonitor/resilience/v1/get-demographics-capability.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const SNAPSHOT = {
  version: 1,
  fetchedAt: '2026-08-18T00:00:00.000Z',
  stages: {
    wpp: { status: 'fresh', fetchedAt: '2026-08-18T00:00:00.000Z', source: 'UN WPP 2024' },
    education: { status: 'retained', fetchedAt: '2026-08-17T00:00:00.000Z', source: 'World Bank WDI / UNESCO UIS' },
    ilostat: { status: 'unavailable', fetchedAt: '', source: 'ILOSTAT' },
  },
  countries: {
    DE: {
      ageStructure: {
        medianAgeYears: { value: 45.69, year: 2026, source: 'UN WPP 2024', unit: 'years' },
        oldAgeDependencyRatioPercent: { value: 39.16, year: 2026, source: 'UN WPP 2024', unit: 'percent' },
        totalDependencyRatioPercent: { value: 61.55, year: 2026, source: 'UN WPP 2024', unit: 'percent' },
        workingAgePopulationPeople: { value: 51_775_142, year: 2026, source: 'UN WPP 2024', unit: 'people' },
        workingAgePopulationProjected10yPeople: { value: 47_232_903, year: 2036, source: 'UN WPP 2024', unit: 'people' },
      },
      education: {
        tertiaryEnrollmentGrossPercent: { value: 77.2, year: 2024, source: 'World Bank WDI', unit: 'percent' },
        stemGraduatesSharePercent: { value: null, year: 2023, source: 'UNESCO UIS', unit: 'percent' },
        researchersPerMillion: { value: -1, year: 2022, source: 'World Bank WDI', unit: 'people per million' },
      },
      industrialWorkforce: {
        craftTradesEmploymentPeople: { value: 4_602_430, year: 2025, source: 'ILOSTAT', unit: 'people' },
        plantMachineOperatorsEmploymentPeople: { value: 2_345_564, year: 2025, source: 'ILOSTAT', unit: 'people' },
        trainedIndustrialWorkforcePeople: { value: 6_947_994, year: 2024, source: 'ILOSTAT', unit: 'people' },
        manufacturingEmploymentSharePercent: { value: 18.01, year: 2025, source: 'ILOSTAT', unit: 'percent' },
      },
    },
  },
};

describe('GetDemographicsCapability transformation', () => {
  test('normalizes ISO-2 and rejects invalid or missing country codes', () => {
    assert.equal(normalizeDemographicsCountryCode(' de '), 'DE');
    assert.equal(normalizeDemographicsCountryCode(''), null);
    assert.equal(normalizeDemographicsCountryCode('DEU'), null);
    assert.equal(normalizeDemographicsCountryCode('12'), null);
  });

  test('keeps independent years/sources/units and does not promote invalid numeric values', () => {
    const response = toDemographicsCapabilityResponse(SNAPSHOT, 'DE');
    assert.equal(response.available, true);
    assert.deepEqual(response.ageStructure.medianAgeYears, {
      available: true, value: 45.69, year: 2026, source: 'UN WPP 2024', unit: 'years',
    });
    assert.equal(response.ageStructure.workingAgePopulationProjected10yPeople.year, 2036);
    assert.equal(response.education.tertiaryEnrollmentGrossPercent.year, 2024);
    assert.equal(response.education.stemGraduatesSharePercent.available, false);
    assert.equal(response.education.researchersPerMillion.available, false);
    assert.equal(response.industrialWorkforce.trainedIndustrialWorkforcePeople.available, false,
      'the combined workforce is invalid unless its canonical year matches both components');
    assert.equal(response.industrialWorkforce.manufacturingEmploymentSharePercent.available, true);
  });

  test('preserves partial groups and stage status metadata', () => {
    const response = toDemographicsCapabilityResponse(SNAPSHOT, 'DE');
    assert.deepEqual(response.stages.map((stage) => stage.status), ['fresh', 'retained', 'unavailable']);
    assert.equal(response.ageStructure.available, true);
    assert.equal(response.education.available, true);
    assert.equal(response.industrialWorkforce.available, true);
  });

  test('returns unavailable for a country miss without inventing observations', () => {
    const response = toDemographicsCapabilityResponse(SNAPSHOT, 'ZZ');
    assert.equal(response.available, false);
    assert.equal(response.countryCode, 'ZZ');
    assert.equal(response.ageStructure.medianAgeYears.available, false);
  });
});

describe('GetDemographicsCapability handler read behavior', () => {
  test('returns no-store unavailable response on a Redis miss', async () => {
    const handler = createGetDemographicsCapability(async () => ({ status: 'miss' }));
    const request = new Request('https://example.test/api/resilience/v1/get-demographics-capability?countryCode=DE');
    const result = await handler({ request } as never, { countryCode: 'DE' });
    assert.equal(result.available, false);
    assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
  });

  test('returns no-store unavailable response on a Redis read error', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const handler = createGetDemographicsCapability(async () => ({ status: 'error', error: new Error('redis down') }));
      const request = new Request('https://example.test/api/resilience/v1/get-demographics-capability?countryCode=DE');
      const result = await handler({ request } as never, { countryCode: 'DE' });
      assert.equal(result.available, false);
      assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /\[demographics-capability\] demographics:capability:v1 read failed: redis down/);
    } finally {
      warn.mock.restore();
    }
  });

  test('reads the canonical unprefixed key', async () => {
    let actualKey = '';
    let actualRaw = false;
    const handler = createGetDemographicsCapability(async (key, raw) => {
      actualKey = key;
      actualRaw = raw;
      return { status: 'hit', value: SNAPSHOT };
    });
    const result = await handler(
      { request: new Request('https://example.test/api/resilience/v1/get-demographics-capability?countryCode=de') } as never,
      { countryCode: 'de' },
    );
    assert.equal(actualKey, 'demographics:capability:v1');
    assert.equal(actualRaw, true);
    assert.equal(result.countryCode, 'DE');
  });

  test('rejects an invalid request before any Redis read', async () => {
    let reads = 0;
    const handler = createGetDemographicsCapability(async () => {
      reads += 1;
      return { status: 'miss' };
    });
    await assert.rejects(
      handler(
        { request: new Request('https://example.test/api/resilience/v1/get-demographics-capability') } as never,
        { countryCode: 'DEU' },
      ),
      (error) => error instanceof Error && error.name === 'ValidationError',
    );
    assert.equal(reads, 0);
  });
});

describe('demographics capability access and cache registration', () => {
  test('the RPC is premium and slow-cache tiered', async () => {
    const { PREMIUM_RPC_PATHS } = await import('../src/shared/premium-paths.ts');
    assert.ok(PREMIUM_RPC_PATHS.has('/api/resilience/v1/get-demographics-capability'));
    assert.match(read('server/_shared/entitlement-check.ts'), /'\/api\/resilience\/v1\/get-demographics-capability': 1/);
    assert.match(read('server/gateway.ts'), /'\/api\/resilience\/v1\/get-demographics-capability': 'slow'/);
  });

  test('the generated gateway denies an anonymous caller before the handler', async () => {
    const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
    delete process.env.WORLDMONITOR_VALID_KEYS;
    try {
      const [gatewayModule, generated, handlerModule] = await Promise.all([
        import('../server/gateway.ts'),
        import('../src/generated/server/worldmonitor/resilience/v1/service_server.ts'),
        import('../server/worldmonitor/resilience/v1/handler.ts'),
      ]);
      const gateway = gatewayModule.createDomainGateway(
        generated.createResilienceServiceRoutes(handlerModule.resilienceHandler, gatewayModule.serverOptions),
      );
      const response = await gateway(new Request(
        'https://www.worldmonitor.app/api/resilience/v1/get-demographics-capability?countryCode=DE',
        { headers: { Origin: 'https://worldmonitor.app' } },
      ));
      assert.equal(response.status, 401);
    } finally {
      if (originalKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
    }
  });

  test('generated OpenAPI publishes the required country query and response contract', () => {
    const openapi = JSON.parse(read('docs/api/ResilienceService.openapi.json'));
    const operation = openapi.paths?.['/api/resilience/v1/get-demographics-capability']?.get;
    assert.ok(operation);
    const country = operation.parameters.find((parameter: { name?: string }) => parameter.name === 'countryCode');
    assert.equal(country.required, true);
    assert.ok(openapi.components?.schemas?.GetDemographicsCapabilityResponse);
    assert.ok(openapi.components?.schemas?.CapabilityObservation);
  });
});
