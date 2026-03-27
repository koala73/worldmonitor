import type {
  ServerContext,
  GetEuFsiRequest,
  GetEuFsiResponse,
  EuFsiObservation,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:fsi-eu:v1';

function buildFallbackResult(): GetEuFsiResponse {
  return {
    latestValue: 0,
    latestDate: '',
    label: '',
    history: [],
    seededAt: '',
    unavailable: true,
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

    return {
      latestValue: Number(raw.latestValue ?? 0),
      latestDate: String(raw.latestDate ?? ''),
      label: String(raw.label ?? ''),
      history,
      seededAt: String(raw.seededAt ?? ''),
      unavailable: false,
    };
  } catch {
    return buildFallbackResult();
  }
}
