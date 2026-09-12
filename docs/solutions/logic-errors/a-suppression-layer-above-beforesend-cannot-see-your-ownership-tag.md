---
title: "A suppression layer above beforeSend cannot see your ownership tag — zero-frame checkout timeouts were dropped twice over"
date: 2026-09-12
category: logic-errors
module: Sentry error filtering
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "WORLDMONITOR-Q4 (`Checkout error: service_unavailable`) showed 20 lifetime events / 15 users, but the count was an undercount: every checkout TIMEOUT produced no Sentry event at all"
  - "A 2026-09-12 production breadcrumb logged `[checkout] service_unavailable signal timed out` three minutes before the event that did arrive, and no Sentry issue anywhere held that timeout"
  - "After tagging the capture and exempting the tag in beforeSend, Safari timeouts were still silently dropped — the fix worked on Chromium only"
  - "Of the 15 identifiable users who hit a terminal checkout failure, zero are on a paid plan today (checked against Convex entitlements)"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - development_workflow
  - testing_framework
tags:
  - sentry
  - before-send
  - ignore-errors
  - zero-frame
  - abort-signal
  - checkout
  - payments
  - webkit
  - regression-testing
---

# A suppression layer above beforeSend cannot see your ownership tag

## Problem

Checkout timeouts on the WorldMonitor dashboard were captured by first-party code and then silently discarded by Sentry noise filtering, so a terminal, revenue-losing failure produced no event. Fixing the visible layer restored Chromium only; a second suppression layer sitting *above* it kept dropping the same failure on WebKit.

## Symptoms

- `reportCheckoutError` demonstrably ran in production (its console breadcrumb is in the event's own breadcrumb trail) and no corresponding Sentry issue existed.
- The issue's event count understated the real failure rate, so triage kept re-deriving impact from a biased sample.
- After the first fix, WebKit remained silent with nothing red in CI.

## What Didn't Work

**Reasoning about the capture site.** The capture call, its tags, and its payload were all correct. Reading `src/services/checkout.ts` explains nothing, because the event is discarded two layers later.

**Assuming the SDK synthesizes a stack.** A Chromium probe settled it — `AbortSignal.timeout` rejects with a DOMException whose `stack` is the header line alone:

```json
{ "name": "TimeoutError", "message": "signal timed out",
  "isError": true, "ctor": "DOMException",
  "stack": "TimeoutError: signal timed out" }
```

It *is* `instanceof Error`, so the SDK parses that stack and extracts zero frames rather than falling back to a synthetic call-site stack. Every `!hasFirstParty` gate therefore reads it as third-party noise.

**Trusting an existing code comment.** `pro-test/src/sentry-filter-policy.ts` argued the dashboard bundle "mints its own `signal timed out` DOMException in first-party code, which does carry caller frames." That is true only of the pre-Baseline-2024 fallback path in `src/services/timeout-signal.ts`; every current engine takes the native `AbortSignal.timeout` branch. Believing the comment is why the gate was written to suppress the shape in the first place.

**Fixing only `beforeSend`.** WebKit words the same rejection `AbortError: Fetch is aborted` (already documented in `src/services/timeout-signal.ts` under WORLDMONITOR-10F), and that phrase lived in `ignoreErrors` — a layer no `beforeSend` exemption can reach.

## Solution

**1. Key the exemption on tag presence, not on a list of names.**

`kind` is set only by first-party capture call sites and can never be set by the SDK, an extension, or an injected script, which makes presence an enforced invariant rather than a maintained census:

```ts
if (
  !hasFirstParty
  && event.tags?.kind === undefined   // presence, not truthiness
  && ( /signal timed out/.test(msg) || /Fetch is aborted/.test(msg) || ... )
) return null;
```

Use `=== undefined`, not `!event.tags?.kind` — the truthiness form reads `kind: ''` as absent, so the natural future shape `kind: someVar` would silently reopen the bug.

**2. Guard the whole chain, not one operand.** The exemption was first attached to a single disjunct of a twelve-way OR, which left the same transport's zero-frame `Failed to fetch` path suppressed.

**3. Move `/Fetch is aborted/` out of `ignoreErrors` into the `beforeSend` zero-frame block.** The `!hasFirstParty` gate reproduces the identical suppression for unowned events, while a first-party report can now claim it.

**4. Build the tag block from one shared helper** (`buildCheckoutReportTags` in `src/services/checkout-sentry-policy.ts`) so the emit side and the gate side are pinned to one source of truth instead of two copies.

## Why This Works

`ignoreErrors` is not a sibling of `beforeSend`. The SDK installs it as `eventFiltersIntegration.processEvent`, and event processors run inside `prepareEvent`, which `Client._processEvent` completes **before** calling `processBeforeSend`. It matches on message text only, blind to both `event.tags` and stack frames. Anything listed there is unrescuable by construction.

Payload tags, by contrast, *do* reach `beforeSend`: `{level, tags, extra}` is recognised as a CaptureContext, applied to a cloned scope via `getFinalScope`, and written onto the event by `applyScopeDataToEvent` — all inside `prepareEvent`, before `beforeSend` runs. Verified against `@sentry/browser` 10.46.0 and now pinned by a test rather than assumed.

## Prevention

**Before trusting a `beforeSend` exemption, grep `ignoreErrors` for the same message.** If it is there, the exemption is dead on arrival.

**Grep it on every surface, and grep it again after adding a capture.** This same mistake was made twice in one change. The first pass fixed the dashboard timeout and left Safari's wording in `ignoreErrors`. The second pass added an ownership-tagged capture to the marketing checkout without checking that bundle's own ignore list, where all three network wordings sat — so the new capture was inert for every network failure, which is the most common way that path fails. A probe against the pre-fix lists shows the split:

| wording | dashboard | marketing |
|---|---|---|
| `Load failed` (Safari, both forms) | dropped | dropped |
| `Failed to fetch` | reached beforeSend | dropped |
| `NetworkError …` | reached beforeSend | dropped |

Adding a capture call is not the end of the work. The question is always whether the message that capture will produce is already suppressed somewhere above the gate you are relying on.

**When relocating a suppression, keep its reach and add only the escape hatch.** These entries moved into `beforeSend` with no frame gate, exactly as unconditional as they were, so ordinary noise volume is unchanged and the sole behavioural difference is that a tagged event survives. A relocation that also widens is two changes wearing one commit.

**Mirror both spellings in the test harness.** Production builds two candidate strings per event — the bare message value, and the value prefixed with the exception type and a colon — and drops the event if either matches:

```js
// @sentry/core getPossibleEventMessages, paraphrased
const candidates = [value, `${type}: ${value}`];
```

The `isIgnored` mirror in `tests/sentry-beforesend.test.mjs` checked only the bare value, so an entry anchored on the type prefix would drop a first-party failure with the suite green. It now takes both the message and the type.

**Prove a suppression fixture against the previous gate.** Compile the old `beforeSend` body out of git and run each new fixture through it — a fixture that the old code also preserved is testing nothing:

```
checkout_request_failed:      DROPPED by old gate
panel_call_rejected:          preserved by old gate   <- the pre-existing exemption
csp_violation:                DROPPED by old gate
variant_theme_load_failed:    DROPPED by old gate
kind_presence_probe:          DROPPED by old gate
```

That run also revealed the gate had been silently eating three other first-party report classes, not just checkout.

**Parameterise over a tag value that belongs to no call site.** Both pre-existing fixtures used real `kind` values, so a regression narrowing the gate back to a name list would have stayed green. A `kind_presence_probe` value fails there and only there.

**Prefer a helper over a source-text regex for emit-side locks.** A regex for `kind: 'checkout_request_failed'` matches the literal just as happily inside `extra`, and `beforeSend` reads only `tags.kind` — so moving the key one field over keeps every test green while production goes dark. An independent review proved this by mutation, then proved a second variant (dropping the payload argument entirely) against the replacement lock.

## Related

- `docs/solutions/best-practices/sentry-noise-filtering-with-stack-gating-and-signature-matching.md` — the frame-gating and signature-matching policy this gate belongs to
- `docs/solutions/logic-errors/name-shaped-trampoline-allowlist-cannot-match-a-nameless-frame.md` — the sibling failure mode, where a name-shaped allowlist could not match a nameless frame
- `docs/solutions/workflow-issues/sentry-resolve-by-shipping-permanently-mutes-issues.md` — why this PR deliberately carries no resolve-on-commit marker

Shipped in PR #8069 (open as of this writing, CI green, unmerged).
