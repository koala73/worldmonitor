import { countryActivityQueries } from '../../shared/country-activity-query';
import { unavailableCountrySignal, sourceClock, qualifiedObservationSchema, type CountrySignalOutcome } from '../../shared/country-signal-observations';
import { CountrySectionError } from './country-brief-error';
import type { CountryBriefSource } from './country-brief-source';
import type { MilitaryVessel } from '@/types';
import { isCountryActivityCoordinate, projectCountryMilitaryActivity, projectCountryMilitarySignalCounts, type CountryMilitarySignalCounts, type Observation } from './country-military-activity';
import { preloadInfrastructureTables } from './related-assets';

const MAX_FLIGHT_PAGES = 8;

export async function loadHostCountryMilitaryActivity(source: CountryBriefSource, code: string, country: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const [{ classifyMilitaryVessel }, { mapProtoToReport, mergeUSNIWithAIS }] = await Promise.all([import('./military-vessels'), import('./usni-fleet')]);
  signal.throwIfAborted();
  const queries = countryActivityQueries(code);
  const flightRead = async () => {
    if (!queries.length) throw new Error('Country flight bounds unavailable');
    const flights = new Map<string, Observation>();
    let pagesRead = 0;
    for (const [windowIndex] of queries.entries()) {
      const seen = new Set<string>();
      let cursor = '';
      for (;;) {
        if (pagesRead >= MAX_FLIGHT_PAGES) throw new Error('Country flight pagination incomplete');
        pagesRead++;
        const result = await source.countryFlightPage(code, windowIndex, cursor, signal);
        for (const flight of result.flights) if (flight.location) flights.set(flight.id, { lat: flight.location.latitude, lon: flight.location.longitude, operatorCountry: flight.operatorCountry, source: flight.source, eventAt: sourceClock(flight.firstSeenAt) });
        const next = result.pagination?.nextCursor;
        if (!next) break;
        if (seen.has(next) || pagesRead >= MAX_FLIGHT_PAGES) throw new Error('Country flight pagination incomplete');
        seen.add(next);
        cursor = next;
      }
    }
    return [...flights.values()];
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
    return { vessels: [...vessels.values()], disruptions: result.snapshot.disruptions ?? [], at: result.snapshot.snapshotAt, invalidReports };
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
  const militaryState = flights !== null || vessels !== null ? 'observed' : denied(flightResult) || denied(aisResult) || denied(fleetResult) ? 'locked' : 'unavailable';
  const qualified: CountrySignalOutcome = { ...unavailableCountrySignal(code, 'military', 'Military source observations unavailable.', militaryState === 'locked' ? 'locked' : 'unavailable'), state: militaryState, partial: flights === null || vessels === null, scope: 'Fixed country activity viewport and existing geographic projection', attribution: 'Redistributable flight providers; AIS / USNI', reason: militaryState === 'observed' ? null : militaryState === 'locked' ? 'This connection is not authorized for military observations.' : 'Military source observations unavailable.' };
  qualified.observationWindow = [ais ? `AIS snapshot ${new Date(ais.at).toISOString()}` : '', fleet ? `USNI report ${fleet.articleDate}` : ''].filter(Boolean).join('; ').slice(0, 200) || null;
  if (flights?.length) {
    const local = flights.filter(row => isCountryActivityCoordinate(row.lat, row.lon, code));
    if (local.length) qualified.observations.push({ id: 'country-flights', family: 'military', type: 'military_flight', severity: local.length >= 10 ? 'high' : local.length >= 5 ? 'medium' : 'low', title: `${local.length} eligible military flight observations`, source: [...new Set(local.map(row => row.source).filter(Boolean))].join(', ').slice(0, 500) || 'Redistributable flight providers', eventAt: local.map(row => row.eventAt).filter((at): at is string => !!at).sort().slice(-1)[0] ?? null, snapshotAt: null, timeBasis: local.some(row => row.eventAt) ? 'event' : 'unknown' });
  }
  if ((summary.nearbyVessels ?? 0) > 0) qualified.observations.push({ id: 'country-vessels', family: 'military', type: 'military_vessel', severity: summary.nearbyVessels! >= 5 ? 'high' : summary.nearbyVessels! >= 2 ? 'medium' : 'low', title: `${summary.nearbyVessels} military vessel observations`, source: fleet ? 'AIS / USNI (reported locations; source dates differ)' : 'AIS candidate snapshot', eventAt: null, snapshotAt: ais && !fleet ? sourceClock(ais.at) : null, timeBasis: ais && !fleet ? 'snapshot' : 'unknown' });
  for (const row of ais?.disruptions ?? []) {
    if (!row.location || !isCountryActivityCoordinate(row.location.latitude, row.location.longitude, code)) continue;
    const observation = qualifiedObservationSchema.safeParse({ id: row.id, family: 'military', type: 'ais_disruption', severity: row.severity.endsWith('_HIGH') ? 'high' : row.severity.endsWith('_ELEVATED') ? 'medium' : 'low', title: row.description.slice(0, 512), source: 'AIS relay disruption snapshot', eventAt: null, snapshotAt: sourceClock(ais!.at), timeBasis: 'snapshot' });
    if (!observation.success) { qualified.partial = true; continue; }
    qualified.observations.push(observation.data);
    if (qualified.observations.length >= 100) { qualified.partial = true; break; }
  }
  if ((!ais || ais.invalidReports > 0 || !fleet) && summary.foreignPresence === false) summary.foreignPresence = null;
  return { ...summary, qualified, deniedSignalFields, signalCounts: projectCountryMilitarySignalCounts(code, flights, vessels), coverage: flights && ais && !ais.invalidReports && fleet ? 'complete' as const : 'partial' as const, coverageNotes: [
    flights ? 'Flight counts include observations licensed for redistribution through this connection.' : 'Flight observations unavailable or unconfirmed. This is not a zero activity count.',
    ais ? `AIS snapshot ${new Date(ais.at).toISOString()}. Country counts use the relay candidate snapshot, bounded to 1,500 reports.${ais.invalidReports ? ` ${ais.invalidReports} military reports with invalid dates excluded; coverage is partial.` : ''}` : 'Live AIS observations unavailable. Current source coverage excludes AIS.',
    fleet ? `USNI fleet report ${fleet.articleDate}. Reported regions and homeports are approximate locations, not live positions.` : 'USNI fleet roster unavailable.',
  ] };
}
