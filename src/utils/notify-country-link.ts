/**
 * NotifyCountryLink — inline "Notify me about this country" sub-action for U8.
 *
 * Mounted on the Country Deep Dive panel right next to the FollowButton.
 * Visible only when the user is currently following the target country
 * (FollowButton in filled state); hidden otherwise. Clicking the link
 * opens the user's notifications settings page so they can configure /
 * create an alert rule for this country.
 *
 * Degraded path (this PR): the link just opens the existing notifications
 * settings tab — no pre-fill. The future PR (after the alertRules
 * `countries` schema lands) will replace `openNotificationsForCountry`'s
 * implementation with a pre-filled-form open. The injection point lives
 * here so the future change is a single-helper swap rather than a
 * cross-file edit.
 *
 * TODO: when alertRules.countries schema lands, pre-fill the create form
 *   with this country code via routing param or query string. See plan
 *   U8 R9.
 *
 * Pattern: `{ html, attach } → teardown`, mirroring
 *   `src/utils/follow-button.ts`
 *   `src/utils/followed-only-chip.ts`
 * so the host element owns the placement and this helper owns the
 * innerHTML + listener lifecycle inside that host.
 */

import {
  isFollowed,
  isFollowFeatureEnabled,
  subscribe,
} from '@/services/followed-countries';
import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NotifyCountryLinkProps {
  countryCode: string;
  /** Optional country display name for tooltip / aria-label. */
  countryName?: string;
}

export interface NotifyCountryLinkHandle {
  html: string;
  attach: (host: HTMLElement) => () => void;
}

// ---------------------------------------------------------------------------
// Global custom event — injection point for the future pre-fill PR.
// ---------------------------------------------------------------------------

/**
 * Window event the App listens for in `event-handlers.ts::setupUnifiedSettings`.
 * Detail carries the country code so the future PR can read it from the
 * event listener and pre-fill the alert-rule create form. Today the
 * listener ignores the detail and just opens the notifications tab.
 */
export const WM_OPEN_NOTIFICATIONS_FOR_COUNTRY =
  'wm-open-notifications-for-country';

export interface OpenNotificationsForCountryDetail {
  country: string;
}

// ---------------------------------------------------------------------------
// Test-injection seam — a swappable open-helper closure.
//
// Mirrors the `_setUpgradeTriggerForTests` pattern in
// `src/utils/follow-button.ts`. Tests assert "click invokes the
// helper" without needing a real window event listener; production
// uses the default closure that dispatches the CustomEvent.
// ---------------------------------------------------------------------------

type OpenHelper = (countryCode: string) => void;

const _defaultOpen: OpenHelper = (countryCode) => {
  if (typeof window === 'undefined') return;
  try {
    const detail: OpenNotificationsForCountryDetail = { country: countryCode };
    window.dispatchEvent(
      new CustomEvent(WM_OPEN_NOTIFICATIONS_FOR_COUNTRY, { detail }),
    );
  } catch {
    /* swallow — non-browser env or CustomEvent unavailable */
  }
};

let _openHelper: OpenHelper = _defaultOpen;

/**
 * Opens the notifications settings page for the given country.
 *
 * Today: dispatches a window CustomEvent that the App listens for and
 * forwards to `unifiedSettings.open('notifications')`. No pre-fill.
 *
 * TODO: when alertRules.countries schema lands, this helper should
 * resolve the user's saved rules and either open the create form
 * pre-filled with `[countryCode]` (no matching rule) or scroll to /
 * focus the existing rule (rule already covers this country). See
 * plan U8 R9. The injection point is intentionally THIS function so
 * the future change is a single-helper swap.
 */
export function openNotificationsForCountry(countryCode: string): void {
  _openHelper(countryCode);
}

/**
 * Test-only override for the open-helper. Pass `null` to restore the
 * production CustomEvent dispatch.
 */
export function _setOpenNotificationsForCountryForTests(
  fn: OpenHelper | null,
): void {
  _openHelper = fn ?? _defaultOpen;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface ViewState {
  visible: boolean;
}

function computeViewState(props: NotifyCountryLinkProps): ViewState {
  if (!isFollowFeatureEnabled()) return { visible: false };
  // Only show the sub-action when the user is currently following the
  // country — the link is the bridge between "I'm interested" and
  // "I want to be notified." If the user isn't following, the link is
  // noise.
  return { visible: isFollowed(props.countryCode) };
}

function renderHtml(state: ViewState, props: NotifyCountryLinkProps): string {
  if (!state.visible) return '';
  const displayName = props.countryName?.trim() || props.countryCode;
  const safeCode = escapeHtml(props.countryCode);
  const safeName = escapeHtml(displayName);
  const tooltip = `Notify me about ${displayName}`;
  const safeTooltip = escapeHtml(tooltip);
  // Real <button type="button"> so keyboard activation + focus work.
  // Visually styled as an inline link via .cdp-notify-link CSS.
  return (
    `<button type="button" class="cdp-notify-link"` +
    ` data-country="${safeCode}"` +
    ` aria-label="${safeTooltip}"` +
    ` title="${safeTooltip}">` +
    // Bell icon — outlined, 12px, centred against text baseline.
    `<svg class="cdp-notify-link-icon" width="12" height="12" viewBox="0 0 24 24"` +
    ` fill="none" stroke="currentColor" stroke-width="2"` +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>` +
    `<path d="M13.73 21a2 2 0 0 1-3.46 0"/>` +
    `</svg>` +
    `<span class="cdp-notify-link-label">Notify me about ${safeName}</span>` +
    `</button>`
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function renderNotifyCountryLink(
  props: NotifyCountryLinkProps,
): NotifyCountryLinkHandle {
  // Feature flag off → empty html, no-op attach. Mirrors FollowButton.
  if (!isFollowFeatureEnabled()) {
    return {
      html: '',
      attach: (_host: HTMLElement) => () => {
        /* no-op */
      },
    };
  }

  const initialState = computeViewState(props);
  const initialHtml = renderHtml(initialState, props);

  return {
    html: initialHtml,
    attach(host: HTMLElement): () => void {
      let tornDown = false;

      const rerender = (): void => {
        if (tornDown) return;
        const next = computeViewState(props);
        setTrustedHtml(host, trustedHtml(renderHtml(next, props), "legacy direct innerHTML migration"));
      };

      // Render once on attach to resolve any state drift between the
      // initial `html` snapshot and `attach()` time.
      rerender();

      const clickHandler = (ev: Event): void => {
        if (tornDown) return;
        const target = ev.target as Element | null;
        const btn =
          target && typeof (target as Element).closest === 'function'
            ? (target as Element).closest<HTMLElement>('.cdp-notify-link')
            : null;
        if (!btn) return;
        ev.preventDefault();
        try {
          // TODO: when alertRules.countries schema lands, pre-fill the
          // create form with this country code via routing param or
          // query string. See plan U8 R9. The future PR replaces
          // `openNotificationsForCountry`'s body — this call site
          // stays the same.
          openNotificationsForCountry(props.countryCode);
        } catch (err) {
          console.warn('[notify-country-link] open helper threw:', err);
        }
      };

      host.addEventListener('click', clickHandler);

      // Re-render whenever the watchlist changes — entering / leaving
      // the followed state for THIS country flips visibility.
      const unsubWatchlist = subscribe(rerender);

      return () => {
        if (tornDown) return;
        tornDown = true;
        try {
          host.removeEventListener('click', clickHandler);
        } catch {
          /* swallow */
        }
        try {
          unsubWatchlist();
        } catch {
          /* swallow */
        }
      };
    },
  };
}
