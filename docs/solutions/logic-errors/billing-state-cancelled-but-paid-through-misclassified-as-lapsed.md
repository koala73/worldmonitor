---
title: "deriveBillingUxState fallthrough misclassified cancelled-but-paid-through subscriptions as lapsed"
date: 2026-07-23
category: logic-errors
module: billing-state
problem_type: logic_error
component: payments
severity: high
symptoms:
  - "deriveBillingUxState (src/services/billing-state.ts) returned 'lapsed' for status 'cancelled' subscriptions unconditionally, without checking whether currentPeriodEnd was still in the future"
  - "A cancelled-but-paid-through customer whose entitlement snapshot resolves after the subscription watch would transiently see 'Your Pro subscription has ended - Resubscribe'"
  - "Diverged from the server's own coverage semantics in isCoveringAt (convex/payments/subscriptionHelpers.ts), which treats cancelled-with-future-currentPeriodEnd as covering, not lapsed"
  - "Four of the ten review personas independently flagged the same fallthrough line pre-merge"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [billing, entitlements, subscription-state, coverage-semantics, cancelled-but-paid-through, client-side-derivation, convex-watch-race]
---

# deriveBillingUxState fallthrough misclassified cancelled-but-paid-through subscriptions as lapsed

## Problem

`deriveBillingUxState(sub, ent, now)` (`src/services/billing-state.ts`) is a new pure client-side function (issue #4771, shipped in PR #5494) that maps the two independent reactive Convex snapshots — the subscription row and the entitlement row — into one of six billing UX states (`free` / `active` / `on_hold` / `renewal_verification_pending` / `renewal_verification_failed` / `lapsed`) driving both the panel-gating CTA and a top-of-page banner.

The function's job is to reproduce, on the client, the same coverage semantics the server already enforces in `isCoveringAt` (`convex/payments/subscriptionHelpers.ts:236-245`):

```ts
function isCoveringAt<T extends Pick<SubscriptionRow, "status" | "currentPeriodEnd">>(
  s: T,
  at: number,
): boolean {
  return (
    s.status === "active" ||
    s.status === "on_hold" ||
    (s.status === "cancelled" && s.currentPeriodEnd > at)
  );
}
```

`isCoveringAt` treats three statuses very differently: `active` and `on_hold` always cover; `cancelled` covers conditionally — only while `currentPeriodEnd` is still in the future ("cancelled-but-paid-through," e.g. a customer who cancelled auto-renew but is still inside the period they already paid for); `expired` never covers. `cancelled` and `expired` are not semantically interchangeable — one is a conditional, time-boxed state and the other is unconditionally terminal.

The initial client-side implementation collapsed that distinction. Its fallthrough after the `active`-status branch was:

```ts
return 'lapsed';
```

with no separate check for `sub.status === 'cancelled'` and `currentPeriodEnd`. Any subscription that reached this point — `cancelled` regardless of period end, or `expired` — was unconditionally mapped to `lapsed`, the state that renders "Your Pro subscription has ended — Resubscribe."

Because the subscription watch and the entitlement watch are two independent Convex subscriptions, either can resolve first on the client. A customer who cancelled but is still inside their paid-through window, whose entitlement snapshot happens to arrive late (or is still `null` while both watches settle), would transiently hit this fallthrough: `sub.status === 'cancelled'`, `entitledNow` false (entitlement snapshot not yet loaded/refreshed), no `active`-status branch taken (status isn't `'active'`) → falls through to `'lapsed'`. The customer sees a false terminal "subscription has ended" message and a resubscribe CTA while still paying and still covered — exactly the duplicate-checkout/support-ticket failure mode issue #4771 was opened to eliminate.

## Symptoms

- `deriveBillingUxState` returned `'lapsed'` for `status: 'cancelled'` subscriptions unconditionally, without checking whether `currentPeriodEnd` was still in the future.
- A customer who cancelled but is still within their paid-through period, whose entitlement snapshot resolves after the subscription watch (or is still `null`), would transiently see "Your Pro subscription has ended — Resubscribe."
- The derivation diverged from the server's own coverage semantics in `isCoveringAt` (`convex/payments/subscriptionHelpers.ts:236-245`), which treats `cancelled`-with-`currentPeriodEnd`-in-the-future as covering, not lapsed.
- The function's own docstring rule 5 (pre-fix) read "`cancelled`/`expired` past their paid window: provider-confirmed end of coverage — `lapsed`" — asserting a "past their paid window" precondition for `cancelled` that the code itself never checked, i.e. the comment and the implementation directly contradicted each other.
- Four of the ten review personas independently flagged the same fallthrough line pre-merge (per this session's review run: the correctness, maintainability, api-contract, and adversarial lenses; the PR body records only the count), with one citing both the `isCoveringAt` precedent and the docstring/code contradiction.

## What Didn't Work

The bug was not caught by writing the code, by a subsequent cleanup pass, or by a full green local test run — it took a dedicated adversarial multi-persona review to surface it, all within the same PR before merge.

Sequence of events inside PR #5494 (pre-squash branch history, described rather than SHA-cited — the squash rewrote these commits, so their SHAs are not reachable from `main`):

1. The initial implementation commit ("feat(billing): pure billing UX state derivation for #4771") shipped the bare `return 'lapsed';` fallthrough together with 25 `it()` cases in `tests/billing-state.test.mts`. All 25 passed.
2. A later simplify/cleanup commit ("refactor(billing): localize banner via shared i18n keys; per-pass gating derivation; skip no-op CTA rebuilds") touched both `src/services/billing-state.ts` and `tests/billing-state.test.mts` — and the fallthrough bug passed through completely unchanged: the `return 'lapsed';` line was untouched and no new cancelled-status test was added (test count remained 25).
3. Local test battery: the PR body records a full green run — `test:data` (16k tests), vitest (832), typecheck, i18n gates, lint boundaries, biome, etc. (Aside: the PR body describes the post-fix derivation suite as "34 pure derivation/variant/override cases"; the merged file actually contains 30 `it()` blocks — 22 derivation + 5 banner + 3 gate-override. The PR's own count was inflated; 30 is what the tree substantiates.) None of this caught the bug either, for a structural reason, not bad luck.
4. Only the adversarial review pass (10 personas + an independent cross-model Codex pass, per-finding validated) converged on the fallthrough line — 4 reviewers independently, per the PR body — leading to the review-fix commit ("fix(review): cancelled-in-period coverage, billing-denial on-call log, behavioral + wiring test locks") in the same PR.

Why the pre-fix test suite was green despite the bug: through both pre-fix commits, the suite had exactly two `cancelled`-status cases:

- `sub({ status: 'cancelled' })` paired with a **valid** entitlement (`ent()`) — asserts `'active'`. This passes, but not because the fallthrough is correct: `entitledNow` is `true`, so the function returns `'active'` on the earlier `if (entitledNow) return 'active';` branch (`billing-state.ts:69`) — it never reaches the `cancelled` branch at all.
- `sub({ status: 'cancelled', currentPeriodEnd: NOW - DAY })` (past-period) paired with an **expired** entitlement — asserts `'lapsed'`. This is the one case that does exercise the fallthrough, and it happens to be correct, because the subscription is genuinely past its period.

No case in the original matrix paired `cancelled` **in-period** with a null or expired (not-yet-loaded / stale) entitlement snapshot — the exact combination the fallthrough mishandled. Every `cancelled`-status test either short-circuited before reaching the buggy line via the `entitledNow` guard, or landed in the one case where the buggy fallthrough happened to produce the right answer by coincidence. The happy-path/fully-loaded matrix was complete; the snapshot-not-yet-loaded matrix was not.

## Solution

Added an explicit in-period guard mirroring `isCoveringAt`'s `cancelled` branch, inserted immediately before the `lapsed` fallthrough (`src/services/billing-state.ts:76-77`):

```ts
if (sub.status === 'cancelled' && sub.currentPeriodEnd >= now) return 'active';
return 'lapsed';
```

(Note: `billing-state.ts` uses `>=` where the server's `isCoveringAt` uses strict `>` at `convex/payments/subscriptionHelpers.ts:243` — the client boundary is inclusive of the instant `currentPeriodEnd === now`, consistent with the rest of this function's other period-end checks, e.g. `billing-state.ts:73`'s `sub.currentPeriodEnd >= now` for the `active`-status branch. This is a deliberate, symmetric choice, not a mismatch to reconcile.)

The precedence docstring (`billing-state.ts:41-60`) was corrected at the same time — rule 5 now reads:

> `cancelled` still inside its paid window keeps coverage (`active`) even when the entitlement snapshot is late — mirrors `isCoveringAt` in `convex/payments/subscriptionHelpers.ts` ("cancelled-but-paid-through"). `cancelled` past the window and `expired` (never covering, same helper): provider-confirmed end of coverage — `lapsed`, not `free`, so copy can say "resubscribe".

This explicitly names `isCoveringAt` as the source of truth and separates `cancelled`'s conditional coverage from `expired`'s unconditional non-coverage — closing the docstring/code contradiction that api-contract review flagged.

Four new matrix cases were added to `tests/billing-state.test.mts` targeting exactly the previously-untested snapshot-not-yet-loaded combinations:

- `tests/billing-state.test.mts:139-141` — cancelled in-period + **null** entitlement → `active` ("cancelled-but-paid-through, never over-gate").
- `tests/billing-state.test.mts:143-148` — cancelled in-period + **expired** entitlement snapshot → `active` ("coverage runs to period end").
- `tests/billing-state.test.mts:150-155` — `expired` status with a **future** `currentPeriodEnd` + null entitlement → `lapsed` ("expired subscription never covers, even with a future period end (mirrors isCoveringAt)") — locking in that `expired` is unconditionally terminal, unlike `cancelled`.
- `tests/billing-state.test.mts:157-160` — an unrecognized/bogus status string → `lapsed` ("unknown runtime status strings stay locked-side (lapsed), never unlock") — locking the fail-closed default for any future status value the client doesn't recognize.

## Why This Works

The fix works because it stops re-deriving per-status coverage semantics from the status string's English connotation and instead copies the server's canonical rule verbatim. `isCoveringAt` (`convex/payments/subscriptionHelpers.ts:236-245`) is the single place the server decides what "covering" means per status; the client's job is to mirror it, not reinterpret it. `cancelled` *sounds* terminal — colloquially "I cancelled my subscription" reads as "it's over" — but the product semantics are "auto-renew is off, coverage continues until the period you already paid for ends." `expired`, by contrast, really is unconditional: `isCoveringAt` never returns `true` for it regardless of `currentPeriodEnd`. Collapsing both into one fallthrough branch was a plausible-looking simplification that was quietly wrong for one of the two statuses it covered.

The new tests work because they target the actual failure mode rather than re-testing the already-correct happy path. The original suite was complete for the case where both snapshots are fully loaded and agree; it had a blind spot for the case where one snapshot (the entitlement row) is missing or stale relative to the other (the subscription row) — which is precisely the situation this whole `deriveBillingUxState` function exists to handle gracefully (per its own top-of-file docstring, `billing-state.ts:1-17`: reconciling two independently-arriving reactive snapshots). A pure function whose entire purpose is reconciling out-of-sync inputs needs its test matrix built around the *out-of-sync* input combinations, not just the settled ones.

## Prevention

- **When a client-side function derives UX/display state from replicated data that a server also governs, treat the server's canonical helper as the spec, not inspiration.** If a helper like `isCoveringAt` already encodes per-status coverage rules, the client derivation should cite it in a docstring (as `billing-state.ts:41-60` now does) and structurally mirror its branches one-for-one — never re-derive coverage from a status string's plain-English connotation. "Cancelled" and "expired" are easy to mentally merge into "not active, so not covered"; only reading the authoritative helper's actual branches (not just its name) reveals that one is conditional and one isn't.
- **For any pure function that reconciles two independently-updating inputs (e.g. two separate Convex/GraphQL/subscription watches), the test matrix must explicitly include the "one input hasn't arrived yet / is stale" combinations for every status branch that can be reached before the fresher input lands** — not just the fully-loaded, mutually-consistent matrix. A matrix that only pairs each status with a "settled" partner value will look complete (every state is asserted "somewhere") while leaving the actual race-prone combinations — the reason the function exists — completely untested. Concretely: for every conditional-coverage status, add a case pairing it with a `null`/expired/not-yet-loaded partner snapshot, in addition to the case pairing it with a valid one.
- **A green test suite through implementation and a refactor/simplify pass is not evidence of correctness for logic a human intuitively "knows" the answer to** — this bug survived both because every test that could exercise the buggy line either short-circuited around it via an earlier `if` branch or coincidentally landed on the one input combination where the wrong logic produced the right output. Adversarial/multi-persona review (or, cheaper going forward, deliberately writing the "what if the other snapshot hasn't loaded yet" test cases *first*, before the happy-path ones) is what actually catches this class of bug — a single-author implementation-then-test pass tends to test the mental model it just used to write the code, reproducing the same blind spot on both sides.

## Related Issues

- Issue lineage (server-to-client hardening arc): #4765 (reconcile missed Dodo renewal webhooks) -> #4770 (on-demand Dodo re-check before hard denial; merged via PR #5447, transient-vs-confirmed refined in PR #5483) -> #4771 (surface explicit billing states in the UI; closed by PR #5494 - the PR whose pre-merge bug this doc records).
- Methodological neighbor: [test-guard-assertions-and-module-state-reset](../best-practices/test-guard-assertions-and-module-state-reset.md) - same class of testing lesson (a test that claims to cover a branch must actually reach that branch via genuinely distinct precondition combinations), stated there for JWT/session guards.
