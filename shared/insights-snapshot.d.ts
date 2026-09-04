export interface InsightSource {
  title: string;
  source: string;
  url: string;
  publishedAt?: string;
}

export interface InsightSourceOptions {
  fallback?: unknown;
  urlOrder?: 'link-first' | 'url-first';
  allowEmptyUrl?: boolean;
}

export const INSIGHTS_MAX_AGE_MS: number;
/** Ceiling on how old a snapshot may be and still be served as flagged LKG. */
export const INSIGHTS_MAX_SERVEABLE_AGE_MS: number;

export function normalizeInsightSourceUrl(value: unknown): string;

export function normalizeInsightSource(
  candidate: unknown,
  options?: InsightSourceOptions,
): InsightSource | null;

export function collectInsightSources(
  candidates: readonly unknown[],
  maxSources?: number,
  options?: InsightSourceOptions,
): InsightSource[];

export type InsightsSnapshotRejection =
  | 'malformed-snapshot'
  | 'missing-generated-at'
  | 'future-generated-at'
  | 'stale-snapshot';

export function insightsSnapshotRejection(
  raw: unknown,
  nowMs?: number,
): InsightsSnapshotRejection | null;

export function isAcceptedInsightsSnapshot(raw: unknown, nowMs?: number): boolean;
