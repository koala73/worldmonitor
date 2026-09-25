// Force-reload tabs running a stale frontend bundle when a newer deploy is
// live. Catches the class of bug where users keep a tab open across a
// wire-shape change (e.g. PR #3466 fixing the setPreferences CONFLICT
// propagation) and end up in a permanent retry loop against the new server
// because their JS doesn't understand the new response shape.
//
// Mechanism: on tab focus, fetch /build-hash.txt (a static asset emitted by
// the Vite plugin in vite.config.ts at build time, content = the deployed
// SHA) and compare against __BUILD_HASH__ baked into the running bundle.
// Mismatch → hard reload.
//
// /build-hash.txt is intentionally NOT under /api/* so installWebApiRedirect
// does NOT rewrite it to the canonical API host — it stays same-origin with
// the bundle, which is the correct comparison target.
//
// The reload never fires under an open modal (#8577). Returning to the app is
// this module's main trigger, and it is also how a user gets back from their
// mail app with a Clerk email verification code, so an unguarded reload wiped
// the sign-up they were halfway through. A mismatch found under a modal is
// remembered in `pendingReload` and the module stops fetching; every later
// trigger retries the reload against the live DOM until one lands. What counts
// as blocking is `findReloadBlockingModal`, shared with the service-worker
// updater — every first-party overlay declares its reload contract with
// `declareOverlay`, and 'safe' surfaces (a read-only display, a prompt that
// re-appears on the next load) do not hold the reload off. Silence blocks, and
// a silent surface that auto-opens with no auto-dismiss wedges the tab for the
// session (WORLDMONITOR-15X/15Z: first the onboarding popover, then the
// SignalModal, neither of which is the sign-up case this guard is for).

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { findReloadBlockingModal, type ModalDocumentLike, type ReloadBlocker } from '@/utils/open-modal';

interface EventTargetLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

/**
 * The document surface this module needs: the visibility trigger AND the modal
 * probe. Extending the shared `ModalDocumentLike` rather than redeclaring it
 * keeps one definition of the modal contract, so a fake cannot model a document
 * that answers `visibilitychange` but not the modal probe.
 *
 * `querySelectorAll` is required rather than optional on purpose, but note the
 * enforcement is weaker than it looks: `tsconfig.json` includes only `src`, and
 * `tsconfig.contract-tests.json` does not list this module's suite, so no job
 * typechecks the fake. A fake that omits it fails loudly at runtime instead.
 */
interface DocumentLike extends ModalDocumentLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  visibilityState?: string;
}

interface StaleBundleCheckOptions {
  /** Hash baked into the running bundle (default: __BUILD_HASH__). */
  currentHash?: string;
  /** Override fetch (for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override window-level event target (default: window). */
  eventTarget?: EventTargetLike;
  /** Override document for visibilitychange (default: document). */
  documentTarget?: DocumentLike;
  /** Override setInterval (for tests). Default: globalThis.setInterval. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Override reload (for tests). Default: window.location.reload(). */
  reload?: () => void;
  /** Override clock (for tests). Default: Date.now. */
  now?: () => number;
  /**
   * Called when an open modal holds off a reload: once when an episode
   * starts, and once more if it survives `wedgeAfterDeferrals` triggers.
   * Default reports to Sentry. A wedged tab (an overlay that never closes)
   * would otherwise keep a stale bundle with no signal anywhere but the
   * user's own console, which is the failure mode this suppression risks.
   */
  reportDeferral?: (report: DeferralReport) => void;
  /**
   * Deferral count at which an episode is reported a second time as a
   * suspected wedge. Provisional: a genuine email-code wait produces a
   * couple of triggers, while an overlay that never closes produces one per
   * focus plus one per periodic tick for the whole session. Getting it wrong
   * costs one extra Sentry event, never a user-visible reload.
   */
  wedgeAfterDeferrals?: number;
  /**
   * Minimum interval between checks. Multiple events within this window
   * collapse to one fetch.
   */
  minIntervalMs?: number;
  /**
   * Wall-clock cadence of the periodic background check. Catches stuck
   * tabs that never fire focus/visibilitychange (e.g. a tab pinned in
   * the background of another window). Browsers throttle background
   * setIntervals to ~1min minimum resolution, so values below that are
   * effectively the same as 60_000ms.
   */
  periodicIntervalMs?: number;
}

/** One report when a deferral starts, one more if it looks wedged. */
export interface DeferralReport {
  readonly currentHash: string;
  readonly deployedHash: string;
  /** Which overlay held the reload off, for telemetry. */
  readonly blockedBy: string;
  /**
   * Whether that overlay declared itself blocking or was silent. Every
   * first-party overlay is declared, so 'undeclared' with a non-`cl-` label is
   * a lint-gate escape, and 'blocking' with a wedge is a declared judgment to
   * revisit. The two need different fixes, which is why both ride into Sentry.
   */
  readonly reloadPolicy: ReloadBlocker['policy'];
  /** Triggers deferred so far in this episode, starting at 1. */
  readonly deferrals: number;
  readonly phase: 'started' | 'suspected-wedge';
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;
/** Wall-clock periodic check. 10min is plenty for stale-bundle detection
 *  (we don't need second-level latency to reload an old bundle) and
 *  respects browser background-tab throttling. */
const DEFAULT_PERIODIC_INTERVAL_MS = 10 * 60_000;
const DEFAULT_WEDGE_AFTER_DEFERRALS = 10;

/**
 * Install listeners that compare the running bundle's hash against the
 * deployed hash and reload on mismatch. Three trigger paths:
 *   1. window `focus` — user switches BACK to the tab
 *   2. document `visibilitychange` — tab goes background→foreground
 *      (fires for some background→foreground transitions that don't
 *      raise window focus, e.g. tab activation within the same window)
 *   3. periodic setInterval — catches tabs pinned in the background of
 *      another window that never receive focus/visibilitychange. Browser
 *      background throttling means actual cadence is ~1min minimum, but
 *      that's fine for stale-bundle detection.
 *
 * All three paths funnel through a `check()` that's deduped by
 * `minIntervalMs` — multiple triggers within the dedupe window collapse
 * to one fetch.
 *
 * The `focus`-only design from PR #3499 missed background-tab users:
 * one user (Sentry user_id user_3Cu7uZZJEeVSoUjv9SBn4BEv1...) hammered
 * setPreferences at ~16 calls/min from 2026-04-30 04:20 UTC onward with
 * a constant `actualSyncVersion: 20`, never refocusing the tab and so
 * never triggering the reload. Adding visibilitychange + setInterval
 * closes the gap.
 *
 * Returns a disposer function that clears the periodic timer (used in
 * tests).
 */
export function installStaleBundleCheck(options: StaleBundleCheckOptions = {}): () => void {
  const currentHash = options.currentHash ?? (typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev');
  // Arrow-function wrapper instead of fetch.bind(globalThis) (banned per
  // AGENTS.md §Critical Conventions). Same effect — preserves the global
  // `this` for fetch — without the brittle .bind() form.
  const fetchImpl: typeof globalThis.fetch =
    options.fetch ?? ((...args) => globalThis.fetch(...args));
  const eventTarget = options.eventTarget ?? window;
  const documentTarget = options.documentTarget ?? (typeof document !== 'undefined' ? document : undefined);
  const setIntervalImpl = options.setInterval ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms));
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const reportDeferral = options.reportDeferral ?? ((report: DeferralReport) => {
    enqueueSentryCall((Sentry) => {
      Sentry.captureMessage(
        report.phase === 'suspected-wedge'
          ? '[stale-bundle] reload still deferred, modal never closed'
          : '[stale-bundle] reload deferred, modal open',
        {
          level: 'warning',
          tags: {
            surface: 'stale-bundle',
            current_hash: report.currentHash,
            deployed_hash: report.deployedHash,
            blocked_by: report.blockedBy,
            reload_policy: report.reloadPolicy,
            deferrals: String(report.deferrals),
          },
        },
      );
    });
  });
  const wedgeAfterDeferrals = options.wedgeAfterDeferrals ?? DEFAULT_WEDGE_AFTER_DEFERRALS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const periodicIntervalMs = options.periodicIntervalMs ?? DEFAULT_PERIODIC_INTERVAL_MS;

  // 'dev' marker means we're running a local build that didn't get a real
  // SHA injected. Skip the check entirely in that case — comparing 'dev'
  // against any deployed SHA would force-reload every dev tab on focus.
  if (currentHash === 'dev') {
    return () => {};
  }

  let lastCheckedAt = 0;
  let inflight = false;
  /**
   * The deployed hash a reload is owed to. Null while the bundle is believed
   * current. Non-null makes `lastCheckedAt` and `inflight` unreachable, because
   * `check()` returns before consulting them.
   */
  let pendingReload: string | null = null;
  /** Triggers deferred in the current episode. Reset when a reload lands. */
  let deferrals = 0;

  /**
   * Reload now, or remember the debt and return while a modal is on screen.
   *
   * The probe belongs here, at the irreversible action, and not at the top of
   * `check()`: reading the DOM when the hash answer arrives rather than when the
   * trigger fired is what catches a modal that mounts mid-fetch. A guard before
   * the fetch would let that one through — the original bug wearing a guard.
   *
   * No document at all means there is no modal to protect, so it reloads. PR
   * #3466's safety property wins that tie.
   */
  const reloadOrDefer = (deployedHash: string): void => {
    const blocker = documentTarget ? findReloadBlockingModal(documentTarget) : null;
    if (blocker !== null) {
      deferrals += 1;
      // Two reports per episode at most: one naming the overlay, and one if
      // the overlay outlasts any plausible email-code wait.
      const phase = pendingReload === null
        ? 'started'
        : deferrals === wedgeAfterDeferrals
          ? 'suspected-wedge'
          : null;
      if (phase !== null) {
        // eslint-disable-next-line no-console
        console.warn('[stale-bundle] reload deferred, modal open:', blocker.label, currentHash, '→', deployedHash);
        reportDeferral({
          currentHash,
          deployedHash,
          blockedBy: blocker.label,
          reloadPolicy: blocker.policy,
          deferrals,
          phase,
        });
      }
      pendingReload = deployedHash;
      return;
    }
    pendingReload = null;
    deferrals = 0;
    // eslint-disable-next-line no-console
    console.warn('[stale-bundle] reload:', currentHash, '→', deployedHash);
    reload();
  };

  const check = async (): Promise<void> => {
    // Treat a mismatch as terminal: retry the reload against the live DOM
    // instead of re-asking the network, bypassing the dedupe window (that
    // window rate-limits fetches, and this path makes none).
    //
    // One case makes the premise false: a rollback to exactly `currentHash`
    // while a reload is pending. The cost is a single redundant reload onto
    // the bundle already running, so re-verifying every trigger would buy
    // nothing but requests.
    if (pendingReload !== null) {
      reloadOrDefer(pendingReload);
      return;
    }

    const t = now();
    if (t - lastCheckedAt < minIntervalMs) return;
    if (inflight) return;
    lastCheckedAt = t;
    inflight = true;
    let deployedHash: string | null = null;
    try {
      // Cache-bust to defeat any intermediate proxy that might serve a
      // stale build-hash.txt (the file itself is emitted with the deploy).
      const res = await fetchImpl(`/build-hash.txt?t=${t}`, { cache: 'no-store' });
      if (res.ok) deployedHash = (await res.text()).trim();
    } catch {
      // Offline, or a network error from fetch/res.text() — silently skip.
      // A non-OK response never throws; it leaves `deployedHash` null and
      // exits below. Either way the next trigger retries.
    } finally {
      inflight = false;
    }
    // Decided outside the catch, so a throw from the modal probe surfaces to
    // Sentry instead of being misfiled as an offline blip.
    if (!deployedHash || deployedHash === 'dev') return;
    if (deployedHash !== currentHash) reloadOrDefer(deployedHash);
  };

  const focusHandler: EventListener = () => {
    void check();
  };
  eventTarget.addEventListener('focus', focusHandler);

  // visibilitychange fires when the tab becomes visible again. We only
  // want to trigger on the visible side (not on hide), so gate with the
  // documentTarget's visibilityState. Closure references documentTarget so
  // the predicate uses the live state at fire time, not at install time.
  const visibilityHandler: EventListener = documentTarget
    ? () => {
        if (documentTarget.visibilityState === 'visible') void check();
      }
    : () => {};
  if (documentTarget) {
    documentTarget.addEventListener('visibilitychange', visibilityHandler);
  }

  // Periodic safety net for background tabs that never receive
  // focus/visibilitychange (e.g. pinned in a background window).
  const intervalHandle = setIntervalImpl(() => void check(), periodicIntervalMs);

  return () => {
    // Full cleanup. Production currently calls installStaleBundleCheck
    // exactly once at boot, but a complete disposer protects against
    // future hot-reload / test-helper reuse where double-install would
    // otherwise leave orphaned listeners firing against stale targets.
    eventTarget.removeEventListener('focus', focusHandler);
    if (documentTarget) {
      documentTarget.removeEventListener('visibilitychange', visibilityHandler);
    }
    if (intervalHandle && typeof clearInterval === 'function') {
      clearInterval(intervalHandle as unknown as ReturnType<typeof setInterval>);
    }
  };
}
