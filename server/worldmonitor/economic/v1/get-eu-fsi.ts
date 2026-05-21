import type {
  ServerContext,
  GetEuFsiRequest,
  GetEuFsiResponse,
  EuFsiObservation,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CISS_STALE_THRESHOLD_MS } from '../../../../src/shared/ciss-staleness';

const SEED_CACHE_KEY = 'economic:fsi-eu:v1';

// `stale` is set when the newest observation is older than the shared CISS
// content-age budget — the ECB series has stopped publishing (issue #3845) —
// so no consumer presents the reading as current.
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
