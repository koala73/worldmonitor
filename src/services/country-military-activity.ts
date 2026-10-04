import { countryActivityQueries } from '../../shared/country-activity-query';
import type { CountrySignalCounts } from '@/types';
import { countryTermIndex } from '../../shared/country-headline-match';
import { ME_STRIKE_BOUNDS, getCountryCentroid, hasCountryGeometry, isCoordinateInCountry, iso3ToIso2Code, nameToCountryCode } from './country-geometry';
import { getNearbyInfrastructure, preloadInfrastructureTables } from './related-assets';
import { getCachedMilitaryBases } from './military-base-config';
import { CountrySectionError } from './country-brief-error';
import type { CountryBriefSource } from './country-brief-source';
import type { MilitaryVessel } from '@/types';

export const COUNTRY_ACTIVITY_BOUNDS: Record<string, { n: number; s: number; e: number; w: number }> = {
  ...ME_STRIKE_BOUNDS,
  CN: { n: 53.6, s: 18.2, e: 134.8, w: 73.5 }, TW: { n: 25.3, s: 21.9, e: 122, w: 120 },
  JP: { n: 45.5, s: 24.2, e: 153.9, w: 122.9 }, KR: { n: 38.6, s: 33.1, e: 131.9, w: 124.6 },
  KP: { n: 43.0, s: 37.7, e: 130.7, w: 124.2 }, IN: { n: 35.5, s: 6.7, e: 97.4, w: 68.2 },
  PK: { n: 37, s: 24, e: 77, w: 61 }, AF: { n: 38.5, s: 29.4, e: 74.9, w: 60.5 },
  UA: { n: 52.4, s: 44.4, e: 40.2, w: 22.1 }, RU: { n: 82, s: 41.2, e: 180, w: 19.6 },
  BY: { n: 56.2, s: 51.3, e: 32.8, w: 23.2 }, PL: { n: 54.8, s: 49, e: 24.1, w: 14.1 },
  EG: { n: 31.7, s: 22, e: 36.9, w: 25 }, LY: { n: 33, s: 19.5, e: 25, w: 9.4 },
  SD: { n: 22, s: 8.7, e: 38.6, w: 21.8 }, US: { n: 49, s: 24.5, e: -66.9, w: -125 },
  GB: { n: 58.7, s: 49.9, e: 1.8, w: -8.2 }, DE: { n: 55.1, s: 47.3, e: 15.0, w: 5.9 },
  FR: { n: 51.1, s: 41.3, e: 9.6, w: -5.1 }, TR: { n: 42.1, s: 36, e: 44.8, w: 26 },
  BR: { n: 5.3, s: -33.8, e: -34.8, w: -73.9 },
};

const MAX_FLIGHT_PAGES = 8;

type Observation = { lat: number; lon: number; operatorCountry: string };
export type CountryMilitarySignalCounts = Pick<CountrySignalCounts, 'militaryFlights' | 'militaryFlightsInCountry' | 'militaryVessels' | 'militaryVesselsInCountry'>;
type ObservedMilitarySignalCounts = { [K in keyof CountryMilitarySignalCounts]: number };

export function projectCountryMilitarySignalCounts(code: string, flights: readonly Observation[], vessels: readonly Observation[]): ObservedMilitarySignalCounts;
export function projectCountryMilitarySignalCounts(code: string, flights: readonly Observation[] | null, vessels: readonly Observation[] | null): CountryMilitarySignalCounts;
export function projectCountryMilitarySignalCounts(code: string, flights: readonly Observation[] | null, vessels: readonly Observation[] | null): CountryMilitarySignalCounts {
  const geographic = hasCountryGeometry(code) || !!COUNTRY_ACTIVITY_BOUNDS[code];
  const inside = (item: Observation) => geographic ? isCountryActivityCoordinate(item.lat, item.lon, code) : item.operatorCountry?.toUpperCase() === code;
  const near = (item: Observation) => {
    if (inside(item)) return true;
    const bounds = COUNTRY_ACTIVITY_BOUNDS[code];
    return geographic && !!bounds && item.lat >= bounds.s - 2 && item.lat <= bounds.n + 2 && item.lon >= bounds.w - 2 && item.lon <= bounds.e + 2;
  };
  return {
    militaryFlights: flights?.filter(near).length ?? null,
    militaryVessels: vessels?.filter(near).length ?? null,
    militaryFlightsInCountry: flights?.filter(inside).length ?? null,
    militaryVesselsInCountry: vessels?.filter(inside).length ?? null,
  };
}

export function isCountryActivityCoordinate(lat: number, lon: number, code: string): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const precise = isCoordinateInCountry(lat, lon, code);
  if (precise !== null) return precise;
  const box = COUNTRY_ACTIVITY_BOUNDS[code];
  return !!box && lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e;
}

function sameOperator(code: string, country: string, raw: string): boolean {
  const normalized = raw.trim();
  const upper = normalized.toUpperCase();
  return upper === code || (upper.length === 3 && iso3ToIso2Code(upper) === code)
    || nameToCountryCode(normalized.toLowerCase()) === code
    || countryTermIndex(normalized.toLowerCase(), country.toLowerCase()) !== -1;
}

export function projectCountryMilitaryActivity(code: string, country: string, flights: Observation[] | null, vessels: Observation[] | null) {
  const geographic = hasCountryGeometry(code) || !!COUNTRY_ACTIVITY_BOUNDS[code];
  const contained = (item: Observation) => geographic ? isCountryActivityCoordinate(item.lat, item.lon, code) : sameOperator(code, country, item.operatorCountry);
  const localFlights = flights?.filter(contained);
  const localVessels = vessels?.filter(contained);
  const ownFlights = localFlights?.filter(item => sameOperator(code, country, item.operatorCountry)).length ?? null;
  const foreignFlights = localFlights && ownFlights !== null ? localFlights.length - ownFlights : null;
  const foreignVessels = localVessels?.filter(item => !sameOperator(code, country, item.operatorCountry)).length ?? null;
  const foreignPresence = (foreignFlights ?? 0) > 0 || (foreignVessels ?? 0) > 0 ? true
    : flights === null || vessels === null ? null : false;
  const centroid = getCountryCentroid(code, COUNTRY_ACTIVITY_BOUNDS);
  const nearestBases = centroid ? getNearbyInfrastructure(centroid.lat, centroid.lon, ['base']).slice(0, 3).map(base => ({
    id: base.id, name: base.name, distanceKm: base.distanceKm,
    country: getCachedMilitaryBases().find(entry => entry.id === base.id)?.country,
  })) : [];
  return { ownFlights, foreignFlights, nearbyVessels: localVessels?.length ?? null, nearestBases, foreignPresence };
}

export async function loadHostCountryMilitaryActivity(source: CountryBriefSource, code: string, country: string, signal: AbortSignal) {
  const [{ classifyMilitaryVessel }, { mapProtoToReport, mergeUSNIWithAIS }] = await Promise.all([import('./military-vessels'), import('./usni-fleet')]);
  signal.throwIfAborted();
  const queries = countryActivityQueries(code);
  const flightRead = async () => {
    if (!queries.length) throw new Error('Country flight bounds unavailable');
    const flights = new Map<string, Observation>();
    let pagesRead = 0;
    for (const box of queries) {
      const seen = new Set<string>();
      let cursor = '';
      for (;;) {
        if (pagesRead >= MAX_FLIGHT_PAGES) throw new Error('Country flight pagination incomplete');
        pagesRead++;
        const result = await source.military.listMilitaryFlights({ neLat: box.ne_lat, neLon: box.ne_lon, swLat: box.sw_lat, swLon: box.sw_lon, pageSize: 100, cursor, operator: 'MILITARY_OPERATOR_UNSPECIFIED', aircraftType: 'MILITARY_AIRCRAFT_TYPE_UNSPECIFIED' }, { signal });
        for (const flight of result.flights) if (flight.location) flights.set(flight.id, { lat: flight.location.latitude, lon: flight.location.longitude, operatorCountry: flight.operatorCountry });
        const next = result.pagination?.nextCursor;
        if (!next) break;
        if (seen.has(next) || pagesRead >= MAX_FLIGHT_PAGES) throw new Error('Country flight pagination incomplete');
        seen.add(next);
        cursor = next;
      }
    }
    return flights.size ? [...flights.values()] : null;
  };
  const aisRead = async () => {
    const vessels = new Map<string, MilitaryVessel>();
    const result = await source.vessels.getVesselSnapshot({ neLat: 0, neLon: 0, swLat: 0, swLon: 0, includeCandidates: true, includeTankers: false }, { signal });
    if (!result.dataAvailable || !result.snapshot || !result.snapshot.status?.connected || !Number.isFinite(result.snapshot.snapshotAt) || result.snapshot.snapshotAt <= 0 || Date.now() - result.snapshot.snapshotAt > 3_600_000 || result.snapshot.snapshotAt > Date.now() + 300_000) throw new Error('AIS snapshot unavailable or stale');
    let invalidReports = 0;
    for (const report of result.snapshot.candidateReports) {
      const vessel = classifyMilitaryVessel(report);
      if (!vessel) continue;
      if (!Number.isFinite(report.timestamp) || report.timestamp <= 0 || report.timestamp > Date.now() + 300_000) { invalidReports++; continue; }
      if (Date.now() - report.timestamp > 3_600_000) continue;
      vessels.set(vessel.id, vessel);
    }
    return { vessels: [...vessels.values()], at: result.snapshot.snapshotAt, invalidReports };
  };
  const [flightResult, aisResult, fleetResult] = await Promise.allSettled([
    flightRead(), aisRead(), source.military.getUSNIFleetReport({ forceRefresh: false }, { signal }).then(mapProtoToReport),
  ]);
  signal.throwIfAborted();
  const denied = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' && result.reason instanceof CountrySectionError && result.reason.state === 'locked';
  const deniedSignalFields: Array<keyof CountryMilitarySignalCounts> = [];
  if (denied(flightResult)) deniedSignalFields.push('militaryFlights', 'militaryFlightsInCountry');
  if (denied(aisResult) || denied(fleetResult)) deniedSignalFields.push('militaryVessels', 'militaryVesselsInCountry');
  const flights = flightResult.status === 'fulfilled' ? flightResult.value : null;
  const ais = aisResult.status === 'fulfilled' ? aisResult.value : null;
  const fleet = fleetResult.status === 'fulfilled' ? fleetResult.value : null;
  const vessels = fleet ? mergeUSNIWithAIS(ais?.vessels ?? [], fleet).vessels : ais?.vessels ?? null;
  await preloadInfrastructureTables();
  signal.throwIfAborted();
  const summary = projectCountryMilitaryActivity(code, country, flights, vessels);
  if ((!ais || ais.invalidReports > 0 || !fleet) && summary.foreignPresence === false) summary.foreignPresence = null;
  return { ...summary, deniedSignalFields, signalCounts: projectCountryMilitarySignalCounts(code, flights, vessels), coverage: flights && ais && !ais.invalidReports && fleet ? 'complete' as const : 'partial' as const, coverageNotes: [
    flights ? 'Flight counts include observations licensed for redistribution through this connection.' : 'Flight observations unavailable or unconfirmed. This is not a zero activity count.',
    ais ? `AIS snapshot ${new Date(ais.at).toISOString()}. Country counts use the relay candidate snapshot, bounded to 1,500 reports.${ais.invalidReports ? ` ${ais.invalidReports} military reports with invalid dates excluded; coverage is partial.` : ''}` : 'Live AIS observations unavailable. Current source coverage excludes AIS.',
    fleet ? `USNI fleet report ${fleet.articleDate}. Reported regions and homeports are approximate locations, not live positions.` : 'USNI fleet roster unavailable.',
  ] };
}
