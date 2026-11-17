import {
  ApiError,
  type ListSentAlertsRequest,
  type ListSentAlertsResponse,
  type ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { TRUSTED_USER_ID_HEADER } from '../../../_shared/mcp-internal-hmac';
import { readCachedJsonList } from '../../../_shared/redis';
import {
  SENT_ALERTS_MAX,
  SENT_ALERTS_RETENTION_DAYS,
  parseSentAlert,
  sentAlertsKey,
  type SentAlertRecord,
} from '../../../_shared/sent-alert-history';

const RETENTION_MS = SENT_ALERTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * The realtime alerts delivered to the calling account, newest first, so the
 * dashboard search can find a headline after it left the loaded news.
 *
 * Account-private. The account is the user id the gateway authenticated and
 * stamped on the request (it strips any client copy of that header); the
 * request carries no user field. A caller the gateway could not tie to a user,
 * such as an operator key, is refused before any read. The route is `no-store`
 * in the gateway and nothing here is cached, so one user's alerts cannot be
 * served to another.
 */
export async function listSentAlerts(
  ctx: ServerContext,
  _req: ListSentAlertsRequest,
): Promise<ListSentAlertsResponse> {
  const userId = ctx.request.headers.get(TRUSTED_USER_ID_HEADER)?.trim();
  if (!userId) throw new ApiError(401, 'Sign in to read the alerts sent to you', '');

  // raw: the relay writes this key without the deployment prefix.
  const read = await readCachedJsonList(sentAlertsKey(userId), SENT_ALERTS_MAX, true);
  if (read.status === 'error') {
    console.warn('[list-sent-alerts] history read failed:', read.error instanceof Error ? read.error.message : String(read.error));
    return { alerts: [], state: 'unavailable', retentionDays: SENT_ALERTS_RETENTION_DAYS };
  }

  const rows = read.status === 'hit' && Array.isArray(read.value) ? read.value : [];
  // The list keeps its TTL as long as alerts keep arriving, so an old row can
  // outlive the stated window; the window is applied here.
  const cutoff = Date.now() - RETENTION_MS;
  const alerts = rows
    .map(parseSentAlert)
    .filter((alert): alert is SentAlertRecord => alert !== null && alert.sentAt >= cutoff);
  return { alerts, state: 'ok', retentionDays: SENT_ALERTS_RETENTION_DAYS };
}
