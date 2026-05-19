import type { IntelligenceCache } from '@/app/app-context';
import type { MapLayers } from '@/types';

export type SensorFusionLayerId =
  | 'globe'
  | 'satellites'
  | 'aircraft'
  | 'maritime'
  | 'webcams'
  | 'seismic'
  | 'thermal'
  | 'weather'
  | '3d-reconstruction';

export type SensorFusionStatus = 'live' | 'ready' | 'available' | 'planned';

export interface SensorFusionLayer {
  id: SensorFusionLayerId;
  label: string;
  source: string;
  status: SensorFusionStatus;
  count: number | null;
  note: string;
}

export interface SensorFusionSnapshot {
  liveLayers: number;
  availableLayers: number;
  trackedObjects: number;
  layers: SensorFusionLayer[];
  gaps: string[];
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function statusFromLayer(enabled: boolean | undefined, hasData: boolean): SensorFusionStatus {
  if (enabled && hasData) return 'live';
  if (enabled) return 'ready';
  if (hasData) return 'available';
  return 'planned';
}

export function buildSensorFusionSnapshot(
  cache: IntelligenceCache = {},
  mapLayers: Partial<MapLayers> = {},
): SensorFusionSnapshot {
  const aircraftCount = countArray(cache.aircraftPositions) + countArray(cache.military?.flights);
  const maritimeCount = countArray(cache.military?.vessels);
  const seismicCount = countArray(cache.earthquakes);
  const thermalCount = countArray(cache.thermalEscalation?.clusters);
  const imageryCount = countArray(cache.imageryScenes);

  const layers: SensorFusionLayer[] = [
    {
      id: 'globe',
      label: '3D globe shell',
      source: 'globe.gl / deck.gl map engines',
      status: 'live',
      count: null,
      note: 'Base geospatial canvas for fused situational awareness.',
    },
    {
      id: 'aircraft',
      label: 'Aircraft tracks',
      source: 'commercial + military aviation feeds',
      status: statusFromLayer(mapLayers.flights || mapLayers.military, aircraftCount > 0),
      count: aircraftCount,
      note: 'WorldView-style ADS-B layer for motion over the terrain.',
    },
    {
      id: 'maritime',
      label: 'Maritime posture',
      source: 'AIS / naval intelligence feeds',
      status: statusFromLayer(mapLayers.ais || mapLayers.military, maritimeCount > 0),
      count: maritimeCount,
      note: 'Vessel layer for chokepoints, ports, and regional convergence.',
    },
    {
      id: 'satellites',
      label: 'Satellites + imagery',
      source: 'orbital tracks / imagery scene footprints',
      status: statusFromLayer(mapLayers.satellites, imageryCount > 0),
      count: imageryCount,
      note: 'Imagery footprints are ready; orbital object counts depend on the satellite layer feed.',
    },
    {
      id: 'webcams',
      label: 'Live webcams',
      source: 'public webcam panels',
      status: statusFromLayer(mapLayers.webcams, false),
      count: null,
      note: 'Public camera feeds belong here, with explicit source attribution and privacy guardrails.',
    },
    {
      id: 'seismic',
      label: 'Seismic activity',
      source: 'USGS / earthquake feed',
      status: statusFromLayer(mapLayers.natural, seismicCount > 0),
      count: seismicCount,
      note: 'Earthquake points provide the fast disaster layer from the WorldView demo.',
    },
    {
      id: 'thermal',
      label: 'Thermal escalation',
      source: 'FIRMS-derived fire and thermal anomaly models',
      status: statusFromLayer(mapLayers.fires || mapLayers.natural, thermalCount > 0),
      count: thermalCount,
      note: 'Conflict-adjacent heat signatures bridge remote sensing and strategic risk.',
    },
    {
      id: 'weather',
      label: 'Weather / atmosphere',
      source: 'weather and radar layers',
      status: statusFromLayer(mapLayers.weather, false),
      count: null,
      note: 'Atmospheric context improves interpretation of aviation, maritime, and disaster layers.',
    },
    {
      id: '3d-reconstruction',
      label: 'Sparse 3D reconstruction',
      source: 'MegaDepth-X / VGGT / 3DGS research path',
      status: 'planned',
      count: null,
      note: 'Roadmap lane for turning sparse public imagery into local 3D context, not active surveillance.',
    },
  ];

  const liveLayers = layers.filter(layer => layer.status === 'live').length;
  const availableLayers = layers.filter(layer => layer.status !== 'planned').length;
  const trackedObjects = layers.reduce((sum, layer) => sum + (layer.count ?? 0), 0);
  const gaps = layers
    .filter(layer => layer.status === 'planned')
    .map(layer => layer.label);

  return { liveLayers, availableLayers, trackedObjects, layers, gaps };
}
