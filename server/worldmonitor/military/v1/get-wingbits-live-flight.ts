import type {
  ServerContext,
  GetWingbitsLiveFlightRequest,
  GetWingbitsLiveFlightResponse,
  WingbitsLiveFlight,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const ECS_API_BASE = 'https://ecs-api.wingbits.com/v1/flights';
const PLANESPOTTERS_API = 'https://api.planespotters.net/pub/photos/hex';
// Live position data — short TTL so the popup reflects current state.
const LIVE_FLIGHT_CACHE_TTL = 30; // 30 seconds
const SCHEDULE_CACHE_TTL = 60;    // 60 seconds — schedule updates rarely mid-flight
const PHOTO_CACHE_TTL = 86400;    // 24 hours — aircraft photos are essentially static

interface EcsScheduleRaw {
  flightIcao?: string;
  depIata?: string;
  arrIata?: string;
  depTime?: string;
  depTimeUtc?: string;
  arrTime?: string;
  arrTimeUtc?: string;
  depEstimated?: string;
  arrEstimated?: string;
  depDelayed?: number;
  arrDelayed?: number;
  status?: string;
  duration?: number;
  arrTerminal?: string;
}

interface PlanespottersPhoto {
  thumbnail_large?: { src?: string };
  link?: string;
  photographer?: string;
}

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
    // Schedule fields — populated later by fetchSchedule
    depIata: '', arrIata: '', depTimeUtc: '', arrTimeUtc: '',
    depEstimatedUtc: '', arrEstimatedUtc: '', depDelayedMin: 0,
    arrDelayedMin: 0, flightStatus: '', flightDurationMin: 0, arrTerminal: '',
    // Photo fields — populated later by fetchPhoto
    photoUrl: '', photoLink: '', photoCredit: '',
  };
}

async function fetchSchedule(callsign: string): Promise<EcsScheduleRaw | null> {
  const resp = await fetch(`${ECS_API_BASE}/schedule/${encodeURIComponent(callsign)}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(6_000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { schedule?: EcsScheduleRaw };
  return data.schedule ?? null;
}

async function fetchPhoto(icao24: string): Promise<PlanespottersPhoto | null> {
  const resp = await fetch(`${PLANESPOTTERS_API}/${icao24}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(6_000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { photos?: PlanespottersPhoto[] };
  return data.photos?.[0] ?? null;
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

  try {
    const liveResult = await cachedFetchJson<{ flight: WingbitsLiveFlight | null }>(
      `military:wingbits-live:v1:${icao24}`,
      LIVE_FLIGHT_CACHE_TTL,
      async () => ({ flight: await fetchWingbitsLiveFlight(icao24) }),
    );

    const flight = liveResult?.flight ?? null;
    if (!flight) return { flight: undefined };

    const callsign = flight.callsign?.trim();
    const [scheduleResult, photoResult] = await Promise.allSettled([
      callsign
        ? cachedFetchJson<{ schedule: EcsScheduleRaw | null }>(
            `military:wingbits-sched:v1:${callsign}`,
            SCHEDULE_CACHE_TTL,
            async () => ({ schedule: await fetchSchedule(callsign) }),
          )
        : Promise.resolve(null),
      cachedFetchJson<{ photo: PlanespottersPhoto | null }>(
        `military:wingbits-photo:v1:${icao24}`,
        PHOTO_CACHE_TTL,
        async () => ({ photo: await fetchPhoto(icao24) }),
      ),
    ]);

    const sched = scheduleResult.status === 'fulfilled' ? scheduleResult.value?.schedule ?? null : null;
    const photo = photoResult.status === 'fulfilled' ? photoResult.value?.photo ?? null : null;

    return {
      flight: {
        ...flight,
        // Schedule
        ...(sched && {
          depIata: sched.depIata ?? '',
          arrIata: sched.arrIata ?? '',
          depTimeUtc: sched.depTimeUtc ?? '',
          arrTimeUtc: sched.arrTimeUtc ?? '',
          depEstimatedUtc: sched.depEstimated ?? '',
          arrEstimatedUtc: sched.arrEstimated ?? '',
          depDelayedMin: sched.depDelayed ?? 0,
          arrDelayedMin: sched.arrDelayed ?? 0,
          flightStatus: sched.status ?? '',
          flightDurationMin: sched.duration ?? 0,
          arrTerminal: sched.arrTerminal ?? '',
        }),
        // Photo
        ...(photo && {
          photoUrl: photo.thumbnail_large?.src ?? '',
          photoLink: photo.link ?? '',
          photoCredit: photo.photographer ?? '',
        }),
      },
    };
  } catch {
    return { flight: undefined };
  }
}
