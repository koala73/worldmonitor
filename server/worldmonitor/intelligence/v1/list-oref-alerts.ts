import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListOrefAlertsRequest,
  ListOrefAlertsResponse,
  OrefAlert,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { getRelayBaseUrl, getRelayHeaders } from './_relay';

const REDIS_KEY = 'relay:oref:history:v1';

interface CachedOrefAlert {
  id?: string | number;
  cat?: string;
  title?: string;
  data?: string[];
  desc?: string;
  alertDate?: string;
}

interface CachedOrefWave {
  alerts?: CachedOrefAlert[];
  timestamp?: string;
}

interface CachedOrefPayload {
  history?: CachedOrefWave[];
  historyCount24h?: number;
  totalHistoryCount?: number;
  activeAlertCount?: number;
  persistedAt?: string;
}

interface RelayAlertsResponse {
  configured?: boolean;
  alerts?: CachedOrefAlert[];
  historyCount24h?: number;
  totalHistoryCount?: number;
  timestamp?: string;
  error?: string;
}

function toEpochMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function emptyResponse(error: string): ListOrefAlertsResponse {
  return {
    configured: false,
    alerts: [],
    history: [],
    historyCount24h: 0,
    totalHistoryCount: 0,
    timestampMs: Date.now(),
    error,
  };
}

function mapAlert(alert: CachedOrefAlert): OrefAlert {
  return {
    id: String(alert.id || ''),
    cat: String(alert.cat || ''),
    title: String(alert.title || ''),
    data: Array.isArray(alert.data) ? alert.data.map(String) : [],
    desc: String(alert.desc || ''),
    timestampMs: toEpochMs(alert.alertDate),
  };
}

/**
 * ListOrefAlerts reads OREF history from Redis (seeded by ais-relay).
 * For live alerts (MODE_ALERTS), falls back to relay when available.
 */
export const listOrefAlerts: IntelligenceServiceHandler['listOrefAlerts'] = async (
  _ctx: ServerContext,
  req: ListOrefAlertsRequest,
): Promise<ListOrefAlertsResponse> => {
  const cached = (await getCachedJson(REDIS_KEY, true)) as CachedOrefPayload | null;

  // History mode: serve entirely from Redis (relay persists history here)
  if (req.mode === 'MODE_HISTORY') {
    if (!cached) return emptyResponse('No OREF history in cache');
    return {
      configured: true,
      alerts: [],
      history: (cached.history || []).map((wave) => ({
        alerts: (wave.alerts || []).map(mapAlert),
        timestampMs: toEpochMs(wave.timestamp),
      })),
      historyCount24h: cached.historyCount24h || 0,
      totalHistoryCount: cached.totalHistoryCount || 0,
      timestampMs: toEpochMs(cached.persistedAt) || Date.now(),
      error: '',
    };
  }

  // Live alerts: relay holds current alerts in-memory; Redis has none.
  // Try relay, fall back to Redis counts with empty alerts.
  const relayBaseUrl = getRelayBaseUrl();
  if (relayBaseUrl) {
    try {
      const response = await fetch(`${relayBaseUrl}/oref/alerts`, {
        headers: getRelayHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = (await response.json()) as RelayAlertsResponse;
        return {
          configured: data.configured ?? true,
          alerts: (data.alerts || []).map(mapAlert),
          history: [],
          historyCount24h: data.historyCount24h ?? cached?.historyCount24h ?? 0,
          totalHistoryCount: data.totalHistoryCount ?? cached?.totalHistoryCount ?? 0,
          timestampMs: toEpochMs(data.timestamp) || Date.now(),
          error: data.error || '',
        };
      }
    } catch {
      // fall through to Redis fallback
    }
  }

  // Relay unavailable: return Redis counts, no active alerts
  if (cached) {
    return {
      configured: true,
      alerts: [],
      history: [],
      historyCount24h: cached.historyCount24h || 0,
      totalHistoryCount: cached.totalHistoryCount || 0,
      timestampMs: toEpochMs(cached.persistedAt) || Date.now(),
      error: 'relay unavailable',
    };
  }

  return emptyResponse('No relay or cache available');
};
