import type { SearchModal } from '@/components/SearchModal';
import { SentAlertSearchSource } from '@/app/search-alert-source';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';
import { getLocale, t } from '@/services/i18n';
import { hasPremiumAccess } from '@/services/panel-gating';
import { fetchSentAlerts, type SentAlert } from '@/services/sent-alerts';

/** "Reuters · Sent 17 Nov, 09:42" in the viewer's language and time zone. */
function describeSentAlert(alert: SentAlert): string {
  let time: string;
  try {
    time = new Intl.DateTimeFormat(getLocale(), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(alert.sentAt);
  } catch {
    time = new Date(alert.sentAt).toISOString().slice(0, 16).replace('T', ' ');
  }
  const sent = t('modals.search.sentAlertTime', { time });
  return alert.source ? `${alert.source} · ${sent}` : sent;
}

/**
 * Feed the palette's "Alerts sent to you" section. The alerts are fetched
 * when the palette opens, for a signed-in Pro account only, and dropped as
 * soon as that account signs out, changes or loses Pro. Returns the teardown.
 */
export function attachSentAlertSearch(modal: SearchModal): () => void {
  // The server reads the account from the Clerk session, so a Pro key with no
  // signed-in user has no alert history to ask for.
  const accountKey = (): string | null => {
    const auth = getAuthState();
    return auth.user && hasPremiumAccess(auth) ? auth.user.id : null;
  };
  const source = new SentAlertSearchSource({
    getAccountKey: accountKey,
    fetchAlerts: fetchSentAlerts,
    publish: (items) => {
      modal.registerSource('alert', items);
      modal.refreshSearch();
    },
    describe: describeSentAlert,
  });
  modal.setOnOpen(() => { void source.refresh(); });

  let lastAccount = accountKey();
  const dropOnAccountChange = (): void => {
    const next = accountKey();
    if (next === lastAccount) return;
    lastAccount = next;
    // Clear now; the next open fetches for whoever is signed in then.
    source.clear();
  };
  const unsubscribeAuth = subscribeAuthState(dropOnAccountChange);
  const unsubscribeEntitlement = onEntitlementChange(dropOnAccountChange);

  return () => {
    unsubscribeAuth();
    unsubscribeEntitlement();
    source.clear();
    modal.setOnOpen(() => {});
  };
}
