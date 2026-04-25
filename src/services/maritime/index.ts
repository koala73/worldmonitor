import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  MaritimeServiceClient,
  type AisDensityZone as ProtoDensityZone,
  type AisDisruption as ProtoDisruption,
  type GetVesselSnapshotResponse,
  type SnapshotCandidateReport as ProtoCandidateReport,
} from '@/generated/client/worldmonitor/maritime/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import type { AisDisruptionEvent, AisDensityZone, AisDisruptionType } from '@/types';
import { dataFreshness } from '../data-freshness';
import { isFeatureAvailable } from '../runtime-config';
import { startSmartPollLoop, type SmartPollLoopHandle } from '../runtime';

const client = new MaritimeServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const snapshotBreaker = createCircuitBreaker<GetVesselSnapshotResponse>({ name: 'Maritime Snapshot', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
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

/**
 * Convert a proto disruption to the app shape. Returns null when either enum
 * is UNSPECIFIED / unknown — the legacy silent fallbacks mislabeled unknown
 * values as `gap_spike` / `low`, which would have polluted the dashboard the
 * first time the proto adds a new enum value the client doesn't know about.
 * Filtering at the mapping boundary is safer than shipping wrong data.
 */
function toDisruptionEvent(proto: ProtoDisruption): AisDisruptionEvent | null {
  const type = DISRUPTION_TYPE_REVERSE[proto.type];
  const severity = SEVERITY_REVERSE[proto.severity];
  if (!type || !severity) return null;
  return {
    id: proto.id,
    name: proto.name,
    type,
    lat: proto.location?.latitude ?? 0,
    lon: proto.location?.longitude ?? 0,
    severity,
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

function toLegacyCandidateReport(proto: ProtoCandidateReport): SnapshotCandidateReport {
  return {
    mmsi: proto.mmsi,
    name: proto.name,
    lat: proto.lat,
    lon: proto.lon,
    shipType: proto.shipType || undefined,
    heading: proto.heading || undefined,
    speed: proto.speed || undefined,
    course: proto.course || undefined,
    timestamp: proto.timestamp,
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

// ---- Callback System ----

type AisCallback = (data: AisPositionData) => void;
const positionCallbacks = new Set<AisCallback>();
const lastCallbackTimestampByMmsi = new Map<string, number>();

// ---- Polling State ----

let pollLoop: SmartPollLoopHandle | null = null;
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

const SNAPSHOT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_STALE_MS = 6 * 60 * 1000;
const CALLBACK_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CALLBACK_TRACKED_VESSELS = 20000;

// ---- Internal Helpers ----

function shouldIncludeCandidates(): boolean {
  return positionCallbacks.size > 0;
}

interface ParsedSnapshot {
  sequence: number;
  status: SnapshotStatus;
  disruptions: AisDisruptionEvent[];
  density: AisDensityZone[];
  candidateReports: SnapshotCandidateReport[];
}

async function fetchSnapshotPayload(includeCandidates: boolean, signal?: AbortSignal): Promise<ParsedSnapshot | null> {
  const response = await snapshotBreaker.execute(
    async () => client.getVesselSnapshot(
      { neLat: 0, neLon: 0, swLat: 0, swLon: 0, includeCandidates, includeTankers: false },
      { signal },
    ),
    emptySnapshotFallback,
  );

  const snapshot = response.snapshot;
  if (!snapshot) return null;

  return {
    sequence: snapshot.sequence,
    status: {
      connected: snapshot.status?.connected ?? false,
      vessels: snapshot.status?.vessels ?? 0,
      messages: snapshot.status?.messages ?? 0,
    },
    disruptions: snapshot.disruptions
      .map(toDisruptionEvent)
      .filter((e): e is AisDisruptionEvent => e !== null),
    density: snapshot.densityZones.map(toDensityZone),
    candidateReports: snapshot.candidateReports.map(toLegacyCandidateReport),
  };
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

async function pollSnapshot(force = false, signal?: AbortSignal): Promise<void> {
  if (!isAisConfigured()) return;
  if (inFlight && !force) return;
  if (signal?.aborted) return;

  inFlight = true;
  try {
    const includeCandidates = shouldIncludeCandidates();
    const snapshot = await fetchSnapshotPayload(includeCandidates, signal);
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
  pollLoop?.stop();
  pollLoop = startSmartPollLoop(({ signal }) => pollSnapshot(false, signal), {
    intervalMs: SNAPSHOT_POLL_INTERVAL_MS,
    // AIS relay traffic is high-cost; pause entirely in hidden tabs.
    pauseWhenHidden: true,
    refreshOnVisible: true,
    runImmediately: false,
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
  pollLoop?.stop();
  pollLoop = null;
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
