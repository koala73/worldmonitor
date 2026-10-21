---
title: A re-emission cooldown keyed on time since last emission drops a genuine escalation instead of deferring it
date: 2026-08-30
category: logic-errors
module: physical-divergence
problem_type: logic_error
component: service_object
severity: high
root_cause: logic_error
resolution_type: code_fix
symptoms:
  - "normal->elevated emits at T0; elevated->stressed 30h later, still inside the 48h cooldown, is silently suppressed"
  - "once the cooldown clears at T0+54h the published snapshot already reads stressed, so previous.regime === next.regime and the escalation never fires -- it is lost, not deferred"
  - "the same-regime guard ran before the cooldown check, so the guard only ever saw a genuinely new change and the bug read as correct in code review"
  - "a suppression test asserted only that suppression happened, with no positive control at the escalation boundary, so it could not have caught the drop"
tags:
  - "cooldown"
  - "re-emission"
  - "regime-transition"
  - "flap-damping"
  - "alerting"
  - "market-signals"
  - "positive-control"
  - "state-vs-time"
related_components:
  - "background_job"
  - "testing_framework"
---
## Context

A cooldown on an alert or signal emitter is supposed to answer one question: *have we already told
someone this?* There are two ways to encode that question, and they are not equivalent.

- **Time-keyed:** "suppress if we emitted anything within the last N." The record you persist is a
  timestamp.
- **State-keyed:** "suppress if the thing we are about to say matches what we last said." The record
  you persist is the *content* of the last emission, and the timer only decides how long that
  content stays authoritative.

Time-keyed is the shorter code and it is what most cooldowns get written as first. It is safe only
under one assumption: that a suppressed candidate will still be there, unchanged, on the next run —
so suppression *defers*. The moment your "what changed?" comparison reads from a store that advances
even on suppressed runs, that assumption breaks and suppression silently becomes *deletion*.

WorldMonitor hit this in the physical-premium regime emitter shipped in PR #7400. The classifier
compares the newly computed reading against the last **published** snapshot, and the seeder publishes
that snapshot on every run whether or not a transition was emitted — the publish at
`scripts/seed-physical-premiums.mjs:504` is unconditional, and the "previous" side of the comparison
is a `GET` of that same published key at `scripts/seed-physical-premiums.mjs:477`, resolved per metal
at `scripts/seed-physical-premiums.mjs:300`.

The pre-fix guard (do not look for it at the tree — the fix is merged, and PR #7400 was
squash-merged, so the pre-fix revision is not reachable from `main`) read:

```js
// PRE-FIX — superseded by PR #7400
if (previous.metal !== next.metal || previous.regime === next.regime) return null;
if (finite(lastEmittedAtMs) && nowMs - lastEmittedAtMs < TRANSITION_COOLDOWN_MS) return null;
```

Two facts about that pair combine badly:

1. **The same-regime guard runs first.** It still does, at
   `scripts/lib/physical-divergence.mjs:330`. Anything reaching the cooldown has already been proven
   to be a *different* regime than the last published one. A literal repeat of the same transition is
   structurally impossible at that point — so the time gate could only ever fire on a genuinely new
   regime change, which is exactly the thing it must not eat.
2. **The comparison baseline advances on suppressed runs.** `previous.regime` is whatever was last
   published, not whatever was last announced.

The window is 48 hours (`TRANSITION_COOLDOWN_MS`, `scripts/lib/physical-divergence.mjs:12`), so:

| Time | Regime move | Pre-fix outcome | Published snapshot after the run |
|---|---|---|---|
| T0 | `normal` -> `elevated` | emitted | `elevated` |
| T0+30h | `elevated` -> `stressed` | suppressed (inside 48h) | **`stressed`** |
| T0+54h | — | `previous.regime === next.regime === 'stressed'`, guard returns `null` | `stressed` |

The escalation to `stressed` is never signalled. Not late — **gone**. And there is no downstream
recovery: the consumer reads only the emitted array, `payload?.transitions` at
`scripts/seed-cross-source-signals.mjs:989`, iterated at `scripts/seed-cross-source-signals.mjs:992`.
Nothing downstream ever looks at the regime field to notice it missed a step.

## Guidance

**Key a re-emission cooldown on the state you last emitted, not on the time since you last emitted.
Persist that state in the cooldown record. Inside the window, allow an escalation beyond it.**

Four concrete rules for designing one:

**1. The cooldown record stores content, not just a clock.** In WorldMonitor the record is written as
`{ emittedAt, transitionId, toRegime }` at `scripts/seed-physical-premiums.mjs:423`, and — critically
— it is written only for transitions that actually emitted, since `cooldownWrites` maps over
`snapshot.transitions` at `scripts/seed-physical-premiums.mjs:419`. That is what makes it a record of
what was *announced* rather than of what was *computed*. It is read back at
`scripts/seed-physical-premiums.mjs:319` and fed in as two separate inputs — `lastEmittedAtMs` from
`emittedAt` and `lastEmittedRegime` from `toRegime` (`scripts/seed-physical-premiums.mjs:305` and
`scripts/seed-physical-premiums.mjs:306`).

**2. Rank your states, and let a rank increase override the timer.** The shipped guard
(`scripts/lib/physical-divergence.mjs:344` through `scripts/lib/physical-divergence.mjs:349`):

```js
const withinCooldown = finite(lastEmittedAtMs) && nowMs - lastEmittedAtMs < TRANSITION_COOLDOWN_MS;
const lastRank = REGIME_RANK[lastEmittedRegime];
const suppressed = withinCooldown
  && finite(lastRank)
  && REGIME_RANK[next.regime] <= lastRank;
if (suppressed) return null;
```

`REGIME_RANK` is `{ normal: 0, elevated: 1, stressed: 2, extreme: 3 }`
(`scripts/lib/physical-divergence.mjs:25`). Read the `<=` carefully: repeats (equal rank) and
de-escalations (lower rank) wait for the window; anything strictly worse than what was announced goes
out immediately. The window still throttles noise — it just cannot throttle news.

**3. Make an absent or unrecognized record fail *open*.** `finite(lastRank)` is a suppression
*precondition*, not a fallback. A record written before `toRegime` existed reads back as `null`
(`scripts/seed-physical-premiums.mjs:326`), which yields an undefined rank and therefore no
suppression. A cooldown that cannot prove it already said something must say it. Defaulting an
unknown last-state to rank 0 would have inverted this and suppressed on the exact rollout window
where you have the least information.

**4. Test the boundary with a positive control.** A suppression test that only ever asserts `null`
cannot fail — see *Why This Matters*.

## Why This Matters

**A dropped escalation is invisible by construction.** Suppression produces no error, no log line
distinguishable from a healthy quiet period, and no downstream artifact. The failure signature is the
*absence* of an event nobody knows to expect. It is not caught by monitoring, and it is not caught by
a test suite that only ever asks "did we stay quiet?"

That second half is the independently reusable half of this learning.

**A suppression test that only ever asserts suppression cannot fail.** The pre-fix test in
`tests/physical-divergence-classifier.test.mjs` passed a finite `lastEmittedAtMs` with a 24h gap and
asserted `null`. Every other case in that test passed `lastEmittedAtMs: null`. Add those up: **no
test anywhere passed a finite, fully-elapsed `lastEmittedAtMs` and expected a transition back.** A
guard mutated to the maximally broken form —

```js
if (finite(lastEmittedAtMs)) return null;   // suppress forever
```

— satisfies every assertion in the suite. Green. The suite measured that the guard *can* suppress,
never that it ever *stops*.

The missing piece is a **positive control at the boundary**: one case that crosses the window and
demands the emission back. The current test has both halves, and the comment at
`tests/physical-divergence-classifier.test.mjs:376` names the mutant it exists to kill:

- `justInsideCooldown` at `NOW_MS + TRANSITION_COOLDOWN_MS - 1` asserts `null`
  (`tests/physical-divergence-classifier.test.mjs:386`) — the negative control.
- `afterCooldown` at exactly `NOW_MS + TRANSITION_COOLDOWN_MS` asserts the transition returns
  (`tests/physical-divergence-classifier.test.mjs:379`) — the positive control.

One without the other is half a test. The pair also pins the boundary's inclusivity, which a single
24h-gap assertion leaves entirely unspecified.

This generalizes past cooldowns to every guard whose job is to *not* do something: rate limiters,
dedup caches, circuit breakers, debounce, feature gates. Assert the suppression **and** the release,
or the suppression assertion is decoration.

## When to Apply

Reach for the state-keyed model whenever **any** of these hold:

- **The "has it changed?" baseline advances independently of emission.** A published snapshot, a
  `lastSeen` row, a cache written every tick. This is the specific trap: your change-detector and
  your suppressor disagree about what "last" means. If the same store feeds both, you are safe; if
  not, a time-only cooldown deletes.
- **The suppressed candidate is not retried verbatim.** Deferral requires that the thing comes back.
  A regime *change* is an edge, and edges do not come back — once both sides of the comparison have
  moved on, the edge is unrecoverable.
- **The states are ordered.** Severity, tier, regime, health level. Ordering is what lets you write a
  precise re-allow rule instead of choosing between "always noisy" and "sometimes silent".
- **No downstream consumer can reconstruct the missed transition.** Verify this rather than assume
  it. Here it was checkable in one read: `scripts/seed-cross-source-signals.mjs:989` takes the
  emitted array and nothing else.

A plain time gate is fine when the candidate is genuinely identical and genuinely persistent — the
same alert still firing, the same row still stale. The tell for that case is that the suppressed
candidate would re-present unchanged on the next run with no external state having moved.

**Design checklist:**

1. What does the cooldown record contain? If it is only a timestamp, ask what happens when the input
   changes mid-window.
2. Is the record written on emission, or on evaluation? It must be on emission.
3. Which transitions bypass the window? Name them explicitly — an empty answer is a bug, not a
   simplification.
4. What happens when the record is absent or from an older schema? It should fail open.
5. Does a test cross the boundary and demand the emission back?

## Examples

### In-repo precedent: `scripts/lib/digest-cooldown-decision.mjs`

This module predates the physical-divergence bug and already encodes the correct model — the fix was
not an invention, it was a failure to look next door first.

- It suppresses against **persisted last-delivered state**, not just a clock: `lastDeliveredAt`,
  `lastDeliveredSourceCount`, `lastDeliveredTier`, resolved from a single key
  (`scripts/lib/digest-cooldown-decision.mjs:6`).
- Its cooldown table has an explicit **"Re-allow trigger"** column per class — the header at
  `scripts/lib/digest-cooldown-decision.mjs:19` — so "what gets through the window" is a first-class
  design output rather than an afterthought. Floors range from 4h (developing kinetic) to 7d
  (analysis).
- It states the universal-escalation rule outright at
  `scripts/lib/digest-cooldown-decision.mjs:32`: *"Severity-tier change is a universal allow trigger
  across all classes EXCEPT the hard-floor ones"*, with the hard-floor marker defined at
  `scripts/lib/digest-cooldown-decision.mjs:28`.
- Mechanically: past the floor it always allows (`scripts/lib/digest-cooldown-decision.mjs:382`);
  inside it, tier rank is compared against the persisted `lastDeliveredTier`
  (`scripts/lib/digest-cooldown-decision.mjs:371`) and evaluated **first** — *"Order of precedence:
  tier change -> source count -> suppress"* (`scripts/lib/digest-cooldown-decision.mjs:394`).

**Honest limit:** this ships in **shadow mode** for Sprint 1 — the decision is logged and never gates
a send (`scripts/lib/digest-cooldown-decision.mjs:6`). It is encoded design, not yet enforcing
behavior. Cite it as the house pattern; do not cite it as production-proven.

### The shipped physical-divergence rule

`createPhysicalPremiumTransition` (`scripts/lib/physical-divergence.mjs:320`) takes
`lastEmittedRegime` as a parameter alongside `lastEmittedAtMs`
(`scripts/lib/physical-divergence.mjs:325`), and the emitted record carries `toRegime`
(`scripts/lib/physical-divergence.mjs:354`) — which is precisely what the next run's cooldown record
is keyed on. The behavior matrix the tests pin:

| Case | Window | Rank vs. last emitted | Result | Test |
|---|---|---|---|---|
| Repeat of announced transition | inside | equal | suppressed | `tests/physical-divergence-classifier.test.mjs:350` |
| De-escalation | inside | lower | suppressed | `tests/physical-divergence-classifier.test.mjs:358` |
| Escalation beyond announced | inside | higher | **emitted** | `tests/physical-divergence-classifier.test.mjs:369` |
| Repeat, window elapsed | outside | equal | emitted | `tests/physical-divergence-classifier.test.mjs:379` |
| Repeat, 1ms before elapse | inside | equal | suppressed | `tests/physical-divergence-classifier.test.mjs:386` |

### External anchors

These are convergent industry practice, not repo facts — attributed, not asserted.

- **Prometheus Alertmanager.** Its `repeat_interval` documentation states verbatim: *"Notifications
  are not repeated if any new alerts have fired or any firing alerts have resolved since the last
  group_interval."* The timer governs *repetition of an unchanged notification*; a change in the
  alert set is evaluated against the last notified **state**, and gets through. Grafana's
  Alertmanager documentation restates the same behavior independently.
- **Deferral, never deletion.** `group_wait` (wait before the first notification for a new group),
  `group_interval` (wait before subsequent notifications for an existing group), and Prometheus's
  `for` clause all delay an evaluation — the pending condition is re-evaluated and still fires. None
  of them can consume a state change.
- **PagerDuty** deduplicates on `dedup_key` identity: an event with a new key always opens a new
  incident regardless of timing. Identity, not elapsed time, is the suppression axis.
- **RFC 2439** (BGP route flap damping) is deliberately asymmetric — penalties accumulate on
  withdrawal, and the RFC notes that for routes with a stable history transitions "should be made
  quickly". Damping is tuned to punish flapping, not to slow a first real change.

**The honest limit:** no source declares "a cooldown must not drop an escalation" as a normative
MUST. There is no RFC to cite. It is convergent design across five mature systems — four external and
one in this repo — and that is the strength of the claim: strong evidence, not a citable rule.
