import type {
  ForecastServiceHandler,
  GetForecastScorecardResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
import { unwrapEnvelope } from '../../../_shared/seed-envelope.ts';

const REDIS_KEY = 'forecast:scorecard:v1';

function emptyScorecard(overrides: Partial<GetForecastScorecardResponse> = {}): GetForecastScorecardResponse {
  return {
    schemaVersion: 1,
    generatedAt: 0,
    rollingWindowDays: 180,
    methodology: '',
    totals: {
      entries: 0,
      resolved: 0,
      pending: 0,
      pendingJudge: 0,
      scored: 0,
      void: 0,
      voidRate: 0,
      publicationCoverage: 0,
    },
    byDomain: [],
    byGenerationOrigin: [],
    calibration: [],
    degraded: false,
    stale: false,
    error: '',
    ...overrides,
  };
}

export const getForecastScorecard: ForecastServiceHandler['getForecastScorecard'] = async (
  _ctx: ServerContext,
): Promise<GetForecastScorecardResponse> => {
  try {
    const data = await getScorecardJson() as Partial<GetForecastScorecardResponse> | null;
    if (!data) return emptyScorecard();
    return emptyScorecard({
      ...data,
      totals: data.totals ?? emptyScorecard().totals,
      byDomain: data.byDomain ?? [],
      byGenerationOrigin: data.byGenerationOrigin ?? [],
      calibration: data.calibration ?? [],
      degraded: false,
      stale: false,
      error: '',
    });
  } catch (err) {
    console.error('[forecast] getForecastScorecard getRawJson failed:', err instanceof Error ? err.message : String(err));
    return emptyScorecard({
      degraded: true,
      stale: false,
      error: 'forecast_scorecard_backend_unavailable',
    });
  }
};

async function getScorecardJson(): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis credentials not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1_500),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const payload = await resp.json() as { result?: string };
  if (!payload.result) return null;
  return unwrapEnvelope(JSON.parse(payload.result)).data;
}
