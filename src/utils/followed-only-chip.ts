/**
 * FollowedOnlyChip — toggleable header chip that scopes a panel's list
 * to the user's followed countries (U7).
 *
 * Returns the same `{ html, attach } → teardown` shape as
 * `src/utils/follow-button.ts` so panels can mount it with a host
 * element whose innerHTML is owned by this helper.
 *
 * State model (per panel):
 *  - `localStorage["wm-followed-only-filter-${panelId}"] = '1' | '0'`
 *    (default off when the key is absent)
 *  - Per-instance `panelId` keeps the user's choice scoped to that
 *    panel — the toggle does NOT bleed across unrelated panels.
 *
 * Disabled state:
 *  - `getFollowed().length === 0` → chip rendered disabled with the
 *    tooltip "Follow countries to enable this filter".
 *  - On `WM_FOLLOWED_COUNTRIES_CHANGED` we re-render so the disabled
 *    flip happens immediately when the user follows / unfollows from
 *    elsewhere in the app.
 *
 * Hidden when `isFollowFeatureEnabled()` returns false (feature flag
 * off) — `html === ''` and `attach()` is a no-op, so a host that's
 * always present in the DOM stays visually empty.
 *
 * Memory: `discriminated-union-over-sentinel-boolean` — `onChange`
 * receives a strict `boolean` (active state) rather than a tri-state.
 * The chip is its own UI primitive; the panel decides what "active"
 * means in its render path.
 */

import {
  getFollowed,
  subscribe,
  isFollowFeatureEnabled,
} from '@/services/followed-countries';
import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FollowedOnlyChipProps {
  /**
   * Stable ID for this panel instance — used in the localStorage key
   * to keep toggles scoped per panel. Two distinct panels may safely
   * use the same key style but different `panelId` values; collisions
   * are the caller's problem.
   */
  panelId: string;
  /** Fired whenever the user toggles the chip. Receives the new state. */
  onChange?: (active: boolean) => void;
  /** Optional override for the chip label. Default: "Followed only". */
  label?: string;
}

export interface FollowedOnlyChipHandle {
  /**
   * Initial markup for the host to insert. The host then calls
   * `attach(host)` which owns subsequent re-renders.
   */
  html: string;
  /**
   * Mounts the chip into `host`. Returns a teardown function that
   * removes both the click listener and the watchlist subscription.
   * Safe to call twice.
   */
  attach: (host: HTMLElement) => () => void;
  /**
   * Reads the current persisted state. Call sites use this in their
   * filter pass instead of mirroring the value into a local field —
   * single source of truth is localStorage.
   */
  isActive: () => boolean;
}

// ---------------------------------------------------------------------------
// Storage helpers — module-private
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = 'wm-followed-only-filter-';

function storageKeyFor(panelId: string): string {
  return `${STORAGE_KEY_PREFIX}${panelId}`;
}

function readActive(panelId: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(storageKeyFor(panelId)) === '1';
  } catch {
    return false;
  }
}

function writeActive(panelId: string, active: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (active) {
      localStorage.setItem(storageKeyFor(panelId), '1');
    } else {
      // Remove the key when off so "default off" remains the absent state.
      localStorage.removeItem(storageKeyFor(panelId));
    }
  } catch {
    /* swallow — quota / sandbox errors don't fail the click */
  }
}

function readEffectiveActive(panelId: string, followedCount: number): boolean {
  const active = readActive(panelId);
  if (!active) return false;
  if (followedCount > 0) return true;
  // A persisted active filter with no followed countries is impossible to use:
  // the button is disabled, so the user cannot click it off. Clear the stale
  // bit and expose inactive state to panel filter passes.
  writeActive(panelId, false);
  return false;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface ViewState {
  visible: boolean;
  active: boolean;
  disabled: boolean;
  label: string;
}

function computeViewState(props: FollowedOnlyChipProps): ViewState {
  if (!isFollowFeatureEnabled()) {
    return {
      visible: false,
      active: false,
      disabled: false,
      label: props.label ?? 'Followed only',
    };
  }
  const followedCount = getFollowed().length;
  const disabled = followedCount === 0;
  const active = readEffectiveActive(props.panelId, followedCount);
  return {
    visible: true,
    active,
    disabled,
    label: props.label ?? 'Followed only',
  };
}

function renderHtml(state: ViewState): string {
  if (!state.visible) return '';
  const safeLabel = escapeHtml(state.label);
  const tooltip = state.disabled
    ? 'Follow countries to enable this filter'
    : state.active
      ? `Showing only your followed countries — click to clear`
      : `Show only your followed countries`;
  const safeTooltip = escapeHtml(tooltip);
  const cls = [
    'wm-followed-only-chip',
    state.active ? 'wm-followed-only-chip--active' : '',
    state.disabled ? 'wm-followed-only-chip--disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const ariaPressed = state.active ? 'true' : 'false';
  // We deliberately keep the chip element a real <button> with type="button"
  // (vs. a span / div + role="button") so keyboard activation, focus, and
  // disabled state come for free.
  return (
    `<button type="button" class="${cls}"` +
    ` aria-pressed="${ariaPressed}"` +
    ` aria-label="${safeTooltip}"` +
    ` title="${safeTooltip}"` +
    (state.disabled ? ' disabled' : '') +
    ` data-state="${state.active ? 'active' : 'inactive'}"` +
    `>` +
    // Star/filter glyph — same outline-star path as FollowButton so the
    // chip visually rhymes with the per-row primitive.
    `<svg class="wm-followed-only-chip-icon" width="12" height="12" viewBox="0 0 24 24"` +
    ` fill="${state.active ? 'currentColor' : 'none'}"` +
    ` stroke="currentColor" stroke-width="2"` +
    ` stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>` +
    `</svg>` +
    `<span class="wm-followed-only-chip-label">${safeLabel}</span>` +
    `</button>`
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function renderFollowedOnlyChip(
  props: FollowedOnlyChipProps,
): FollowedOnlyChipHandle {
  const flagOn = isFollowFeatureEnabled();

  // Feature flag off → empty html, no-op attach.
  if (!flagOn) {
    return {
      html: '',
      attach: (_host: HTMLElement) => () => {
        /* no-op */
      },
      isActive: () => false,
    };
  }

  const initialState = computeViewState(props);
  const initialHtml = renderHtml(initialState);

  return {
    html: initialHtml,
    attach(host: HTMLElement): () => void {
      let tornDown = false;

      const rerender = (): void => {
        if (tornDown) return;
        const next = computeViewState(props);
        setTrustedHtml(host, trustedHtml(renderHtml(next), "legacy direct innerHTML migration"));
      };

      // Render once on attach so any state drift between the initial
      // `html` snapshot and `attach()` time is resolved.
      rerender();

      const clickHandler = (ev: Event): void => {
        if (tornDown) return;
        const target = ev.target as Element | null;
        const btn =
          target && typeof (target as Element).closest === 'function'
            ? (target as Element).closest<HTMLElement>('.wm-followed-only-chip')
            : null;
        if (!btn) return;
        if (btn.hasAttribute('disabled')) {
          // Defensive: disabled <button> shouldn't fire click, but guard
          // anyway in case a wrapping host re-dispatches.
          return;
        }
        ev.preventDefault();
        const before = readActive(props.panelId);
        const next = !before;
        writeActive(props.panelId, next);
        rerender();
        try {
          props.onChange?.(next);
        } catch (err) {
          console.warn('[followed-only-chip] onChange threw:', err);
        }
      };

      host.addEventListener('click', clickHandler);

      // Re-render on watchlist change so the disabled flip happens
      // immediately when the user follows / unfollows elsewhere in the
      // app. Note: this does NOT fire `onChange` — the chip's own state
      // didn't change, only the disabled-ness did. The panel's filter
      // pass should subscribe to `WM_FOLLOWED_COUNTRIES_CHANGED`
      // independently to re-filter rows.
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
    isActive: () => {
      if (!isFollowFeatureEnabled()) return false;
      return readEffectiveActive(props.panelId, getFollowed().length);
    },
  };
}

/**
 * Test-only — clears every persisted chip state. Useful in
 * `beforeEach` to keep tests independent without touching real
 * localStorage internals.
 */
export function _resetAllPersistedStateForTests(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    // localStorage doesn't expose keys() in our test stub; the test
    // shim provides `clear()`. In production this helper is only ever
    // called from tests, so a full clear is the simplest safe op.
    // If a future test needs partial clears, swap to an enumeration.
    const keysToRemove: string[] = [];
    // Some storage stubs implement length + key(). Walk if available.
    const len = (localStorage as unknown as { length?: number }).length;
    if (typeof len === 'number' && typeof (localStorage as unknown as { key?: (i: number) => string | null }).key === 'function') {
      const keyFn = (localStorage as unknown as { key: (i: number) => string | null }).key;
      for (let i = 0; i < len; i += 1) {
        const k = keyFn.call(localStorage, i);
        if (k && k.startsWith(STORAGE_KEY_PREFIX)) keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    /* swallow */
  }
}
