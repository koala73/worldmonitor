import type {
  IntelligenceServiceHandler,
  ServerContext,
  ListOrefAlertsRequest,
  ListOrefAlertsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

/**
 * ListOrefAlerts fetches Israeli Red Alerts from the Home Front Command relay.
 */
export const listOrefAlerts: IntelligenceServiceHandler['listOrefAlerts'] = async (
  _ctx: ServerContext,
  req: ListOrefAlertsRequest,
): Promise<ListOrefAlertsResponse> => {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) {
    return {
      configured: false,
      alerts: [],
      history: [],
      historyCount24h: 0,
      totalHistoryCount: 0,
      timestamp: new Date().toISOString(),
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
      return {
        configured: false,
        alerts: [],
        history: [],
        historyCount24h: 0,
        totalHistoryCount: 0,
        timestamp: new Date().toISOString(),
        error: `Relay HTTP ${resp.status}`,
      };
    }

    const data = await resp.json();
    return {
      configured: data.configured ?? false,
      alerts: (data.alerts || []).map((a: any) => ({
        id: String(a.id || ''),
        cat: String(a.cat || ''),
        title: String(a.title || ''),
        data: Array.isArray(a.data) ? a.data.map(String) : [],
        desc: String(a.desc || ''),
        alertDate: String(a.alertDate || ''),
      })),
      history: (data.history || []).map((h: any) => ({
        alerts: (h.alerts || []).map((a: any) => ({
          id: String(a.id || ''),
          cat: String(a.cat || ''),
          title: String(a.title || ''),
          data: Array.isArray(a.data) ? a.data.map(String) : [],
          desc: String(a.desc || ''),
          alertDate: String(a.alertDate || ''),
        })),
        timestamp: String(h.timestamp || ''),
      })),
      historyCount24h: data.historyCount24h || 0,
      totalHistoryCount: data.totalHistoryCount || 0,
      timestamp: data.timestamp || new Date().toISOString(),
      error: data.error || '',
    };
  } catch (err) {
    return {
      configured: false,
      alerts: [],
      history: [],
      historyCount24h: 0,
      totalHistoryCount: 0,
      timestamp: new Date().toISOString(),
      error: String(err),
    };
  }
};
