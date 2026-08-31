import { getEnergyImportDependencyObservedSources } from '../../resilience/v1/_energy-import-dependency-source';
import { decideIndicatorRawRedistribution } from '../../resilience/v1/_indicator-source-policy';

export interface ResolvedEnergyImportDependency {
  available: boolean;
  value: number;
  year: number;
  source: string;
}

export const UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY: ResolvedEnergyImportDependency = Object.freeze({
  available: false,
  value: 0,
  year: 0,
  source: '',
});

export function resolveEnergyImportDependency(
  staticRecord: unknown,
): ResolvedEnergyImportDependency {
  const observation = (
    staticRecord as {
      iea?: {
        energyImportDependency?: {
          value?: unknown;
          year?: unknown;
          source?: unknown;
        };
      };
    } | null
  )?.iea?.energyImportDependency;

  if (
    typeof observation?.value !== 'number'
    || !Number.isFinite(observation.value)
    || typeof observation.year !== 'number'
    || !Number.isInteger(observation.year)
    || observation.year <= 0
  ) {
    return UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY;
  }

  const decision = decideIndicatorRawRedistribution({
    indicatorId: 'energyImportDependency',
    observationState: 'observed',
    sources: getEnergyImportDependencyObservedSources(observation.source),
  });
  if (!decision.expose) return UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY;

  return {
    available: true,
    value: observation.value,
    year: observation.year,
    source: decision.providerName,
  };
}
