import type { ResilienceDimensionId, ResilienceDimensionScore } from './_dimension-scorers';
import { INDICATOR_REGISTRY, getIndicatorSourceKeys } from './_indicator-registry';

export const RESILIENCE_INDICATOR_IDS = [
  'govRevenuePct', 'debtGrowthRate', 'currentAccountPct', 'unemploymentPct', 'householdDebtService',
  'inflationStability', 'fxReservesAdequacy', 'fxVolatility', 'fxDeviation',
  'tradeRestrictions', 'tradeBarriers', 'appliedTariffRate',
  'shortTermExternalDebtPctGni', 'bisLbsXborderPctGdp', 'fatfListingStatus', 'financialCenterRedundancy',
  'cyberThreats', 'internetOutages', 'gpsJamming',
  'roadsPavedLogistics', 'shippingStress', 'transitDisruption',
  'electricityAccess', 'roadsPavedInfra', 'infraOutages', 'broadband',
  'energyImportDependency', 'gasShare', 'coalShare', 'renewShare', 'euGasStorageStress',
  'energyPriceStress', 'electricityConsumption', 'importedFossilDependence',
  'lowCarbonGenerationShare', 'powerLossesPct',
  'wgiVoiceAccountability', 'wgiPoliticalStability', 'wgiGovernmentEffectiveness',
  'wgiRegulatoryQuality', 'wgiRuleOfLaw', 'wgiControlOfCorruption',
  'gpiScore', 'displacementTotal', 'unrestEvents',
  'ucdpConflict', 'displacementHosted',
  'rsfPressFreedom', 'socialVelocity', 'newsThreatScore',
  'femaleUpperSecondaryAttainment',
  'uhcIndex', 'measlesCoverage', 'hospitalBeds', 'physiciansPer1k', 'healthExpPerCapitaUsd',
  'ipcPeopleInCrisis', 'ipcPhase', 'aquastatScore',
  'recoveryGovRevenue', 'recoveryFiscalBalance', 'recoveryDebtToGdp', 'debtSustainabilityGap',
  'recoveryReserveMonths', 'recoveryLiquidReserveMonths', 'recoverySovereignWealthEffectiveMonths',
  'recoveryDebtToReserves', 'recoveryImportHhi',
  'recoveryWgiContinuity', 'recoveryConflictPressure', 'recoveryDisplacementVelocity',
  'recoveryFuelStockDays',
] as const;

export type ResilienceIndicatorId = typeof RESILIENCE_INDICATOR_IDS[number];

export type IndicatorTraceState =
  | 'observed'
  | 'imputed'
  | 'missing'
  | 'fallback'
  | 'not-applicable'
  | 'source-failure'
  | 'inactive'
  | 'retired';

export interface IndicatorObservedSource {
  providerName: string;
  sourceUrl?: string;
}

export interface IndicatorTraceMetric {
  indicatorId: ResilienceIndicatorId;
  score: number | null;
  weight: number;
  fallbackScore?: number;
  certaintyCoverage?: number;
  imputed?: boolean;
  imputationClass?: string;
  state?: 'observed' | 'imputed' | 'missing' | 'fallback' | 'not-applicable';
  nominalWeight?: number;
  rawValue?: number | string | null;
  rawUnit?: string;
  sourceYear?: number | null;
  observedAtMs?: number | null;
  observedSources?: readonly IndicatorObservedSource[];
  provenanceHint?: string;
}

export interface IndicatorTraceContribution {
  indicatorId: ResilienceIndicatorId;
  normalizedScore: number | null;
  nominalWeight: number;
  runtimeWeight: number;
  scoringWeightShare: number;
  literalContribution: number;
  state: Exclude<IndicatorTraceState, 'inactive' | 'retired' | 'source-failure'>;
  imputationClass: string | null;
  certaintyCoverage: number;
  rawValue: number | string | null;
  rawUnit: string;
  sourceYear: number | null;
  observedAtMs: number | null;
  observedSources: readonly IndicatorObservedSource[];
  provenanceHint: string;
}

export interface RecordedDimensionTrace {
  dimensionId: ResilienceDimensionId;
  prePolicyScore: number;
  contributions: IndicatorTraceContribution[];
  policyCapName: string;
  policyCapFactor: number;
  inactiveReason: string;
  sourceFailure: boolean;
}

export interface IndicatorTraceRow extends Omit<IndicatorTraceContribution, 'state'> {
  state: IndicatorTraceState;
  dimension: ResilienceDimensionId;
  includedInDimensionScore: boolean;
  effectiveContribution: number;
  sourceKeys: readonly string[];
  tier: 'core' | 'enrichment' | 'experimental';
  license: string;
  reason: string;
}

export interface DimensionIndicatorTrace {
  id: ResilienceDimensionId;
  active: boolean;
  reason: string;
  score: number;
  prePolicyScore: number;
  policyCapName: string;
  policyCapFactor: number;
  indicators: IndicatorTraceRow[];
}

export interface ResilienceIndicatorTraceSnapshot {
  indicators: IndicatorTraceRow[];
  dimensions: DimensionIndicatorTrace[];
}

export interface IndicatorTraceCollector {
  recordBlend(dimensionId: ResilienceDimensionId, score: number, metrics: readonly IndicatorTraceMetric[]): void;
  recordManual(dimensionId: ResilienceDimensionId, score: number, metrics: readonly IndicatorTraceMetric[]): void;
  recordInactiveDimension(dimensionId: ResilienceDimensionId, reason: string): void;
  recordRetiredDimension(dimensionId: ResilienceDimensionId, reason: string): void;
  recordPolicyCap(dimensionId: ResilienceDimensionId, name: string, preCapScore: number, finalScore: number): void;
  recordSourceFailure(dimensionId: ResilienceDimensionId): void;
  readDimension(dimensionId: ResilienceDimensionId): RecordedDimensionTrace | undefined;
}

export interface ResilienceScoreOptions {
  trace?: IndicatorTraceCollector;
}

function finiteScore(metric: IndicatorTraceMetric): number | null {
  if (Number.isFinite(metric.score)) return metric.score as number;
  if (Number.isFinite(metric.fallbackScore)) return metric.fallbackScore as number;
  return null;
}

function metricState(metric: IndicatorTraceMetric): IndicatorTraceContribution['state'] {
  if (metric.state) return metric.state;
  if (!Number.isFinite(metric.score) && Number.isFinite(metric.fallbackScore)) return 'fallback';
  if (!Number.isFinite(metric.score)) return 'missing';
  return metric.imputed === true ? 'imputed' : 'observed';
}

function contributionsFor(metrics: readonly IndicatorTraceMetric[]): IndicatorTraceContribution[] {
  const scoringWeight = metrics.reduce((sum, metric) => (
    finiteScore(metric) == null ? sum : sum + metric.weight
  ), 0);

  return metrics.map((metric) => {
    const scoringScore = finiteScore(metric);
    const share = scoringScore == null || scoringWeight === 0 ? 0 : metric.weight / scoringWeight;
    const state = metricState(metric);
    return {
      indicatorId: metric.indicatorId,
      normalizedScore: scoringScore,
      nominalWeight: metric.nominalWeight ?? metric.weight,
      runtimeWeight: metric.weight,
      scoringWeightShare: share,
      literalContribution: scoringScore == null ? 0 : scoringScore * share,
      state,
      imputationClass: state === 'imputed' ? metric.imputationClass ?? null : null,
      certaintyCoverage: metric.certaintyCoverage ?? (scoringScore == null ? 0 : 1),
      rawValue: metric.rawValue ?? null,
      rawUnit: metric.rawUnit ?? '',
      sourceYear: Number.isFinite(metric.sourceYear) ? Number(metric.sourceYear) : null,
      observedAtMs: Number.isFinite(metric.observedAtMs) ? Number(metric.observedAtMs) : null,
      observedSources: metric.observedSources ?? [],
      provenanceHint: metric.provenanceHint ?? '',
    };
  });
}

export function createIndicatorTraceCollector(): IndicatorTraceCollector {
  const dimensions = new Map<ResilienceDimensionId, RecordedDimensionTrace>();

  const record = (
    dimensionId: ResilienceDimensionId,
    score: number,
    metrics: readonly IndicatorTraceMetric[],
  ): void => {
    dimensions.set(dimensionId, {
      dimensionId,
      prePolicyScore: score,
      contributions: contributionsFor(metrics),
      policyCapName: '',
      policyCapFactor: 1,
      inactiveReason: '',
      sourceFailure: false,
    });
  };

  return {
    recordBlend: record,
    recordManual: record,
    recordInactiveDimension(dimensionId, reason) {
      dimensions.set(dimensionId, {
        dimensionId,
        prePolicyScore: 0,
        contributions: [],
        policyCapName: '',
        policyCapFactor: 1,
        inactiveReason: reason,
        sourceFailure: false,
      });
    },
    recordRetiredDimension(dimensionId, reason) {
      dimensions.set(dimensionId, {
        dimensionId,
        prePolicyScore: 0,
        contributions: [],
        policyCapName: '',
        policyCapFactor: 1,
        inactiveReason: `retired:${reason}`,
        sourceFailure: false,
      });
    },
    recordPolicyCap(dimensionId, name, preCapScore, finalScore) {
      const current = dimensions.get(dimensionId);
      if (!current) return;
      current.prePolicyScore = preCapScore;
      current.policyCapName = name;
      current.policyCapFactor = preCapScore === 0 ? 1 : finalScore / preCapScore;
    },
    recordSourceFailure(dimensionId) {
      const current = dimensions.get(dimensionId);
      if (current) current.sourceFailure = true;
      else {
        dimensions.set(dimensionId, {
          dimensionId,
          prePolicyScore: 0,
          contributions: [],
          policyCapName: '',
          policyCapFactor: 1,
          inactiveReason: '',
          sourceFailure: true,
        });
      }
    },
    readDimension(dimensionId) {
      return dimensions.get(dimensionId);
    },
  };
}

function allocateFourDecimalContributions(
  rows: readonly IndicatorTraceContribution[],
  finalScore: number,
  capFactor: number,
): Map<ResilienceIndicatorId, number> {
  const included = rows.filter((row) => row.scoringWeightShare > 0);
  const targetUnits = Math.round(finalScore * 10_000);
  const scaled = included.map((row) => Math.max(0, row.literalContribution * capFactor));
  const scaledTotal = scaled.reduce((sum, value) => sum + value, 0);
  if (included.length === 0 || targetUnits === 0 || scaledTotal === 0) {
    return new Map(included.map((row) => [row.indicatorId, 0]));
  }

  const allocations = scaled.map((value, index) => {
    const exactUnits = (value / scaledTotal) * targetUnits;
    const floorUnits = Math.floor(exactUnits);
    return { index, floorUnits, remainder: exactUnits - floorUnits };
  });
  let remaining = targetUnits - allocations.reduce((sum, item) => sum + item.floorUnits, 0);
  allocations.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) {
    const allocation = allocations[index % allocations.length];
    if (allocation) allocation.floorUnits += 1;
  }
  allocations.sort((left, right) => left.index - right.index);

  return new Map(allocations.map((item, index) => [
    included[index]!.indicatorId,
    item.floorUnits / 10_000,
  ]));
}

const EMPTY_CONTRIBUTION: Omit<IndicatorTraceContribution, 'indicatorId'> = {
  normalizedScore: null,
  nominalWeight: 0,
  runtimeWeight: 0,
  scoringWeightShare: 0,
  literalContribution: 0,
  state: 'missing',
  imputationClass: null,
  certaintyCoverage: 0,
  rawValue: null,
  rawUnit: '',
  sourceYear: null,
  observedAtMs: null,
  observedSources: [],
  provenanceHint: '',
};

export function materializeIndicatorTrace(
  collector: IndicatorTraceCollector,
  scores: Readonly<Record<ResilienceDimensionId, ResilienceDimensionScore>>,
): ResilienceIndicatorTraceSnapshot {
  const registryIds = INDICATOR_REGISTRY.map((indicator) => indicator.id);
  if (
    registryIds.length !== RESILIENCE_INDICATOR_IDS.length
    || registryIds.some((id, index) => id !== RESILIENCE_INDICATOR_IDS[index])
  ) {
    throw new Error('RESILIENCE_INDICATOR_IDS must match INDICATOR_REGISTRY order exactly');
  }

  const rows: IndicatorTraceRow[] = [];
  const dimensions = new Map<ResilienceDimensionId, DimensionIndicatorTrace>();
  const derivedDimensions = new Map<ResilienceDimensionId, {
    recorded: RecordedDimensionTrace | undefined;
    contributions: ReadonlyMap<ResilienceIndicatorId, IndicatorTraceContribution>;
    effective: ReadonlyMap<ResilienceIndicatorId, number>;
    finalScore: number;
    retired: boolean;
    sourceFailure: boolean;
  }>();

  for (const spec of INDICATOR_REGISTRY) {
    const indicatorId = spec.id as ResilienceIndicatorId;
    let derived = derivedDimensions.get(spec.dimension);
    if (!derived) {
      const recorded = collector.readDimension(spec.dimension);
      const finalScore = scores[spec.dimension]?.score ?? 0;
      derived = {
        recorded,
        contributions: new Map(recorded?.contributions.map((row) => [row.indicatorId, row]) ?? []),
        effective: recorded
          ? allocateFourDecimalContributions(recorded.contributions, finalScore, recorded.policyCapFactor)
          : new Map(),
        finalScore,
        retired: recorded?.inactiveReason.startsWith('retired:') === true,
        sourceFailure: recorded?.sourceFailure === true,
      };
      derivedDimensions.set(spec.dimension, derived);
    }
    const { recorded, effective, finalScore, retired, sourceFailure } = derived;
    const recordedRow = derived.contributions.get(indicatorId);
    const included = recordedRow != null && recordedRow.scoringWeightShare > 0 && !sourceFailure;
    const state: IndicatorTraceState = sourceFailure
      ? 'source-failure'
      : retired
        ? 'retired'
        : recordedRow?.state ?? 'inactive';
    const reason = included
      ? ''
      : sourceFailure
        ? 'dimension-source-failure'
        : recorded?.inactiveReason
          || (recordedRow?.state === 'not-applicable'
            ? 'not-applicable-to-country'
            : recordedRow?.state === 'missing'
              ? 'missing-source-value'
              : 'not-selected-by-active-formula');
    const base = recordedRow ?? { indicatorId, ...EMPTY_CONTRIBUTION, nominalWeight: spec.weight };
    const row: IndicatorTraceRow = {
      ...base,
      state,
      dimension: spec.dimension,
      includedInDimensionScore: included,
      effectiveContribution: included ? effective.get(indicatorId) ?? 0 : 0,
      sourceKeys: getIndicatorSourceKeys(spec),
      tier: spec.tier,
      license: spec.license,
      reason,
    };
    rows.push(row);

    const dimension = dimensions.get(spec.dimension) ?? {
      id: spec.dimension,
      active: recorded != null && recorded.inactiveReason.length === 0,
      reason: recorded?.inactiveReason ?? 'not-traced',
      score: finalScore,
      prePolicyScore: recorded?.prePolicyScore ?? finalScore,
      policyCapName: recorded?.policyCapName ?? '',
      policyCapFactor: recorded?.policyCapFactor ?? 1,
      indicators: [],
    };
    dimension.indicators.push(row);
    dimensions.set(spec.dimension, dimension);
  }

  return { indicators: rows, dimensions: [...dimensions.values()] };
}
