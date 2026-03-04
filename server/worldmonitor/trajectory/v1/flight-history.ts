import type {
  ServerContext,
  FlightHistoryRequest,
  FlightHistoryResponse,
  TrajectoryPoint,
} from '../../../../src/generated/server/worldmonitor/trajectory/v1/service_server';
import { validateHexParam } from '../../../../src/utils/validation';

/**
 * OpenSky REST API track endpoint.
 *
 * IMPORTANT: /api/tracks/all only returns the LAST known track (~1 hour of data).
 * It does NOT return full historical trajectories. This is a Phase 1 limitation.
 * For full history, Phase 2 will need an SSH tunnel to the OpenSky Impala DB.
 *
 * The 'time' param selects which track snapshot (0 = current, unix timestamp = specific).
 * Anonymous rate limit: 10 req/min.
 */
const OPENSKY_TRACKS_URL = 'https://opensky-network.org/api/tracks/all';

/** Maximum points in a single response to prevent memory exhaustion. */
const MAX_POINTS = 10_000;

/** Number of points above which we apply Ramer-Douglas-Peucker downsampling. */
const DOWNSAMPLE_THRESHOLD = 500;

/** Epsilon for RDP algorithm (in degrees, ~0.001 = ~111m). */
const RDP_EPSILON = 0.0005;

/** Fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * OpenSky /api/tracks/all response shape.
 * path entries: [time, lat, lon, baro_altitude, heading, on_ground]
 */
interface OpenSkyTrackResponse {
  icao24: string;
  callsign: string;
  startTime: number;
  endTime: number;
  path: [number, number, number, number, number, boolean][];
}

/**
 * Ramer-Douglas-Peucker line simplification algorithm.
 * Reduces the number of points in a trajectory while preserving shape.
 * Uses lat/lon as the 2D coordinates for perpendicular distance calculation.
 */
export function ramerDouglasPeucker(
  points: TrajectoryPoint[],
  epsilon: number,
): TrajectoryPoint[] {
  if (points.length <= 2) return points;

  // Find the point with the maximum distance from the line (first -> last)
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(
      points[i].latitude, points[i].longitude,
      first.latitude, first.longitude,
      last.latitude, last.longitude,
    );
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  // If max distance exceeds epsilon, recursively simplify both halves
  if (maxDist > epsilon) {
    const left = ramerDouglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = ramerDouglasPeucker(points.slice(maxIdx), epsilon);
    // Avoid duplicating the pivot point
    return [...left.slice(0, -1), ...right];
  }

  // All intermediate points are within epsilon; keep only endpoints
  return [first, last];
}

/**
 * Perpendicular distance from point (px, py) to line segment (x1, y1)-(x2, y2).
 * Uses simple Euclidean approximation (sufficient for small distances in degrees).
 */
function perpendicularDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const denom = Math.sqrt(dx * dx + dy * dy);
  if (denom === 0) {
    // Start and end are the same point
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }
  return Math.abs(dx * (y1 - py) - (x1 - px) * dy) / denom;
}

/**
 * Converts OpenSky path entry to TrajectoryPoint.
 * path entry format: [time, lat, lon, baro_altitude, heading, on_ground]
 */
function toTrajectoryPoint(entry: [number, number, number, number, number, boolean]): TrajectoryPoint {
  return {
    timestamp: entry[0],
    latitude: entry[1],
    longitude: entry[2],
    altitude: entry[3] ?? 0,
    heading: entry[4] ?? 0,
    velocity: 0, // OpenSky tracks endpoint does not include velocity
    onGround: entry[5] ?? false,
  };
}

export async function queryFlightHistory(
  _ctx: ServerContext,
  req: FlightHistoryRequest,
): Promise<FlightHistoryResponse> {
  // 1. Validate icao24 (6-character hex code)
  const icao24 = validateHexParam(req.icao24, 'icao24', 6);

  // 2. Build OpenSky API URL
  const url = new URL(OPENSKY_TRACKS_URL);
  url.searchParams.set('icao24', icao24);
  if (req.begin > 0) {
    url.searchParams.set('time', String(req.begin));
  }

  // 3. Fetch from OpenSky with timeout
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OmniSentinel/1.0',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[Trajectory] Fetch error for ${icao24}: ${err instanceof Error ? err.message : 'unknown'}`);
    return {
      points: [],
      callsign: '',
      status: 'error',
      errorMessage: `Failed to fetch trajectory: ${err instanceof Error ? err.message : 'network error'}`,
    };
  }

  // 4. Handle error responses
  if (response.status === 404) {
    return {
      points: [],
      callsign: '',
      status: 'not_found',
      errorMessage: `No track data found for ICAO24 ${icao24}`,
    };
  }

  if (response.status === 429) {
    return {
      points: [],
      callsign: '',
      status: 'rate_limited',
      errorMessage: 'OpenSky API rate limit exceeded. Anonymous limit: 10 req/min.',
    };
  }

  if (!response.ok) {
    return {
      points: [],
      callsign: '',
      status: 'error',
      errorMessage: `OpenSky API returned status ${response.status}`,
    };
  }

  // 5. Parse response
  let data: OpenSkyTrackResponse;
  try {
    data = await response.json() as OpenSkyTrackResponse;
  } catch {
    return {
      points: [],
      callsign: '',
      status: 'error',
      errorMessage: 'Failed to parse OpenSky response',
    };
  }

  // 6. Handle empty data
  if (!data.path || data.path.length === 0) {
    return {
      points: [],
      callsign: (data.callsign ?? '').trim(),
      status: 'no_data',
      errorMessage: '',
    };
  }

  // 7. Convert path entries to TrajectoryPoints
  let points = data.path.map(toTrajectoryPoint);

  // 8. Enforce hard maximum
  if (points.length > MAX_POINTS) {
    // Uniform sampling to get under MAX_POINTS before applying RDP
    const step = Math.ceil(points.length / MAX_POINTS);
    const sampled: TrajectoryPoint[] = [];
    for (let i = 0; i < points.length; i += step) {
      sampled.push(points[i]);
    }
    // Always include the last point
    if (sampled[sampled.length - 1] !== points[points.length - 1]) {
      sampled.push(points[points.length - 1]);
    }
    points = sampled;
  }

  // 9. Downsample with Ramer-Douglas-Peucker if still too many points
  if (points.length > DOWNSAMPLE_THRESHOLD) {
    points = ramerDouglasPeucker(points, RDP_EPSILON);
  }

  console.log(`[Trajectory] ${icao24}: ${data.path.length} raw -> ${points.length} points, callsign=${(data.callsign ?? '').trim()}`);

  return {
    points,
    callsign: (data.callsign ?? '').trim(),
    status: 'ok',
    errorMessage: '',
  };
}
