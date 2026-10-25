import { projectCountrySignalFamily, unavailableCountrySignal, type CountrySignalOutcome } from '../../../shared/country-signal-observations';

export const qualifiedFixtureTime = 1792324800000;
export const qualifiedFixtureCode = 'IR';
export function qualifiedFixtureOutcomes(): CountrySignalOutcome[] {
  const at = qualifiedFixtureTime;
  const location = { latitude: 35.7, longitude: 51.4 };
  const outcomes = [
    projectCountrySignalFamily('IR', 'outages', { fetchedAt: at, outages: [{ id: 'outage', country: 'IR', title: 'Controlled Internet outage', detectedAt: at, severity: 'OUTAGE_SEVERITY_TOTAL' }] }),
    projectCountrySignalFamily('IR', 'unrest', { events: Array.from({ length: 10 }, (_, i) => ({ id: `unrest-${i}`, country: 'Iran', title: 'Controlled protest', severity: 'SEVERITY_LEVEL_HIGH', sourceType: 'UNREST_SOURCE_TYPE_ACLED', occurredAt: at })) }),
    projectCountrySignalFamily('IR', 'fires', { fetchedAt: at, dataAvailable: true, fireDetections: [{ id: 'fire', brightness: 370, location, detectedAt: at, source: 'firms' }] }),
    projectCountrySignalFamily('IR', 'radiation', { fetchedAt: at, dataAvailable: true, observations: [{ id: 'radiation', country: 'IR', locationName: 'Controlled station', source: 'RADIATION_SOURCE_SAFECAST', severity: 'RADIATION_SEVERITY_SPIKE', observedAt: at }] }),
    projectCountrySignalFamily('IR', 'sanctions', { fetchedAt: String(at), countries: [{ countryCode: 'IR', entryCount: 60, newEntryCount: 5 }] }),
    projectCountrySignalFamily('IR', 'conflict', { scrapedAt: String(at), events: [{ id: 'conflict', country: 'IR', severity: 'low', timestamp: String(at), location }] }),
    projectCountrySignalFamily('IR', 'posture', { state: 'observed', status: 'live', provider: 'adsb.lol', sourceAt: new Date(at).toISOString(), theaters: [{ theater: 'iran-theater', postureLevel: 'normal', assessedAt: at }] }),
  ];
  const military: CountrySignalOutcome = { ...unavailableCountrySignal('IR', 'military', ''), state: 'observed', reason: null, partial: false, scope: 'Controlled eligible military observations', attribution: 'adsb.lol / USNI' };
  military.observations = ['military_flight', 'military_vessel', 'ais_disruption'].map((type, i) => ({ id: String(i), family: 'military', type, severity: 'medium', title: `Controlled ${type}`, source: i ? 'AIS / USNI' : 'adsb.lol', eventAt: new Date(at).toISOString(), snapshotAt: null, timeBasis: 'event' }));
  return [...outcomes, military];
}
