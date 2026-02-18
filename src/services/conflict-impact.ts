import type { UcdpGeoEvent, CountryDisplacement, PopulationExposure } from '@/types';
import type { ClimateAnomaly } from '@/services/climate';

export interface ConflictImpactLink {
  country: string;
  conflictEvents: number;
  totalDeaths: number;
  displacementOutflow: number;
  climateAnomaly: ClimateAnomaly | null;
  populationExposed: number;
  combinedSeverity: number;
}

export function correlateConflictImpact(
  ucdpEvents: UcdpGeoEvent[],
  displacementData: CountryDisplacement[],
  anomalies: ClimateAnomaly[],
  exposures: PopulationExposure[],
): ConflictImpactLink[] {
  const byCountry = new Map<string, { events: number; deaths: number }>();

  for (const e of ucdpEvents) {
    const country = e.country;
    const current = byCountry.get(country) || { events: 0, deaths: 0 };
    current.events++;
    current.deaths += e.deaths_best;
    byCountry.set(country, current);
  }

  const displacementMap = new Map<string, CountryDisplacement>();
  for (const d of displacementData) {
    displacementMap.set(d.name, d);
    displacementMap.set(d.code, d);
  }

  const exposureByCountry = new Map<string, number>();
  for (const exp of exposures) {
    const current = exposureByCountry.get(exp.eventName) || 0;
    exposureByCountry.set(exp.eventName, current + exp.exposedPopulation);
  }

  const links: ConflictImpactLink[] = [];

  for (const [country, { events, deaths }] of byCountry) {
    const displacement = displacementMap.get(country);
    const displacementOutflow = displacement ? displacement.refugees + displacement.asylumSeekers : 0;

    const climateAnomaly = anomalies.find(a => {
      const zoneLower = a.zone.toLowerCase();
      const countryLower = country.toLowerCase();
      return zoneLower.includes(countryLower) || countryLower.includes(zoneLower);
    }) || null;

    const exposed = exposureByCountry.get(country) || 0;

    const conflictScore = Math.min(40, events * 2 + Math.sqrt(deaths) * 3);
    const displacementScore = Math.min(30, displacementOutflow > 1_000_000 ? 30 : displacementOutflow > 100_000 ? 15 : 0);
    const climateScore = climateAnomaly?.severity === 'extreme' ? 20 : climateAnomaly?.severity === 'moderate' ? 10 : 0;
    const popScore = Math.min(10, exposed > 1_000_000 ? 10 : exposed > 100_000 ? 5 : 0);

    links.push({
      country,
      conflictEvents: events,
      totalDeaths: deaths,
      displacementOutflow,
      climateAnomaly,
      populationExposed: exposed,
      combinedSeverity: Math.round(conflictScore + displacementScore + climateScore + popScore),
    });
  }

  return links.sort((a, b) => b.combinedSeverity - a.combinedSeverity);
}
