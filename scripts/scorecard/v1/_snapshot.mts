import { SCORECARD_INPUT_REGISTRY_VERSION } from './_input-registry.mts';
import { SCORECARD_METHODOLOGY_VERSION } from './_methodology.mts';
import { scoreCountry } from './_score-country.mts';
import { adaptCountryEvidence, type ScorecardSourceSnapshots } from './_source-adapters.mts';
import { SCORECARD_SNAPSHOT_SCHEMA_VERSION, type FiveFactorSnapshotV1, type ScorecardSourceState } from './_types.mts';

export const FIVE_FACTOR_SCORECARD_KEY = 'scorecard:five-factor:v1';
export const FIVE_FACTOR_SCORECARD_SEED_META_KEY = 'seed-meta:scorecard:five-factor';
export const FIVE_FACTOR_SCORECARD_MAX_BYTES = 5 * 1024 * 1024;

const SOURCE_STATE_KEYS: Array<[keyof ScorecardSourceSnapshots, string]> = [
  ['population', 'economic:imf:labor:v1'],
  ['foodStocks', 'resilience:food-stocks:v1'],
  ['demographics', 'demographics:capability:v1'],
  ['defense', 'military:industrial-base:v1'],
  ['energyMix', 'energy:mix:v1:_all'],
  ['staticByCountry', 'resilience:static:{ISO2}'],
  ['lowCarbon', 'resilience:low-carbon-generation:v1'],
  ['powerLosses', 'resilience:power-losses:v1'],
  ['importHhi', 'resilience:recovery:import-hhi:v1'],
  ['techByIso2', 'economic:worldbank-techreadiness:v1'],
];

export function buildFiveFactorSnapshot(
  countryCodes: string[],
  sources: ScorecardSourceSnapshots,
  computedAt = new Date().toISOString(),
): FiveFactorSnapshotV1 {
  const countries = Object.fromEntries(countryCodes.map((countryCode) => {
    const evidence = adaptCountryEvidence(countryCode, sources);
    return [countryCode, { evidence, result: scoreCountry(evidence) }];
  }));
  const sourceStates = Object.fromEntries(SOURCE_STATE_KEYS.map(([field, sourceKey]) => [sourceKey, {
    status: sources[field] ? 'available' : 'unavailable',
    sourceKey,
    ...(!sources[field] ? { detail: 'Canonical source snapshot was not available during computation.' } : {}),
  }])) as Record<string, ScorecardSourceState>;
  return {
    schemaVersion: SCORECARD_SNAPSHOT_SCHEMA_VERSION,
    methodologyVersion: SCORECARD_METHODOLOGY_VERSION,
    inputRegistryVersion: SCORECARD_INPUT_REGISTRY_VERSION,
    computedAt,
    sourceStates,
    countries,
  };
}

export function scorecardSnapshotBytes(snapshot: FiveFactorSnapshotV1): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

export function validateFiveFactorSnapshot(
  snapshot: FiveFactorSnapshotV1,
  options: { minimumCountries?: number; maxBytes?: number } = {},
): boolean {
  const minimumCountries = options.minimumCountries ?? 150;
  const maxBytes = options.maxBytes ?? FIVE_FACTOR_SCORECARD_MAX_BYTES;
  if (
    snapshot?.schemaVersion !== SCORECARD_SNAPSHOT_SCHEMA_VERSION
    || snapshot?.methodologyVersion !== SCORECARD_METHODOLOGY_VERSION
    || snapshot?.inputRegistryVersion !== SCORECARD_INPUT_REGISTRY_VERSION
    || !Number.isFinite(Date.parse(snapshot?.computedAt))
  ) return false;
  const entries = Object.entries(snapshot?.countries || {});
  if (entries.length < minimumCountries || scorecardSnapshotBytes(snapshot) > maxBytes) return false;
  let scoreablePillars = 0;
  for (const [countryCode, record] of entries) {
    if (record.evidence.countryCode !== countryCode || record.result.countryCode !== countryCode) return false;
    if (JSON.stringify(scoreCountry(record.evidence)) !== JSON.stringify(record.result)) return false;
    scoreablePillars += Object.values(record.result.pillars).filter((pillar) => pillar.hasScore).length;
  }
  return scoreablePillars > 0;
}
