---
title: "A bare boolean sent the recovery path to ambient state for its diagnosis — and `mint_failed` named a mint nobody attempted"
date: 2026-08-17
category: logic-errors
module: wm-session
problem_type: logic_error
component: authentication
severity: high
symptoms:
  - "Two of `ensureWmSession()`'s `false` returns — the already-dead short-circuit, and the `cookie_not_persisted` verdict where the mint had actually SUCCEEDED — were both reported to Sentry as `mint_failed`, the verdict that suppresses every anonymous API call for 15 minutes"
  - "`markWmSessionDead()` extends `sessionDeadUntil` by a fresh 15 minutes BEFORE its already-dead early return, so every request in flight when a blackout landed silently re-armed it"
  - "A suppressed call inherited the prior mint's transport cause from the module-scoped `lastMintFailureCause` and was filed as corroborating evidence, striking a bystander route for 15 minutes"
  - "`mint_cause` was tagged conditionally, so `no cause for this episode` and `tag dropped by an old client` shared one blank Sentry bucket"
  - "After making the tag unconditional, `mint_cause: none` was still FALSE in the modal burst shape — an all-mints-failed episode reported healthy mints"
root_cause: logic_error
resolution_type: code_fix
related_components: [tooling, testing_framework]
tags: [wm-session, anonymous-session, sentry, telemetry-provenance, ambient-state, discriminated-union, blackout-window, mint-cause, mutation-testing]
---

# A bare boolean sent the recovery path to ambient state for its diagnosis — and `mint_failed` named a mint nobody attempted

## Problem

`ensureWmSession()` returned `Promise<boolean>`. That answers "do I have a session?" but not the only question the fetch interceptor's recovery path actually needs answered — *did we ask the server, and what did it say?* So recovery read the cause from a module-scoped `lastMintFailureCause`, introduced by #6413, the very PR that added the `mint_cause` Sentry tag.

That variable is ambient. It holds whichever mint finished last, not the one belonging to this attempt, and it is `null` for every `false` that never reached a failing mint. In the current tree three paths return a non-`ok` attempt and only one of them is a failed mint (`src/services/wm-session.ts:676-716`):

- `attemptWmSession()`'s first line, `if (isWmSessionDead()) return { ok: false, kind: 'suppressed' }` (`src/services/wm-session.ts:677`) — the session is already blacked out, so no mint is attempted at all.
- `cookie_not_persisted` (`src/services/wm-session.ts:709-710`) — the mint **succeeded**; the browser then proved it will not keep the cookie, and `markWmSessionDead('cookie_not_persisted', ...)` has already recorded that verdict.
- the genuine failed mint (`src/services/wm-session.ts:697`).

Under the old shape all three collapsed to `false`, and recovery reported all three as `mint_failed` with whatever cause happened to be lying around. The module's response to `mint_failed` is not cheap: it returns a synthetic `503` with `X-Wm-Session-Degraded: 1` for **every** anonymous API call for `SESSION_DEAD_COOLDOWN_MS` — 15 minutes (`src/services/wm-session.ts:36`, `458-466`). Sentry issue `WORLDMONITOR-WG` counts those blackouts.

## Symptoms

Three distinct harms, each reachable from the same misreading.

**1. A suppressed call re-armed the blackout it was suppressed by.** `markWmSessionDead` pushes the deadline out *before* it checks whether an episode is already open (`src/services/wm-session.ts:310-320`):

```ts
const alreadyDead = isWmSessionDead();
sessionDeadUntil = Date.now() + SESSION_DEAD_COOLDOWN_MS;
if (!alreadyDead) sessionDeadReason = reason;
...
if (alreadyDead) return;
```

The early return suppresses the duplicate *capture*, not the extension. So every request that was still in flight when a blackout landed — the only requests that can reach recovery at all, since anything starting later short-circuits at `src/services/wm-session.ts:958` — reported a `mint_failed` that never happened and bought the user another full 15 minutes. Sentry showed one episode; the tab stayed dark for a multiple of the intended window.

**2. A bystander route was struck for a mint nobody attempted.** The suppressed call inherited the prior mints' transport cause, which is not a server verdict, so it took the corroboration branch and was filed as evidence (`src/services/wm-session.ts:447`). `recordRouteStrike` suppresses that route for `SESSION_DEAD_ROUTE_STRIKE_TTL_MS` (15 minutes, `src/services/wm-session.ts:63`) and adds it to the quorum evidence. Per-route suppression is deliberately silent, so the only local reader of that state is `getStruckRoutes()` (`src/services/wm-session.ts:197-199`) — the harm produces no report of its own.

**3. `mint_cause` was written conditionally**, so "this episode has no mint cause" and "the tag was dropped by an old client" landed in the same blank Sentry bucket and could not be told apart.

## What Didn't Work

**Reading the issue's headline ratio.** The issue reported `mint_cause` absent on 99.2% of `mint_failed` events. The ratio is real and it is also **pre-tag history**: the tag shipped in #6413 on 2026-08-10, and WG's 645 lifetime `mint_failed` events are dominated by a 2026-07-20 → 07-27 spike that predates it. Restricted to the post-deploy window there were 7 such events, 5 of them carrying a cause. The 2 without carry a breadcrumb whose `data` is byte-identical to the pre-#6413 shape (`{route, blocked, reason}` — compare the current `src/services/wm-session.ts:365-370`, which also writes `mint_cause`), from an Electron desktop build and from a bundle predating even #5674.

The `release` tag is `worldmonitor@2.10.0` on every one of those events, so it cannot separate an old bundle from a new one; the breadcrumb payload *shape* was the only working version discriminator. Net result: **no production event proved the shipped code emitted a causeless `mint_failed`.** The defect is real by code reading and proven by test, but it was latent — the fix is correctness work, not an incident response, and saying so is part of the finding.

**Making the tag unconditional, and stopping there.** The obvious fix is `cause ?? 'none'`. Adversarial review found that this is *worse than the blank it replaces* in the modal WG shape — a dashboard boot burst over a flaky transport:

1. The recovery leader's mint fails (`network`) and records strike #1. One route is below `SESSION_DEAD_ROUTE_QUORUM` (`src/services/wm-session.ts:49`), so no blackout.
2. The followers replay carrying **no cookie** — none was ever minted — via the follower branch at `src/services/wm-session.ts:1121-1132`. Their 401s are guaranteed rather than evidential.
3. The first of those tips the quorum, with a `retry_401` verdict that has no cause of its own.

An episode caused entirely by failed mints came out tagged `mint_cause: none`, with `route` pointing at a bystander panel. A blank tag reads as "unknown" — a truthful non-claim. `none` asserts the mints were healthy. Turning a silence into a claim means the claim has to be earned.

**Two of the new tests were vacuous, and three independent reviewers caught one of them.** Asserting the tags alone cannot prove the `cookie_not_persisted` guard works: `markWmSessionDead`'s already-dead early return swallows the second capture, and one route cannot reach the quorum, so every tag assertion stays green with the guard deleted. See Prevention for what replaced them.

**The ambient variable was never a considered tradeoff (session history).** The transcript of the #6413 session shows the module-scoped `lastMintFailureCause` was added as a quick follow-on edit immediately after the behavioural core of that fix ("thread the cause onto the Sentry tag so WG becomes diagnosable"). There is no discussion of threading the cause through a return value instead, and none of the two paths — a failed mint versus `ensureWmSession()`'s early `isWmSessionDead()` return — needing to agree on what "cause" means. The design was incidental, not evaluated and chosen.

That matters because #6413 was not a careless change. That same session ran an 8-mutant mutation sweep (all eventually killed, and it caught a real gap — no test for the `malformed` branch) and a fresh-eyes review that found a stale docblock contradicting the new behaviour. Neither surfaced this bug, because "the return value disagrees with module-scoped truth" was not in the mutant set. A mutation sweep only tests the hypotheses you encode as mutants.

## Solution

PR #6809 (merged 2026-08-17), all in `src/services/wm-session.ts`.

**1. Make the verdict inseparable from the result.** An internal `attemptWmSession()` returns a discriminated union (`src/services/wm-session.ts:640-654`):

```ts
type SessionAttempt =
  | { ok: true }
  | { ok: false; kind: 'suppressed' }
  | { ok: false; kind: 'cookie_not_persisted' }
  | { ok: false; kind: 'mint_failed'; cause: MintFailureCause };
```

Only one arm carries a cause, and it is the only arm the reporter accepts (`src/services/wm-session.ts:1096-1098`):

```ts
if (attempt.kind === 'mint_failed' && isCurrentSessionIdentity()) {
  noteRecoveryFailure({ reason: 'mint_failed', cause: attempt.cause }, path);
}
```

`noteRecoveryFailure` takes the same shape rather than a loose `(reason, cause)` pair (`src/services/wm-session.ts:411-413`), so a caller cannot hand it a category without the evidence for it. `lastMintFailureCause` and its `fetchNewSession` wrapper are **deleted** — a stale cause is no longer representable. The public surface is unchanged: `ensureWmSession(): Promise<boolean>` is a two-line adapter (`src/services/wm-session.ts:718-720`).

**2. State the blackout gate positively.** It was `!mintCauseIsTransport(cause)`. It is now (`src/services/wm-session.ts:566-568`):

```ts
function mintCauseIsServerVerdict(cause: MintFailureCause | null): boolean {
  return cause === 'refused' || cause === 'malformed';
}
```

Same two values today, opposite default tomorrow. The negative spelling made every value the taxonomy did not yet name — a missing cause, and now `unknown` — fall through to the most expensive verdict the client can reach.

**3. Name the client-side throw.** A new `unknown` cause (`src/services/wm-session.ts:537`) covers an attempt that threw. It is not a server verdict, so it takes the corroboration route instead of blacking out the tab, and it is not retried, because we cannot say what would be retried. This is a live path, not a defensive floor: `new AbortController()` and the timeout `setTimeout` sit *outside* `mintSession`'s `try` (`src/services/wm-session.ts:580-589`) and `markWmSessionDead`'s `new CustomEvent(...)` is unguarded (`src/services/wm-session.ts:382-384`) — all three on exactly the old WebView / Smart-TV engines the `AbortSignal.timeout` comment names. `unknown` alone tells on-call nothing, so the exception rides along (`src/services/wm-session.ts:671-674`):

```ts
function reportUnknownMintThrow(error: unknown): SessionAttempt {
  try { sentryEnqueue((s) => s.captureException(error)); } catch { /* best-effort telemetry */ }
  return SESSION_ATTEMPT_THREW;
}
```

**4. Emit `mint_cause` unconditionally** (`src/services/wm-session.ts:358`), `const mintCause: MintCauseTag = cause ?? 'none'`, on both the tag set and the breadcrumb (`src/services/wm-session.ts:359-370`). A blank now means exactly one thing: a client too old to carry it.

**5. Carry the cause with the corroboration evidence, so `none` is earned.** This is the correction that came out of review finding the modal shape above. `recentRouteFailures` became `Map<string, { at: number; cause: MintFailureCause | null }>` (`src/services/wm-session.ts:132`), written by `recordRouteStrike(rawPath, cause)` (`src/services/wm-session.ts:225`), and the tipping verdict no longer speaks for the episode alone (`src/services/wm-session.ts:249-256`):

```ts
function episodeMintCause(tippingCause: MintFailureCause | null): MintFailureCause | null {
  if (tippingCause) return tippingCause;
  let latest: { at: number; cause: MintFailureCause | null } | null = null;
  for (const seen of recentRouteFailures.values()) {
    if (seen.cause && (latest === null || seen.at > latest.at)) latest = seen;
  }
  return latest?.cause ?? null;
}
```

The burst above now reports `mint_cause: network`. Crucially, this is **not** the ambient state the same PR removed: `recentRouteFailures` is bounded by `SESSION_DEAD_CORROBORATION_MS` (60 s, `src/services/wm-session.ts:58`), cleared by any success via `noteRouteSuccess` (`src/services/wm-session.ts:271`), and cleared by the blackout itself (`src/services/wm-session.ts:318`). It is episode-scoped evidence with an expiry, not a last-value global with none.

## Why This Works

The old code had to answer "which failure was this?" from a variable that no longer belonged to the failure. Three sources of truth existed — the boolean, the module-scoped cause, and the verdict `markWmSessionDead` had already written — and nothing tied them together. The union collapses them into one value that is produced and consumed in the same call chain, so the two states that were never mint failures cannot be described as mint failures: `suppressed` and `cookie_not_persisted` have no `cause` field to read.

That fixes all three harms at the root rather than one at a time. `suppressed` never reaches `noteRecoveryFailure`, so it neither re-arms `sessionDeadUntil` nor strikes the route that happened to be in flight. `cookie_not_persisted` keeps the verdict `markWmSessionDead` already recorded — which matters beyond telemetry, because `describeWmSessionDegradation` (`src/services/wm-session-copy.ts:32-40`) shows a different remedy per reason, and `cookie_not_persisted` is the *only* one of the three where checking cookie settings is the right advice.

The `none`/absent distinction survives only because step 5 makes `none` a claim the module can defend. `none` means "no mint failed anywhere in this 60-second episode"; a blank means an old client. If the tag had shipped unconditional but uncorroborated, `none` would have been false in precisely the shape WG is mostly made of — the one query a triager would run first.

## Prevention

**A `false` that has to be interpreted is a `false` that will be interpreted wrongly.** When a caller must know *why* an operation failed, return the reason in the same value. Reaching for module-scoped state to recover it re-introduces the ambiguity the boolean created, and adds a fresh one: the state belongs to whichever call finished last. The type is the guardrail — `{ ok: false; kind: 'suppressed' }` has no `cause` to misread.

**Prefer the positive spelling for a gate that authorizes an expensive action.** `!isTransport(cause)` and `isServerVerdict(cause)` agree on every value the enum names today and disagree on every value added tomorrow. The negation defaults new states to the most expensive verdict, silently, at the next enum widening — which in this module is a 15-minute blackout of every anonymous panel.

**Making a silent field explicit is a new claim; check the modal case before shipping it.** `mint_cause: none` is strictly worse than a blank tag if `none` can be false, because a blank reads as "unknown" and `none` reads as "the mints were fine". Before converting an absence into an assertion, walk the *most common* production shape — not the simplest one — and confirm the assertion holds there. Here the tipping verdict was systematically the one *without* a cause, which is the opposite of the intuition that motivated the change.

**Check a tag's ship date before reading its absence rate.** A "99.2% missing" ratio over an issue's lifetime says nothing if the tag shipped in the last week of that lifetime. When `release` is constant across every event (it was `worldmonitor@2.10.0` here), the payload *shape* of a breadcrumb or context object is a usable version discriminator where the version tag is not.

**Find observables with teeth, then prove each test red for its own reason.** Two of these tests initially could not fail. The fix was to attack the guard, not the assertion:

- **Advance a stubbed `Date.now` inside the Sentry capture sink.** `onCapture` runs synchronously inside `markWmSessionDead`, after `sessionDeadUntil` has been pushed out and before the function returns — the only seam between one verdict and the next. Without it both verdicts land on the same millisecond and a second, redundant verdict extends the cooldown by exactly zero, making the re-arming bug invisible (`tests/wm-session-auto-refresh.test.mts:2037-2062`, armed at `:2749`, cashed at `:2772-2777`).
- **Assert the exported `getStruckRoutes()`.** A bystander strike produces no capture of its own, so the tag assertions cannot see it (`tests/wm-session-auto-refresh.test.mts:2680-2684` and `:2783-2787`).

Then verify by **copying the pre-fix file back over the source** (a file copy — never `git checkout`, which would take the tests with it) and confirming each test fails on the assertion it is *named* for, not on an unrelated one. A test that goes red for the wrong reason is still a test that will not catch the regression it was written for.

**Test the burst, not the single request.** The bug that survived the first draft of this fix only appears with two concurrent callers, because it depends on the follower replay path (`src/services/wm-session.ts:1121-1132`) tipping a quorum the leader could not. `tests/wm-session-auto-refresh.test.mts:2870-2909` drives it with a `Promise.all` of two routes (`:2893-2896`); a sequential version of the same scenario passes while the tag is wrong.

**Mutate the state-shape, not just the branch conditions.** #6413 shipped with a passing 8-mutant sweep. Every mutant flipped a condition or a constant; none replaced a return value with a stale module-scoped read, which is exactly the defect that survived. When a function's callers must infer something the return type does not carry, add that inference to the mutant set explicitly — flip the ambient variable to a stale value and see whether any test notices.

## Related

- #6804 (this issue), PR #6809 — merged 2026-08-17
- #6413 — added the `mint_cause` tag and the `lastMintFailureCause` global this removes; also the transport-vs-server-verdict split
- #5674 / #5677 — [one route's 401 declared the whole anonymous session dead](one-route-401-declared-the-whole-anon-session-dead.md), the direct ancestor: the route quorum, the `route` tag, and the two-store suppression/evidence split this builds on
- #5245 — the WG telemetry itself; #5219 / #5251 — the original 15-minute cooldown
- `tests/wm-session-auto-refresh.test.mts` — `describe('wm-session mint cause provenance (#6804)')` at `:2568`
