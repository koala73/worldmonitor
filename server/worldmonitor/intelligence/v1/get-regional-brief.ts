import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetRegionalBriefRequest,
  GetRegionalBriefResponse,
  RegionalBrief,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const KEY_PREFIX = 'intelligence:regional-briefs:v1:weekly:';

interface PersistedBrief {
  region_id?: string;
  generated_at?: number;
  period_start?: number;
  period_end?: number;
  situation_recap?: string;
  regime_trajectory?: string;
  key_developments?: string[];
  risk_outlook?: string;
  provider?: string;
  model?: string;
}

export function adaptBrief(raw: PersistedBrief): RegionalBrief {
  return {
    regionId: raw.region_id ?? '',
    generatedAt: typeof raw.generated_at === 'number' ? raw.generated_at : 0,
    periodStart: typeof raw.period_start === 'number' ? raw.period_start : 0,
    periodEnd: typeof raw.period_end === 'number' ? raw.period_end : 0,
    situationRecap: raw.situation_recap ?? '',
    regimeTrajectory: raw.regime_trajectory ?? '',
    keyDevelopments: Array.isArray(raw.key_developments) ? raw.key_developments.filter((d) => typeof d === 'string') : [],
    riskOutlook: raw.risk_outlook ?? '',
    provider: raw.provider ?? '',
    model: raw.model ?? '',
  };
}

export const getRegionalBrief: IntelligenceServiceHandler['getRegionalBrief'] = async (
  _ctx: ServerContext,
  req: GetRegionalBriefRequest,
): Promise<GetRegionalBriefResponse> => {
  const regionId = req.regionId;
  if (!regionId || typeof regionId !== 'string') {
    return {};
  }

  const key = `${KEY_PREFIX}${regionId}`;
  const raw = await getCachedJson(key, true) as PersistedBrief | null;
  if (!raw || typeof raw !== 'object') {
    return { upstreamUnavailable: true } as GetRegionalBriefResponse & { upstreamUnavailable: boolean };
  }

  const brief = adaptBrief(raw);
  return { brief };
};
