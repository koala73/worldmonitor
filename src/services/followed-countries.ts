/**
 * Followed-countries client service — single owner of watchlist semantics.
 *
 * Operating modes:
 *  1. Anonymous (no Clerk user) — localStorage at `wm-followed-countries-v1`,
 *     storing `JSON.stringify({ countries: string[] })`. Cap enforced
 *     client-side. (U2.)
 *  2. handoffPending — transitional during the anon→signed-in merge.
 *     Mutations refused with `HANDOFF_PENDING`. (U3.)
 *  3. Signed-in (handoff complete) — Convex authoritative. (U3.)
 *
 * Sign-in orchestration (U3):
 *  - On Clerk user transition `null → user` OR `user-A → user-B`:
 *    increment `_handoffGeneration`, capture `userIdAtStart`, parse
 *    localStorage, optionally call `mergeAnonymousLocal`. The post-await
 *    callback verifies `(currentClerkUserId === userIdAtStart) &&
 *    (currentGen === capturedGen)` and DROPS stale results — prevents a
 *    user-B sign-in or user-A sign-out from clearing localStorage on
 *    user-A's behalf (memory: cloud-prefs-sync `_authGeneration` pattern).
 *  - On `user → null` (sign-out): increment `_handoffGeneration`, clear
 *    `_lastKnownSubscriptionSnapshot = null` (cross-user-leak fix —
 *    memory: `session-storage-cross-user-leak-on-auth-transition`),
 *    unsubscribe, reset `_handoffState = 'idle'`.
 *
 * Patterns mirrored from:
 *  - src/services/market-watchlist.ts (event dispatch, JSON.parse safety)
 *  - src/services/aviation/watchlist.ts (storage-key versioning)
 *  - src/services/entitlements.ts (hasTier / getEntitlementState; ConvexClient.onUpdate)
 *  - src/utils/cloud-prefs-sync.ts (`_authGeneration` guard pattern)
 *
 * Memory: `discriminated-union-over-sentinel-boolean` —
 * `FollowMutationResult` is a discriminated union, never a `boolean | null`.
 *
 * Memory: `convex-error-string-data-strips-errordata-on-wire` — kind
 * extraction reads `err.data.kind`, not substring-match the message.
 */

import type { FunctionReference } from 'convex/server';
import { toIso2 } from '../utils/country-codes';
import {
  getEntitlementState as _getEntitlementState,
  hasTier as _hasTier,
} from './entitlements';
import { getCurrentClerkUser as _getCurrentClerkUser } from './clerk';
import { subscribeAuthState as _subscribeAuthState } from './auth-state';
import {
  getConvexClient as _getConvexClient,
  getConvexApi as _getConvexApi,
  waitForConvexAuth as _waitForConvexAuth,
} from './convex-client';
import type { MergeAnonymousLocalResult as ServerMergeAnonymousLocalResult } from '../../convex/followedCountries';

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

/** Mirror of the server-side `convex/constants.ts::FREE_TIER_FOLLOW_LIMIT`. */
export const FREE_TIER_FOLLOW_LIMIT = 3;

/** localStorage key for the anonymous-mode list. Versioned for safe migration. */
export const FOLLOWED_COUNTRIES_STORAGE_KEY = 'wm-followed-countries-v1';

/** Custom event name dispatched on every successful mutation. */
export const WM_FOLLOWED_COUNTRIES_CHANGED = 'wm-followed-countries-changed';

/**
 * Custom event dispatched after a sign-in handoff completes with cap-drops.
 * `detail = { kept, dropped }` — number of localStorage entries kept vs
 * dropped due to FREE-tier cap. UI consumers can render an upgrade-CTA toast.
 */
export const WM_FOLLOWED_COUNTRIES_CAP_DROP = 'wm-followed-countries-cap-drop';

/**
 * Discriminated-union result. Service NEVER throws from
 * `addCountry` / `removeCountry`.
 */
export type FollowMutationResult =
  | { ok: true }
  | { ok: false; reason: 'DISABLED' }
  | { ok: false; reason: 'INVALID_INPUT' }
  | { ok: false; reason: 'FREE_CAP'; currentCount?: number; limit?: number }
  | { ok: false; reason: 'ENTITLEMENT_LOADING' }
  | { ok: false; reason: 'HANDOFF_PENDING' }
  | { ok: false; reason: 'STORAGE_FULL' };

export type ServiceEntitlementState = 'pro' | 'free' | 'loading';

/**
 * Strongly-typed Convex function references for the followedCountries
 * surface. Using `FunctionReference<...>` (vs the previous `unknown`
 * placeholders) eliminates the `{country: code}` vs `{countries: code}`
 * typo class — the compiler now requires the exact arg shape per ref.
 *
 * P1 #8 — replaces the previous `ConvexClientLike` / `ConvexApiLike`
 * unknown-based shapes.
 */
type FollowCountryRef = FunctionReference<
  'mutation',
  'public',
  { country: string },
  { ok: true; idempotent: boolean }
>;
type UnfollowCountryRef = FunctionReference<
  'mutation',
  'public',
  { country: string },
  { ok: true; idempotent: boolean }
>;
type MergeAnonymousLocalRef = FunctionReference<
  'mutation',
  'public',
  { countries: string[] },
  ServerMergeAnonymousLocalResult
>;
type ListFollowedRef = FunctionReference<'query', 'public', Record<string, never>, string[]>;

/**
 * Subset of `convex/browser`.ConvexClient surface that this module uses.
 * Defined as an interface so tests can inject a fake without pulling the
 * real WebSocket transport.
 */
export interface ConvexClientLike {
  mutation: <Ref extends FunctionReference<'mutation'>>(
    ref: Ref,
    args: Ref['_args'],
  ) => Promise<Ref['_returnType']>;
  onUpdate: <Ref extends FunctionReference<'query'>>(
    ref: Ref,
    args: Ref['_args'],
    onResult: (result: Ref['_returnType']) => void,
    onError?: (err: Error) => void,
  ) => () => void; // returns an unsubscribe fn (or { unsubscribe })
}

// ---------------------------------------------------------------------------
// Test-injection seams
// ---------------------------------------------------------------------------
//
// Node's `node:test` runner has no first-class ESM module mocker; rather
// than reach for ts-jest / vitest just for U2/U3, we expose narrow setter
// hooks. Production callers never touch these.

type ClerkUserGetter = () => { id: string } | null;
type EntitlementStateGetter = () => { features?: { tier?: number } } | null;
type HasTierFn = (minTier: number) => boolean;

/**
 * Strongly-typed Convex API surface this module needs. Mirrors the
 * generated `api.followedCountries` shape via `FunctionReference<...>`
 * generics so arg/result shapes are checked at the call site.
 */
interface ConvexApiLike {
  followedCountries: {
    followCountry: FollowCountryRef;
    unfollowCountry: UnfollowCountryRef;
    mergeAnonymousLocal: MergeAnonymousLocalRef;
    listFollowed: ListFollowedRef;
  };
}

let _clerkUserGetter: ClerkUserGetter = () =>
  _getCurrentClerkUser() as { id: string } | null;
let _entitlementStateGetter: EntitlementStateGetter = () =>
  _getEntitlementState();
let _hasTierFn: HasTierFn = (n) => _hasTier(n);
let _featureFlagOverride: boolean | null = null;
let _convexClientGetter: () => Promise<ConvexClientLike | null> = async () =>
  (await _getConvexClient()) as ConvexClientLike | null;
let _convexApiGetter: () => Promise<ConvexApiLike | null> = async () =>
  (await _getConvexApi()) as ConvexApiLike | null;
/**
 * Codex round-4 P1: defer the merge until Convex auth is ready. The
 * Clerk auth-state listener fires the moment the JWT is in the Clerk
 * client, but Convex's `setAuth` callback runs async (the next event
 * loop tick after `client.setAuth(...)` is invoked). Without this
 * gate, `mergeAnonymousLocal` can fire before Convex sees the
 * identity → throws ConvexError({kind:'UNAUTHENTICATED'}). That kind
 * was previously classified as PERMANENT, which clears localStorage
 * and loses the anonymous follows on every transient auth lag.
 *
 * Resolves to `true` when Convex auth lands; `false` if it doesn't
 * within the timeout window (which still falls through to the
 * mergeAnonymousLocal call — the catch path now treats UNAUTHENTICATED
 * as transient and the visibilitychange retry will succeed once
 * Convex catches up).
 */
let _waitForConvexAuthFn: (timeoutMs?: number) => Promise<boolean> = (
  timeoutMs,
) => _waitForConvexAuth(timeoutMs);

/**
 * Test-only override hook. Pass `null` to restore the real
 * implementations. For `convexClient` / `convexApi`, pass the literal
 * string `'force-null'` to make the getter return null without falling
 * through to the production importer (which would crash on missing
 * `import.meta.env.VITE_CONVEX_URL` in the node:test runner).
 */
export function _setDepsForTests(deps: {
  getCurrentClerkUser?: ClerkUserGetter | null;
  getEntitlementState?: EntitlementStateGetter | null;
  hasTier?: HasTierFn | null;
  featureFlagEnabled?: boolean | null;
  convexClient?: ConvexClientLike | null | 'force-null';
  convexApi?: ConvexApiLike | null | 'force-null';
  waitForConvexAuth?: ((timeoutMs?: number) => Promise<boolean>) | null;
}): void {
  if (deps.getCurrentClerkUser !== undefined) {
    _clerkUserGetter =
      deps.getCurrentClerkUser ??
      (() => _getCurrentClerkUser() as { id: string } | null);
  }
  if (deps.getEntitlementState !== undefined) {
    _entitlementStateGetter =
      deps.getEntitlementState ?? (() => _getEntitlementState());
  }
  if (deps.hasTier !== undefined) {
    _hasTierFn = deps.hasTier ?? ((n) => _hasTier(n));
  }
  if (deps.featureFlagEnabled !== undefined) {
    _featureFlagOverride = deps.featureFlagEnabled;
  }
  if (deps.convexClient !== undefined) {
    const fake = deps.convexClient;
    if (fake === null) {
      _convexClientGetter = async () =>
        (await _getConvexClient()) as ConvexClientLike | null;
    } else if (fake === 'force-null') {
      _convexClientGetter = async () => null;
    } else {
      _convexClientGetter = async () => fake;
    }
  }
  if (deps.convexApi !== undefined) {
    const fake = deps.convexApi;
    if (fake === null) {
      _convexApiGetter = async () =>
        (await _getConvexApi()) as ConvexApiLike | null;
    } else if (fake === 'force-null') {
      _convexApiGetter = async () => null;
    } else {
      _convexApiGetter = async () => fake;
    }
  }
  if (deps.waitForConvexAuth !== undefined) {
    _waitForConvexAuthFn =
      deps.waitForConvexAuth ?? ((tm) => _waitForConvexAuth(tm));
  }
}

/** Test-only — clears all module-level state so tests start from a clean slate. */
export function _resetStateForTests(): void {
  _handoffState = 'idle';
  _handoffGeneration = 0;
  _handoffRetryAttempt = 0;
  _initialSnapshotReceived = false;
  _lastKnownSubscriptionSnapshot = null;
  _stopReactiveSubscription();
  _lastSeenUserId = null;
  if (_visibilityRetryListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityRetryListener);
  }
  _visibilityRetryListener = null;
  if (_crossTabStorageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', _crossTabStorageListener);
  }
  _crossTabStorageListener = null;
}

/**
 * P1 #4 — Test-only recovery hook. If a handoff entered
 * 'failed-permanent', this clears that latch and resets retry counters
 * so a follow-up `_emitAuthStateForTests` (or production sign-in) can
 * re-attempt. Also clears any visibilitychange retry listener.
 *
 * Production has no equivalent today: a permanent failure requires the
 * user to sign out and sign back in to start a fresh handoff
 * generation.
 */
export function _clearFailedHandoffForTests(): void {
  _handoffRetryAttempt = 0;
  if (_handoffState === 'failed-permanent' || _handoffState === 'failed') {
    _handoffState = 'idle';
  }
  _clearVisibilityRetryListener();
}

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/**
 * Handoff state machine.
 *
 *  - 'idle'             : no signed-in user OR initial replay
 *  - 'pending'          : handoff in flight (await mergeAnonymousLocal)
 *  - 'failed'           : transient failure (network / convex unavailable);
 *                         visibilitychange retry scheduled
 *  - 'complete'         : handoff finished successfully; reactive sub installed
 *  - 'failed-permanent' : permanent failure (P1 #4 — max-retry exhausted OR
 *                         server returned a permanent ConvexError such as
 *                         INPUT_TOO_LARGE / EMPTY_INPUT). Localhost storage
 *                         cleared; reactive sub installed; manual recovery
 *                         only via `_clearFailedHandoffForTests()`.
 */
let _handoffState:
  | 'idle'
  | 'pending'
  | 'failed'
  | 'complete'
  | 'failed-permanent' = 'idle';

/**
 * Incremented on every auth-state transition. Captured by handoff
 * callbacks before `await` and verified after, to drop stale results.
 * Mirrors the cloud-prefs-sync.ts `_authGeneration` pattern.
 */
let _handoffGeneration = 0;

/**
 * P1 #4 — counts visibilitychange-driven retries within a single
 * handoff generation. Reset to 0 when `_runHandoff` is invoked from
 * `onAuthStateChange` (fresh generation); incremented each time the
 * visibilitychange retry fires. After `MAX_HANDOFF_RETRIES` (5),
 * transition to 'failed-permanent' and stop scheduling retries.
 */
let _handoffRetryAttempt = 0;

/** Max visibilitychange-driven retry attempts per handoff generation. */
const MAX_HANDOFF_RETRIES = 5;

/** Exponential backoff schedule (ms) for retry attempt N (0-indexed). */
const HANDOFF_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/**
 * Test-only override for the backoff schedule. When set, replaces
 * `HANDOFF_RETRY_BACKOFF_MS` lookup. Tests use `[0, 0, ...]` to make
 * retries fire immediately (the visibility-event flow remains intact;
 * only the post-event delay is collapsed).
 */
let _handoffBackoffOverride: number[] | null = null;

function _backoffMsFor(attemptIndex: number): number {
  const schedule = _handoffBackoffOverride ?? HANDOFF_RETRY_BACKOFF_MS;
  const i = Math.min(attemptIndex, schedule.length - 1);
  return schedule[i] ?? 0;
}

/** Test-only — collapse retry backoff so tests don't need to wait seconds. */
export function _setHandoffBackoffForTests(schedule: number[] | null): void {
  _handoffBackoffOverride = schedule;
}

/**
 * P2 #20 — Tracks whether the reactive subscription has delivered its
 * first snapshot since `_handoffState` flipped to 'complete'. Used by
 * `getFollowed()` to fall back to localStorage during the gap between
 * "complete" being set and the first onUpdate result landing — without
 * this, an empty-handoff path briefly returns `[]` while the
 * subscription warms up.
 *
 * Reset every time the reactive subscription is (re)started; flipped to
 * `true` by the onUpdate callback in `_startReactiveSubscription`.
 */
let _initialSnapshotReceived = false;

/**
 * User-scoped cache of the most recent listFollowed snapshot. Cleared on
 * sign-out / user-switch (memory:
 * `session-storage-cross-user-leak-on-auth-transition`). `getFollowed()`
 * only unions this with localStorage if `userId === currentClerkUser.id`.
 */
let _lastKnownSubscriptionSnapshot:
  | { userId: string; countries: string[] }
  | null = null;

/** Last-observed Clerk user id, for diffing transitions inside the auth callback. */
let _lastSeenUserId: string | null = null;

/** Active reactive-subscription teardown (if signed-in mode). */
let _reactiveUnsubscribe: (() => void) | null = null;

/** Pending visibilitychange-retry listener (set when handoffState='failed'). */
let _visibilityRetryListener: (() => void) | null = null;

/**
 * P1 #10 — cross-tab `storage` event listener. When Tab-A mutates
 * `wm-followed-countries-v1`, every other tab fires a `storage` event.
 * We re-dispatch as `WM_FOLLOWED_COUNTRIES_CHANGED` so FollowButton
 * subscribers in Tab-B re-render. Installed once via
 * `installFollowedCountriesAuthListener()`.
 */
let _crossTabStorageListener: ((ev: StorageEvent) => void) | null = null;

// ---------------------------------------------------------------------------
// Feature-flag gate
// ---------------------------------------------------------------------------

function isFeatureFlagEnabled(): boolean {
  if (_featureFlagOverride !== null) return _featureFlagOverride;
  // Default ON in dev/preview; OFF only when explicitly set to '0'.
  // Plan U2: use `!== '0'` (default-on).
  try {
    const flag = import.meta.env?.VITE_FOLLOW_COUNTRIES_ENABLED;
    return flag !== '0';
  } catch {
    return true;
  }
}

/**
 * Public read-only mirror of the internal feature-flag check. Exposed so
 * UI helpers (e.g. FollowButton in U4) gate on the same source of truth
 * — including the `_setDepsForTests({ featureFlagEnabled: ... })` override
 * — instead of duplicating the `import.meta.env` parse.
 */
export function isFollowFeatureEnabled(): boolean {
  return isFeatureFlagEnabled();
}

// ---------------------------------------------------------------------------
// Storage I/O — anonymous mode
// ---------------------------------------------------------------------------

interface StoredShape {
  countries: string[];
}

/**
 * Result of attempting to read the stored shape from localStorage:
 *  - { kind: 'absent' } — no key set
 *  - { kind: 'corrupt' } — non-JSON or wrong shape (caller should `removeItem`)
 *  - { kind: 'ok', list }
 *
 * Distinct from `readLocalStorageList` (which collapses absent/corrupt to
 * `[]`) because the U3 handoff needs to differentiate "nothing to merge"
 * from "corrupt → clear unconditionally".
 */
function parseLocalStorageRaw(): { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'ok'; list: string[] } {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)
      : null;
  } catch {
    return { kind: 'absent' };
  }
  if (!raw) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Partial<StoredShape>).countries)
  ) {
    return { kind: 'corrupt' };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of (parsed as StoredShape).countries) {
    if (typeof c !== 'string') continue;
    const norm = toIso2(c);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return { kind: 'ok', list: out };
}

function readLocalStorageList(): string[] {
  const r = parseLocalStorageRaw();
  return r.kind === 'ok' ? r.list : [];
}

/**
 * Returns `true` on success, `false` on storage quota / write failure.
 */
function writeLocalStorageList(list: string[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: list }),
    );
    return true;
  } catch {
    return false;
  }
}

function removeLocalStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(FOLLOWED_COUNTRIES_STORAGE_KEY);
    }
  } catch {
    /* swallow */
  }
}

function dispatchChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
  } catch {
    // jsdom-less test envs may not have CustomEvent; swallow.
  }
}

function dispatchCapDrop(kept: number, dropped: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(WM_FOLLOWED_COUNTRIES_CAP_DROP, {
        detail: { kept, dropped },
      }),
    );
  } catch {
    /* swallow */
  }
}

// ---------------------------------------------------------------------------
// Entitlement + auth state resolution
// ---------------------------------------------------------------------------

/**
 * Returns the effective service-level entitlement state.
 *
 *  - Anonymous (no Clerk user) → `'free'` (NEVER `'loading'`; otherwise
 *    anon users would be permanently blocked because
 *    `getEntitlementState()` returns null without a Clerk session).
 *  - Signed-in, entitlement snapshot not yet arrived → `'loading'`.
 *  - Signed-in, snapshot arrived, tier ≥ 1 → `'pro'`.
 *  - Otherwise → `'free'`.
 *
 * Codex round-2 finding #1: anonymous users must never block on
 * entitlement loading.
 */
export function serviceEntitlementState(): ServiceEntitlementState {
  const user = _clerkUserGetter();
  if (!user) return 'free';
  const ent = _entitlementStateGetter();
  if (ent === null) return 'loading';
  return _hasTierFn(1) ? 'pro' : 'free';
}

// ---------------------------------------------------------------------------
// Auth-state listener (U3)
// ---------------------------------------------------------------------------

let _authListenerInstalled = false;

/**
 * Install the auth-state listener AND the cross-tab `storage` listener
 * (P1 #10). Idempotent. Called once from app boot. Tests don't call
 * this; they drive the auth-state callback manually via
 * `_emitAuthStateForTests`.
 */
export function installFollowedCountriesAuthListener(): void {
  if (_authListenerInstalled) return;
  _authListenerInstalled = true;
  _subscribeAuthState((state) => {
    void onAuthStateChange(state.user ? { id: state.user.id } : null);
  });
  _installCrossTabStorageListener();
}

/**
 * P1 #10 — re-dispatch `storage` events for our key as
 * `WM_FOLLOWED_COUNTRIES_CHANGED` so subscribers in other tabs
 * (FollowButton instances) re-render when this tab mutates the
 * anonymous-mode list. The browser only fires `storage` in OTHER tabs;
 * the tab that performed the write doesn't see its own event (this
 * matches our intent — same-tab updates already dispatch via
 * `dispatchChanged()` from the write site).
 *
 * Test-only callers can also install this via
 * `_installCrossTabStorageListenerForTests()` to drive the
 * `_window.dispatchEvent(new StorageEvent(...))` shape directly.
 */
function _installCrossTabStorageListener(): void {
  if (_crossTabStorageListener) return;
  if (typeof window === 'undefined') return;
  const handler = (ev: StorageEvent): void => {
    if (ev.key !== FOLLOWED_COUNTRIES_STORAGE_KEY) return;
    dispatchChanged();
  };
  window.addEventListener('storage', handler);
  _crossTabStorageListener = handler;
}

/**
 * Test-only — install the cross-tab storage listener without going
 * through `installFollowedCountriesAuthListener` (which also wires the
 * Clerk-driven auth listener). Lets tests assert the storage→change
 * fan-out in isolation.
 */
export function _installCrossTabStorageListenerForTests(): void {
  _installCrossTabStorageListener();
}

/**
 * Test-only: drive the auth-state callback directly without installing
 * the real Clerk listener. Always returns a Promise that resolves once
 * the handoff (if any) has fully resolved or dropped.
 */
export function _emitAuthStateForTests(
  nextUser: { id: string } | null,
): Promise<void> {
  return onAuthStateChange(nextUser);
}

/**
 * Auth-state transition handler. Called once at module-init with the
 * current state, then on every Clerk transition.
 *
 * Transitions handled:
 *  - null → user        : start sign-in handoff
 *  - userA → userB       : sign-out cleanup THEN start handoff for userB
 *  - user → null         : sign-out cleanup
 *  - null → null         : ignore (initial replay)
 *  - same user → same    : ignore (Clerk re-emit on tab focus etc.)
 */
async function onAuthStateChange(
  nextUser: { id: string } | null,
): Promise<void> {
  const prevUserId = _lastSeenUserId;
  const nextUserId = nextUser?.id ?? null;

  if (prevUserId === nextUserId) {
    // No-op: initial replay or duplicate emission.
    return;
  }
  _lastSeenUserId = nextUserId;

  // Always invalidate any in-flight handoff on a transition. Increment
  // BEFORE the user-swap branch so that even the user-A→user-B "two
  // generations" requirement of the plan (sign-out then sign-in) is
  // observable to a stale callback.
  _handoffGeneration += 1;
  // Stop the prior reactive subscription if it was running (sign-out OR
  // user-swap before starting a fresh one for the new user).
  _stopReactiveSubscription();
  _lastKnownSubscriptionSnapshot = null;
  _clearVisibilityRetryListener();

  if (!nextUser) {
    // Sign-out OR remained anonymous on first emit (no prior user).
    _handoffState = 'idle';
    return;
  }

  // null → user OR user-A → user-B. Bump generation a second time for
  // the user-swap case so the plan-specified "gen increments to 3 (one
  // for sign-out, one for sign-in)" holds. For the null→user case, this
  // is just an extra bump — harmless, since callbacks only verify
  // equality and we capture the post-bump value below.
  if (prevUserId !== null) {
    _handoffGeneration += 1;
  }

  const gen = _handoffGeneration;
  const userIdAtStart = nextUser.id;
  _handoffState = 'pending';
  // P1 #4 — fresh handoff generation, reset retry counter.
  _handoffRetryAttempt = 0;

  await _runHandoff(userIdAtStart, gen);
}

/**
 * Core handoff procedure. Extracted so the visibilitychange retry can
 * call it again with a fresh generation capture.
 *
 * P1 #3 — catches now use `_extractConvexErrorKind`. Permanent error
 * kinds (INPUT_TOO_LARGE / EMPTY_INPUT) are NOT retried; they transition
 * the state machine to 'failed-permanent', clear localStorage (since
 * the input shape is the problem), and install the reactive
 * subscription so getFollowed still works.
 *
 * Codex round-4 P1 — UNAUTHENTICATED is now TRANSIENT, not permanent.
 * `subscribeAuthState` emits the current signed-in state IMMEDIATELY on
 * subscribe, but Convex auth is not yet ready (the JWT hasn't been
 * attached to the Convex client). `mergeAnonymousLocal` fires before
 * Convex sees the auth → throws UNAUTHENTICATED. The previous
 * classification cleared localStorage, losing anonymous follows on
 * every transient auth lag. Two-part fix:
 *   (a) await `_waitForConvexAuthFn()` BEFORE the mutation call so the
 *       race usually doesn't fire at all;
 *   (b) treat UNAUTHENTICATED as transient if it still fires (e.g.,
 *       waitForConvexAuth timed out, or Convex auth dropped mid-call) —
 *       visibilitychange + max-retry path will re-attempt once Convex
 *       auth lands. UNAUTHENTICATED IS counted toward the max-retry
 *       budget (it's the same state-machine state as a network
 *       failure); a real persistent auth mismatch will eventually
 *       transition to 'failed-permanent' after MAX_HANDOFF_RETRIES.
 *
 * P1 #4 — max-retry counter (5) + exponential backoff (1, 2, 4, 8, 16
 * seconds) gates the visibilitychange retry path. After exhaustion,
 * the state flips to 'failed-permanent' and no further retries are
 * scheduled.
 */
async function _runHandoff(
  userIdAtStart: string,
  gen: number,
): Promise<void> {
  // Step 1: parse localStorage (corruption recovery is unconditional).
  const parsed = parseLocalStorageRaw();
  if (parsed.kind === 'corrupt') {
    removeLocalStorage();
  }

  const localList = parsed.kind === 'ok' ? parsed.list : [];

  if (localList.length === 0) {
    // Nothing to merge — verify auth is still us, then transition to complete.
    if (!_authStillMatches(userIdAtStart, gen)) return;
    _handoffState = 'complete';
    // P2 #20 — defer dispatchChanged until the first reactive snapshot
    // lands (set inside `_startReactiveSubscription`'s onResult). Without
    // this, an empty-handoff path would dispatch `WM_FOLLOWED_COUNTRIES_CHANGED`
    // before any subscription data exists, briefly causing FollowButtons
    // to render as if the list were empty when in fact the snapshot was
    // simply not yet available. `_startReactiveSubscription` fires the
    // change event itself once the first onResult arrives.
    _initialSnapshotReceived = false;
    void _startReactiveSubscription(userIdAtStart, gen);
    return;
  }

  // Step 2: call mergeAnonymousLocal.
  let result: ServerMergeAnonymousLocalResult;
  try {
    const client = await _convexClientGetter();
    const api = await _convexApiGetter();
    if (!client || !api) {
      // Convex unavailable — treat as transient failure. Keep localStorage,
      // schedule retry on visibilitychange.
      if (!_authStillMatches(userIdAtStart, gen)) return;
      _markFailedAndScheduleRetry(userIdAtStart, gen);
      return;
    }
    // Codex round-4 P1 — defer the merge until Convex auth has landed.
    // Without this, mergeAnonymousLocal can fire BEFORE Convex sees the
    // identity (Clerk emits the signed-in state immediately; Convex's
    // setAuth callback runs on the next event-loop tick) and the server
    // throws UNAUTHENTICATED. waitForConvexAuth resolves to true once
    // the server confirms the client is authenticated, false on timeout.
    // On timeout we still attempt the call — the catch below will treat
    // any resulting UNAUTHENTICATED as transient and schedule a retry.
    await _waitForConvexAuthFn();
    if (!_authStillMatches(userIdAtStart, gen)) return;
    result = await client.mutation(
      api.followedCountries.mergeAnonymousLocal,
      { countries: localList },
    );
  } catch (err) {
    if (!_authStillMatches(userIdAtStart, gen)) return;
    // P1 #3 — branch on ConvexError kind. Permanent kinds skip retry.
    // Codex round-4 P1 — UNAUTHENTICATED is no longer permanent; it's
    // the canonical signal of "Convex auth not yet attached" and the
    // visibilitychange retry will succeed once auth lands.
    const kind = _extractConvexErrorKind(err);
    if (kind === 'INPUT_TOO_LARGE' || kind === 'EMPTY_INPUT') {
      // Permanent: the input shape is the problem (over-large array OR
      // empty array). Clear localStorage so the next sign-in starts
      // clean. Install the reactive subscription so signed-in reads
      // still work.
      console.warn(
        `[followed-countries] handoff permanent failure (kind=${kind}); clearing localStorage`,
      );
      removeLocalStorage();
      _handoffState = 'failed-permanent';
      _initialSnapshotReceived = false;
      void _startReactiveSubscription(userIdAtStart, gen);
      return;
    }
    // Transient (network / 5xx / UNAUTHENTICATED-while-Convex-catches-up).
    // Visibility-retry-gated; counted toward MAX_HANDOFF_RETRIES so a
    // genuinely-stuck auth mismatch eventually flips to failed-permanent.
    _markFailedAndScheduleRetry(userIdAtStart, gen);
    return;
  }

  // Step 3: auth-generation guard AFTER await — drop silently on stale.
  if (!_authStillMatches(userIdAtStart, gen)) return;

  // Step 4: success path.
  removeLocalStorage();
  _handoffState = 'complete';
  _initialSnapshotReceived = false;
  void _startReactiveSubscription(userIdAtStart, gen);
  // Note: we still dispatch immediately here because the localStorage
  // mutation is itself a state change that subscribers want to know
  // about (mergeAnonymousLocal cleared it). The subscription's first
  // snapshot will fire a second event when it arrives.
  dispatchChanged();

  // Step 5: surface cap-drop event so the UI can render an upgrade toast.
  const droppedDueToCap = Array.isArray(result.droppedDueToCap)
    ? result.droppedDueToCap
    : [];
  const accepted = Array.isArray(result.accepted) ? result.accepted : [];
  if (droppedDueToCap.length > 0) {
    dispatchCapDrop(accepted.length, droppedDueToCap.length);
  }
}

/**
 * P1 #4 — central retry-budget enforcer. Either schedules a
 * visibilitychange retry (with the exponential-backoff delay scaled by
 * `_handoffRetryAttempt`) OR transitions to 'failed-permanent' if the
 * budget is exhausted.
 */
function _markFailedAndScheduleRetry(
  userIdAtStart: string,
  gen: number,
): void {
  if (_handoffRetryAttempt >= MAX_HANDOFF_RETRIES) {
    console.warn(
      `[followed-countries] handoff retry budget exhausted (${MAX_HANDOFF_RETRIES}); marking permanent`,
    );
    _handoffState = 'failed-permanent';
    _clearVisibilityRetryListener();
    _initialSnapshotReceived = false;
    void _startReactiveSubscription(userIdAtStart, gen);
    return;
  }
  _handoffState = 'failed';
  _scheduleVisibilityChangeRetry(userIdAtStart, gen);
}

function _authStillMatches(userIdAtStart: string, gen: number): boolean {
  if (gen !== _handoffGeneration) return false;
  const current = _clerkUserGetter();
  if (!current || current.id !== userIdAtStart) return false;
  return true;
}

function _scheduleVisibilityChangeRetry(
  userIdAtStart: string,
  gen: number,
): void {
  if (typeof document === 'undefined') return;
  _clearVisibilityRetryListener();
  // P1 #4 — exponential backoff. The visibilitychange event fires when
  // the tab becomes visible again; we additionally hold off for the
  // backoff duration before re-running the handoff so a flapping
  // network doesn't get hammered by a tab-flip-flap pattern.
  const handler = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    // One-shot — remove and rerun. Only retry if auth still matches AND
    // the handoff generation is still ours; otherwise drop silently.
    _clearVisibilityRetryListener();
    if (!_authStillMatches(userIdAtStart, gen)) return;
    const backoffMs = _backoffMsFor(_handoffRetryAttempt);
    _handoffRetryAttempt += 1;
    if (backoffMs > 0 && typeof setTimeout !== 'undefined') {
      setTimeout(() => {
        if (!_authStillMatches(userIdAtStart, gen)) return;
        void _runHandoff(userIdAtStart, gen);
      }, backoffMs);
    } else {
      void _runHandoff(userIdAtStart, gen);
    }
  };
  document.addEventListener('visibilitychange', handler);
  _visibilityRetryListener = handler;
}

function _clearVisibilityRetryListener(): void {
  if (_visibilityRetryListener && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityRetryListener);
  }
  _visibilityRetryListener = null;
}

/**
 * Test-only: trigger the pending visibilitychange retry without going
 * through the real DOM event. Returns a promise that resolves when the
 * retry's handoff finishes.
 */
export function _triggerVisibilityRetryForTests(): Promise<void> {
  if (!_visibilityRetryListener) return Promise.resolve();
  // The handler is sync but kicks off `_runHandoff` (async). To make
  // tests deterministic, replicate the handler's logic with awaitable
  // semantics here.
  return new Promise<void>((resolve) => {
    const handler = _visibilityRetryListener;
    if (!handler) {
      resolve();
      return;
    }
    // We don't actually call the DOM-bound handler (which doesn't return
    // a promise) — instead, we simulate the visibilitychange retry by
    // capturing state and running `_runHandoff` directly. Tests rely on
    // this awaiting completion.
    _clearVisibilityRetryListener();
    // We can't recover userIdAtStart/gen from the closure, so call the
    // handler synchronously and chain on the next microtask. The handler
    // schedules an async `_runHandoff`; we await it via a microtask flush.
    handler();
    // Allow the spawned _runHandoff microtask chain to settle. We use a
    // small loop of microtask flushes; tests only need this to resolve
    // after the mutation promise has resolved.
    queueMicrotask(() => queueMicrotask(() => resolve()));
  });
}

// ---------------------------------------------------------------------------
// Reactive subscription to listFollowed (U3)
// ---------------------------------------------------------------------------

async function _startReactiveSubscription(
  userIdAtStart: string,
  gen: number,
): Promise<void> {
  // Idempotent — if a prior subscription is still active, replace it.
  _stopReactiveSubscription();

  const client = await _convexClientGetter();
  const api = await _convexApiGetter();
  if (!client || !api) {
    // No transport available (Convex disabled in this env). Subscription
    // stays empty; getFollowed() falls through to localStorage union or
    // empty list.
    return;
  }

  // After the await, verify auth is still ours before installing the
  // subscription. Without this, a sign-out mid-startReactive would
  // silently install a subscription for a now-detached user.
  if (!_authStillMatches(userIdAtStart, gen)) return;

  const teardown = client.onUpdate(
    api.followedCountries.listFollowed,
    {},
    (result) => {
      // Defensive: drop late callbacks that fire after the subscription
      // was meant to be torn down.
      if (!_authStillMatches(userIdAtStart, gen)) return;
      const countries = Array.isArray(result)
        ? (result.filter((c) => typeof c === 'string') as string[])
        : [];
      _lastKnownSubscriptionSnapshot = { userId: userIdAtStart, countries };
      // P2 #20 — first snapshot has landed; from now on getFollowed
      // returns the snapshot authoritatively.
      _initialSnapshotReceived = true;
      dispatchChanged();
    },
    (err: Error) => {
      // Subscription error — leave the snapshot as-is so getFollowed()
      // returns the last known good list. The next reconnect will
      // refresh it.
      console.warn('[followed-countries] listFollowed error:', err.message);
    },
  );

  // ConvexClient.onUpdate returns an Unsubscribe (callable) per the
  // simple_client.d.ts surface. Tests inject a function directly.
  _reactiveUnsubscribe = typeof teardown === 'function' ? teardown : null;
}

function _stopReactiveSubscription(): void {
  if (_reactiveUnsubscribe) {
    try {
      _reactiveUnsubscribe();
    } catch {
      /* swallow */
    }
  }
  _reactiveUnsubscribe = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current followed list as an ISO-2 array.
 *
 * Anonymous mode: localStorage. Signed-in mode: user-scoped Convex
 * snapshot. During handoffPending: union of localStorage + the
 * user-scoped snapshot (only if `snap.userId === currentClerkUser.id`).
 *
 * Sync, never throws. Empty/corrupt storage → [].
 */
export function getFollowed(): string[] {
  const user = _clerkUserGetter();
  const localList = readLocalStorageList();

  // Anonymous mode → localStorage.
  if (!user) return localList;

  // Signed-in. If snapshot belongs to current user, use it; otherwise
  // (cross-user-leak guard) ignore the snapshot. During handoffPending
  // OR failed, union with localStorage.
  const snap = _lastKnownSubscriptionSnapshot;
  const snapList =
    snap && snap.userId === user.id ? snap.countries : [];

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return [...new Set([...localList, ...snapList])];
  }

  // Complete (post-handoff): authoritative is the snapshot. localStorage
  // should already be cleared after a successful handoff, but if for
  // any reason it isn't, the snapshot wins.
  //
  // P2 #20 — if the handoff is 'complete' but the first reactive
  // snapshot hasn't landed yet, fall back to localStorage so the UI
  // doesn't briefly render an empty list during the subscription warm-up
  // window. (For the empty-handoff path localStorage is already empty;
  // for the merge-success path localStorage was cleared, so the
  // fallback returns []. No harm in either case.)
  if (_handoffState === 'complete') {
    if (!_initialSnapshotReceived) {
      return [...new Set([...localList, ...snapList])];
    }
    return [...snapList];
  }

  if (_handoffState === 'failed-permanent') {
    // Permanent failure: localStorage was cleared (input shape was the
    // problem). Authoritative source is whatever the reactive
    // subscription returns. If the subscription hasn't landed yet,
    // return [] (we won't fall back to localStorage because we cleared
    // it on purpose).
    return [...snapList];
  }

  // 'idle' shouldn't be reachable when there's a Clerk user (the
  // listener flips to 'pending' on transition). Fallback: just return
  // the snapshot OR localStorage (defensive).
  return snap && snap.userId === user.id
    ? [...snap.countries]
    : localList;
}

/** Sync `isFollowed` check; case-folds via `toIso2`. */
export function isFollowed(code: string): boolean {
  const norm = toIso2(code);
  if (!norm) return false;
  return getFollowed().includes(norm);
}

function _extractConvexErrorKind(err: unknown): string | null {
  // Memory: convex-error-string-data-strips-errordata-on-wire — the
  // data field is the source of truth. ConvexError({kind: ...}) is
  // serialized as `err.data = { kind, ... }` over the wire.
  const e = err as { data?: { kind?: unknown } } | undefined;
  if (e && e.data && typeof e.data.kind === 'string') return e.data.kind;
  return null;
}

function _extractConvexErrorData(
  err: unknown,
): Record<string, unknown> | null {
  const e = err as { data?: unknown } | undefined;
  if (e && e.data && typeof e.data === 'object') {
    return e.data as Record<string, unknown>;
  }
  return null;
}

/**
 * Add a country to the followed list. Idempotent. Never throws —
 * returns a `FollowMutationResult` discriminated union.
 */
export async function addCountry(input: string): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const ent = serviceEntitlementState();
  if (ent === 'loading') {
    return { ok: false, reason: 'ENTITLEMENT_LOADING' };
  }

  const user = _clerkUserGetter();

  // Signed-in & handoff complete → Convex authoritative path.
  if (user) {
    // P1 #6 — DROPPED: the `if (existing.includes(code)) return {ok:true}`
    // short-circuit is removed on the signed-in branch. The Convex
    // mutation is itself idempotent (returns `{idempotent:true}` when
    // the row already exists) and authoritative; the local snapshot is
    // eventually consistent and could lie (e.g., another tab just
    // unfollowed). The anonymous-mode early-return below is preserved
    // because localStorage IS the source of truth there.
    // P1 #11 — capture auth identity BEFORE await so a sign-out / user
    // swap mid-mutation can be detected and surfaced as HANDOFF_PENDING.
    const userIdAtStart = user.id;
    const genAtStart = _handoffGeneration;
    try {
      const client = await _convexClientGetter();
      const api = await _convexApiGetter();
      // P1 #11 — re-verify after the await. If a sign-out / user swap
      // happened, fall through to HANDOFF_PENDING (do NOT touch
      // localStorage; the new auth state's listener will handle merge).
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // P1 #5 — when client/api is null in signed-in mode (e.g., Convex
      // misconfigured for this env), DO NOT silently fall back to
      // localStorage — that would create a stale partial-write that
      // never reconciles with the authoritative table. Surface as
      // HANDOFF_PENDING so the UI shows the syncing tooltip.
      if (!client || !api) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      await client.mutation(
        api.followedCountries.followCountry,
        { country: code },
      );
      // P1 #11 — re-verify after the mutation await as well; otherwise
      // a user-swap between mutation start and resolution could let
      // user-A's success "land" while we're already user-B.
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // The reactive subscription will pick up the new row and dispatch
      // WM_FOLLOWED_COUNTRIES_CHANGED; no need to manually fire here.
      return { ok: true };
    } catch (err) {
      const kind = _extractConvexErrorKind(err);
      const data = _extractConvexErrorData(err);
      if (kind === 'FREE_CAP') {
        const currentCount =
          typeof data?.currentCount === 'number'
            ? (data.currentCount as number)
            : undefined;
        const limit =
          typeof data?.limit === 'number'
            ? (data.limit as number)
            : FREE_TIER_FOLLOW_LIMIT;
        return { ok: false, reason: 'FREE_CAP', currentCount, limit };
      }
      if (kind === 'INVALID_COUNTRY') {
        return { ok: false, reason: 'INVALID_INPUT' };
      }
      if (kind === 'UNAUTHENTICATED') {
        // Race: Clerk says we're signed in but Convex hasn't seen the
        // identity yet (or the token expired between this call site and
        // the mutation). Surface as HANDOFF_PENDING so the UI shows the
        // syncing tooltip and the user can retry.
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // Unknown Convex/network error — surface as STORAGE_FULL? No, that
      // misleads the toast. Fall back to a generic ENTITLEMENT_LOADING
      // would also mislead. Cleanest: rethrow so callers can decide. But
      // the contract says "never throws." Map unknown to HANDOFF_PENDING
      // (transient — encourages a retry by the user). Production logs
      // get the real error via the global Sentry hook.
      console.warn('[followed-countries] followCountry unknown error:', err);
      return { ok: false, reason: 'HANDOFF_PENDING' };
    }
  }

  // Anonymous mode — localStorage path.
  const existing = getFollowed();
  if (existing.includes(code)) {
    return { ok: true };
  }
  if (ent === 'free' && existing.length >= FREE_TIER_FOLLOW_LIMIT) {
    return {
      ok: false,
      reason: 'FREE_CAP',
      currentCount: existing.length,
      limit: FREE_TIER_FOLLOW_LIMIT,
    };
  }
  return _writeLocalStorageAdd(code);
}

function _writeLocalStorageAdd(code: string): FollowMutationResult {
  const existing = readLocalStorageList();
  if (existing.includes(code)) return { ok: true };
  const next = [...existing, code];
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Remove a country from the followed list. Idempotent — removing a
 * country that isn't in the list returns `{ok:true}`.
 */
export async function removeCountry(
  input: string,
): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  if (_handoffState === 'pending' || _handoffState === 'failed') {
    return { ok: false, reason: 'HANDOFF_PENDING' };
  }

  const user = _clerkUserGetter();

  if (user) {
    // P1 #6 — DROPPED: the `if (!existing.includes(code)) return {ok:true}`
    // short-circuit is removed on the signed-in branch. Convex's
    // `unfollowCountry` is itself idempotent (returns `{idempotent:true}`
    // on absent rows). The local snapshot is eventually consistent.
    // P1 #11 — capture auth identity before await for post-await re-check.
    const userIdAtStart = user.id;
    const genAtStart = _handoffGeneration;
    try {
      const client = await _convexClientGetter();
      const api = await _convexApiGetter();
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // P1 #5 — same as addCountry: HANDOFF_PENDING when client is null,
      // never silently fall back to localStorage in signed-in mode.
      if (!client || !api) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      await client.mutation(
        api.followedCountries.unfollowCountry,
        { country: code },
      );
      if (!_authStillMatches(userIdAtStart, genAtStart)) {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      // Reactive subscription will fire the change event.
      return { ok: true };
    } catch (err) {
      const kind = _extractConvexErrorKind(err);
      if (kind === 'INVALID_COUNTRY') {
        return { ok: false, reason: 'INVALID_INPUT' };
      }
      if (kind === 'UNAUTHENTICATED') {
        return { ok: false, reason: 'HANDOFF_PENDING' };
      }
      console.warn('[followed-countries] unfollowCountry unknown error:', err);
      return { ok: false, reason: 'HANDOFF_PENDING' };
    }
  }

  // Anonymous mode.
  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  return _writeLocalStorageRemove(code);
}

function _writeLocalStorageRemove(code: string): FollowMutationResult {
  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  const next = existing.filter((c) => c !== code);
  const wrote = writeLocalStorageList(next);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Subscribe to followed-list changes. Fires after every successful
 * `addCountry` / `removeCountry` (anon mode); for signed-in mode, also
 * fires on every Convex reactive `listFollowed` snapshot.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(handler: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {
      /* no-op in non-browser env */
    };
  }
  window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  return () => {
    window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  };
}

/**
 * Test-only: snapshot of internal state for assertion. Production
 * callers must NOT rely on this shape — it is private.
 */
export function _getInternalStateForTests(): {
  handoffState: typeof _handoffState;
  handoffGeneration: number;
  handoffRetryAttempt: number;
  initialSnapshotReceived: boolean;
  lastKnownSubscriptionSnapshot:
    | { userId: string; countries: string[] }
    | null;
  hasReactiveSubscription: boolean;
  hasVisibilityRetryListener: boolean;
  hasCrossTabStorageListener: boolean;
} {
  return {
    handoffState: _handoffState,
    handoffGeneration: _handoffGeneration,
    handoffRetryAttempt: _handoffRetryAttempt,
    initialSnapshotReceived: _initialSnapshotReceived,
    lastKnownSubscriptionSnapshot: _lastKnownSubscriptionSnapshot
      ? {
          userId: _lastKnownSubscriptionSnapshot.userId,
          countries: [..._lastKnownSubscriptionSnapshot.countries],
        }
      : null,
    hasReactiveSubscription: _reactiveUnsubscribe !== null,
    hasVisibilityRetryListener: _visibilityRetryListener !== null,
    hasCrossTabStorageListener: _crossTabStorageListener !== null,
  };
}

/**
 * Test-only: drive the reactive subscription's `onResult` callback as if
 * the Convex server pushed a new snapshot. Mocking this directly via
 * the injected fake `convexClient.onUpdate` is also fine; this helper is
 * a convenience for tests that don't want to capture the callback.
 */
export function _pushSubscriptionSnapshotForTests(
  userId: string,
  countries: string[],
): void {
  // Mirrors the inline branch in `_startReactiveSubscription`: only
  // accept if the auth still matches.
  const current = _clerkUserGetter();
  if (!current || current.id !== userId) return;
  _lastKnownSubscriptionSnapshot = { userId, countries: [...countries] };
  _initialSnapshotReceived = true;
  dispatchChanged();
}
