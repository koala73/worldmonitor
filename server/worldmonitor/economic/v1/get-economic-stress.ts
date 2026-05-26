import type {
  ServerContext,
  GetEconomicStressRequest,
  GetEconomicStressResponse,
  EconomicStressComponent,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:stress-index:v1';

function buildFallbackResult(): GetEconomicStressResponse {
  return {
    compositeScore: 0,
    label: '',
    components: [],
    seededAt: '',
    unavailable: true,
  };
}

export async function getEconomicStress(
  _ctx: ServerContext,
  _req: GetEconomicStressRequest,
): Promise<GetEconomicStressResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as Record<string, unknown> | null;
    if (!raw || raw.unavailable) return buildFallbackResult();

    const components = (Array.isArray(raw.components) ? raw.components : []).map(
      (c: Record<string, unknown>): EconomicStressComponent => {
        const isMissing = c.missing === true || c.rawValue === null || c.rawValue === undefined;
        return {
          id: String(c.id ?? ''),
          label: String(c.label ?? ''),
          rawValue: isMissing ? 0 : Number(c.rawValue),
          score: Number(c.score ?? 0),
          weight: Number(c.weight ?? 0),
          missing: isMissing,
        };
      },
    );

    return {
      compositeScore: Number(raw.compositeScore ?? 0),
      label: String(raw.label ?? ''),
      components,
      seededAt: String(raw.seededAt ?? ''),
      unavailable: false,
    };
  } catch {
    return buildFallbackResult();
  }
}
