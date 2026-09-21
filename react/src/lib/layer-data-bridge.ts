/**
 * Layer data bridge for React MonitorMap.
 *
 * Mirrors vanilla DataLoaderManager.loadDataForLayer for map paint data:
 * static geo (conflicts, bases, nuclear, cables geometry, …) paints from
 * DeckGLMap config imports when setLayers enables them — no fetch.
 * Dynamic layers hydrate via the same @/services fetchers as :3030.
 */
import type { MapLayers } from '@/types';
import { ensurePipelineRegistriesHydrated } from '@/shared/pipeline-registry-store';
import {
  fetchWeatherAlerts,
  fetchAisSignals,
  fetchProtestEvents,
  fetchNaturalEvents,
  fetchEarthquakes,
  fetchInternetOutages,
  fetchCableHealth,
  fetchCanadaRoads,
  fetchCanadaAlerts,
  fetchMilitaryFlights,
  fetchIranEvents,
  fetchUcdpEvents,
  fetchClimateAnomalies,
  fetchAllFires,
  flattenFires,
  toMapFires,
  fetchRadiationWatch,
} from '@/services';
import { fetchGpsInterference } from '@/services/gps-interference';
import { fetchUnhcrPopulation } from '@/services/displacement';
import { fetchDiseaseOutbreaks } from '@/services/disease-outbreaks';
import { fetchSatelliteTLEs, initSatRecs, propagatePositions } from '@/services/satellites';
import { fetchPositiveGeoEvents } from '@/services/positive-events-geo';
import { getResilienceRanking } from '@/services/resilience';

/** Minimal MapContainer surface the bridge needs. */
export type MapDataApi = {
  getState?: () => { zoom?: number };
  getBbox?: () => string | null;
  setWeatherAlerts: (alerts: Awaited<ReturnType<typeof fetchWeatherAlerts>>) => void;
  setEarthquakes: (eq: Awaited<ReturnType<typeof fetchEarthquakes>>) => void;
  setAisData: (
    disruptions: Awaited<ReturnType<typeof fetchAisSignals>>['disruptions'],
    density: Awaited<ReturnType<typeof fetchAisSignals>>['density'],
  ) => void;
  setProtests: (events: import('@/types').SocialUnrestEvent[]) => void;
  setNaturalEvents: (events: Awaited<ReturnType<typeof fetchNaturalEvents>>) => void;
  setOutages: (outages: Awaited<ReturnType<typeof fetchInternetOutages>>) => void;
  setCableHealth: (health: Awaited<ReturnType<typeof fetchCableHealth>>['cables']) => void;
  setCableActivity?: (
    advisories: import('@/types').CableAdvisory[],
    ships: import('@/types').RepairShip[],
  ) => void;
  setCanadaRoads?: (records: Awaited<ReturnType<typeof fetchCanadaRoads>>) => void;
  setCanadaAlerts?: (alerts: Awaited<ReturnType<typeof fetchCanadaAlerts>>) => void;
  setFires?: (fires: ReturnType<typeof toMapFires>) => void;
  setCyberThreats?: (threats: import('@/types').CyberThreat[]) => void;
  setMilitaryFlights?: (
    flights: Awaited<ReturnType<typeof fetchMilitaryFlights>>['flights'],
    clusters: Awaited<ReturnType<typeof fetchMilitaryFlights>>['clusters'],
  ) => void;
  setMilitaryVessels?: (
    vessels: import('@/types').MilitaryVessel[],
    clusters?: import('@/types').MilitaryVesselCluster[],
  ) => void;
  setFlightDelays?: (delays: import('@/services/aviation').AirportDelayAlert[]) => void;
  setIranEvents?: (events: Awaited<ReturnType<typeof fetchIranEvents>>) => void;
  setUcdpEvents?: (events: import('@/types').UcdpGeoEvent[]) => void;
  setDisplacementFlows?: (flows: import('@/services/displacement').DisplacementFlow[]) => void;
  setClimateAnomalies?: (
    anomalies: NonNullable<Awaited<ReturnType<typeof fetchClimateAnomalies>>['anomalies']>,
  ) => void;
  setGpsJamming?: (
    hexes: NonNullable<Awaited<ReturnType<typeof fetchGpsInterference>>>['hexes'],
  ) => void | Promise<void>;
  setRadiationObservations?: (
    observations: Awaited<ReturnType<typeof fetchRadiationWatch>>['observations'],
  ) => void;
  setSatellites?: (positions: import('@/services/satellites').SatellitePosition[]) => void;
  setWebcams?: (
    markers: Array<
      | import('@/generated/client/worldmonitor/webcam/v1/service_client').WebcamEntry
      | import('@/generated/client/worldmonitor/webcam/v1/service_client').WebcamCluster
    >,
  ) => void;
  setPositiveEvents?: (events: Awaited<ReturnType<typeof fetchPositiveGeoEvents>>) => void;
  setDiseaseOutbreaks?: (
    outbreaks: import('@/services/disease-outbreaks').DiseaseOutbreakItem[],
  ) => void;
  setResilienceRanking?: (
    items: Awaited<ReturnType<typeof getResilienceRanking>>['items'],
    greyedOut?: Awaited<ReturnType<typeof getResilienceRanking>>['greyedOut'],
  ) => void;
  setTechEvents?: (
    events: Array<{
      id: string;
      title: string;
      location: string;
      lat: number;
      lng: number;
      country: string;
      startDate: string;
      endDate: string;
      url: string | null;
      daysUntil: number;
    }>,
  ) => void;
  setNewsLocations?: (
    data: Array<{
      lat: number;
      lon: number;
      title: string;
      threatLevel: string;
      timestamp?: Date;
    }>,
  ) => void;
  setLayerLoading: (layer: keyof MapLayers, loading: boolean) => void;
  setLayerReady?: (layer: keyof MapLayers, ready: boolean) => void;
};

const inFlight = new Set<string>();

/**
 * Layers whose paint data is baked into DeckGLMap (config / geo imports).
 * Enabling via setLayers is enough — no bridge fetch.
 */
const STATIC_OWNED = new Set<string>([
  'conflicts',
  'hotspots',
  // convoHotspots catalog is static; Live news channel hydrates via fetch
  'aiUsage',
  'aiPolicy',
  'nuclear',
  'irradiators',
  'bases',
  'waterways',
  'tradeRoutes',
  'spaceports',
  'minerals',
  'datacenters',
  'startupHubs',
  'techHQs',
  'cloudRegions',
  'stockExchanges',
  'financialCenters',
  'centralBanks',
  'commodityHubs',
  'commodityPorts',
  'dayNight',
  'ciiChoropleth',
  'economic',
  'gulfInvestments',
  'accelerators',
  'happiness',
  'speciesRecovery',
  'renewableInstallations',
  'miningSites',
  'processingPlants',
  // Sanctions countries choropleth uses SANCTIONED_COUNTRIES_ALPHA2 in DeckGLMap;
  // fetchSanctionsPressure feeds a panel, not map geometry — keep static.
  'sanctions',
]);

export async function loadLayerData(
  map: MapDataApi,
  layer: keyof MapLayers,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  if (STATIC_OWNED.has(layer)) return;
  if (inFlight.has(layer)) return;

  inFlight.add(layer);
  map.setLayerLoading(layer, true);

  try {
    switch (layer) {
      case 'pipelines':
      case 'storageFacilities':
      case 'fuelShortages':
      case 'liveTankers':
        await ensurePipelineRegistriesHydrated();
        map.setLayerReady?.(layer, true);
        break;

      case 'weather': {
        const alerts = await fetchWeatherAlerts();
        map.setWeatherAlerts(alerts);
        map.setLayerReady?.('weather', alerts.length > 0);
        break;
      }

      case 'natural': {
        const [quakes, events] = await Promise.all([
          fetchEarthquakes().catch(() => []),
          fetchNaturalEvents(30).catch(() => []),
        ]);
        map.setEarthquakes(quakes);
        map.setNaturalEvents(events);
        map.setLayerReady?.(
          'natural',
          quakes.length > 0 || events.length > 0,
        );
        break;
      }

      case 'fires': {
        const fireResult = await fetchAllFires(1);
        if (!fireResult.skipped && fireResult.totalCount > 0) {
          const flat = flattenFires(fireResult.regions);
          map.setFires?.(toMapFires(flat));
          map.setLayerReady?.('fires', true);
        } else {
          map.setLayerReady?.('fires', false);
        }
        break;
      }

      case 'ais': {
        const ais = await fetchAisSignals();
        map.setAisData(ais.disruptions ?? [], ais.density ?? []);
        map.setLayerReady?.(
          'ais',
          (ais.disruptions?.length ?? 0) > 0 || (ais.density?.length ?? 0) > 0,
        );
        break;
      }

      case 'protests': {
        const data = await fetchProtestEvents();
        map.setProtests(data.events ?? []);
        map.setLayerReady?.('protests', (data.events?.length ?? 0) > 0);
        break;
      }

      case 'outages': {
        const outages = await fetchInternetOutages();
        map.setOutages(outages);
        map.setLayerReady?.('outages', outages.length > 0);
        break;
      }

      case 'cables': {
        try {
          const health = await fetchCableHealth();
          map.setCableHealth(health.cables);
        } catch {
          /* geometry still paints from UNDERSEA_CABLES */
        }
        try {
          const { fetchCableActivity } = await import('@/services/cable-activity');
          const activity = await fetchCableActivity();
          map.setCableActivity?.(activity.advisories, activity.repairShips);
        } catch {
          /* optional overlay */
        }
        break;
      }

      case 'canadaRoads': {
        const roads = await fetchCanadaRoads();
        map.setCanadaRoads?.(roads);
        map.setLayerReady?.('canadaRoads', roads.length > 0);
        break;
      }

      case 'canadaAlerts': {
        const alerts = await fetchCanadaAlerts();
        map.setCanadaAlerts?.(alerts);
        map.setLayerReady?.('canadaAlerts', alerts.length > 0);
        break;
      }

      case 'cyberThreats': {
        const { fetchCyberThreats } = await import('@/services/cyber');
        const threats = await fetchCyberThreats({ limit: 500, days: 14 });
        map.setCyberThreats?.(threats);
        map.setLayerReady?.('cyberThreats', threats.length > 0);
        break;
      }

      case 'flights': {
        const { fetchFlightDelays } = await import('@/services/aviation');
        const delays = await fetchFlightDelays();
        map.setFlightDelays?.(delays);
        map.setLayerReady?.('flights', delays.length > 0);
        break;
      }

      case 'military': {
        const flightData = await fetchMilitaryFlights();
        map.setMilitaryFlights?.(flightData.flights, flightData.clusters);
        try {
          const vesselsMod = await import('@/services/military-vessels');
          if (vesselsMod.isMilitaryVesselTrackingConfigured()) {
            vesselsMod.initMilitaryVesselStream();
          }
          const vesselData = await vesselsMod.fetchMilitaryVessels();
          map.setMilitaryVessels?.(vesselData.vessels, vesselData.clusters);
          map.setLayerReady?.(
            'military',
            flightData.flights.length > 0 || vesselData.vessels.length > 0,
          );
        } catch {
          map.setLayerReady?.('military', flightData.flights.length > 0);
        }
        break;
      }

      case 'iranAttacks': {
        const events = await fetchIranEvents();
        map.setIranEvents?.(events);
        map.setLayerReady?.('iranAttacks', events.length > 0);
        break;
      }

      case 'ucdpEvents': {
        const result = await fetchUcdpEvents();
        const events = result.success ? result.data : [];
        map.setUcdpEvents?.(events);
        map.setLayerReady?.('ucdpEvents', events.length > 0);
        break;
      }

      case 'displacement': {
        const unhcr = await fetchUnhcrPopulation();
        const flows = unhcr.ok ? (unhcr.data.topFlows ?? []) : [];
        map.setDisplacementFlows?.(flows);
        map.setLayerReady?.('displacement', flows.length > 0);
        break;
      }

      case 'climate': {
        const climate = await fetchClimateAnomalies();
        const anomalies = climate.ok ? (climate.anomalies ?? []) : [];
        map.setClimateAnomalies?.(anomalies);
        map.setLayerReady?.('climate', anomalies.length > 0);
        break;
      }

      case 'gpsJamming': {
        const data = await fetchGpsInterference();
        const hexes = data?.hexes ?? [];
        await map.setGpsJamming?.(hexes);
        map.setLayerReady?.('gpsJamming', hexes.length > 0);
        break;
      }

      case 'radiationWatch': {
        const result = await fetchRadiationWatch();
        const anomalies = result.observations.filter((o) => o.severity !== 'normal');
        map.setRadiationObservations?.(anomalies);
        map.setLayerReady?.('radiationWatch', anomalies.length > 0);
        break;
      }

      case 'satellites': {
        const tles = await fetchSatelliteTLEs();
        if (tles?.length) {
          const satRecs = await initSatRecs(tles);
          const positions = propagatePositions(satRecs);
          map.setSatellites?.(positions);
          map.setLayerReady?.('satellites', positions.length > 0);
        } else {
          map.setLayerReady?.('satellites', false);
        }
        break;
      }

      case 'webcams': {
        const zoom = Math.max(2, map.getState?.()?.zoom ?? 3);
        const bboxStr = map.getBbox?.() ?? null;
        const parts = bboxStr ? bboxStr.split(',').map(Number) : [-180, -90, 180, 90];
        const [w, s, e, n] = [
          parts[0] ?? -180,
          parts[1] ?? -90,
          parts[2] ?? 180,
          parts[3] ?? 90,
        ];
        const { fetchWebcams } = await import('@/services/webcams');
        const result = await fetchWebcams(zoom, { w, s, e, n });
        const allMarkers = [...result.webcams, ...result.clusters];
        map.setWebcams?.(allMarkers);
        map.setLayerReady?.('webcams', allMarkers.length > 0);
        break;
      }

      case 'positiveEvents': {
        const events = await fetchPositiveGeoEvents();
        map.setPositiveEvents?.(events);
        map.setLayerReady?.('positiveEvents', events.length > 0);
        break;
      }

      case 'diseaseOutbreaks': {
        const data = await fetchDiseaseOutbreaks();
        const outbreaks = data.outbreaks ?? [];
        if (outbreaks.length > 0 && Number.isFinite(data.fetchedAt) && data.fetchedAt > 0) {
          map.setDiseaseOutbreaks?.(outbreaks);
          map.setLayerReady?.('diseaseOutbreaks', true);
        } else {
          map.setLayerReady?.('diseaseOutbreaks', false);
        }
        break;
      }

      case 'resilienceScore': {
        try {
          const result = await getResilienceRanking();
          map.setResilienceRanking?.(result.items, result.greyedOut ?? []);
          map.setLayerReady?.(
            'resilienceScore',
            (result.items?.length ?? 0) > 0,
          );
        } catch {
          map.setResilienceRanking?.([]);
          map.setLayerReady?.('resilienceScore', false);
        }
        break;
      }

      case 'convoHotspots': {
        // Catalog wiki/Trends/GDELT points paint from static config; Live news
        // channel needs digest → setNewsLocations (hub geo or article location).
        try {
          const { fetchConvoLiveNewsLocations } = await import(
            '@/services/convo-live-news'
          );
          const locs = await fetchConvoLiveNewsLocations();
          map.setNewsLocations?.(locs);
          // Ready if catalog or live pins exist — catalog alone is enough to paint.
          map.setLayerReady?.('convoHotspots', true);
        } catch (err) {
          console.warn('[layer-data-bridge] convoHotspots live news failed', err);
          map.setLayerReady?.('convoHotspots', true);
        }
        break;
      }

      case 'techEvents': {
        try {
          const { fetchTechEvents } = await import('@/services/research');
          const events = await fetchTechEvents({ days: 90, limit: 50 });
          map.setTechEvents?.(events);
          map.setLayerReady?.('techEvents', events.length > 0);
        } catch (err) {
          console.warn('[layer-data-bridge] techEvents failed', err);
          map.setTechEvents?.([]);
          map.setLayerReady?.('techEvents', false);
        }
        break;
      }

      case 'kindness':
        // Needs happy-news context — skip without inventing points
        map.setLayerReady?.(layer, false);
        break;

      default:
        break;
    }
  } catch (err) {
    console.warn(`[layer-data-bridge] ${String(layer)} failed`, err);
    map.setLayerReady?.(layer, false);
  } finally {
    inFlight.delete(layer);
    map.setLayerLoading(layer, false);
  }
}

/** Load every enabled layer that needs a fetch (mission / URL boot). */
export async function loadEnabledLayers(
  map: MapDataApi,
  layers: MapLayers,
): Promise<void> {
  const keys = Object.keys(layers) as Array<keyof MapLayers>;
  await Promise.all(
    keys.filter((k) => layers[k]).map((k) => loadLayerData(map, k, true)),
  );
}
