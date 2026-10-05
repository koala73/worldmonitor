import { RAW_SIGNAL_FAMILIES, projectRawSignals, type RawSignalFamily, type RawSignalsValue, type RawSignalOutcome } from '../../shared/country-raw-signals';
import { TIER1_COUNTRIES } from '@/config/countries';
import type { CountrySignalCounts } from '@/types';
import type { CountryMilitarySignalCounts } from './country-military-activity';

export type CountryRawSignalValues = Pick<CountrySignalCounts, 'earthquakes' | 'outages' | 'travelAdvisories' | 'travelAdvisoryMaxLevel' | 'thermalEscalations'>;

export function countrySignalsFromMilitary(code: string, military?: CountryMilitarySignalCounts, raw?: CountryRawSignalValues): CountrySignalCounts {
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
    ...raw,
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


export type CountryRawSignalDisplays = {
  [Family in RawSignalFamily]: { latest: RawSignalsValue['sources'][Family]; observation: RawSignalsValue['sources'][Family] | null; retained: boolean };
};
export type CountryRawSignalSlot = { countryCode: string; families: CountryRawSignalDisplays };

export function recoverRawSignals(next: RawSignalsValue, previous: CountryRawSignalSlot | null): CountryRawSignalSlot {
  function display<Family extends RawSignalFamily>(family: Family): CountryRawSignalDisplays[Family] {
    const latest = next.sources[family];
    const prior = previous?.countryCode === next.countryCode ? previous.families[family].observation : null;
    const retained = latest.state !== 'locked' && (latest.state !== 'observed' || latest.partial) && prior?.state === 'observed' && !prior.partial;
    return { latest, observation: retained ? prior : latest.state === 'observed' ? latest : null, retained } as CountryRawSignalDisplays[Family];
  }
  return { countryCode: next.countryCode, families: { earthquakes: display('earthquakes'), outages: display('outages'), advisories: display('advisories'), thermal: display('thermal') } };
}

function observationDates(source: RawSignalOutcome): Array<string | number> {
  return source.records?.flatMap<string | number>(row => 'occurredAt' in row ? [row.occurredAt] : 'detectedAt' in row ? [row.detectedAt, ...(row.endedAt ? [row.endedAt] : [])] : 'pubDate' in row ? [row.pubDate] : [row.firstDetectedAt, row.lastDetectedAt]) ?? [];
}

export function composeCountrySignals(base: CountrySignalCounts, code: string, name: string, military: CountryMilitarySignalCounts | undefined, militaryNotes: readonly string[], raw: CountryRawSignalSlot | null, hasGeography: boolean, contains: (lat: number, lon: number) => boolean) {
  const notes = [...militaryNotes];
  if (!raw || raw.countryCode !== code) return { signals: { ...base, ...military }, notes, coverage: null };
  const families = raw.families;
  const displayed: RawSignalsValue = { countryCode: code, missing: [], sources: {
    earthquakes: families.earthquakes.observation ?? families.earthquakes.latest,
    outages: families.outages.observation ?? families.outages.latest,
    advisories: families.advisories.observation ?? families.advisories.latest,
    thermal: families.thermal.observation ?? families.thermal.latest,
  } };
  const coverage = Object.fromEntries(RAW_SIGNAL_FAMILIES.map(family => {
    const display = families[family];
    const observation = display.observation;
    const source = observation ?? display.latest;
    const dates = observationDates(source);
    const sortedDates = dates.map(value => typeof value === 'number' ? new Date(value).toISOString() : value).sort();
    const originalDateRange = sortedDates.length ? [sortedDates[0], sortedDates[sortedDates.length - 1]] : [];
    notes.push(`${family}:${display.retained ? ' Showing previously loaded observations for this country; these counts are not fresh.' : ''}${source.partial ? ' Partial evidence; exact country count is unknown.' : ''}${display.latest.reason ? ` Latest attempt: ${display.latest.reason}` : ''} Snapshot time ${source.snapshotAt ?? 'unknown'}; retrieved ${source.retrievedAt}.${source.computationAt ? ` Watch computed ${source.computationAt}; this is not upstream capture time. Reported window ${source.observationWindow}; source version ${source.sourceVersion}.` : ''}${originalDateRange.length ? ` Original returned-sample dates ${originalDateRange.join(' to ')}.` : ''} ${source.attribution} ${source.scope}`);
    return [family, { state: display.latest.state, partial: display.latest.partial, retained: display.retained,
      latestRetrievedAt: display.latest.retrievedAt, latestReason: display.latest.reason,
      observation: observation ? { scope: observation.scope, attribution: observation.attribution, retrievedAt: observation.retrievedAt,
        snapshotAt: observation.snapshotAt, computationAt: observation.computationAt, observationWindow: observation.observationWindow,
        sourceVersion: observation.sourceVersion, originalDateRange, partial: observation.partial } : null }];
  }));
  return { signals: { ...base, ...military, ...projectRawSignals(displayed, name, hasGeography, contains) }, notes, coverage };
}
