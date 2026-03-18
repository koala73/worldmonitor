import type {
  ServerContext,
  GetWingbitsLiveFlightRequest,
  GetWingbitsLiveFlightResponse,
  WingbitsLiveFlight,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const ECS_API_BASE = 'https://ecs-api.wingbits.com/v1/flights';
// Live position data — short TTL so the popup reflects current state.
const LIVE_FLIGHT_CACHE_TTL = 30; // 30 seconds

interface EcsFlightRaw {
  icao24?: string;
  callsign?: string;
  lat?: number;
  lon?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  verticalRate?: number;
  vertical_rate?: number;
  registration?: string;
  model?: string;
  operator?: string;
  onGround?: boolean;
  on_ground?: boolean;
  lastSeen?: number;
  last_seen?: number;
}

function mapEcsFlight(icao24: string, raw: EcsFlightRaw): WingbitsLiveFlight {
  return {
    icao24,
    callsign: raw.callsign ?? '',
    lat: raw.lat ?? 0,
    lon: raw.lon ?? 0,
    altitude: raw.altitude ?? 0,
    speed: raw.speed ?? 0,
    heading: raw.heading ?? 0,
    verticalRate: raw.verticalRate ?? raw.vertical_rate ?? 0,
    registration: raw.registration ?? '',
    model: raw.model ?? '',
    operator: raw.operator ?? '',
    onGround: raw.onGround ?? raw.on_ground ?? false,
    lastSeen: String(raw.lastSeen ?? raw.last_seen ?? 0),
  };
}

async function fetchWingbitsLiveFlight(icao24: string): Promise<WingbitsLiveFlight | null> {
  const resp = await fetch(`${ECS_API_BASE}/${icao24}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(8_000),
  });

  // Throw on transient upstream errors so cachedFetchJson does not cache them
  // as negative hits. Only 404 (aircraft unknown to Wingbits) is a cacheable miss.
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`Wingbits ECS ${resp.status}`);
  }

  const data = (await resp.json()) as { flight?: EcsFlightRaw | null };
  if (!data.flight) return null;

  return mapEcsFlight(icao24, data.flight);
}

export async function getWingbitsLiveFlight(
  _ctx: ServerContext,
  req: GetWingbitsLiveFlightRequest,
): Promise<GetWingbitsLiveFlightResponse> {
  if (!req.icao24) return { flight: undefined };

  const icao24 = req.icao24.toLowerCase().trim();
  if (!/^[0-9a-f]{6}$/.test(icao24)) return { flight: undefined };
  const cacheKey = `military:wingbits-live:v1:${icao24}`;

  try {
    const result = await cachedFetchJson<{ flight: WingbitsLiveFlight | null }>(
      cacheKey,
      LIVE_FLIGHT_CACHE_TTL,
      async () => ({ flight: await fetchWingbitsLiveFlight(icao24) }),
    );
    return { flight: result?.flight ?? undefined };
  } catch {
    return { flight: undefined };
  }
}
