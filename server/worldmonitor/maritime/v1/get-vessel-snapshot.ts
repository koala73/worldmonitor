declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetVesselSnapshotRequest,
  GetVesselSnapshotResponse,
  VesselSnapshot,
  AisDensityZone,
  AisDisruption,
  AisDisruptionType,
  AisDisruptionSeverity,
} from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Helpers
// ========================================================================

function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .replace(/\/$/, '');
}

const DISRUPTION_TYPE_MAP: Record<string, AisDisruptionType> = {
  gap_spike: 'AIS_DISRUPTION_TYPE_GAP_SPIKE',
  chokepoint_congestion: 'AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION',
};

const SEVERITY_MAP: Record<string, AisDisruptionSeverity> = {
  low: 'AIS_DISRUPTION_SEVERITY_LOW',
  elevated: 'AIS_DISRUPTION_SEVERITY_ELEVATED',
  high: 'AIS_DISRUPTION_SEVERITY_HIGH',
};

// In-memory cache (matches old /api/ais-snapshot behavior)
const SNAPSHOT_CACHE_TTL_MS = 10_000; // 10 seconds -- matches client poll interval
let cachedSnapshot: VesselSnapshot | undefined;
let cacheTimestamp = 0;
let inFlightRequest: Promise<VesselSnapshot | undefined> | null = null;

async function fetchVesselSnapshot(): Promise<VesselSnapshot | undefined> {
  // Return cached if fresh
  const now = Date.now();
  if (cachedSnapshot && (now - cacheTimestamp) < SNAPSHOT_CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  // In-flight dedup: if a request is already running, await it
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = fetchVesselSnapshotFromRelay();
  try {
    const result = await inFlightRequest;
    if (result) {
      cachedSnapshot = result;
      cacheTimestamp = Date.now();
    }
    return result ?? cachedSnapshot; // serve stale on relay failure
  } finally {
    inFlightRequest = null;
  }
}

async function fetchVesselSnapshotFromRelay(): Promise<VesselSnapshot | undefined> {
  try {
    const relayBaseUrl = getRelayBaseUrl();
    if (!relayBaseUrl) return undefined;

    const response = await fetch(
      `${relayBaseUrl}/ais/snapshot?candidates=false`,
      {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) return undefined;

    const data = await response.json();
    if (!data || !Array.isArray(data.disruptions) || !Array.isArray(data.density)) {
      return undefined;
    }

    const densityZones: AisDensityZone[] = data.density.map((z: any): AisDensityZone => ({
      id: String(z.id || ''),
      name: String(z.name || ''),
      location: {
        latitude: Number(z.lat) || 0,
        longitude: Number(z.lon) || 0,
      },
      intensity: Number(z.intensity) || 0,
      deltaPct: Number(z.deltaPct) || 0,
      shipsPerDay: Number(z.shipsPerDay) || 0,
      note: String(z.note || ''),
    }));

    const disruptions: AisDisruption[] = data.disruptions.map((d: any): AisDisruption => ({
      id: String(d.id || ''),
      name: String(d.name || ''),
      type: DISRUPTION_TYPE_MAP[d.type] || 'AIS_DISRUPTION_TYPE_UNSPECIFIED',
      location: {
        latitude: Number(d.lat) || 0,
        longitude: Number(d.lon) || 0,
      },
      severity: SEVERITY_MAP[d.severity] || 'AIS_DISRUPTION_SEVERITY_UNSPECIFIED',
      changePct: Number(d.changePct) || 0,
      windowHours: Number(d.windowHours) || 0,
      darkShips: Number(d.darkShips) || 0,
      vesselCount: Number(d.vesselCount) || 0,
      region: String(d.region || ''),
      description: String(d.description || ''),
    }));

    return {
      snapshotAt: Date.now(),
      densityZones,
      disruptions,
    };
  } catch {
    return undefined;
  }
}

// ========================================================================
// RPC handler
// ========================================================================

export async function getVesselSnapshot(
  _ctx: ServerContext,
  _req: GetVesselSnapshotRequest,
): Promise<GetVesselSnapshotResponse> {
  try {
    const snapshot = await fetchVesselSnapshot();
    return { snapshot };
  } catch {
    return { snapshot: undefined };
  }
}
