import type {
  ServerContext,
  GetWingbitsLiveFlightRequest,
  GetWingbitsLiveFlightResponse,
  WingbitsLiveFlight,
} from '../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { toIataCallsign } from '../../../_shared/airline-codes';

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
  // Full-name fields (details/enrichment endpoint)
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
  // Abbreviated fields returned by the live position endpoint
  h?: string;   // icao24
  f?: string;   // callsign
  la?: number;  // lat
  lo?: number;  // lon
  ab?: number;  // altitude (barometric, feet)
  gs?: number;  // ground speed (knots)
  tr?: number;  // track/heading (degrees)
  rs?: number;  // vertical rate (ft/min)
  og?: boolean; // on ground
  ra?: string;  // last seen (ISO timestamp)
}

function mapEcsFlight(icao24: string, raw: EcsFlightRaw): WingbitsLiveFlight {
  const raTsMs = raw.ra ? new Date(raw.ra).getTime() : Number.NaN;
  const lastSeenTs = raw.lastSeen ?? raw.last_seen ?? (Number.isFinite(raTsMs) ? Math.floor(raTsMs / 1000) : 0);
  const cs = raw.callsign ?? raw.f ?? '';
  const iataInfo = toIataCallsign(cs);
  return {
    icao24: raw.icao24 ?? raw.h ?? icao24,
    callsign: cs,
    lat: raw.lat ?? raw.la ?? 0,
    lon: raw.lon ?? raw.lo ?? 0,
    altitude: raw.altitude ?? raw.ab ?? 0,
    speed: raw.speed ?? raw.gs ?? 0,
    heading: raw.heading ?? raw.tr ?? 0,
    verticalRate: raw.verticalRate ?? raw.vertical_rate ?? raw.rs ?? 0,
    registration: raw.registration ?? '',
    model: raw.model ?? '',
    operator: raw.operator ?? '',
    onGround: raw.onGround ?? raw.on_ground ?? raw.og ?? false,
    lastSeen: String(lastSeenTs),
    // Schedule fields — populated later by fetchSchedule
    depIata: '', arrIata: '', depTimeUtc: '', arrTimeUtc: '',
    depEstimatedUtc: '', arrEstimatedUtc: '', depDelayedMin: 0,
    arrDelayedMin: 0, flightStatus: '', flightDurationMin: 0, arrTerminal: '',
    // Photo fields — populated later by fetchPhoto
    photoUrl: '', photoLink: '', photoCredit: '',
    // Airline — resolved from ICAO callsign prefix
    callsignIata: iataInfo?.callsign ?? '',
    airlineName: iataInfo?.name ?? '',
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

    // Normalize callsign to uppercase to prevent duplicate cache keys (ECS may return mixed-case).
    const callsign = flight.callsign?.trim().toUpperCase() || '';
    const iataCs = flight.callsignIata || null;
    const [scheduleResult, photoResult] = await Promise.allSettled([
      callsign
        ? cachedFetchJson<{ schedule: EcsScheduleRaw | null }>(
            `military:wingbits-sched:v1:${callsign}`,
            SCHEDULE_CACHE_TTL,
            async () => {
              // Try ICAO callsign first; fall back to IATA if no result.
              // Cache tradeoff: both attempts cached under ICAO key for 60s (source is opaque but acceptable).
              const sched = await fetchSchedule(callsign);
              if (sched) return { schedule: sched };
              if (iataCs) return { schedule: await fetchSchedule(iataCs) };
              return { schedule: null };
            },
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
