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

export function isAcceptedInsightsSnapshot(raw: unknown, nowMs?: number): boolean;
