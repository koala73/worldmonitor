import type { PanelConfig } from '@/types';

/**
 * Free-tier gate collaborator: the timing state and the pure map transforms
 * behind App.enforceFreeTierLimits.
 *
 * Extracted from App so the gate's two failure-prone parts — the grace timer
 * and the legacy custom-widget sweep — can be driven directly from tests. App
 * itself is Vite/DOM-coupled and cannot be imported by the node:test suites,
 * so anything left inside it is only ever coverable by source-text assertions.
 *
 * Deliberately depends on `@/types` alone: no service imports, so the test
 * suite can load this module without pulling in Clerk/Convex. The caller reads
 * the tier signals and passes the answers in.
 */

/**
 * Last-resort deadline for the auth session to settle before the free-tier
 * caps are applied anyway. Comfortably past Clerk's own 4 s
 * requestIdleCallback timeout so it only fires when the SDK never loads.
 */
export const AUTH_SETTLE_GRACE_MS = 8000;

/**
 * Owns the "enforce anyway if the session never settles" backstop.
 *
 * The deadline is sticky within one auth/entitlement window: a session that
 * never resolves must not be able to defer the caps a second time. A new
 * account handoff explicitly resets the window so the next account gets its
 * own grace period.
 */
export class FreeTierGate {
  private deadlineExceeded = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly enforce: () => void) {}

  /** True once the grace period elapsed with the session still unresolved. */
  get authSettleDeadlineExceeded(): boolean {
    return this.deadlineExceeded;
  }

  /** Test seam: whether a fallback is currently armed. */
  get fallbackPending(): boolean {
    return this.fallbackTimer !== null;
  }

  /** Arm the one-shot fallback. Idempotent while one is already pending. */
  scheduleFallback(): void {
    if (this.fallbackTimer !== null || this.deadlineExceeded) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.deadlineExceeded = true;
      this.enforce();
    }, AUTH_SETTLE_GRACE_MS);
  }

  /**
   * Drop a pending fallback — the tier resolved on its own, or App is being
   * torn down. Without this the timer still fires 8 s into every session and
   * runs a redundant enforcement pass after the answer is already known.
   */
  cancelFallback(): void {
    if (this.fallbackTimer === null) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  /** Start a fresh grace window for a new auth/account transition. */
  resetForAuthTransition(): void {
    this.cancelFallback();
    this.deadlineExceeded = false;
  }
}

/**
 * One-time recovery for pre-`proGated` damage: re-enable every custom widget
 * the user still owns whose panel entry is disabled but carries no marker.
 *
 * Builds before the gate became reversible disabled cw-* panels on boot for
 * every Pro user (the session was still pending) and left no marker behind, so
 * `restoreProGatedPanels` cannot find them. Ownership is the only filter that
 * survives: deleting a widget removes its panelSettings entry outright (see the
 * wm:panel-close handler), so this can only resurrect widgets the user still
 * has a spec for.
 *
 * It cannot distinguish that legacy damage from a widget the user hid
 * deliberately — both are `enabled: false` with no marker — which is why the
 * caller must run it at most once per browser. Post-fix, every gate-disable
 * stamps `proGated` and the targeted restore handles it, so this sweep is
 * strictly a migration for entries written by older builds.
 *
 * Returns a NEW map; the input is never mutated.
 */
export function sweepLegacyDisabledCustomWidgets(
  panelSettings: Record<string, PanelConfig>,
  ownedWidgetIds: ReadonlySet<string>,
): Record<string, PanelConfig> {
  const next: Record<string, PanelConfig> = {};
  for (const [key, config] of Object.entries(panelSettings)) {
    if (key.startsWith('cw-') && !config.enabled && ownedWidgetIds.has(key)) {
      next[key] = { ...config, enabled: true };
    } else {
      next[key] = { ...config };
    }
  }
  return next;
}

/**
 * Whether a reconciled panel map differs from the stored one in any way the
 * gate owns — `enabled` OR the `proGated` marker.
 *
 * Comparing `enabled` alone drops a marker-only strip: when the user re-enables
 * a still-marked panel themselves, `restoreProGatedPanels` clears the marker
 * but leaves `enabled` at its existing value, so the write is skipped and a
 * stale marker survives in storage (and in the cloud blob) to auto-restore the
 * panel after a later deliberate hide.
 */
export function panelGateStateChanged(
  before: Record<string, PanelConfig>,
  after: Record<string, PanelConfig>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key]?.enabled !== after[key]?.enabled) return true;
    if (before[key]?.proGated !== after[key]?.proGated) return true;
  }
  return false;
}

/**
 * A bounded second chance for a cloud snapshot that predates `proGated`.
 *
 * The first cloud version after the local recovery baseline is the only
 * snapshot eligible for the legacy sweep. Once it has been processed, later
 * cloud writes must never re-arm the heuristic and undo deliberate hides.
 */
export function shouldRunCloudLegacyRecovery(
  baselineSyncVersion: number | null,
  appliedSyncVersion: number | null,
  incomingSyncVersion: number | undefined,
): boolean {
  if (incomingSyncVersion === undefined || appliedSyncVersion !== null) return false;
  return baselineSyncVersion === null || incomingSyncVersion > baselineSyncVersion;
}
