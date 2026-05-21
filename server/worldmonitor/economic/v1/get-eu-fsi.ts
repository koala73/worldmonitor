import type {
  ServerContext,
  GetEuFsiRequest,
  GetEuFsiResponse,
  EuFsiObservation,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:fsi-eu:v1';

// CISS content-age budget — mirrors CISS_MAX_CONTENT_AGE_MIN in
// scripts/seed-fsi-eu.mjs (10 days). When the newest observation is older than
// this, the ECB series has stopped publishing (issue #3845) and `stale` is set
// so no consumer presents the reading as current.
const CISS_STALE_THRESHOLD_MS = 10 * 24 * 60 * 60 * 1000;

function isStale(latestDate: string): boolean {
  const ts = Date.parse(latestDate);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > CISS_STALE_THRESHOLD_MS;
}

function buildFallbackResult(): GetEuFsiResponse {
  return {
    latestValue: 0,
    latestDate: '',
    label: '',
    history: [],
    seededAt: '',
    unavailable: true,
    stale: false,
  };
}

export async function getEuFsi(
  _ctx: ServerContext,
  _req: GetEuFsiRequest,
): Promise<GetEuFsiResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as Record<string, unknown> | null;
    if (!raw || raw.unavailable) return buildFallbackResult();

    const history = (Array.isArray(raw.history) ? raw.history : []) as EuFsiObservation[];
    const latestDate = String(raw.latestDate ?? '');

    return {
      latestValue: Number(raw.latestValue ?? 0),
      latestDate,
      label: String(raw.label ?? ''),
      history,
      seededAt: String(raw.seededAt ?? ''),
      unavailable: false,
      stale: isStale(latestDate),
    };
  } catch {
    return buildFallbackResult();
  }
}
