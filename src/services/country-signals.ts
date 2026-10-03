import type { CountrySignalCounts } from '@/types';
import type { CountryMilitarySignalCounts } from './country-military-activity';

export function countrySignalsFromMilitary(military?: CountryMilitarySignalCounts): CountrySignalCounts {
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
    travelAdvisoryMaxLevel: null, gpsJammingHexes: null, isTier1: null,
    thermalEscalations: null, sanctionsDesignations: null, sanctionsNewDesignations: null,
  };
}
