/** Types for _forecast-evidence-archive.mjs (plain JS so the seeder and other
 *  .mjs scripts can import it without a build step). */

export interface ForecastEvidenceRecord {
  v: number;
  hash: string;
  title: string;
  link: string;
  description: string;
  publishedAt: number;
  /** epoch ms of the digest publication that wrote this record */
  lastSeen: number;
}

export interface ForecastEvidenceParseResult {
  record: ForecastEvidenceRecord | null;
  malformed: boolean;
  /** set when the member parsed but was dropped by the byte budget */
  oversized: boolean;
}

export const FORECAST_EVIDENCE_KEY: string;
export const FORECAST_EVIDENCE_RECORD_KEY_PREFIX: string;
export const FORECAST_EVIDENCE_COVERAGE_KEY: string;
export const FORECAST_EVIDENCE_SOURCE_KEY: string;
export const FORECAST_EVIDENCE_VERSION: number;
export const FORECAST_EVIDENCE_COVERAGE_VERSION: number;
export const FORECAST_EVIDENCE_TTL_S: number;
export const FORECAST_EVIDENCE_MAX_LOOKBACK_MS: number;
export const FORECAST_EVIDENCE_MEMBER_MAX_BYTES: number;
export const ACCUMULATOR_RETENTION_MS: number;
export const FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS: number;
export function resolveForecastEvidenceCoverageMaxLagMs(
  env?: Record<string, string | undefined>,
): number;
export function utf8ByteLength(value: string): number;
export function isForecastEvidenceHash(value: unknown): value is string;
export function forecastEvidenceRecordKey(hash: string): string;
export interface ForecastEvidenceCoverage {
  v: number;
  coverageStartMs: number;
  coverageEndMs: number;
  cutoverVerifiedAtMs: number;
  sourceDigestAtMs: number;
  maxLookbackMs: number;
  retentionSeconds: number;
  sourceKey: string;
  legacyOldestHash: string;
  legacyOldestScoreMs: number;
}
export function parseForecastEvidenceCoverage(raw: unknown): ForecastEvidenceCoverage | null;
/**
 * `maxLagMs` defaults to 0: only the read path opts into a staleness budget;
 * gates that authorize destruction demand a marker reaching the instant given.
 */
export function forecastEvidenceCoversWindow(
  raw: unknown,
  startMs: number,
  endMs: number,
  maxLagMs?: number,
): boolean;
/** Move a verified marker forward to a newer confirmed publication. */
export function advanceForecastEvidenceCoverage(
  raw: unknown,
  nowMs: number,
): ForecastEvidenceCoverage | null;

/** Eligibility gate for dual publication: only the full/English scope is archived. */
export function isEligibleForecastEvidence(variant: string, lang: string): boolean;

/**
 * Build the self-contained archive member for one story. Returns null when a
 * required field is missing or the serialized member exceeds the byte budget.
 */
export function buildForecastEvidenceMember(
  track: { hash?: unknown; title?: unknown; link?: unknown; description?: unknown; publishedAt?: unknown },
  lastSeen: number,
): string | null;

/** Parse one archived member; malformed members are reported, not dropped. */
export function parseForecastEvidenceMember(raw: unknown): ForecastEvidenceParseResult;

/** ZREMRANGEBYSCORE bounds pruning the digest accumulator past its retention contract. */
export function accumulatorPruneBounds(nowMs: number, retentionMs?: number): { min: string; max: string };

/** ZREMRANGEBYSCORE bounds pruning the evidence archive past the 14-day reader contract. */
export function evidencePruneBounds(nowMs: number): { min: string; max: string };
