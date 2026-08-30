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
/**
 * How far past its refresh window a cached cohort may still be served when the
 * refresh itself fails. Comfortably inside the 3-day snapshot TTL and the daily
 * publication cadence, so an Upstash outage degrades to slightly-stale data
 * instead of `scorecard-snapshot-unavailable`, but a genuinely dead seeder still
 * surfaces within a few hours.
 */
const CANONICAL_STALE_SERVE_CEILING_MS = 6 * 60 * 60_000;
export const SCORECARD_READ_DEADLINE_MS = 7_000;
/**
 * Entitlement allowance the gateway can spend BEFORE this deadline starts.
 * createDomainGateway awaits checkEntitlementDetailed first, and its Convex
 * fallback aborts at 3s on a cache miss. Exported so the client budget can be
 * pinned against the composed worst case instead of guessed independently.
 */
export const SCORECARD_ENTITLEMENT_ALLOWANCE_MS = 3_000;
let canonicalLastGood: { cachedAt: number; snapshot: FiveFactorSnapshotV1 } | null = null;

/**
 * Snapshots this isolate has already shape-checked, keyed by object identity.
 *
 * `hasFiveFactorSnapshotShape` re-runs `scoreCountry` and two `JSON.stringify`
 * calls for EVERY country in the cohort (~196 in production). Every handler
 * calls `asFiveFactorSnapshot` on whatever the reader returns, so without this
 * memo the canonical path pays that cost twice on a cold read and once more on
 * every subsequent warm-cache hit -- the module cache saved the fetch and the
 * parse but not the CPU, which is the expensive part.
 */
const validatedSnapshots = new WeakSet<object>();

function validateSnapshot(value: unknown): FiveFactorSnapshotV1 | null {
  if (typeof value !== 'object' || value === null) return null;
  if (validatedSnapshots.has(value)) return value as FiveFactorSnapshotV1;
  if (!hasFiveFactorSnapshotShape(value)) return null;
  validatedSnapshots.add(value);
  return value;
}

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

function serveStale(warm: typeof canonicalLastGood): FiveFactorSnapshotV1 | null {
  if (!warm || Date.now() - warm.cachedAt > CANONICAL_STALE_SERVE_CEILING_MS) return null;
  return warm.snapshot;
}

async function readCanonicalFallback(deadlineAtMs: number): Promise<unknown> {
  const warm = canonicalLastGood;
  if (warm && Date.now() - warm.cachedAt <= CANONICAL_FALLBACK_CACHE_MS) return warm.snapshot;
  const timeoutMs = remainingReadBudget(deadlineAtMs);
  if (timeoutMs === 0) return serveStale(warm);
  let value: unknown;
  try {
    value = await getLargeRawJson(FIVE_FACTOR_SCORECARD_KEY, timeoutMs);
  } catch (error) {
    // A failed refresh must not discard a cohort this isolate is still holding.
    // getLargeRawJson throws on a non-2xx, a command error, or the abort
    // deadline, and every handler turns that into
    // `scorecard-snapshot-unavailable` -- so without this an Upstash blip
    // longer than the refresh window made a warm isolate serve nothing at all.
    const stale = serveStale(warm);
    if (stale) return stale;
    throw error;
  }
  const validated = validateSnapshot(value);
  if (validated) canonicalLastGood = { cachedAt: Date.now(), snapshot: validated };
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
        // Scope a corrupt hash field to the country it belongs to. A single bad
        // field used to discard the whole assembled cohort and force the request
        // onto the full-snapshot fallback, which re-scores every country -- a
        // 30-member bloc paid that penalty for one unreadable member. The
        // response contract already carries per-member exclusion
        // (excludedMembers / unavailableReason), so the caller can say which
        // country is missing without abandoning the cheap read.
        let expected = 0;
        let corrupt = 0;
        const countries = Object.fromEntries(countryCodes.flatMap((countryCode) => {
          // A country absent from the published cohort is not corruption; it is
          // simply not scored, and the handler reports country-unavailable.
          if (!metadata.countryCodes.includes(countryCode)) return [];
          expected += 1;
          const record = parseJson<FiveFactorSnapshotV1['countries'][string]>(values.get(`country:${countryCode}`));
          if (!record || record.evidence?.countryCode !== countryCode || record.result?.countryCode !== countryCode) {
            corrupt += 1;
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
        // Only abandon the targeted read when the read model yielded nothing
        // usable for a cohort its own metadata says should exist -- that points
        // at a half-written swap rather than one bad field.
        const wholeCohortCorrupt = expected > 0 && corrupt === expected;
        if (!wholeCohortCorrupt && validateSnapshot(snapshot)) return snapshot;
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
  return validateSnapshot(value);
}
