import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListOrefAlertsRequest,
  ListOrefAlertsResponse,
  OrefAlert,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

interface RelayOrefAlert {
  id: string;
  cat: string;
  title: string;
  data: string[];
  desc: string;
  alertDate: string;
}

interface RelayOrefWave {
  alerts: RelayOrefAlert[];
  timestamp: string;
}

interface RelayOrefResponse {
  configured: boolean;
  alerts?: RelayOrefAlert[];
  history?: RelayOrefWave[];
  historyCount24h?: number;
  totalHistoryCount?: number;
  timestamp?: string;
  error?: string;
}

function parseOrefDate(dateStr: string): string {
  if (!dateStr) return "0";
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? "0" : d.getTime().toString();
}

/**
 * ListOrefAlerts fetches Israeli Red Alerts from the Home Front Command relay.
 */
export const listOrefAlerts: IntelligenceServiceHandler['listOrefAlerts'] = async (
  _ctx: ServerContext,
  req: ListOrefAlertsRequest,
): Promise<ListOrefAlertsResponse> => {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) {
    const nowMs = Date.now().toString();
    return {
      configured: false,
      alerts: [],
      history: [],
      historyCount24h: 0,
      totalHistoryCount: 0,
      timestampMs: nowMs,
      error: 'WS_RELAY_URL not configured',
    };
  }

  const base = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
  const endpoint = req.mode === 'MODE_HISTORY' ? '/oref/history' : '/oref/alerts';
  const url = `${base}${endpoint}`;

  try {
    const relaySecret = process.env.RELAY_SHARED_SECRET || '';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (relaySecret) {
      const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
      headers[relayHeader] = relaySecret;
      headers.Authorization = `Bearer ${relaySecret}`;
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      const nowMs = Date.now().toString();
      return {
        configured: false,
        alerts: [],
        history: [],
        historyCount24h: 0,
        totalHistoryCount: 0,
        timestampMs: nowMs,
        error: `Relay HTTP ${resp.status}`,
      };
    }

    const data = await resp.json() as RelayOrefResponse;
    const mapAlert = (a: RelayOrefAlert): OrefAlert => ({
      id: String(a.id || ''),
      cat: String(a.cat || ''),
      title: String(a.title || ''),
      data: Array.isArray(a.data) ? a.data.map(String) : [],
      desc: String(a.desc || ''),
      timestampMs: parseOrefDate(a.alertDate),
    });

    return {
      configured: data.configured ?? false,
      alerts: (data.alerts || []).map(mapAlert),
      history: (data.history || []).map((h) => ({
        alerts: (h.alerts || []).map(mapAlert),
        timestampMs: parseOrefDate(h.timestamp),
      })),
      historyCount24h: data.historyCount24h || 0,
      totalHistoryCount: data.totalHistoryCount || 0,
      timestampMs: parseOrefDate(data.timestamp || new Date().toISOString()),
      error: data.error || '',
    };
  } catch (err) {
    const nowMs = Date.now().toString();
    return {
      configured: false,
      alerts: [],
      history: [],
      historyCount24h: 0,
      totalHistoryCount: 0,
      timestampMs: nowMs,
      error: String(err),
    };
  }
};
