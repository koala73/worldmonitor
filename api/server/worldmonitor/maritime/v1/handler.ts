/**
 * Maritime service handler -- implements the generated MaritimeServiceHandler
 * interface with 2 RPCs proxying two distinct upstream APIs:
 *   - getVesselSnapshot: WS relay HTTP endpoint for AIS vessel density/disruption data
 *   - listNavigationalWarnings: NGA MSI API for active broadcast navigational warnings
 *
 * Consolidates two legacy edge functions:
 *   - api/ais-snapshot.js (AIS snapshot proxy with 3-layer caching -- caching removed)
 *   - api/nga-warnings.js (NGA warnings proxy)
 *
 * All RPCs have graceful degradation: return empty on upstream failure.
 * No error logging on upstream failures (following established 2F-01 pattern).
 * No caching in handler (client-side polling manages refresh intervals).
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  MaritimeServiceHandler,
  ServerContext,
  GetVesselSnapshotRequest,
  GetVesselSnapshotResponse,
  VesselSnapshot,
  AisDensityZone,
  AisDisruption,
  AisDisruptionType,
  AisDisruptionSeverity,
  ListNavigationalWarningsRequest,
  ListNavigationalWarningsResponse,
  NavigationalWarning,
} from '../../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

// ========================================================================
// RPC 1: getVesselSnapshot -- Port from api/ais-snapshot.js
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

async function fetchVesselSnapshot(): Promise<VesselSnapshot | undefined> {
  try {
    const relayBaseUrl = getRelayBaseUrl();
    if (!relayBaseUrl) return undefined;

    const response = await fetch(
      `${relayBaseUrl}/ais/snapshot?candidates=false`,
      {
        headers: { Accept: 'application/json' },
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
// RPC 2: listNavigationalWarnings -- Port from api/nga-warnings.js
// ========================================================================

const NGA_WARNINGS_URL = 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';

function parseNgaDate(dateStr: unknown): number {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  // Format: "081653Z MAY 2024"
  const match = dateStr.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!match) return Date.parse(dateStr) || 0;
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = parseInt(match[1]!, 10);
  const hours = parseInt(match[2]!.slice(0, 2), 10);
  const minutes = parseInt(match[2]!.slice(2, 4), 10);
  const month = months[match[3]!.toUpperCase()] ?? 0;
  const year = parseInt(match[4]!, 10);
  return Date.UTC(year, month, day, hours, minutes);
}

async function fetchNgaWarnings(area?: string): Promise<NavigationalWarning[]> {
  try {
    const response = await fetch(NGA_WARNINGS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const rawWarnings: any[] = Array.isArray(data) ? data : (data?.broadcast_warn ?? []);

    let warnings: NavigationalWarning[] = rawWarnings.map((w: any): NavigationalWarning => ({
      id: `${w.navArea || ''}-${w.msgYear || ''}-${w.msgNumber || ''}`,
      title: `NAVAREA ${w.navArea || ''} ${w.msgNumber || ''}/${w.msgYear || ''}`,
      text: w.text || '',
      area: `${w.navArea || ''}${w.subregion ? ' ' + w.subregion : ''}`,
      location: undefined,
      issuedAt: parseNgaDate(w.issueDate),
      expiresAt: 0,
      authority: w.authority || '',
    }));

    if (area) {
      const areaLower = area.toLowerCase();
      warnings = warnings.filter(
        (w) =>
          w.area.toLowerCase().includes(areaLower) ||
          w.text.toLowerCase().includes(areaLower),
      );
    }

    return warnings;
  } catch {
    return [];
  }
}

// ========================================================================
// Handler export
// ========================================================================

export const maritimeHandler: MaritimeServiceHandler = {
  async getVesselSnapshot(
    _ctx: ServerContext,
    _req: GetVesselSnapshotRequest,
  ): Promise<GetVesselSnapshotResponse> {
    try {
      const snapshot = await fetchVesselSnapshot();
      return { snapshot };
    } catch {
      return { snapshot: undefined };
    }
  },

  async listNavigationalWarnings(
    _ctx: ServerContext,
    req: ListNavigationalWarningsRequest,
  ): Promise<ListNavigationalWarningsResponse> {
    try {
      const warnings = await fetchNgaWarnings(req.area);
      return { warnings, pagination: undefined };
    } catch {
      return { warnings: [], pagination: undefined };
    }
  },
};
