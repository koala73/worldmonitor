import type {
  ForecastServiceHandler,
  GetForecastScorecardResponse,
  MarketAlertScorecard,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/forecast/v1/service_server';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { selectMarketAlertScorecard, selectScorecardFields } from './scorecard-fields';

const REDIS_KEY = 'forecast:scorecard:v1';
const MARKET_ALERTS_KEY = 'correlation:market-alerts:scorecard:v1';
const MAX_STALE_MS = 2160 * 60 * 1000;

interface ScorecardSeedEnvelope {
  _seed?: { fetchedAt?: unknown };
  data?: unknown;
}

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
    publishedByDomain: [],
    receipts: [],
    degraded: false,
    stale: false,
    error: '',
    ...overrides,
  };
}

export const getForecastScorecard: ForecastServiceHandler['getForecastScorecard'] = async (
  ctx: ServerContext,
): Promise<GetForecastScorecardResponse> => {
  try {
    const [envelope, marketAlerts] = await Promise.all([getSeedJson(REDIS_KEY), readMarketAlerts()]);
    const data = envelope.data as Record<string, unknown> | null;
    if (!data) return markNoStoreFallbackResponse(ctx.request, withMarketAlerts(emptyScorecard(), marketAlerts));
    const fetchedAt = Number(envelope.fetchedAt);
    return withMarketAlerts(emptyScorecard({
      ...selectScorecardFields(data),
      degraded: false,
      stale: Number.isFinite(fetchedAt) ? Date.now() - fetchedAt > MAX_STALE_MS : false,
      error: '',
    }), marketAlerts);
  } catch (err) {
    console.error('[forecast] getForecastScorecard getRawJson failed:', err instanceof Error ? err.message : String(err));
    return emptyScorecard({
      degraded: true,
      stale: false,
      error: 'forecast_scorecard_backend_unavailable',
    });
  }
};

// The market-alert block is a second key read on its own: a miss or a failed
// read leaves it absent and never degrades the forecast scorecard.
async function readMarketAlerts(): Promise<MarketAlertScorecard | undefined> {
  try {
    return selectMarketAlertScorecard((await getSeedJson(MARKET_ALERTS_KEY)).data);
  } catch (err) {
    console.error('[forecast] getForecastScorecard market-alerts read failed:', err instanceof Error ? err.message : String(err));
    captureSilentError(err, { tags: { route: 'api/forecast', step: 'market-alerts-read' }, level: 'warning' });
    return undefined;
  }
}

function withMarketAlerts(
  response: GetForecastScorecardResponse,
  marketAlerts: MarketAlertScorecard | undefined,
): GetForecastScorecardResponse {
  if (marketAlerts) response.marketAlerts = marketAlerts;
  return response;
}

async function getSeedJson(key: string): Promise<{ data: unknown | null; fetchedAt: number | null }> {
  const raw = await getRawString(key);
  if (raw == null) return { data: null, fetchedAt: null };
  const parsed = JSON.parse(raw) as unknown;
  if (isScorecardSeedEnvelope(parsed)) {
    const fetchedAt = Number(parsed._seed.fetchedAt);
    return { data: parsed.data ?? null, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null };
  }
  return { data: parsed, fetchedAt: null };
}

function isScorecardSeedEnvelope(value: unknown): value is ScorecardSeedEnvelope & { _seed: { fetchedAt: unknown } } {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const seed = (value as ScorecardSeedEnvelope)._seed;
  return seed != null && typeof seed === 'object' && 'fetchedAt' in seed;
}

async function getRawString(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis credentials not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'worldmonitor-gateway/1.0' },
    signal: AbortSignal.timeout(1_500),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const payload = await resp.json() as { result?: string };
  return payload.result || null;
}
