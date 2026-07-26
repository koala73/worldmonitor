---
title: A denied push permission rendered as a retryable failure, making "Try again" a permanent dead end
date: 2026-07-25
category: logic-errors
module: pro-activation
problem_type: logic_error
component: frontend_stimulus
severity: high
symptoms:
  - "Activation wizard's alerts step showed \"DIDN'T WORK — Try again\" when notifications were blocked at the browser level"
  - "Clicking \"Try again\" failed identically every time — browsers never re-prompt once Notification.permission is denied"
  - "The wizard already had a correct blocked state with site-settings instructions, but it only rendered when permission was denied at mount"
root_cause: logic_error
resolution_type: code_fix
related_components: [authentication, testing_framework]
tags: [activation, onboarding, push-notifications, permissions, terminal-vs-transient, retry-dead-end, telemetry-collapse, test-harness-vacuity, mutation-testing]
---

# A denied push permission rendered as a retryable failure, making "Try again" a permanent dead end

## Problem

The Pro post-checkout activation wizard offers a "real-time alerts" step that
requests browser notification permission. When `Notification.requestPermission()`
resolved `denied`, the step fell into the wizard's generic failure state:
**"DIDN'T WORK — Try again"**. Browsers never re-prompt once permission is
`denied`, so that button was guaranteed to fail identically forever — the user's
only escape was abandoning the step.

Surfaced during the live purchase repro in #5600, filed as #5609, fixed in PR
#5615.

## Symptoms

- The alerts step showed the failed badge and an error note, with the primary
  CTA relabelled to "Try again".
- Every retry produced the same failure, with no new browser prompt.
- The wizard *already had* the right UI — a blocked state carrying the
  browser's own remedy ("turn them on in your browser's site settings") — but
  it only rendered when permission was already `denied` when the flow opened.

## What Didn't Work

**Reaching for the error message.** `subscribeToPush()` throws a
denial-specific string (`'Notifications are blocked. Enable them in your
browser settings to continue.'`, `src/services/push-notifications.ts:139`), so
the obvious classification is to match on it. Rejected: error strings are
incidental. They get reworded, localized, or wrapped, and the classification
silently degrades to the buggy behavior with no test failing. The permission
state itself is the authoritative signal and is already exposed.

**Widening the existing `failed` state instead of adding a state.** Making the
failed state conditionally hide its retry button would have left `failed`
meaning two different things depending on a flag, and left the outcome recorded
as a failure — which the exit summary renders as "we couldn't set this up", the
wrong sentence for something the browser refused and we never attempted.

## Solution

**1. Give the result union a way to say "do not retry."** The confirm handler
returned a binary `'verified' | 'failed'`, and `failed` implicitly promises a
retry is worth taking. A third member carries the distinction
(`src/components/ProActivationInterstitial.ts:80`):

```ts
export type ActivationConfirmResult = 'verified' | 'failed' | 'blocked';
```

**2. Classify from live platform state, not the thrown error.** After
`subscribeToPush()` rejects, re-read the permission
(`src/components/ProActivationInterstitial.ts:1171`):

```ts
} catch (err) {
  console.warn('[pro-activation] push subscribe declined/failed', err);
  // Read the LIVE permission rather than the thrown message: once it is
  // `denied` no browser re-prompts, so the step is blocked, not retryable.
  // A dismissed prompt leaves it `default` and stays a retryable failure.
  return getPushPermission() === 'denied' ? 'blocked' : 'failed';
}
```

This also preserves the *correct* retry: a user who dismisses the prompt
without choosing leaves permission at `default`, the browser will ask again,
and "Try again" still means something.

**3. Fold the runtime override into a single state accessor.** The blocked UI
already existed but every render path read the step's declared `step.state`.
Rather than adding parallel branches, one accessor merges the mid-flow block
into that state, and *all* reads go through it:

```ts
const blockedByConfirm = new Set<ActivationStepId>();

const effectiveState = (step: ActivationStep): ActivationStepState =>
  blockedByConfirm.has(step.id) ? 'blocked' : step.state;
```

A mid-flow block then renders through the exact path a mount-blocked step
already used — blocked badge, site-settings note, a single "Continue", no retry
CTA — with no second implementation to drift.

**4. Keep the outcome honest, and replace the signal it costs.** A blocked step
resolves as `skipped`, not `failed`, so the summary does not claim a failure.
But `skipped` is also what a user who simply clicked "Skip for now" produces, so
the denial cohort would have vanished into voluntary skips. A distinct funnel
event keeps them separable (`src/services/pro-activation-state.ts:900`):

```ts
stepBlocked: 'pro-activation-step-blocked',
```

## Why This Works

The root cause is a **terminal state modelled as a transient one**. `failed`
encodes "this attempt did not work"; the retry affordance is downstream of that
meaning. A browser permission denial is not a failed attempt — it is a standing
refusal that no amount of retrying inside the page can lift, and whose remedy
lives outside the app entirely. Once the result vocabulary can express that, the
right UI was already written.

Reading `getPushPermission()` rather than the error text works because the
permission is the thing that actually determines whether a retry can succeed.
The spec commits `Notification.permission` before `requestPermission()`'s
promise settles, so the read is accurate at the moment of the catch. If some
engine violated that, the read returns a stale `default` and the code falls back
to today's retryable behavior — it fails safe.

## Prevention

**Ask "can a retry ever succeed?" before rendering a retry.** Any failure path
that surfaces a retry CTA needs an answer. Where the failure comes from a
platform permission, a hard quota, a revoked grant, or a policy block, the
answer is no, and the UI owes the user the *out-of-app* remedy instead. This is
the mirror of a bug already documented in this repo — see
[billing-state-cancelled-but-paid-through-misclassified-as-lapsed](./billing-state-cancelled-but-paid-through-misclassified-as-lapsed.md),
where a state that merely *sounded* terminal was treated as terminal. Both come
from inferring terminal-vs-transient from a proxy (a status word, an error
string) instead of reading the authoritative live signal.

**When a state becomes reachable at a new time, funnel every read through one
accessor.** The blocked state was previously only reachable at mount, so reads
of `step.state` were safe. Making it reachable mid-flow turned each direct read
into a latent bug. Two reviewers independently found two reads that had not been
migrated — inert at the time, because both only branched on `already-done`, but
they would have failed silently the moment either branched on `blocked`. Grep
for the raw field after introducing an override and migrate all of them.

**When a fix reclassifies an outcome into an existing bucket, check what signal
that erases.** Moving denials from `failed` to `skipped` was right for the user
and quietly destroyed the ability to size the denial cohort — a browser refusal
would have read as disinterest in the funnel. Adding an event was ~6 lines. The
durable Convex record still collapses the two (`skippedSteps` with no marker),
tracked as #5617.

**A test DOM whose `innerHTML` getter replays the assigned string will go
vacuous.** The unit harness for this fix parses assigned `innerHTML` so the
component's `querySelector` wiring works. Its getter originally returned the raw
assigned string, which is sound only while nothing mutates the subtree after
render — and this component *already* mutates post-render elsewhere (the brief
step's preview swap). The moment coverage extends there, `assert.doesNotMatch`
starts passing because nothing was parsed rather than because the thing is
absent: green while red. Serialize the live tree instead:

```ts
class ParsingElement extends MiniElement {
  override get innerHTML(): string {
    return this.childNodes.map((child) => serializeNode(child as MiniElement | MiniText)).join('');
  }
  override set innerHTML(value: string) { /* parse into childNodes */ }
}
```

The serializer must be attribute-faithful — `MiniElement`'s own `outerHTML`
drops attributes, which would break every `data-action="..."` assertion.

**Prove the guard with a mutation, not a passing run.** Both regressions here
were confirmed by breaking the code and watching exactly one test go red:
disabling the `blocked` branch reddens the e2e; making `finalizeAndShowSummary`
record blocked steps as `failed` reddens the Escape-while-blocked unit test. A
test that has never been observed failing has not been shown to test anything.

## Related

- #5609 — the issue (closed by PR #5615)
- #5600 — the P0 live purchase repro that surfaced it
- #5617 — open follow-up: the durable Convex record still cannot distinguish a
  blocked step from a voluntary skip
- PR #5534 — the origin feature that introduced the wizard and its mount-time
  blocked state
- #5608 — same theme in a different subsystem: premium panels rendering a 403
  as a terminal "upgrade" prompt when the client's own entitlement says Pro
