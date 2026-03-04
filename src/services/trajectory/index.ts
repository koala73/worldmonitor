import {
  TrajectoryServiceClient,
  type FlightHistoryResponse as ProtoResponse,
  type TrajectoryPoint as ProtoPoint,
} from '@/generated/client/worldmonitor/trajectory/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// --- Consumer-friendly types ---

export interface TrajectoryPoint {
  latitude: number;
  longitude: number;
  /** Barometric altitude in meters */
  altitude: number;
  /** Unix timestamp (seconds) */
  timestamp: number;
  velocity: number;
  heading: number;
  onGround: boolean;
}

export interface FlightHistoryResult {
  points: TrajectoryPoint[];
  callsign: string;
  status: 'ok' | 'no_data' | 'not_found' | 'rate_limited' | 'error';
  errorMessage: string;
}

// --- Internal mapping ---

function toDisplayPoint(proto: ProtoPoint): TrajectoryPoint {
  return {
    latitude: proto.latitude,
    longitude: proto.longitude,
    altitude: proto.altitude,
    timestamp: proto.timestamp,
    velocity: proto.velocity,
    heading: proto.heading,
    onGround: proto.onGround,
  };
}

function toDisplayResult(proto: ProtoResponse): FlightHistoryResult {
  return {
    points: proto.points.map(toDisplayPoint),
    callsign: proto.callsign,
    status: (proto.status as FlightHistoryResult['status']) || 'error',
    errorMessage: proto.errorMessage,
  };
}

// --- Client + circuit breaker ---

const client = new TrajectoryServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<FlightHistoryResult>({
  name: 'Flight History',
  cacheTtlMs: 5 * 60 * 1000, // 5 min cache for trajectory data
  persistCache: false,
});

// --- Main fetch (public API) ---

/**
 * Fetch recent flight trajectory for an aircraft by ICAO24 hex code.
 *
 * NOTE: Phase 1 limitation - OpenSky /api/tracks/all only returns the LAST
 * known track (~1 hour of data). For full historical trajectories, Phase 2
 * will use an SSH tunnel to the OpenSky Impala database.
 *
 * @param icao24 - 6-character hex ICAO24 transponder code
 * @param begin  - Optional Unix timestamp to select track snapshot (0 = current)
 */
export async function fetchFlightHistory(
  icao24: string,
  begin = 0,
): Promise<FlightHistoryResult> {
  const emptyResult: FlightHistoryResult = {
    points: [],
    callsign: '',
    status: 'error',
    errorMessage: 'Service unavailable',
  };

  return breaker.execute(async () => {
    const response = await client.queryFlightHistory({
      icao24,
      begin,
      end: 0,
    });
    return toDisplayResult(response);
  }, emptyResult);
}
