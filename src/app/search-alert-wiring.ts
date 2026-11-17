import type { SearchModal } from '@/components/SearchModal';
import { SentAlertSearchSource, isOpenableAlertLink } from '@/app/search-alert-source';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { isDesktopRuntime } from '@/services/desktop-runtime';
import { onEntitlementChange } from '@/services/entitlements';
import { isOpenableExternalUrl, openExternalUrl } from '@/services/external-navigation';
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
 * Whether this runtime can open an alert's article. Desktop opens through the
 * native opener, which takes https (and http for localhost only), so a
 * plain-http article is listed there without a link instead of as a row that
 * does nothing when selected.
 */
export function canOpenSentAlertLink(link: string): boolean {
  if (!isOpenableAlertLink(link)) return false;
  return !isDesktopRuntime() || isOpenableExternalUrl(link);
}

/**
 * Open a delivered alert's article outside the dashboard. A search row is not
 * an anchor, so the desktop link interceptor (app/event-handlers.ts) never
 * sees it: desktop hands the URL to the OS browser here, and `window.open`
 * would open it inside the app's WebView. Web opens a new tab.
 */
export function openSentAlertLink(url: string): void {
  if (isDesktopRuntime()) void openExternalUrl(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
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
  // True while the palette is still opening. A fresh palette has no query, so
  // a clear issued then needs no re-render; re-rendering there would also
  // pre-empt the phone sheet's deferred first paint.
  let opening = false;
  const source = new SentAlertSearchSource({
    getAccountKey: accountKey,
    fetchAlerts: fetchSentAlerts,
    publish: (items) => {
      const revision = modal.getSearchIndexRevision();
      modal.registerSource('alert', items);
      // Re-render only when the alerts changed: a re-render resets the
      // arrow-key selection.
      if (!opening && modal.getSearchIndexRevision() !== revision) modal.refreshSearch();
    },
    describe: describeSentAlert,
    canOpenLink: canOpenSentAlertLink,
  });
  modal.setOnOpen(() => {
    opening = true;
    // refresh() drops a previous account's alerts before its first await.
    const pending = source.refresh();
    opening = false;
    void pending;
  });

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
