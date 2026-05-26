/**
 * FollowButton — reusable star/follow-button helper for U4.
 *
 * Mounted by all three PR-A surfaces (CountryDeepDivePanel,
 * CountryIntelModal, CIIPanel rows) via `renderFollowButton({...})`.
 *
 * Owns:
 *  - Visual states: outlined star (not followed), filled star (followed),
 *    spinner (entitlement loading), hidden (feature flag off).
 *  - Click handler that calls into `addCountry` / `removeCountry`.
 *  - Subscription to watchlist + entitlement changes (re-render on update).
 *  - Branch on `FollowMutationResult.reason` — opens the upgrade modal
 *    on `FREE_CAP` via the same path `notifications-settings.ts` uses
 *    (lazy `@/services/clerk` + `@/services/checkout`).
 *
 * Pattern:
 *  - `{ html, attach } → teardown` matches `src/services/notifications-settings.ts`.
 *  - The factory does NOT produce real DOM nodes; it returns an `html`
 *    string for the host to insert and an `attach(host)` that owns the
 *    container's innerHTML on each re-render. This keeps the helper
 *    DOM-light and unit-testable against a minimal host stub (the
 *    project's `tests/*.test.mjs` runner has no jsdom).
 *
 * Memory:
 *  - `paywalled-feature-needs-three-layer-entitlement-gate` — the button
 *    consults `serviceEntitlementState()` (not raw `getEntitlementState()`)
 *    so anonymous users render interactive immediately while signed-in
 *    users awaiting their first entitlement snapshot show the spinner.
 *  - `discriminated-union-over-sentinel-boolean` — branches on
 *    `FollowMutationResult.reason`, never on a boolean.
 *
 * NOTE: cap-drop toast (the `WM_FOLLOWED_COUNTRIES_CAP_DROP` event from
 * U3) is intentionally NOT handled here. The button is a per-country
 * primitive; the toast is App-level UI. TODO(U7+): wire a single
 * cap-drop listener at the App / toast-service level so it doesn't
 * fire once-per-mounted-button.
 */

import {
  addCountry,
  removeCountry,
  isFollowed,
  getFollowed,
  subscribe,
  serviceEntitlementState,
  isFollowFeatureEnabled,
  FREE_TIER_FOLLOW_LIMIT,
  type FollowMutationResult,
} from '@/services/followed-countries';
import { onEntitlementChange } from '@/services/entitlements';
import { escapeHtml } from '@/utils/sanitize';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FollowButtonProps {
  countryCode: string;
  /** Render size. Default `'md'`. */
  size?: 'sm' | 'md';
  /**
   * Optional country display name for the tooltip. If omitted the
   * tooltip falls back to the country code. We don't depend on
   * `getCountryNameByCode` because GeoJSON may not be loaded when
   * the button is mounted and we want zero render-blocking awaits.
   */
  countryName?: string;
}

export interface FollowButtonHandle {
  /**
   * Initial markup the host inserts. The host then calls `attach(host)`
   * which owns subsequent re-renders inside that same node.
   */
  html: string;
  /**
   * Mounts the button into `host`. Returns a teardown function that
   * unsubs both watchlist + entitlement listeners and removes the
   * click listener. Safe to call twice.
   */
  attach: (host: HTMLElement) => () => void;
}

// ---------------------------------------------------------------------------
// Test-injection seam: upgrade-modal trigger
// ---------------------------------------------------------------------------
//
// In production, the `FREE_CAP` branch dynamically imports clerk +
// checkout (the same lazy path `notifications-settings.ts` uses for the
// "Upgrade to Pro" button). Tests inject a synchronous fake here so
// they can assert the trigger was called without spinning up the real
// import graph.

type UpgradeTrigger = (source: string) => void;

let _upgradeTrigger: UpgradeTrigger = (source) => {
  // Match the notifications-settings.ts pattern: try sign-in first if no
  // user, otherwise drop into checkout. If anything fails we fall back
  // to the `/pro` page (consistent w/ ProBanner CTA).
  try {
    void import('@/services/clerk').then((clerk) => {
      const user = clerk.getCurrentClerkUser?.();
      if (!user) {
        const opener = clerk.openSignIn;
        if (typeof opener === 'function') {
          opener();
          return;
        }
      }
      // Signed-in OR no openSignIn helper — go straight to checkout.
      void import('@/services/checkout')
        .then((checkout) =>
          import('@/config/products').then((products) => {
            const product = (products as { DEFAULT_UPGRADE_PRODUCT?: unknown })
              .DEFAULT_UPGRADE_PRODUCT;
            if (product && typeof checkout.startCheckout === 'function') {
              checkout.startCheckout(
                product as Parameters<typeof checkout.startCheckout>[0],
              );
            } else {
              window.open('/pro#pricing', '_blank');
            }
          }),
        )
        .catch(() => {
          window.open('/pro#pricing', '_blank');
        });
    });
  } catch {
    try {
      window.open('/pro#pricing', '_blank');
    } catch {
      /* swallow — non-browser env */
    }
  }
  // `source` is informational; analytics integration is App-level.
  // We deliberately don't pull in `@/services/analytics` here to avoid
  // a heavy import chain on the button factory.
  void source;
};

/**
 * Test-only override for the upgrade-modal trigger. Pass `null` to
 * restore the production lazy-import path.
 */
export function _setUpgradeTriggerForTests(fn: UpgradeTrigger | null): void {
  _upgradeTrigger = fn ?? ((source) => {
    void source;
    try {
      window.open('/pro#pricing', '_blank');
    } catch {
      /* swallow */
    }
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface ButtonViewState {
  visible: boolean;
  followed: boolean;
  loading: boolean;
  atCap: boolean;
}

function computeViewState(countryCode: string): ButtonViewState {
  if (!isFollowFeatureEnabled()) {
    return { visible: false, followed: false, loading: false, atCap: false };
  }
  const entState = serviceEntitlementState();
  if (entState === 'loading') {
    return { visible: true, followed: false, loading: true, atCap: false };
  }
  const followed = isFollowed(countryCode);
  // We don't query getFollowed().length here for `atCap` — the *click*
  // path is the source of truth (the service rejects on FREE_CAP and
  // returns the discriminated reason). The tooltip is the only thing
  // that benefits from knowing "would clicking this fail?" upfront, and
  // for that we do a cheap-and-correct check: if free + already at cap
  // + not currently followed, the next click would hit FREE_CAP.
  let atCap = false;
  if (entState === 'free' && !followed) {
    // Local import to avoid a circular dependency through addCountry's
    // re-entry. We import getFollowed lazily via the top-level service.
    // Doing this dynamically keeps the synchronous render path simple.
    // (We DO statically import the rest of the service above.)
    try {
      // The countModule branch is intentionally a defensive try; if
      // anything throws we fall back to atCap=false and let the click
      // handler reveal the cap.
      const list = _getFollowedListSafe();
      atCap = list.length >= FREE_TIER_FOLLOW_LIMIT;
    } catch {
      atCap = false;
    }
  }
  return { visible: true, followed, loading: false, atCap };
}

function _getFollowedListSafe(): string[] {
  try {
    return getFollowed();
  } catch {
    return [];
  }
}

function renderHtml(state: ButtonViewState, props: FollowButtonProps): string {
  if (!state.visible) return '';

  const sizeCls = `wm-follow-btn--${props.size ?? 'md'}`;
  const displayName = props.countryName?.trim() || props.countryCode;
  const safeCode = escapeHtml(props.countryCode);
  const safeName = escapeHtml(displayName);

  if (state.loading) {
    return (
      `<button type="button" class="wm-follow-btn ${sizeCls} wm-follow-btn--loading"` +
      ` data-country="${safeCode}" data-state="loading"` +
      ` aria-label="Loading follow state for ${safeName}"` +
      ` title="Syncing your follows…" disabled>` +
      `<span class="wm-follow-btn-spinner" aria-hidden="true"></span>` +
      `</button>`
    );
  }

  if (state.followed) {
    return (
      `<button type="button" class="wm-follow-btn ${sizeCls} wm-follow-btn--followed"` +
      ` data-country="${safeCode}" data-state="followed"` +
      ` aria-pressed="true"` +
      ` aria-label="Unfollow ${safeName}"` +
      ` title="Unfollow ${safeName}">` +
      // Filled star
      `<svg class="wm-follow-btn-icon" width="16" height="16" viewBox="0 0 24 24"` +
      ` fill="currentColor" aria-hidden="true">` +
      `<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>` +
      `</svg>` +
      `</button>`
    );
  }

  // Not followed.
  const tooltip = state.atCap ? 'Upgrade to follow more' : `Follow ${displayName}`;
  return (
    `<button type="button" class="wm-follow-btn ${sizeCls} wm-follow-btn--unfollowed${
      state.atCap ? ' wm-follow-btn--at-cap' : ''
    }"` +
    ` data-country="${safeCode}" data-state="unfollowed"` +
    ` aria-pressed="false"` +
    ` aria-label="${escapeHtml(tooltip)}"` +
    ` title="${escapeHtml(tooltip)}">` +
    // Outlined star
    `<svg class="wm-follow-btn-icon" width="16" height="16" viewBox="0 0 24 24"` +
    ` fill="none" stroke="currentColor" stroke-width="2"` +
    ` stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>` +
    `</svg>` +
    `</button>`
  );
}

export function renderFollowButton(
  props: FollowButtonProps,
): FollowButtonHandle {
  const flagOn = isFollowFeatureEnabled();

  // Feature flag off → empty html, no-op attach. The host inserts
  // nothing; nothing to teardown.
  if (!flagOn) {
    return {
      html: '',
      attach: (_host: HTMLElement) => () => {
        /* no-op */
      },
    };
  }

  // Initial render uses the current (synchronous) state. The host
  // inserts this directly; `attach` then re-renders inside the host
  // when state changes.
  const initialState = computeViewState(props.countryCode);
  const initialHtml = renderHtml(initialState, props);

  return {
    html: initialHtml,
    attach(host: HTMLElement): () => void {
      let tornDown = false;
      // P2 #17 — inFlight latch prevents rapid double-click duplicate
      // mutations. Set true at click-handler entry, cleared in finally
      // after the awaited mutation resolves. While true, additional
      // clicks are dropped silently (no second addCountry/removeCountry
      // is fired). Without this, a double-click on an unfollowed button
      // would produce TWO follows that both succeed (the service is
      // idempotent on (user, country) but the second add is wasted
      // network + counter increment work).
      let inFlight = false;

      // Re-render uses host.innerHTML (the host is dedicated to this
      // button; it's not a delegated container). This keeps the
      // rendering side-effect-free w.r.t. the surrounding panel.
      const rerender = () => {
        if (tornDown) return;
        const next = computeViewState(props.countryCode);
        host.innerHTML = renderHtml(next, props);
      };

      // Render once on attach so any state drift between the initial
      // `html` snapshot and `attach()` time (rare but possible) is
      // resolved. Also ensures a freshly-mounted button always reflects
      // the current world.
      rerender();

      const clickHandler = (ev: Event) => {
        if (tornDown) return;
        // Resolve the actual <button>; ignore clicks on nested children
        // that bubble up.
        const target = ev.target as Element | null;
        const btn =
          target && typeof (target as Element).closest === 'function'
            ? (target as Element).closest<HTMLElement>('.wm-follow-btn')
            : null;
        if (!btn) return;
        if (btn.getAttribute('data-state') === 'loading') {
          // Defensive: spinner state should already be `disabled`, but
          // make the click a no-op regardless.
          return;
        }
        // P2 #17 — drop duplicate clicks while a mutation is in flight.
        if (inFlight) {
          ev.preventDefault();
          return;
        }
        ev.preventDefault();
        inFlight = true;
        void onClick(props, () => rerender()).finally(() => {
          inFlight = false;
        });
      };

      host.addEventListener('click', clickHandler);

      // Subscribe to watchlist + entitlement changes; re-render on
      // either signal.
      const unsubWatchlist = subscribe(rerender);
      const unsubEntitlement = onEntitlementChange(rerender);

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
        try {
          unsubEntitlement();
        } catch {
          /* swallow */
        }
      };
    },
  };
}

/**
 * P2 #16 — exhaustiveness helper. Used in the `onClick` switch on
 * `FollowMutationResult.reason`. If a future contributor adds a new
 * reason variant to `FollowMutationResult` and forgets to add a
 * `case` here, TypeScript will fail to compile because the residual
 * `result.reason` won't narrow to `never`. The runtime fallback only
 * fires for an actual untyped value (e.g., from a malformed test
 * fake) — production code paths are caught at typecheck time.
 */
function assertNever(value: never, where = 'follow-button'): never {
  throw new Error(`[${where}] unhandled discriminant: ${String(value)}`);
}

async function onClick(
  props: FollowButtonProps,
  rerenderForFailure: () => void,
): Promise<void> {
  const followedNow = isFollowed(props.countryCode);

  let result: FollowMutationResult;
  try {
    result = followedNow
      ? await removeCountry(props.countryCode)
      : await addCountry(props.countryCode);
  } catch (err) {
    // Service contract is "never throws," but defensively re-render so
    // the visual state stays in sync if some transitive call rejects.
    console.warn('[follow-button] mutation threw unexpectedly:', err);
    rerenderForFailure();
    return;
  }

  if (result.ok) {
    // The service dispatches WM_FOLLOWED_COUNTRIES_CHANGED on success,
    // which our `subscribe(rerender)` listener picks up. No manual
    // re-render needed.
    return;
  }

  switch (result.reason) {
    case 'FREE_CAP':
      try {
        _upgradeTrigger('follow-cap');
      } catch (err) {
        console.warn('[follow-button] upgrade trigger failed:', err);
      }
      // Re-render so the tooltip / aria-label settles back to the
      // "Upgrade to follow more" state if it wasn't already there.
      rerenderForFailure();
      return;
    case 'HANDOFF_PENDING':
    case 'ENTITLEMENT_LOADING':
    case 'DISABLED':
      // Defensive: button should have been hidden / disabled. Re-render
      // so the visible state catches up.
      rerenderForFailure();
      return;
    case 'INVALID_INPUT':
      console.warn(
        '[follow-button] invalid country code at mount site:',
        props.countryCode,
      );
      return;
    case 'STORAGE_FULL':
      // Anonymous-mode quota exhausted. Not user-actionable; logging
      // suffices. (A toast would be nice but is out of scope for U4.)
      console.warn(
        '[follow-button] anonymous storage full — cannot persist follow',
      );
      return;
    default:
      // P2 #16 — exhaustiveness: when every variant is handled above,
      // `result` narrows to `never` here. Adding a new reason to
      // `FollowMutationResult` widens the residual type and produces
      // a TS2345 ('not assignable to never') at the call site below.
      assertNever(result);
  }
}
