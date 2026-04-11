import type { ResilienceScoreResponse } from '@/services/resilience';

// Gated locked-preview fixture rendered when the resilience widget is
// visible to non-entitled users. The preview is blurred and
// non-interactive via the .resilience-widget__preview CSS class, so
// the exact values do not need to match any real country. They just
// need to populate the 5 domain bars AND the 13-cell per-dimension
// confidence grid (T1.6) with realistic-looking data so the gated
// card is not a blank gap. Raised in PR #2949 review. Lives in this
// dependency-free utils module so tests can import it without
// pulling in the full ResilienceWidget class (the class indirectly
// depends on `import.meta.env.DEV` via proxy.ts, which breaks plain
// node test runners).
export const LOCKED_PREVIEW: ResilienceScoreResponse = {
  countryCode: 'US',
  overallScore: 73,
  baselineScore: 82,
  stressScore: 58,
  stressFactor: 0.21,
  level: 'high',
  domains: [
    {
      id: 'economic',
      score: 82,
      weight: 0.22,
      dimensions: [
        { id: 'macroFiscal', score: 85, coverage: 0.95, observedWeight: 0.95, imputedWeight: 0.05 },
        { id: 'currencyExternal', score: 80, coverage: 0.88, observedWeight: 0.88, imputedWeight: 0.12 },
        { id: 'tradeSanctions', score: 78, coverage: 0.9, observedWeight: 0.9, imputedWeight: 0.1 },
      ],
    },
    {
      id: 'infrastructure',
      score: 68,
      weight: 0.2,
      dimensions: [
        { id: 'cyberDigital', score: 72, coverage: 0.85, observedWeight: 0.85, imputedWeight: 0.15 },
        { id: 'logisticsSupply', score: 70, coverage: 0.8, observedWeight: 0.8, imputedWeight: 0.2 },
        { id: 'infrastructure', score: 65, coverage: 0.9, observedWeight: 0.9, imputedWeight: 0.1 },
      ],
    },
    {
      id: 'energy',
      score: 88,
      weight: 0.15,
      dimensions: [
        { id: 'energy', score: 88, coverage: 0.82, observedWeight: 0.82, imputedWeight: 0.18 },
      ],
    },
    {
      id: 'social-governance',
      score: 71,
      weight: 0.25,
      dimensions: [
        { id: 'governanceInstitutional', score: 78, coverage: 0.95, observedWeight: 0.95, imputedWeight: 0.05 },
        { id: 'socialCohesion', score: 72, coverage: 0.9, observedWeight: 0.9, imputedWeight: 0.1 },
        { id: 'borderSecurity', score: 68, coverage: 0.75, observedWeight: 0.75, imputedWeight: 0.25 },
        { id: 'informationCognitive', score: 66, coverage: 0.82, observedWeight: 0.82, imputedWeight: 0.18 },
      ],
    },
    {
      id: 'health-food',
      score: 54,
      weight: 0.18,
      dimensions: [
        { id: 'healthPublicService', score: 58, coverage: 0.88, observedWeight: 0.88, imputedWeight: 0.12 },
        { id: 'foodWater', score: 50, coverage: 0.85, observedWeight: 0.85, imputedWeight: 0.15 },
      ],
    },
  ],
  trend: 'rising',
  change30d: 2.4,
  lowConfidence: false,
  imputationShare: 0,
  dataVersion: '',
};

export type ResilienceVisualLevel = 'very_high' | 'high' | 'moderate' | 'low' | 'very_low' | 'unknown';

export const RESILIENCE_VISUAL_LEVEL_COLORS: Record<ResilienceVisualLevel, string> = {
  very_high: '#22c55e',
  high: '#84cc16',
  moderate: '#eab308',
  low: '#f97316',
  very_low: '#ef4444',
  unknown: 'var(--text-faint)',
};

const DOMAIN_LABELS: Record<string, string> = {
  economic: 'Economic',
  infrastructure: 'Infra & Supply',
  energy: 'Energy',
  'social-governance': 'Social & Gov',
  'health-food': 'Health & Food',
};

export function getResilienceVisualLevel(score: number): ResilienceVisualLevel {
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'very_low';
}

export function getResilienceTrendArrow(trend: string): string {
  if (trend === 'rising') return '↑';
  if (trend === 'falling') return '↓';
  return '→';
}

export function getResilienceDomainLabel(domainId: string): string {
  return DOMAIN_LABELS[domainId] ?? domainId;
}

export function formatResilienceConfidence(data: ResilienceScoreResponse): string {
  if (data.lowConfidence) return 'Low confidence — sparse data';
  const coverages = data.domains.flatMap((d) => d.dimensions.map((dim) => dim.coverage));
  const avgCoverage = coverages.length > 0
    ? Math.round((coverages.reduce((s, c) => s + c, 0) / coverages.length) * 100)
    : 0;
  return `Coverage ${avgCoverage}% ✓`;
}

export function formatResilienceChange30d(change30d: number): string {
  const rounded = Number.isFinite(change30d) ? change30d.toFixed(1) : '0.0';
  const sign = change30d > 0 ? '+' : '';
  return `30d ${sign}${rounded}`;
}

export function formatBaselineStress(baseline: number, stress: number): string {
  const b = Number.isFinite(baseline) ? Math.round(baseline) : 0;
  const s = Number.isFinite(stress) ? Math.round(stress) : 0;
  return `Baseline: ${b} | Stress: ${s}`;
}

// Formats the dataVersion field (ISO date YYYY-MM-DD, sourced from the
// seed-meta key) for display in the widget footer. Returns an empty string
// when dataVersion is missing, malformed, or not a real calendar date so
// the caller can skip rendering. Format is stable and regex + calendar
// tested by resilience-widget.test.mts.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function formatResilienceDataVersion(dataVersion: string | null | undefined): string {
  if (typeof dataVersion !== 'string' || !ISO_DATE_PATTERN.test(dataVersion)) return '';
  // Regex-shape is not enough: `/^\d{4}-\d{2}-\d{2}$/` accepts values like
  // `9999-99-99` or `2024-13-45`. A stale or corrupted Redis key could emit
  // one, and the widget would render it without complaint. Defensively
  // verify the string parses to a real calendar date AND round-trips back
  // to the same YYYY-MM-DD slice (so e.g. `2024-02-30` does not silently
  // become `2024-03-01`). Raised in review of PR #2943.
  const parsed = new Date(dataVersion);
  if (Number.isNaN(parsed.getTime())) return '';
  if (parsed.toISOString().slice(0, 10) !== dataVersion) return '';
  return `Data ${dataVersion}`;
}

// T1.6 Phase 1 of the country-resilience reference-grade upgrade plan.
// Per-dimension confidence helpers. The widget uses these to render a
// compact confidence grid below the 5-domain rows so analysts can see
// per-dimension data coverage without opening the deep-dive panel.
//
// This slice uses ONLY the existing ResilienceDimension fields (`id`,
// `coverage`, `observedWeight`, `imputedWeight`) already on every
// response, so no proto or schema changes are needed. The downstream
// adds (imputation class icon from T1.7, freshness badge from T1.5)
// land as additional columns in later PRs once the schema exposes
// those fields through the response type.

// Short labels for each of the 13 dimensions so the compact grid does
// not wrap. Keys match `ResilienceDimensionId` from
// server/worldmonitor/resilience/v1/_dimension-scorers.ts. The doc
// linter test (resilience-methodology-lint.test.mts) already pins the
// scorer side, so any new dimension must land in both places together.
const DIMENSION_LABELS: Record<string, string> = {
  macroFiscal: 'Macro',
  currencyExternal: 'Currency',
  tradeSanctions: 'Trade',
  cyberDigital: 'Cyber',
  logisticsSupply: 'Logistics',
  infrastructure: 'Infra',
  energy: 'Energy',
  governanceInstitutional: 'Gov',
  socialCohesion: 'Social',
  borderSecurity: 'Border',
  informationCognitive: 'Info',
  healthPublicService: 'Health',
  foodWater: 'Food',
};

export function getResilienceDimensionLabel(dimensionId: string): string {
  return DIMENSION_LABELS[dimensionId] ?? dimensionId;
}

// Minimal shape the confidence helpers need from a ResilienceDimension.
// Defined locally so this module does not take a hard dependency on the
// generated service types; the real ResilienceDimension from the proto
// already has these fields (plus more).
export interface DimensionConfidenceInput {
  id: string;
  coverage: number;
  observedWeight: number;
  imputedWeight: number;
}

export type DimensionCoverageStatus = 'observed' | 'partial' | 'imputed' | 'absent';

export interface DimensionConfidence {
  id: string;
  label: string;
  coveragePct: number;
  status: DimensionCoverageStatus;
  /** True when total weight (observed + imputed) is zero, meaning no data at all. */
  absent: boolean;
}

/**
 * Classify a dimension's coverage into one of four semantic buckets so
 * the widget can render a status icon without re-deriving the logic.
 *
 * - `absent`: no observed or imputed weight at all (dimension scorer
 *   returned an empty result). Rare, indicates a data-collection bug.
 * - `imputed`: all weight came from imputation, zero real data.
 * - `partial`: mix of observed and imputed weight; less than 80%
 *   observed share.
 * - `observed`: at least 80% of weight came from real data.
 *
 * The 80% threshold mirrors the existing `lowConfidence` rule in
 * `_shared.ts` where imputation share above 40% (i.e. below 60% observed)
 * flips the widget-wide low-confidence flag. The per-dimension threshold
 * is stricter because a single well-covered dimension should not be
 * obscured by the domain's worst case.
 */
export function formatDimensionConfidence(input: DimensionConfidenceInput): DimensionConfidence {
  const coverage = Number.isFinite(input.coverage) ? input.coverage : 0;
  const coveragePct = Math.round(Math.max(0, Math.min(1, coverage)) * 100);
  const observed = Number.isFinite(input.observedWeight) ? input.observedWeight : 0;
  const imputed = Number.isFinite(input.imputedWeight) ? input.imputedWeight : 0;
  const total = observed + imputed;
  const label = getResilienceDimensionLabel(input.id);

  if (total <= 0) {
    return { id: input.id, label, coveragePct: 0, status: 'absent', absent: true };
  }

  const observedShare = observed / total;
  let status: DimensionCoverageStatus;
  if (observed === 0) {
    status = 'imputed';
  } else if (observedShare >= 0.8) {
    status = 'observed';
  } else {
    status = 'partial';
  }

  return { id: input.id, label, coveragePct, status, absent: false };
}

/**
 * Collect every dimension across every domain in the response into a
 * flat, stable-ordered list of DimensionConfidence entries. Preserves
 * the order the scorer emits (domain order, then dimension order inside
 * each domain) so the widget can render a predictable grid.
 */
export function collectDimensionConfidences(
  domains: ReadonlyArray<{ dimensions: ReadonlyArray<DimensionConfidenceInput> }>,
): DimensionConfidence[] {
  const out: DimensionConfidence[] = [];
  for (const domain of domains) {
    for (const dim of domain.dimensions) {
      out.push(formatDimensionConfidence(dim));
    }
  }
  return out;
}
