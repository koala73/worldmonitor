---
title: "Historical-playback control gated on a Clerk role field that no writer ever populates"
date: 2026-07-29
category: logic-errors
module: playback-gate
problem_type: logic_error
component: payments
severity: high
symptoms:
  - "Historical-playback control was invisible to every user, including paying Pro subscribers, for months, with no bug report and no alarm - the feature simply did not exist from the user's point of view"
  - "setupPlaybackControl gated the control behind getAuthState().user?.role === 'pro', a field sourced from Clerk publicMetadata that zero code paths ever write, so it read 'free' for every account and the gate could never pass"
  - "Found incidentally during unrelated work rather than through a support ticket, since a permanently-false gate produces no error, no failed request, and no monitoring signal"
root_cause: logic_error
resolution_type: code_fix
related_components: [authentication, development_workflow]
tags: [entitlements, premium-gating, clerk, convex, fail-closed, playback-control, unwritten-signal, affirmative-denial]
---

# Historical-playback control gated on a Clerk role field that no writer ever populates

## Problem

The dashboard's historical-playback control (the header "rewind" toggle that scrubs through saved snapshots) was invisible to every user, including paying Pro subscribers, for months. `setupPlaybackControl` in `src/app/event-handlers.ts` gated the control's visibility on `getAuthState().user?.role === 'pro'`. That `role` field lives on `AuthUser` (`src/services/auth-state.ts:10`) and is populated from Clerk `publicMetadata` — but nothing in the codebase writes it. A repo-wide sweep for the writer side (`grep -rln "clerkClient\|updateUser" src/ api/ server/`) returns zero matches: no code path ever calls Clerk's admin API to set `publicMetadata.plan`/`role`. Every account, including a customer with an active Dodo subscription, therefore reads `role: 'free'` forever, and `role === 'pro'` could never evaluate true.

**The generalizable bug class: a premium feature gated on a signal that no writer ever populates fails closed for 100% of users, silently.** There is no error to log and no user to complain, because the feature never renders at all. Contrast the loud failure mode — a paying user hits a paywall and files a ticket — with this silent one, where nobody sees anything and so nobody reports it.

This is the same dead-field trap the codebase had already diagnosed once for panel gating: `src/services/panel-gating.ts:41-46` documents that Clerk `publicMetadata.plan` is untrustworthy for exactly this reason, and `hasPremiumAccess()` instead resolves through `isProUser()`, which uses `role === 'pro'` only as one arm of a boolean union (`src/services/widget-store.ts:223-230`). The playback control's gate had never been migrated to that pattern and read the raw, unwritten field directly.

Fixed in three commits on `fix/playback-gate-entitlement`, closing [#5632](https://github.com/koala73/worldmonitor/issues/5632). Unmerged as of this writing; the commits are identified below by what they change rather than by SHA, since a squash merge rewrites them.

## Symptoms

- The historical-playback toggle never appeared in the dashboard header for any account — free, Pro, or desktop-API-key — regardless of subscription status.
- No error was thrown, nothing was logged, and no Sentry event fired: the code path evaluated a false boolean and skipped rendering.
- No support tickets and no internal alert, because there was no failure signature to notice. The feature read as "doesn't exist" rather than "broken."
- Invisible to a source-grep style "did we wire the gate" check: a test asserting `evaluatePlaybackGate` appears in the source would pass with the original `role === 'pro'` gate fully in place, because a grep cannot see that the gate's *input* is dead.

## What Didn't Work

- **A source-grep "wiring guard" test.** An early idea for locking in the fix was asserting the new `evaluatePlaybackGate`/`resolvePlaybackGate` symbols appear in `src/app/event-handlers.ts`. That check goes green with the original bug restored verbatim — it never drives the decision, only confirms a name exists in the file. The suite that shipped instead (`tests/dom/playback-gate-wiring.test.mts`) mounts the real `EventHandlerManager`, calls the real `setupPlaybackControl()`, and asserts what `.playback-control`'s `style.display` and `document.body.classList` actually contain. Only a behavioral test that drives production code has teeth against this bug class.
- **A regex-targeted mutation round produced a false negative.** The first mutation pass targeted `if (this.ctx.isDestroyed) return;` by pattern rather than line number. That exact line appears five times in `src/app/event-handlers.ts` (lines 837, 1644, 1785, 1804, and 1975 — the last being the one inside `setupPlaybackControl`'s `applyGate`). The pattern matched an earlier occurrence inside `setupExportPanel`, so the suite stayed green and looked like a real coverage gap when it was actually a mistargeted mutant. Switching to line-number-targeted mutation killed it.

## Solution

**Before** — `setupPlaybackControl`, reduced to the gate:

```ts
const isPro = getAuthState().user?.role === 'pro'; // always false: nothing writes this field
el.style.display = isPro ? '' : 'none';
```

**After**, in three commits.

> **Paths below are as-of #5632.** [#5813](https://github.com/koala73/worldmonitor/issues/5813) later moved these modules without changing behaviour: `src/services/playback-gate.ts` → `src/services/gates/playback-resolver.ts`, and `readPlaybackGateInputs` → `src/services/gates/playback.ts`, where it is now module-private (`evaluatePlaybackGate` was always its only caller). The snippets are left as they shipped.

**1. The gate itself** — a zero-import pure leaf, `src/services/playback-gate.ts`, wired through `src/services/panel-gating.ts`:

```ts
// src/services/playback-gate.ts
export function resolvePlaybackGate(input: PlaybackGateInputs): PlaybackGateVerdict {
  if (input.premiumAccess) return 'visible';
  if (input.authPending) return 'pending';
  if (!input.signedIn) return 'denied';
  if (!input.entitlementLoaded) return 'visible';
  return 'denied';
}
```

```ts
// src/services/panel-gating.ts
export function readPlaybackGateInputs(authState: AuthSession): PlaybackGateInputs {
  return {
    premiumAccess: hasPremiumAccess(authState),
    authPending: authState.isPending,
    signedIn: Boolean(authState.user),
    entitlementLoaded: getEntitlementState() !== null,
  };
}
```

```ts
// src/app/event-handlers.ts — setupPlaybackControl
let gateHitTracked = false;
const applyGate = (): void => {
  if (this.ctx.isDestroyed) return;
  const verdict = evaluatePlaybackGate(getAuthState());
  const visible = verdict === 'visible';
  el.style.display = visible ? '' : 'none';
  if (!visible) this.ctx.playbackControl?.exitPlayback();
  if (verdict === 'denied' && !gateHitTracked) {
    gateHitTracked = true;
    trackGateHit('playback');
  }
};

applyGate();
this.proGateUnsubscribers.push(subscribeAuthState(() => applyGate()));
this.proGateUnsubscribers.push(onEntitlementChange(() => applyGate()));
```

**2. Mid-replay revocation** — `PlaybackControl.exitPlayback()`, called from `applyGate` on every non-visible verdict:

```ts
// src/components/PlaybackControl.ts
public exitPlayback(): void {
  if (!this.isPlaybackMode) return;
  this.element.querySelector('.playback-panel')?.classList.add('hidden');
  this.goLive();
}
```

**3. Test-drift removal** — `isEntitlementActive(state, now)` extracted from `isEntitled()`:

```ts
// src/services/entitlements.ts
export function isEntitlementActive(state: EntitlementState | null, now: number): boolean {
  return state !== null && state.planKey !== 'free' && state.validUntil >= now;
}

export function isEntitled(): boolean {
  return isEntitlementActive(currentState, Date.now());
}
```

so the DOM test's mock delegates instead of re-implementing:

```ts
// tests/dom/playback-gate-wiring.test.mts
isEntitled: () => actual.isEntitlementActive(entitlement, Date.now()),
```

## Why This Works

**The gate now reads a signal that is actually written.** `hasPremiumAccess()` (`src/services/panel-gating.ts:53-58`) unions the desktop `WORLDMONITOR_API_KEY` secret with `isProUser()`, which itself unions the widget-tester keys, the dead Clerk `role` field, and `isEntitled()` (`src/services/widget-store.ts:223-230`). Because `isEntitled()` is fed by the real Dodo-to-Convex webhook pipeline, a paying subscriber now has an actually-true path into the gate regardless of whether Clerk's `role` is ever populated.

**The two "unknown" states resolve asymmetrically on purpose, and the asymmetry is load-bearing:**

- `authPending → 'pending'` is a **bounded** unknown. Clerk hydrates within its idle window (`src/services/auth-state.ts:19` sets the boot default `isPending: true`), and `subscribeAuthState` re-runs `applyGate()` immediately after. Hiding here costs a brief delay, not a lockout. Because it is not an affirmative denial it is deliberately excluded from the `trackGateHit('playback')` funnel metric, so a boot state cannot be miscounted as a denial for a user who was never gated.
- `!entitlementLoaded → 'visible'` is an **unbounded** unknown. `initEntitlementSubscription()` (`src/services/entitlements.ts:59-105`) returns without ever assigning `currentState` when `VITE_CONVEX_URL` is unset or when `waitForConvexAuth(10_000)` times out. In either case no snapshot is ever coming for that session, so failing closed would turn a boot blip into a permanent lockout for a paying customer — precisely the failure `src/app/panel-layout.ts:723-748` already records as a prior mistake ("Prior iterations of this code tried the opposite — gating positively on `hasTier(1)` — and locked legitimate Pro users out whenever the Convex snapshot was late, skipped, or failed").

**`exitPlayback()`'s guard is what makes the fail-open branch safe.** Because a signed-in free user is shown the control until their snapshot proves otherwise, that user can enter playback before the snapshot lands and denies them. Hiding the element alone strands the dashboard on historical data — the only "Live" button lives *inside* the element that just received `display: none`. But `applyGate()` fires on every page load, including the ordinary pending transition, so an unguarded `exitPlayback()` would trigger `goLive()` → `onSnapshotChange(null)` → a full `loadAllData()` on every boot. The `if (!this.isPlaybackMode) return;` guard makes it a true no-op unless the user was mid-replay, which the DOM suite pins with `expect(loadAllData).not.toHaveBeenCalled()` on a mere pending-auth hide.

**Subscribing to both emitters closes the post-checkout gap.** The Convex entitlement watcher and Clerk's auth state are separate, independently-firing sources. An auth-only subscription would never re-run `applyGate()` when a snapshot lands after sign-in — exactly the moment a user finishes checkout. `setupExportPanel` already subscribed to both for the same reason.

**Extracting `isEntitlementActive` removes a silent-drift hazard in the test.** `isEntitled()` read the module-private `currentState` with no setter, so any test simulating "entitled" had to hand-copy its three conditions into a mock — and if the real predicate later changed, the copy would silently diverge while the suite stayed green testing the wrong rule. Verified empirically: with the hand-copied mock, mutating the real predicate left the suite green; after the extraction, the same mutation reds 5 tests.

## Prevention

**Detecting this bug class.** For every premium/paywalled gate, ask "who writes this signal, and can I point at the writer?" A gate on a value nothing writes fails closed for 100% of users with no error, no log line, and no complaint to notice it by.

- Run `grep -rn "role === 'pro'" src/` periodically. It should only ever appear as one arm of a boolean union inside `hasPremiumAccess()` (`src/services/panel-gating.ts:56`) or `isProUser()` (`src/services/widget-store.ts:227`) — never as the sole condition gating a feature. `src/components/ProBanner.ts:133` is another correct usage (it leads with `isEntitled()`).
- Before shipping a new gate, verify the writer side exists. `grep -rln "clerkClient\|updateUser" src/ api/ server/` currently returns nothing, confirming Clerk `publicMetadata` has no writer here — so any new code reading `user.role` as an authoritative signal is reading a field that can never become true. Route new gates through `hasPremiumAccess()`/`isProUser()`.
- A source-text "is the gate wired" test does not catch this class; it cannot see that the gate's input is dead. Regression tests for a gate must drive the real function that renders or hides the UI and assert on rendered state.

**The affirmative-denial rule, and which way an unknown should fail.** Never let an unknown resolve to a denial. Resolve to `denied` only on affirmative evidence — signed-out with no snapshot to check, or a loaded snapshot that positively fails the predicate. For every unknown, ask whether it is bounded or unbounded:

- **Bounded** unknowns (guaranteed to resolve within a known window, like Clerk hydration) may hide briefly, because the cost is a delay rather than a lockout — and should be excluded from denial metrics, since they are not denials.
- **Unbounded** unknowns (a value that may never arrive) must fail open, because failing closed is indistinguishable from a permanent lockout for a paying customer. This is the second place in this codebase where that reasoning had to be applied, which is a signal it belongs in any new premium-gate design from the start rather than being rediscovered per feature.
- When a fail-open branch can be entered mid-use, the consumer must handle the `visible → non-visible` transition explicitly. A fail-open design is only safe if losing access mid-use has defined, tested behavior instead of stranding the UI.

**Mutation-testing pitfall.** Target mutants by line number, not by regex, in files that repeat a guard idiom. A pattern match can silently mutate the wrong occurrence and produce a false-negative "coverage gap" — as happened here with a line that appears five times in one file.

## Related Issues

- [`billing-state-cancelled-but-paid-through-misclassified-as-lapsed.md`](billing-state-cancelled-but-paid-through-misclassified-as-lapsed.md) — closest sibling. Different root cause (a late Convex snapshot causing misclassification rather than a field nobody writes), but the same prevention instinct: a missing or not-yet-loaded entitlement signal must not be treated as denial. Also touches `panel-gating.ts`.
- [`verify-the-verifier-mutation-test-every-detection-layer.md`](../conventions/verify-the-verifier-mutation-test-every-detection-layer.md) — names the exact anti-pattern the `isEntitlementActive` extraction fixes: "a companion test has its own private read-and-match loop instead of calling the real scan, so it can never observe a regression."
- [`denied-push-permission-rendered-as-retryable-failure.md`](denied-push-permission-rendered-as-retryable-failure.md) — shares two shapes: widening a binary result into a three-state union, and folding logic into a single accessor so there is no second implementation to drift.
- [`checks-must-fail-closed-when-they-lose-their-target.md`](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — **not** contradicted by this doc's fail-open choice, despite the surface tension. That doc governs CI/contract checks losing observability of their target; this is a product gating decision reasoned against a specific bounded-vs-unbounded tradeoff.
- GitHub [#5632](https://github.com/koala73/worldmonitor/issues/5632) — the source issue.
- GitHub [#5604](https://github.com/koala73/worldmonitor/issues/5604) — opposite-direction sibling: `exportFormats` and `maxDashboards` are advertised capabilities with no enforcement at all. Worth a sweep for other dead or unwired entitlement config keys.
- GitHub [#4276](https://github.com/koala73/worldmonitor/issues/4276) — the tier-gated playback epic that spawned the original gate.
