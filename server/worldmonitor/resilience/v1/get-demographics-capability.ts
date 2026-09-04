import type {
  CapabilityObservation,
  DemographicsAgeStructure,
  DemographicsCapabilityStage,
  DemographicsEducation,
  DemographicsIndustrialWorkforce,
  GetDemographicsCapabilityRequest,
  GetDemographicsCapabilityResponse,
  ResilienceServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { readCachedJson, type CacheReadResult } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

export const DEMOGRAPHICS_CAPABILITY_KEY = 'demographics:capability:v1';

function logReadFailure(key: string, error: unknown): void {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    console.error(`[REDIS-TIMEOUT] readCachedJson key=${key}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[demographics-capability] ${key} read failed: ${message}`);
}

type CacheReader = (key: string, raw?: boolean) => Promise<CacheReadResult>;
type UnknownRecord = Record<string, unknown>;
type MetricRule = {
  unit: string;
  min: number;
  max: number;
};

const EMPTY_OBSERVATION: CapabilityObservation = {
  available: false,
  value: 0,
  year: 0,
  source: '',
  unit: '',
};

const STAGE_NAMES = ['wpp', 'education', 'ilostat'] as const;
const VALID_STAGE_STATUSES = new Set(['fresh', 'retained', 'unavailable']);

const AGE_RULES = {
  medianAgeYears: { unit: 'years', min: 0, max: 100 },
  oldAgeDependencyRatioPercent: { unit: 'percent', min: 0, max: 500 },
  totalDependencyRatioPercent: { unit: 'percent', min: 0, max: 500 },
  workingAgePopulationPeople: { unit: 'people', min: 0, max: 20_000_000_000 },
  workingAgePopulationProjected10yPeople: { unit: 'people', min: 0, max: 20_000_000_000 },
} satisfies Record<string, MetricRule>;

const EDUCATION_RULES = {
  tertiaryEnrollmentGrossPercent: { unit: 'percent', min: 0, max: 500 },
  stemGraduatesSharePercent: { unit: 'percent', min: 0, max: 100 },
  researchersPerMillion: { unit: 'people per million', min: 0, max: 1_000_000 },
} satisfies Record<string, MetricRule>;

const WORKFORCE_RULES = {
  craftTradesEmploymentPeople: { unit: 'people', min: 0, max: 20_000_000_000 },
  plantMachineOperatorsEmploymentPeople: { unit: 'people', min: 0, max: 20_000_000_000 },
  trainedIndustrialWorkforcePeople: { unit: 'people', min: 0, max: 20_000_000_000 },
  manufacturingEmploymentSharePercent: { unit: 'percent', min: 0, max: 100 },
} satisfies Record<string, MetricRule>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unavailableObservation(): CapabilityObservation {
  return { ...EMPTY_OBSERVATION };
}

function observation(raw: unknown, rule: MetricRule): CapabilityObservation {
  if (!isRecord(raw)) return unavailableObservation();
  const value = raw.value;
  const year = raw.year;
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const unit = typeof raw.unit === 'string' ? raw.unit.trim() : rule.unit;
  const maxYear = new Date().getUTCFullYear() + 50;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < rule.min
    || value > rule.max
    || typeof year !== 'number'
    || !Number.isInteger(year)
    || year < 1900
    || year > maxYear
    || !source
    || unit !== rule.unit
  ) {
    return unavailableObservation();
  }
  return { available: true, value, year, source, unit };
}

function hasObservation(observations: CapabilityObservation[]): boolean {
  return observations.some((entry) => entry.available);
}

function ageStructure(raw: unknown): DemographicsAgeStructure {
  const source = isRecord(raw) ? raw : {};
  const medianAgeYears = observation(source.medianAgeYears, AGE_RULES.medianAgeYears);
  const oldAgeDependencyRatioPercent = observation(source.oldAgeDependencyRatioPercent, AGE_RULES.oldAgeDependencyRatioPercent);
  const totalDependencyRatioPercent = observation(source.totalDependencyRatioPercent, AGE_RULES.totalDependencyRatioPercent);
  const workingAgePopulationPeople = observation(source.workingAgePopulationPeople, AGE_RULES.workingAgePopulationPeople);
  const workingAgePopulationProjected10yPeople = observation(
    source.workingAgePopulationProjected10yPeople,
    AGE_RULES.workingAgePopulationProjected10yPeople,
  );
  return {
    available: hasObservation([
      medianAgeYears,
      oldAgeDependencyRatioPercent,
      totalDependencyRatioPercent,
      workingAgePopulationPeople,
      workingAgePopulationProjected10yPeople,
    ]),
    medianAgeYears,
    oldAgeDependencyRatioPercent,
    totalDependencyRatioPercent,
    workingAgePopulationPeople,
    workingAgePopulationProjected10yPeople,
  };
}

function education(raw: unknown): DemographicsEducation {
  const source = isRecord(raw) ? raw : {};
  const tertiaryEnrollmentGrossPercent = observation(
    source.tertiaryEnrollmentGrossPercent,
    EDUCATION_RULES.tertiaryEnrollmentGrossPercent,
  );
  const stemGraduatesSharePercent = observation(
    source.stemGraduatesSharePercent,
    EDUCATION_RULES.stemGraduatesSharePercent,
  );
  const researchersPerMillion = observation(source.researchersPerMillion, EDUCATION_RULES.researchersPerMillion);
  return {
    available: hasObservation([
      tertiaryEnrollmentGrossPercent,
      stemGraduatesSharePercent,
      researchersPerMillion,
    ]),
    tertiaryEnrollmentGrossPercent,
    stemGraduatesSharePercent,
    researchersPerMillion,
  };
}

function industrialWorkforce(raw: unknown): DemographicsIndustrialWorkforce {
  const source = isRecord(raw) ? raw : {};
  const craft = observation(source.craftTradesEmploymentPeople, WORKFORCE_RULES.craftTradesEmploymentPeople);
  const operators = observation(
    source.plantMachineOperatorsEmploymentPeople,
    WORKFORCE_RULES.plantMachineOperatorsEmploymentPeople,
  );
  let trained = observation(
    source.trainedIndustrialWorkforcePeople,
    WORKFORCE_RULES.trainedIndustrialWorkforcePeople,
  );

  // The combined value has meaning only when the two underlying ISCO groups
  // describe the same observation year and agree with the stored sum.
  const sameCohort = craft.available
    && operators.available
    && trained.available
    && craft.year === operators.year
    && trained.year === craft.year
    && craft.source === operators.source
    && trained.source === craft.source;
  const expectedSum = craft.value + operators.value;
  const sumTolerance = Math.max(1, Math.abs(expectedSum) * 1e-9);
  if (!sameCohort || Math.abs(trained.value - expectedSum) > sumTolerance) {
    trained = unavailableObservation();
  }
  const manufacturingEmploymentSharePercent = observation(
    source.manufacturingEmploymentSharePercent,
    WORKFORCE_RULES.manufacturingEmploymentSharePercent,
  );

  const group: DemographicsIndustrialWorkforce = {
    available: hasObservation([craft, operators, trained, manufacturingEmploymentSharePercent]),
    craftTradesEmploymentPeople: craft,
    plantMachineOperatorsEmploymentPeople: operators,
    trainedIndustrialWorkforcePeople: trained,
    manufacturingEmploymentSharePercent,
  };
  return group;
}

function stageStatus(rawStages: unknown): DemographicsCapabilityStage[] {
  const stages = isRecord(rawStages) ? rawStages : {};
  return STAGE_NAMES.map((name) => {
    const raw = isRecord(stages[name]) ? stages[name] as UnknownRecord : {};
    const status = typeof raw.status === 'string' && VALID_STAGE_STATUSES.has(raw.status)
      ? raw.status
      : 'unavailable';
    const recordCount = typeof raw.recordCount === 'number' && Number.isInteger(raw.recordCount) && raw.recordCount >= 0
      ? raw.recordCount
      : 0;
    const newestObservationYear = typeof raw.newestObservationYear === 'number'
      && Number.isInteger(raw.newestObservationYear)
      && raw.newestObservationYear >= 1900
      && raw.newestObservationYear <= new Date().getUTCFullYear() + 50
      ? raw.newestObservationYear
      : 0;
    return {
      name,
      status,
      fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
      recordCount,
      newestObservationYear,
    };
  });
}

function emptyResponse(countryCode: string): GetDemographicsCapabilityResponse {
  return {
    countryCode,
    available: false,
    fetchedAt: '',
    stages: stageStatus(null),
    ageStructure: ageStructure(null),
    education: education(null),
    industrialWorkforce: industrialWorkforce(null),
  };
}

export function normalizeDemographicsCountryCode(raw: string): string | null {
  const normalized = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function toDemographicsCapabilityResponse(
  snapshot: unknown,
  countryCode: string,
): GetDemographicsCapabilityResponse {
  if (!isRecord(snapshot)) return emptyResponse(countryCode);
  const countries = isRecord(snapshot.countries) ? snapshot.countries : {};
  const country = isRecord(countries[countryCode]) ? countries[countryCode] as UnknownRecord : null;
  const age = ageStructure(country?.ageStructure);
  const learning = education(country?.education);
  const workforce = industrialWorkforce(country?.industrialWorkforce);
  const fetchedAt = typeof snapshot.generatedAt === 'string'
    ? snapshot.generatedAt
    : typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '';

  return {
    countryCode,
    available: age.available || learning.available || workforce.available,
    fetchedAt,
    stages: stageStatus(snapshot.stages),
    ageStructure: age,
    education: learning,
    industrialWorkforce: workforce,
  };
}

export function createGetDemographicsCapability(
  cacheReader: CacheReader = readCachedJson,
): ResilienceServiceHandler['getDemographicsCapability'] {
  return async (
    ctx: ServerContext,
    req: GetDemographicsCapabilityRequest,
  ): Promise<GetDemographicsCapabilityResponse> => {
    const countryCode = normalizeDemographicsCountryCode(req.countryCode ?? '');
    if (!countryCode) {
      throw new ValidationError([{
        field: 'countryCode',
        description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code',
      }]);
    }

    const read = await cacheReader(DEMOGRAPHICS_CAPABILITY_KEY, true);
    if (read.status === 'error') {
      logReadFailure(DEMOGRAPHICS_CAPABILITY_KEY, read.error);
      return markNoStoreFallbackResponse(ctx.request, emptyResponse(countryCode));
    }
    if (read.status !== 'hit') {
      return markNoStoreFallbackResponse(ctx.request, emptyResponse(countryCode));
    }
    return toDemographicsCapabilityResponse(read.value, countryCode);
  };
}

export const getDemographicsCapability = createGetDemographicsCapability();
