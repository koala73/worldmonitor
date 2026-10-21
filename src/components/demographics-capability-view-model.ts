export interface DemographicsObservationLike {
  available: boolean;
  value: number;
  year: number;
  source: string;
  unit: string;
}

function formatValue(value: number, unit: string): string {
  if (unit === 'people') {
    return Math.round(value).toLocaleString();
  }

  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (unit === 'percent') return `${formatted}%`;
  if (unit === 'years') {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 1,
      style: 'unit',
      unit: 'year',
      unitDisplay: 'long',
    }).format(value);
  }
  // A language-neutral ratio avoids leaking an English unit into localized panels.
  if (unit === 'people per million') return `${formatted} / 10⁶`;
  return unit ? `${formatted} ${unit}` : formatted;
}

export function formatDemographicsObservation(
  observation: DemographicsObservationLike | undefined,
  unavailableLabel: string,
): string {
  if (
    !observation?.available
    || !Number.isFinite(observation.value)
    || !Number.isInteger(observation.year)
    || observation.year <= 0
  ) {
    return unavailableLabel;
  }

  return `${formatValue(observation.value, observation.unit)} · ${observation.year}`;
}

export function summarizeDemographicsSources(
  observations: Array<DemographicsObservationLike | undefined>,
): string {
  return [...new Set(
    observations
      .filter((observation): observation is DemographicsObservationLike => Boolean(
        observation?.available && observation.source.trim(),
      ))
      .map((observation) => observation.source.trim()),
  )].join('; ');
}
