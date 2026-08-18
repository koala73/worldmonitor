import Papa from 'papaparse';

import { CHROME_UA, sleep } from './_seed-utils.mjs';
import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };
import unToIso2 from './shared/un-to-iso2.json' with { type: 'json' };

export const DEMOGRAPHICS_CAPABILITY_KEY = 'demographics:capability:v1';
export const DEMOGRAPHICS_CAPABILITY_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEMOGRAPHICS_CAPABILITY_MAX_STALE_MIN = 25 * 24 * 60;
export const DEMOGRAPHICS_CAPABILITY_MAX_CONTENT_AGE_MIN = 5 * 365 * 24 * 60;
export const DEMOGRAPHICS_CAPABILITY_SOURCE_VERSION = 'demographics-capability-v1';

export const EDUCATION_INDICATORS = Object.freeze({
  tertiaryEnrollmentGrossPercent: 'SE.TER.ENRR',
  researchersPerMillion: 'SP.POP.SCIE.RD.P6',
  engineeringGraduatesShare: 'SE.TER.GRAD.EN.ZS',
  scienceGraduatesShare: 'SE.TER.GRAD.SC.ZS',
  ictGraduatesShare: 'UIS.FOSGP.5T8.F600',
});

export const DEMOGRAPHICS_STAGE_METRIC_FLOORS = Object.freeze({
  wpp: Object.freeze({
    medianAgeYears: 150,
    oldAgeDependencyRatioPercent: 150,
    totalDependencyRatioPercent: 150,
    workingAgePopulationPeople: 150,
    workingAgePopulationProjected10yPeople: 150,
  }),
  education: Object.freeze({
    tertiaryEnrollmentGrossPercent: 150,
    // Researcher and field-of-study series have a smaller official reporting
    // cohort than gross enrollment. These floors still reject empty or sharply
    // truncated HTTP-200 responses without excluding the normal corpus.
    researchersPerMillion: 100,
    stemGraduatesSharePercent: 100,
  }),
  ilostat: Object.freeze({
    craftTradesEmploymentPeople: 150,
    plantMachineOperatorsEmploymentPeople: 150,
    trainedIndustrialWorkforcePeople: 150,
    manufacturingEmploymentSharePercent: 150,
  }),
});

const STAGE_DEFINITIONS = Object.freeze({
  wpp: { section: 'ageStructure' },
  education: { section: 'education' },
  ilostat: { section: 'industrialWorkforce' },
});
const WPP_SOURCE = 'UN World Population Prospects 2024';
const EDUCATION_SOURCE = 'UNESCO UIS via World Bank WDI';
const ILOSTAT_SOURCE = 'ILOSTAT';
const WPP_BASE = 'https://population.un.org/dataportalapi/uiapi/v1/data';
const WORLD_BANK_BASE = 'https://api.worldbank.org/v2';
const ILOSTAT_BASE = 'https://sdmx.ilo.org/rest';

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerYear(value) {
  const numeric = finiteNumber(value);
  return Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200 ? numeric : null;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function observation(value, year, source, { min = 0, max = Infinity } = {}) {
  const numeric = finiteNumber(value);
  const observationYear = integerYear(year);
  if (numeric == null || observationYear == null || numeric < min || numeric > max) return null;
  return { value: round(numeric), year: observationYear, source };
}

function upsertCountry(countries, iso2, metric, value) {
  if (!iso2 || !value) return;
  countries[iso2] ||= {};
  countries[iso2][metric] = value;
}

export function validateDemographicsStageCoverage(countries, stageName) {
  const floors = DEMOGRAPHICS_STAGE_METRIC_FLOORS[stageName];
  if (!floors) throw new Error(`Unknown demographics stage: ${stageName}`);
  const rows = Object.values(countries || {});
  const counts = {};
  for (const [metric, minimum] of Object.entries(floors)) {
    const count = rows.filter((country) => country?.[metric]).length;
    counts[metric] = count;
    if (count < minimum) {
      throw new Error(`${stageName} ${metric} coverage too small: ${count} < ${minimum}`);
    }
  }
  return counts;
}

function mappedM49(value) {
  const numeric = finiteNumber(value);
  if (numeric == null) return null;
  return unToIso2[String(Math.trunc(numeric)).padStart(3, '0')] || null;
}

/** Parse the two official UN WPP UI API result arrays for one reference year. */
export function parseWppCapability(demographicsRows, workingAgeRows, { currentYear = new Date().getUTCFullYear() } = {}) {
  const countries = {};
  const expected = new Map([
    [67, { metric: 'medianAgeYears', ageId: 188, max: 150 }],
    [84, { metric: 'oldAgeDependencyRatioPercent', ageId: 1005, max: 500 }],
    [86, { metric: 'totalDependencyRatioPercent', ageId: 1015, max: 500 }],
  ]);

  for (const row of Array.isArray(demographicsRows) ? demographicsRows : []) {
    const indicatorId = finiteNumber(row?.indicatorId);
    const spec = expected.get(indicatorId);
    if (
      !spec
      || finiteNumber(row?.variantId) !== 4
      || finiteNumber(row?.sexId) !== 3
      || finiteNumber(row?.ageId) !== spec.ageId
      || integerYear(row?.timeLabel) !== currentYear
    ) continue;
    upsertCountry(
      countries,
      mappedM49(row.locationId),
      spec.metric,
      observation(row.value, currentYear, WPP_SOURCE, { max: spec.max }),
    );
  }

  for (const row of Array.isArray(workingAgeRows) ? workingAgeRows : []) {
    const year = integerYear(row?.timeLabel);
    if (
      finiteNumber(row?.indicatorId) !== 70
      || finiteNumber(row?.variantId) !== 4
      || finiteNumber(row?.sexId) !== 3
      || finiteNumber(row?.ageId) !== 40
      || (year !== currentYear && year !== currentYear + 10)
    ) continue;
    const metric = year === currentYear
      ? 'workingAgePopulationPeople'
      : 'workingAgePopulationProjected10yPeople';
    upsertCountry(countries, mappedM49(row.locationId), metric, observation(row.value, year, WPP_SOURCE));
  }

  // The +10 projection is an observation carried by the current WPP release;
  // it must not make a frozen current-year release appear fresh for ten years.
  return { countries, newestObservationYear: currentYear };
}

function latestWorldBankObservation(rows, { max = Infinity } = {}) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const iso2 = iso3ToIso2[String(row?.countryiso3code || '').toUpperCase()];
    const obs = observation(row?.value, row?.date, EDUCATION_SOURCE, { max });
    if (!iso2 || !obs) continue;
    if (!latest.has(iso2) || obs.year > latest.get(iso2).year) latest.set(iso2, obs);
  }
  return latest;
}

function worldBankByCountryYear(rows) {
  const values = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const iso2 = iso3ToIso2[String(row?.countryiso3code || '').toUpperCase()];
    const obs = observation(row?.value, row?.date, EDUCATION_SOURCE, { max: 100 });
    if (iso2 && obs) values.set(`${iso2}:${obs.year}`, obs.value);
  }
  return values;
}

/** Parse World Bank WDI JSON rows, including the UIS STEM same-year join. */
export function parseWorldBankEducation(rowsByIndicator) {
  const countries = {};
  // Gross enrollment can exceed 100 when older/younger students attend the
  // level, unlike the three STEM composition shares below.
  const tertiary = latestWorldBankObservation(rowsByIndicator?.[EDUCATION_INDICATORS.tertiaryEnrollmentGrossPercent], { max: 500 });
  const researchers = latestWorldBankObservation(rowsByIndicator?.[EDUCATION_INDICATORS.researchersPerMillion]);
  for (const [iso2, obs] of tertiary) upsertCountry(countries, iso2, 'tertiaryEnrollmentGrossPercent', obs);
  for (const [iso2, obs] of researchers) upsertCountry(countries, iso2, 'researchersPerMillion', obs);

  const engineering = worldBankByCountryYear(rowsByIndicator?.[EDUCATION_INDICATORS.engineeringGraduatesShare]);
  const science = worldBankByCountryYear(rowsByIndicator?.[EDUCATION_INDICATORS.scienceGraduatesShare]);
  const ict = worldBankByCountryYear(rowsByIndicator?.[EDUCATION_INDICATORS.ictGraduatesShare]);
  const complete = new Map();
  for (const [countryYear, engineeringValue] of engineering) {
    if (!science.has(countryYear) || !ict.has(countryYear)) continue;
    const [iso2, rawYear] = countryYear.split(':');
    const year = Number(rawYear);
    const value = engineeringValue + science.get(countryYear) + ict.get(countryYear);
    if (value > 100) continue;
    const previous = complete.get(iso2);
    if (!previous || year > previous.year) complete.set(iso2, { value: round(value), year, source: EDUCATION_SOURCE });
  }
  for (const [iso2, obs] of complete) upsertCountry(countries, iso2, 'stemGraduatesSharePercent', obs);

  const years = Object.values(countries).flatMap((country) => Object.values(country).map((obs) => obs.year));
  return { countries, newestObservationYear: years.length ? Math.max(...years) : null };
}

function parseCsv(text, label) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) throw new Error(`${label} CSV parse failed: ${parsed.errors[0].message}`);
  return parsed.data;
}

function collectIlostatSeries(rows, dimension, acceptedCodes) {
  const byCountry = new Map();
  for (const row of rows) {
    const iso2 = iso3ToIso2[String(row?.REF_AREA || '').toUpperCase()];
    const code = row?.[dimension];
    const year = integerYear(row?.TIME_PERIOD);
    const value = finiteNumber(row?.OBS_VALUE);
    const multiplier = finiteNumber(row?.UNIT_MULT);
    if (
      !iso2
      || !acceptedCodes.has(code)
      || year == null
      || value == null
      || value < 0
      || !Number.isInteger(multiplier)
      || multiplier < -9
      || multiplier > 9
      || (row?.SEX && row.SEX !== 'SEX_T')
      || (row?.UNIT_MEASURE && row.UNIT_MEASURE !== 'PS')
    ) continue;
    const key = `${iso2}:${year}`;
    byCountry.set(key, { ...(byCountry.get(key) || {}), [code]: value * (10 ** multiplier) });
  }
  return byCountry;
}

/** Parse official ILOSTAT SDMX CSV for occupations and modelled economic activity. */
export function parseIlostatWorkforceCsv(occupationCsv, economicCsv) {
  const occupationCodes = new Set(['OCU_ISCO08_7', 'OCU_ISCO08_8']);
  const economicCodes = new Set(['ECO_AGGREGATE_TOTAL', 'ECO_AGGREGATE_MAN']);
  const occupations = collectIlostatSeries(parseCsv(occupationCsv, 'ILOSTAT occupation'), 'OCU', occupationCodes);
  const economy = collectIlostatSeries(parseCsv(economicCsv, 'ILOSTAT economic activity'), 'ECO', economicCodes);
  const countries = {};
  const occupationByCountry = new Map();
  const economyByCountry = new Map();
  for (const [countryYear, values] of occupations) {
    const [iso2, rawYear] = countryYear.split(':');
    if (values.OCU_ISCO08_7 == null || values.OCU_ISCO08_8 == null) continue;
    const year = Number(rawYear);
    if (!occupationByCountry.has(iso2) || year > occupationByCountry.get(iso2).year) {
      occupationByCountry.set(iso2, { year, ...values });
    }
  }
  for (const [countryYear, values] of economy) {
    const [iso2, rawYear] = countryYear.split(':');
    const total = values.ECO_AGGREGATE_TOTAL;
    const manufacturing = values.ECO_AGGREGATE_MAN;
    if (total == null || manufacturing == null || total <= 0 || manufacturing > total) continue;
    const year = Number(rawYear);
    if (!economyByCountry.has(iso2) || year > economyByCountry.get(iso2).year) {
      economyByCountry.set(iso2, { year, total, manufacturing });
    }
  }

  for (const [iso2, values] of occupationByCountry) {
    upsertCountry(countries, iso2, 'craftTradesEmploymentPeople', observation(values.OCU_ISCO08_7, values.year, ILOSTAT_SOURCE));
    upsertCountry(countries, iso2, 'plantMachineOperatorsEmploymentPeople', observation(values.OCU_ISCO08_8, values.year, ILOSTAT_SOURCE));
    upsertCountry(countries, iso2, 'trainedIndustrialWorkforcePeople', observation(
      values.OCU_ISCO08_7 + values.OCU_ISCO08_8,
      values.year,
      ILOSTAT_SOURCE,
    ));
  }
  for (const [iso2, values] of economyByCountry) {
    upsertCountry(countries, iso2, 'manufacturingEmploymentSharePercent', observation(
      (values.manufacturing / values.total) * 100,
      values.year,
      ILOSTAT_SOURCE,
      { max: 100 },
    ));
  }

  const years = Object.values(countries).flatMap((country) => Object.values(country).map((obs) => obs.year));
  return { countries, newestObservationYear: years.length ? Math.max(...years) : null };
}

async function fetchResponse(fetchImpl, url, {
  accept,
  acceptLanguage,
  signal,
  timeoutMs = 25_000,
  attempts = 2,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        headers: {
          Accept: accept,
          ...(acceptLanguage ? { 'Accept-Language': acceptLanguage } : {}),
          'User-Agent': CHROME_UA,
        },
        signal: requestSignal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason || error;
      if (attempt < attempts) await sleep(250 * attempt);
    }
  }
  throw lastError;
}

export async function fetchWppStage({
  fetchImpl = globalThis.fetch,
  currentYear = new Date().getUTCFullYear(),
  signal,
} = {}) {
  const locationIds = Object.keys(unToIso2).map(Number).filter(Number.isFinite);
  const demographicsRows = [];
  const workingAgeRows = [];
  for (let offset = 0; offset < locationIds.length; offset += 50) {
    const locations = locationIds.slice(offset, offset + 50).join(',');
    const [demographics, workingAge] = await Promise.all([
      fetchResponse(fetchImpl, `${WPP_BASE}/indicators/67,84,86/locations/${locations}/years/${currentYear}/vars/4/ages/188,1005,1015/sexes/3/cats/0`, { accept: 'application/json', signal }).then((response) => response.json()),
      fetchResponse(fetchImpl, `${WPP_BASE}/indicators/70/locations/${locations}/years/${currentYear},${currentYear + 10}/vars/4/ages/40/sexes/3/cats/0`, { accept: 'application/json', signal }).then((response) => response.json()),
    ]);
    demographicsRows.push(...(Array.isArray(demographics) ? demographics : []));
    workingAgeRows.push(...(Array.isArray(workingAge) ? workingAge : []));
  }
  const parsed = parseWppCapability(demographicsRows, workingAgeRows, { currentYear });
  if (Object.keys(parsed.countries).length < 150) throw new Error(`WPP coverage too small: ${Object.keys(parsed.countries).length}`);
  validateDemographicsStageCoverage(parsed.countries, 'wpp');
  return { ...parsed, fetchedAt: new Date().toISOString() };
}

async function fetchWorldBankIndicator(indicator, { fetchImpl, currentYear, signal }) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({
      format: 'json',
      per_page: '10000',
      page: String(page),
      date: `2000:${currentYear}`,
    });
    const response = await fetchResponse(
      fetchImpl,
      `${WORLD_BANK_BASE}/country/all/indicator/${encodeURIComponent(indicator)}?${params}`,
      { accept: 'application/json', signal },
    );
    const payload = await response.json();
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) throw new Error(`World Bank ${indicator} response shape invalid`);
    rows.push(...payload[1]);
    totalPages = Math.min(Number(payload[0]?.pages || 1), 100);
    page += 1;
  } while (page <= totalPages);
  return rows;
}

export async function fetchEducationStage({
  fetchImpl = globalThis.fetch,
  currentYear = new Date().getUTCFullYear(),
  signal,
} = {}) {
  const entries = await Promise.all(Object.values(EDUCATION_INDICATORS).map(async (indicator) => (
    [indicator, await fetchWorldBankIndicator(indicator, { fetchImpl, currentYear, signal })]
  )));
  const parsed = parseWorldBankEducation(Object.fromEntries(entries));
  if (Object.keys(parsed.countries).length < 120) throw new Error(`education coverage too small: ${Object.keys(parsed.countries).length}`);
  validateDemographicsStageCoverage(parsed.countries, 'education');
  return { ...parsed, fetchedAt: new Date().toISOString() };
}

export async function fetchIlostatStage({ fetchImpl = globalThis.fetch, signal } = {}) {
  const occupationUrl = `${ILOSTAT_BASE}/data/ILO,DF_EMP_TEMP_SEX_OCU_NB/.A..SEX_T.OCU_ISCO08_7+OCU_ISCO08_8?startPeriod=2015&format=csv`;
  const economicUrl = `${ILOSTAT_BASE}/data/ILO,DF_EMP_2EMP_SEX_ECO_NB/.A..SEX_T.ECO_AGGREGATE_TOTAL+ECO_AGGREGATE_MAN?startPeriod=2015&format=csv`;
  const headers = { accept: 'text/csv', acceptLanguage: 'en' };
  const [occupationCsv, economicCsv] = await Promise.all([
    fetchResponse(fetchImpl, occupationUrl, { ...headers, signal }).then((response) => response.text()),
    fetchResponse(fetchImpl, economicUrl, { ...headers, signal }).then((response) => response.text()),
  ]);
  const parsed = parseIlostatWorkforceCsv(occupationCsv, economicCsv);
  if (Object.keys(parsed.countries).length < 150) throw new Error(`ILOSTAT coverage too small: ${Object.keys(parsed.countries).length}`);
  validateDemographicsStageCoverage(parsed.countries, 'ilostat');
  return { ...parsed, fetchedAt: new Date().toISOString() };
}

function previousStageCountries(previous, section) {
  const countries = {};
  for (const [iso2, country] of Object.entries(previous?.countries || {})) {
    const value = country?.[section];
    if (value && typeof value === 'object' && Object.keys(value).length > 0) countries[iso2] = value;
  }
  return countries;
}

/** Merge independently settled stages. A failed stage can only retain its own prior section. */
export function buildDemographicsPayload(settledResults, previous, { generatedAt = new Date().toISOString() } = {}) {
  const stageDefinitions = Object.entries(STAGE_DEFINITIONS);
  if (!settledResults || typeof settledResults !== 'object'
    || stageDefinitions.some(([name]) => !settledResults[name])) {
    throw new Error('demographics stage result count is invalid');
  }
  const stages = {};
  const stageCountries = {};
  let freshStages = 0;
  let safeStages = 0;

  stageDefinitions.forEach(([name, { section }]) => {
    const settled = settledResults[name];
    const freshCountries = settled?.status === 'fulfilled' ? settled.value?.countries : null;
    if (freshCountries && Object.keys(freshCountries).length > 0) {
      freshStages += 1;
      safeStages += 1;
      stageCountries[section] = freshCountries;
      stages[name] = {
        status: 'fresh',
        fetchedAt: settled.value.fetchedAt || generatedAt,
        recordCount: Object.keys(freshCountries).length,
        newestObservationYear: integerYear(settled.value.newestObservationYear),
      };
      return;
    }

    const retained = previousStageCountries(previous, section);
    const priorMeta = previous?.stages?.[name];
    if (Object.keys(retained).length > 0 && priorMeta?.fetchedAt) {
      safeStages += 1;
      stageCountries[section] = retained;
      stages[name] = {
        status: 'retained',
        fetchedAt: priorMeta.fetchedAt,
        recordCount: Object.keys(retained).length,
        newestObservationYear: integerYear(priorMeta.newestObservationYear),
      };
      return;
    }
    stageCountries[section] = {};
    stages[name] = { status: 'unavailable', fetchedAt: null, recordCount: 0, newestObservationYear: null };
  });

  if (safeStages === 0) throw new Error('All demographics stages failed and no safe previous data exists');
  if (freshStages === 0) throw new Error('All demographics stages failed; preserving the existing canonical snapshot');

  const countries = {};
  for (const { section } of Object.values(STAGE_DEFINITIONS)) {
    for (const [iso2, value] of Object.entries(stageCountries[section])) {
      countries[iso2] ||= {};
      countries[iso2][section] = value;
    }
  }
  return { version: 1, generatedAt, stages, countries };
}

export function declareDemographicsRecords(payload) {
  return Object.keys(payload?.countries || {}).length;
}

export function validateDemographicsPayload(payload) {
  return payload?.version === 1
    && payload?.stages
    && Object.keys(payload?.countries || {}).length >= 150
    && Object.values(payload.stages).some((stage) => stage?.status === 'fresh');
}

export function demographicsContentMeta(payload) {
  const stageYears = Object.values(payload?.stages || {})
    .map((stage) => integerYear(stage?.newestObservationYear))
    .filter((year) => year != null);
  const observationYears = Object.values(payload?.countries || {}).flatMap((country) => (
    Object.values(country || {}).flatMap((section) => (
      Object.values(section || {}).map((obs) => integerYear(obs?.year)).filter((year) => year != null)
    ))
  ));
  if (stageYears.length === 0 || observationYears.length === 0) return null;
  // The oldest stage's latest observation controls stack freshness. A current
  // WPP projection must not hide a frozen education or workforce stage.
  return {
    newestItemAt: Date.UTC(Math.min(...stageYears), 11, 31),
    oldestItemAt: Date.UTC(Math.min(...observationYears), 0, 1),
  };
}

export function demographicsStageCoverageMeta(payload) {
  const statuses = Object.values(payload?.stages || {}).map((stage) => stage?.status);
  const freshCount = statuses.filter((status) => status === 'fresh').length;
  const total = Object.keys(STAGE_DEFINITIONS).length;
  return {
    status: freshCount === total ? 'complete' : 'partial',
    completedPages: freshCount,
    failedPages: total - freshCount,
    completionRatio: freshCount / total,
    rejectedCount: statuses.filter((status) => status === 'unavailable').length,
  };
}
