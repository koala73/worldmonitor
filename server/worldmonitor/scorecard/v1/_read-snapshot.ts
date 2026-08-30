import { getHashFieldsBatch, getLargeRawJson } from '../../../_shared/redis';
import {
  FIVE_FACTOR_SCORECARD_KEY,
  FIVE_FACTOR_SCORECARD_READ_MODEL_KEY,
  FIVE_FACTOR_SCORECARD_READ_MODEL_LIST_FIELD,
  FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD,
  hasCountryScorecardSummaryShape,
  hasFiveFactorSnapshotShape,
} from './_snapshot';
import type { CountryScorecardSummary, FiveFactorReadModelMetadata, FiveFactorSnapshotV1 } from './_types';

export type ScorecardSnapshotReader = (countryCodes?: string[]) => Promise<unknown>;
const CANONICAL_FALLBACK_CACHE_MS = 5 * 60_000;
const SCORECARD_READ_DEADLINE_MS = 7_000;
let canonicalLastGood: { cachedAt: number; snapshot: FiveFactorSnapshotV1 } | null = null;

function parseJson<T>(value: string | undefined): T | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function readModelMetadata(value: string | undefined): FiveFactorReadModelMetadata | null {
  const metadata = parseJson<FiveFactorReadModelMetadata>(value);
  if (!metadata) return null;
  const skeleton = {
    schemaVersion: metadata.schemaVersion,
    methodologyVersion: metadata.methodologyVersion,
    inputRegistryVersion: metadata.inputRegistryVersion,
    computedAt: metadata.computedAt,
    sourceStates: metadata.sourceStates,
    countries: {},
  };
  if (!hasFiveFactorSnapshotShape(skeleton) || !Array.isArray(metadata.countryCodes)) return null;
  if (
    metadata.countryCodes.some((countryCode) => typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode))
    || new Set(metadata.countryCodes).size !== metadata.countryCodes.length
    || metadata.countryCodes.some((countryCode, index) => index > 0 && metadata.countryCodes[index - 1]! >= countryCode)
  ) return null;
  return metadata;
}

function remainingReadBudget(deadlineAtMs: number): number {
  return Math.max(0, deadlineAtMs - Date.now());
}

export function createFiveFactorReadDeadline(): number {
  return Date.now() + SCORECARD_READ_DEADLINE_MS;
}

async function readCanonicalFallback(deadlineAtMs: number): Promise<unknown> {
  if (canonicalLastGood && Date.now() - canonicalLastGood.cachedAt <= CANONICAL_FALLBACK_CACHE_MS) {
    return canonicalLastGood.snapshot;
  }
  const timeoutMs = remainingReadBudget(deadlineAtMs);
  if (timeoutMs === 0) return null;
  const value = await getLargeRawJson(FIVE_FACTOR_SCORECARD_KEY, timeoutMs);
  if (hasFiveFactorSnapshotShape(value)) canonicalLastGood = { cachedAt: Date.now(), snapshot: value };
  return value;
}

export function __resetFiveFactorSnapshotCacheForTests(): void {
  canonicalLastGood = null;
}

export async function readFiveFactorSnapshot(
  countryCodes: string[] = [],
  deadlineAtMs = createFiveFactorReadDeadline(),
): Promise<unknown> {
  try {
    if (countryCodes.length > 0) {
      const fields = [FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD, ...countryCodes.map((countryCode) => `country:${countryCode}`)];
      const timeoutMs = remainingReadBudget(deadlineAtMs);
      if (timeoutMs === 0) return readCanonicalFallback(deadlineAtMs);
      const values = await getHashFieldsBatch(FIVE_FACTOR_SCORECARD_READ_MODEL_KEY, fields, true, timeoutMs);
      const metadata = readModelMetadata(values.get(FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD));
      if (metadata) {
        let invalidExpectedField = false;
        const countries = Object.fromEntries(countryCodes.flatMap((countryCode) => {
          const record = parseJson<FiveFactorSnapshotV1['countries'][string]>(values.get(`country:${countryCode}`));
          if (!metadata.countryCodes.includes(countryCode)) return [];
          if (!record || record.evidence?.countryCode !== countryCode || record.result?.countryCode !== countryCode) {
            invalidExpectedField = true;
            return [];
          }
          return [[countryCode, record]];
        }));
        const snapshot = {
          schemaVersion: metadata.schemaVersion,
          methodologyVersion: metadata.methodologyVersion,
          inputRegistryVersion: metadata.inputRegistryVersion,
          computedAt: metadata.computedAt,
          sourceStates: metadata.sourceStates,
          countries,
        };
        if (!invalidExpectedField && hasFiveFactorSnapshotShape(snapshot)) return snapshot;
      }
    }
  } catch { /* fall through to the canonical last-good cohort */ }
  return readCanonicalFallback(deadlineAtMs);
}

export async function readFiveFactorListProjection(
  deadlineAtMs = createFiveFactorReadDeadline(),
): Promise<{
  metadata: FiveFactorReadModelMetadata;
  scorecards: CountryScorecardSummary[];
} | null> {
  try {
    const fields = [FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD, FIVE_FACTOR_SCORECARD_READ_MODEL_LIST_FIELD];
    const timeoutMs = remainingReadBudget(deadlineAtMs);
    if (timeoutMs === 0) return null;
    const values = await getHashFieldsBatch(FIVE_FACTOR_SCORECARD_READ_MODEL_KEY, fields, true, timeoutMs);
    const metadata = readModelMetadata(values.get(FIVE_FACTOR_SCORECARD_READ_MODEL_METADATA_FIELD));
    const scorecards = parseJson<CountryScorecardSummary[]>(values.get(FIVE_FACTOR_SCORECARD_READ_MODEL_LIST_FIELD));
    if (
      !metadata
      || !Array.isArray(scorecards)
      || scorecards.length !== metadata.countryCodes.length
      || scorecards.some((summary, index) =>
        !hasCountryScorecardSummaryShape(summary, metadata.countryCodes[index]))
    ) return null;
    return { metadata, scorecards };
  } catch {
    return null;
  }
}

export function asFiveFactorSnapshot(value: unknown): FiveFactorSnapshotV1 | null {
  return hasFiveFactorSnapshotShape(value) ? value : null;
}
