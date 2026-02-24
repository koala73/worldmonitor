import {
  MaritimeServiceClient,
  type AisDensityZone as ProtoDensityZone,
  type AisDisruption as ProtoDisruption,
  type GetVesselSnapshotResponse,
} from '@/generated/client/worldmonitor/maritime/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import type { AisDisruptionEvent, AisDensityZone, AisDisruptionType } from '@/types';
import { dataFreshness } from '../data-freshness';
import { isFeatureAvailable } from '../runtime-config';

// ---- Proto fallback (desktop safety when relay URL is unavailable) ----

const client = new MaritimeServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const snapshotBreaker = createCircuitBreaker<GetVesselSnapshotResponse>({ name: 'Maritime Snapshot' });
const emptySnapshotFallback: GetVesselSnapshotResponse = { snapshot: undefined };

const DISRUPTION_TYPE_REVERSE: Record<string, AisDisruptionType> = {
  AIS_DISRUPTION_TYPE_GAP_SPIKE: 'gap_spike',
  AIS_DISRUPTION_TYPE_CHOKEPOINT_CONGESTION: 'chokepoint_congestion',
};

const SEVERITY_REVERSE: Record<string, 'low' | 'elevated' | 'high'> = {
  AIS_DISRUPTION_SEVERITY_LOW: 'low',
  AIS_DISRUPTION_SEVERITY_ELEVATED: 'elevated',
  AIS_DISRUPTION_SEVERITY_HIGH: 'high',
};

function toDisruptionEvent(proto: ProtoDisruption): AisDisruptionEvent {
  return {
    id: proto.id,
    name: proto.name,
    type: DISRUPTION_TYPE_REVERSE[proto.type] || 'gap_spike',
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    severity: SEVERITY_REVERSE[proto.severity] || 'low',
    changePct: proto.changePct,
    windowHours: proto.windowHours,
    darkShips: proto.darkShips,
    vesselCount: proto.vesselCount,
    region: proto.region,
    description: proto.description,
  };
}

function toDensityZone(proto: ProtoDensityZone): AisDensityZone {
  return {
    id: proto.id,
    name: proto.name,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    intensity: proto.intensity,
    deltaPct: proto.deltaPct,
    shipsPerDay: proto.shipsPerDay,
    note: proto.note,
  };
}

// ---- Feature Gating ----

const isClientRuntime = typeof window !== 'undefined';
const aisConfigured = isClientRuntime && import.meta.env.VITE_ENABLE_AIS !== 'false';

export function isAisConfigured(): boolean {
  return aisConfigured && isFeatureAvailable('aisRelay');
}

// ---- AisPositionData (exported for military-vessels.ts) ----

export interface AisPositionData {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
}

// ---- Internal Interfaces ----

interface SnapshotStatus {
  connected: boolean;
  vessels: number;
  messages: number;
}

interface SnapshotCandidateReport extends AisPositionData {
  timestamp: number;
}

interface AisSnapshotResponse {
  sequence?: number;
  timestamp?: string;
  status?: {
    connected?: boolean;
    vessels?: number;
    messages?: number;
  };
  disruptions?: AisDisruptionEvent[];
  density?: AisDensityZone[];
  candidateReports?: SnapshotCandidateReport[];
}

// ---- Callback System ----

type AisCallback = (data: AisPositionData) => void;
const positionCallbacks = new Set<AisCallback>();
const lastCallbackTimestampByMmsi = new Map<string, number>();

// ---- Polling State ----

let pollInterval: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let isPolling = false;
let lastPollAt = 0;
let lastSequence = 0;

let latestDisruptions: AisDisruptionEvent[] = [];
let latestDensity: AisDensityZone[] = [];
let latestStatus: SnapshotStatus = {
  connected: false,
  vessels: 0,
  messages: 0,
};

// ---- Constants ----

const SNAPSHOT_POLL_INTERVAL_MS = 30 * 1000;
const SNAPSHOT_STALE_MS = 45 * 1000;
const CALLBACK_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CALLBACK_TRACKED_VESSELS = 20000;

// ---- Raw Relay URL (for candidate reports path) ----

const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const RAILWAY_SNAPSHOT_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/ais/snapshot'
  : '';
const LOCAL_SNAPSHOT_FALLBACK = 'http://localhost:3004/ais/snapshot';
const isLocalhost = isClientRuntime && window.location.hostname === 'localhost';

// ---- Internal Helpers ----

function shouldIncludeCandidates(): boolean {
  return positionCallbacks.size > 0;
}

function parseSnapshot(data: unknown): {
  sequence: number;
  status: SnapshotStatus;
  disruptions: AisDisruptionEvent[];
  density: AisDensityZone[];
  candidateReports: SnapshotCandidateReport[];
} | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as AisSnapshotResponse;

  if (!Array.isArray(raw.disruptions) || !Array.isArray(raw.density)) return null;

  const status = raw.status || {};
  return {
    sequence: Number.isFinite(raw.sequence as number) ? Number(raw.sequence) : 0,
    status: {
      connected: Boolean(status.connected),
      vessels: Number.isFinite(status.vessels as number) ? Number(status.vessels) : 0,
      messages: Number.isFinite(status.messages as number) ? Number(status.messages) : 0,
    },
    disruptions: raw.disruptions,
    density: raw.density,
    candidateReports: Array.isArray(raw.candidateReports) ? raw.candidateReports : [],
  };
}

// ---- Hybrid Fetch Strategy ----

async function fetchRawRelaySnapshot(includeCandidates: boolean): Promise<unknown> {
  const query = `?candidates=${includeCandidates ? 'true' : 'false'}`;

  if (RAILWAY_SNAPSHOT_URL) {
    try {
      const railway = await fetch(`${RAILWAY_SNAPSHOT_URL}${query}`, { headers: { Accept: 'application/json' } });
      if (railway.ok) return railway.json();
    } catch { /* Railway unavailable -- fall through */ }
  }

  if (isLocalhost) {
    const local = await fetch(`${LOCAL_SNAPSHOT_FALLBACK}${query}`, { headers: { Accept: 'application/json' } });
    if (local.ok) return local.json();
  }

  throw new Error('AIS raw relay snapshot unavailable');
}

async function fetchSnapshotPayload(includeCandidates: boolean): Promise<unknown> {
  if (includeCandidates) {
    // Candidate reports are only available on the raw relay endpoint.
    return fetchRawRelaySnapshot(true);
  }

  try {
    // Prefer direct relay path to avoid normal web traffic double-hop via Vercel.
    return await fetchRawRelaySnapshot(false);
  } catch (rawError) {
    // Desktop fallback: use proto route when relay URL/local relay is unavailable.
    const response = await snapshotBreaker.execute(async () => {
      return client.getVesselSnapshot({});
    }, emptySnapshotFallback);

    if (response.snapshot) {
      return {
        sequence: 0, // Proto payload does not include relay sequence.
        status: { connected: true, vessels: 0, messages: 0 },
        disruptions: response.snapshot.disruptions.map(toDisruptionEvent),
        density: response.snapshot.densityZones.map(toDensityZone),
        candidateReports: [],
      };
    }

    throw rawError;
  }
}

// ---- Callback Emission ----

function pruneCallbackTimestampIndex(now: number): void {
  if (lastCallbackTimestampByMmsi.size <= MAX_CALLBACK_TRACKED_VESSELS) {
    return;
  }

  const threshold = now - CALLBACK_RETENTION_MS;
  for (const [mmsi, ts] of lastCallbackTimestampByMmsi) {
    if (ts < threshold) {
      lastCallbackTimestampByMmsi.delete(mmsi);
    }
  }

  if (lastCallbackTimestampByMmsi.size <= MAX_CALLBACK_TRACKED_VESSELS) {
    return;
  }

  const oldest = Array.from(lastCallbackTimestampByMmsi.entries())
    .sort((a, b) => a[1] - b[1]);
  const toDelete = lastCallbackTimestampByMmsi.size - MAX_CALLBACK_TRACKED_VESSELS;
  for (let i = 0; i < toDelete; i++) {
    const entry = oldest[i];
    if (!entry) break;
    lastCallbackTimestampByMmsi.delete(entry[0]);
  }
}

function emitCandidateReports(reports: SnapshotCandidateReport[]): void {
  if (positionCallbacks.size === 0 || reports.length === 0) return;
  const now = Date.now();

  for (const report of reports) {
    if (!report?.mmsi || !Number.isFinite(report.lat) || !Number.isFinite(report.lon)) continue;

    const reportTs = Number.isFinite(report.timestamp) ? Number(report.timestamp) : now;
    const lastTs = lastCallbackTimestampByMmsi.get(report.mmsi) || 0;
    if (reportTs <= lastTs) continue;

    lastCallbackTimestampByMmsi.set(report.mmsi, reportTs);
    const callbackData: AisPositionData = {
      mmsi: report.mmsi,
      name: report.name || '',
      lat: report.lat,
      lon: report.lon,
      shipType: report.shipType,
      heading: report.heading,
      speed: report.speed,
      course: report.course,
    };

    for (const callback of positionCallbacks) {
      try {
        callback(callbackData);
      } catch {
        // Ignore callback errors
      }
    }
  }

  pruneCallbackTimestampIndex(now);
}

// ---- Polling ----

async function pollSnapshot(force = false): Promise<void> {
  if (!isAisConfigured()) return;
  // Skip polling when tab is hidden to avoid wasting relay bandwidth.
  // The interval keeps running so polling resumes instantly on focus.
  if (!force && isClientRuntime && document.hidden) return;
  if (inFlight && !force) return;

  inFlight = true;
  try {
    const includeCandidates = shouldIncludeCandidates();
    const payload = await fetchSnapshotPayload(includeCandidates);
    const snapshot = parseSnapshot(payload);
    if (!snapshot) throw new Error('Invalid snapshot payload');

    latestDisruptions = snapshot.disruptions;
    latestDensity = snapshot.density;
    latestStatus = snapshot.status;
    lastPollAt = Date.now();

    if (includeCandidates) {
      if (snapshot.sequence > lastSequence) {
        emitCandidateReports(snapshot.candidateReports);
        lastSequence = snapshot.sequence;
      } else if (lastSequence === 0) {
        emitCandidateReports(snapshot.candidateReports);
        lastSequence = snapshot.sequence;
      }
    } else {
      lastSequence = snapshot.sequence;
    }

    const itemCount = latestDisruptions.length + latestDensity.length;
    if (itemCount > 0 || latestStatus.vessels > 0) {
      dataFreshness.recordUpdate('ais', itemCount > 0 ? itemCount : latestStatus.vessels);
    }
  } catch {
    latestStatus.connected = false;
  } finally {
    inFlight = false;
  }
}

function startPolling(): void {
  if (isPolling || !isAisConfigured()) return;
  isPolling = true;
  void pollSnapshot(true);
  pollInterval = setInterval(() => {
    void pollSnapshot(false);
  }, SNAPSHOT_POLL_INTERVAL_MS);
}

function pausePolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function resumePolling(): void {
  if (!isPolling || pollInterval) return;
  // Avoid overlapping relay requests if a poll is already in flight.
  if (!inFlight) {
    void pollSnapshot(false);
  }
  pollInterval = setInterval(() => {
    void pollSnapshot(false);
  }, SNAPSHOT_POLL_INTERVAL_MS);
}

// Pause AIS polling when the browser tab is hidden to avoid wasting
// Railway relay bandwidth on backgrounded tabs.
if (isClientRuntime) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pausePolling();
    } else {
      resumePolling();
    }
  });
}

// ---- Exported Functions ----

export function registerAisCallback(callback: AisCallback): void {
  positionCallbacks.add(callback);
  startPolling();
}

export function unregisterAisCallback(callback: AisCallback): void {
  positionCallbacks.delete(callback);
  if (positionCallbacks.size === 0) {
    lastCallbackTimestampByMmsi.clear();
  }
}

export function initAisStream(): void {
  startPolling();
}

export function disconnectAisStream(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  isPolling = false;
  inFlight = false;
  latestStatus.connected = false;
}

export function getAisStatus(): { connected: boolean; vessels: number; messages: number } {
  const isFresh = Date.now() - lastPollAt <= SNAPSHOT_STALE_MS;
  return {
    connected: latestStatus.connected && isFresh,
    vessels: latestStatus.vessels,
    messages: latestStatus.messages,
  };
}

export async function fetchAisSignals(): Promise<{ disruptions: AisDisruptionEvent[]; density: AisDensityZone[] }> {
  if (!aisConfigured) {
    return { disruptions: [], density: [] };
  }

  startPolling();
  const shouldRefresh = Date.now() - lastPollAt > SNAPSHOT_STALE_MS;
  if (shouldRefresh) {
    await pollSnapshot(true);
  }

  return {
    disruptions: latestDisruptions,
    density: latestDensity,
  };
}
