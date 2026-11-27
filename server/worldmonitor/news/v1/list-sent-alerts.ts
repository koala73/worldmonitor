import {
  ApiError,
  type ListSentAlertsRequest,
  type ListSentAlertsResponse,
  type ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { isLinkSuppressed, parseSuppressionEntries } from '../../../../scripts/shared/notification-link-suppression.cjs';
import { TRUSTED_USER_ID_HEADER } from '../../../_shared/mcp-internal-hmac';
import { readCachedJsonList, runRedisPipeline } from '../../../_shared/redis';
import {
  BLOCKED_NOTIFICATION_LINKS_KEY,
  SENT_ALERTS_MAX,
  SENT_ALERTS_RETENTION_DAYS,
  parseSentAlert,
  sentAlertsKey,
  type SentAlertRecord,
} from '../../../_shared/sent-alert-history';

const RETENTION_MS = SENT_ALERTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const UNAVAILABLE: ListSentAlertsResponse = { alerts: [], state: 'unavailable' };

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
 *
 * An alert whose link an operator has since blocked (#8401) is left out: the
 * search opens the link in one click, the same navigation the service worker
 * refuses for an already-delivered push. When the block list cannot be read
 * the answer is `unavailable`, never an unchecked list.
 */
export async function listSentAlerts(
  ctx: ServerContext,
  _req: ListSentAlertsRequest,
): Promise<ListSentAlertsResponse> {
  const userId = ctx.request.headers.get(TRUSTED_USER_ID_HEADER)?.trim();
  if (!userId) throw new ApiError(401, 'Sign in to read the alerts sent to you', '');

  // raw: the relay writes both keys without the deployment prefix.
  const [history, [blocked]] = await Promise.all([
    readCachedJsonList(sentAlertsKey(userId), SENT_ALERTS_MAX, true),
    runRedisPipeline([['SMEMBERS', BLOCKED_NOTIFICATION_LINKS_KEY]], true),
  ]);
  if (history.status === 'error' || !blocked || blocked.error || !Array.isArray(blocked.result)) {
    console.warn('[list-sent-alerts] history or link block list could not be read');
    return UNAVAILABLE;
  }

  const rows = history.status === 'hit' && Array.isArray(history.value) ? history.value : [];
  const suppressed = parseSuppressionEntries(blocked.result);
  // The list keeps its TTL as long as alerts keep arriving, so an old row can
  // outlive the stated window; the window is applied here.
  const cutoff = Date.now() - RETENTION_MS;
  const alerts = rows
    .map(parseSentAlert)
    .filter((alert): alert is SentAlertRecord => (
      alert !== null && alert.sentAt >= cutoff && !isLinkSuppressed(alert.link, suppressed)
    ))
    // The relay stores a pass's records when the pass ends, and a quiet-hours
    // batch runs alongside realtime delivery, so the stored order is not the
    // delivery order. The search keeps the first of two rows for one headline
    // and link, which has to be the newest. The sort is stable: alerts sent in
    // the same millisecond keep their stored order.
    .sort((a, b) => b.sentAt - a.sentAt);
  return { alerts, state: 'ok' };
}
