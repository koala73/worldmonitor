import { TIER1_COUNTRIES } from '@/config/countries';
import type { CountrySignalCounts } from '@/types';
import type { CountryMilitarySignalCounts } from './country-military-activity';

export function countrySignalsFromMilitary(code: string, military?: CountryMilitarySignalCounts): CountrySignalCounts {
  return {
    criticalNews: null, protests: null,
    militaryFlights: military?.militaryFlights ?? null,
    militaryVessels: military?.militaryVessels ?? null,
    militaryFlightsInCountry: military?.militaryFlightsInCountry ?? null,
    militaryVesselsInCountry: military?.militaryVesselsInCountry ?? null,
    outages: null, aisDisruptions: null, satelliteFires: null, radiationAnomalies: null,
    temporalAnomalies: null, globalTemporalAnomalies: null, cyberThreats: null, earthquakes: null,
    displacementOutflow: null, climateStress: null, conflictEvents: null, activeStrikes: null,
    orefSirens: null, orefHistory24h: null, aviationDisruptions: null, travelAdvisories: null,
    travelAdvisoryMaxLevel: null, gpsJammingHexes: null, isTier1: !!TIER1_COUNTRIES[code],
    thermalEscalations: null, sanctionsDesignations: null, sanctionsNewDesignations: null,
  };
}

export function recoverCountrySignals(next: CountrySignalCounts, previous: CountrySignalCounts | null, denied: readonly (keyof CountryMilitarySignalCounts)[]) {
  const signals = { ...next };
  const retained: string[] = [];
  const labels = {
    militaryFlights: 'near-country flights', militaryFlightsInCountry: 'in-country flights',
    militaryVessels: 'near-country vessels', militaryVesselsInCountry: 'in-country vessels',
  } satisfies Record<keyof CountryMilitarySignalCounts, string>;
  for (const key of Object.keys(labels) as Array<keyof CountryMilitarySignalCounts>) {
    if (next[key] === null && previous?.[key] != null && !denied.includes(key)) {
      signals[key] = previous[key];
      retained.push(labels[key]);
    }
  }
  return { signals, notes: retained.length ? [`Refresh could not confirm ${retained.join(', ')}. Showing previously loaded observations for this country; these counts are not fresh.`] : [] };
}
