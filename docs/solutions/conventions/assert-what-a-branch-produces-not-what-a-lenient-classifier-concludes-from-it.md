---
title: "Assert what a branch produces, not what a lenient classifier concludes from it"
date: 2026-09-02
category: conventions
module: test and CI verification infrastructure
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "A test asserts a downstream outcome (a retry firing, a boolean flag, a coarse classification) instead of the value the branch under test directly produces"
  - "A lenient downstream classifier — a broad regex, a coarse enum, a boolean check — sits between the branch and the assertion and can map several distinct branch outputs onto the same outcome"
  - "Writing or reviewing a test for a fallback ladder such as `err?.message ?? err?.code ?? JSON.stringify(err)` whose output feeds a classifier"
  - 'A classification regex like /\b429\b|rate.?limit|too many requests/i is fed by a JSON.stringify() fallback rung, whose serialized output can satisfy the regex by accident'
  - "Auditing whether deleting or reordering one rung of a fallback chain would still leave the existing suite green"
related_components:
  - testing_framework
  - development_workflow
  - background_job
tags:
  - mutation-testing
  - vacuous-tests
  - test-discrimination
  - positive-control
  - lenient-regex
  - error-message-ladder
  - non-discriminating-assertion
  - json-stringify-fallback
---

## Context

`scripts/seed-portwatch-port-activity.mjs` normalizes inconsistent ArcGIS error envelopes through a three-rung fallback ladder, extracted into a shared helper by PR #7539 so the direct, proxy, and diagnostic-capture parsers cannot drift apart:

```js
// scripts/seed-portwatch-port-activity.mjs:266-267
function arcgisErrorInfo(err) {
  return err?.message ?? err?.code ?? JSON.stringify(err);
}
```

The string it produces is later classified for retry by `refreshFailureCode`, whose rate-limit rung is a regex (`scripts/seed-portwatch-port-activity.mjs:1079`):

```js
if (/\b429\b|rate.?limit|too many requests/i.test(text)) return 'rate_limited';
```

The regression test written alongside that ladder fed a code-only envelope `{ error: { code: 429 } }` through the real parser and asserted the *outcome*: offsets `[0, 1, 1]`, one 2000 ms backoff. It was believed to pin the `?? code` rung. It did not.

`JSON.stringify({ code: 429 })` is `{"code":429}`. `\b429\b` matches inside that string — `:` and `}` are non-word characters, so they form word boundaries around the digits. Deleting the `?? code` rung entirely, leaving `err?.message ?? JSON.stringify(err)`, still produces a message the classifier calls `rate_limited`, still fires the retry, still yields offsets `[0, 1, 1]` and one 2000 ms sleep. The test stayed green with the branch it claimed to cover removed from the source.

A pre-merge review pass on the branch that became PR #7539 (open at the time of writing) caught it, before the branch was pushed — a separate reviewer lens, not a GitHub review thread, so there is no review artifact on the PR. The author had written the test believing it pinned that rung, and had already mutation-tested *other* parts of the same change successfully. Issue #7537 tracks the surrounding seam work.

## Guidance

**A test that asserts a downstream outcome cannot discriminate which upstream branch produced it, whenever a lenient downstream classifier maps several branches onto the same outcome.** Coverage of the line is not discrimination between the lines. The test executes the branch, the branch contributes to the result, and the assertion is still blind to whether that branch exists.

Assert the value the branch *directly produces*, at the seam closest to it — here the thrown message string, not the retry behaviour that message eventually triggers.

When the assertion must run through a downstream classifier, **choose an input the classifier does not absorb**, so sibling branches produce visibly different values. That is the whole trick in the fix: `400` instead of `429`.

```js
// tests/portwatch-port-activity-recovery.test.mjs:229-233
const codeOnly = await rejectedRefsError({ error: { code: 400 } });
assert.equal(codeOnly, 'ArcGIS error: 400');                  // ?? code rung

const neither = await rejectedRefsError({ error: { details: ['nope'] } });
assert.equal(neither, 'ArcGIS error: {"details":["nope"]}');  // stringify rung
```

`400` does not match the rate-limit regex, so the two rungs yield `ArcGIS error: 400` versus `ArcGIS error: {"code":400}` — distinguishable strings, one assertion apart. The helper `rejectedRefsError` (`tests/portwatch-port-activity-recovery.test.mjs:41-51`) drives the real parser and returns the thrown message, so the test still exercises production code rather than a copy of the ladder.

**The diagnostic is one question, and only running it answers it:** *if I deleted this branch, would this test still pass?* Intuition answers wrong — the author's did. Delete the rung, run the test, read the result. It takes under a minute and it is the only thing that settles it.

**Mutation-testing one branch does not vouch for its siblings.** Each rung of a ladder, each arm of a switch, each guard clause is a separate mutation. A change that "passed mutation testing" has proven exactly the branches that were mutated and nothing else.

## Why This Matters

The failure mode is silent and permanent. A test that cannot fail still runs green forever, still counts as coverage, and still reads in review as protection for the thing its title names. Nothing degrades, because the protection was never there. The next person to touch the ladder gets a green suite for a regression.

It is also self-concealing in exactly the way that defeats review: the test *does* execute the branch, the input *is* realistic, the assertion *is* about real behaviour. Everything looks right except the link between the branch and the assertion — and that link lives in a regex eight hundred lines away, in a different function.

## When to Apply

Check for this wherever the thing asserted is *many-to-one* with the branch meant to be pinned:

- **Regex or substring classifiers** — a permissive pattern matches several distinct upstream strings, including serialized fallbacks (this case).
- **Coarse enums** — several code paths all resolve to `rate_limited`, `retryable`, `error`, `unknown`.
- **Boolean returns** — `isValid()`, `shouldRetry()`, `hasAccess()` collapse every rejection reason into `false`; a test asserting `false` cannot say which check produced it.
- **Status codes collapsed to categories** — `4xx` handling that treats 400, 403, and 429 alike downstream.
- **Counters and call-count assertions** — "the retry fired once" is satisfied by any branch that reaches the retry.
- **Serialization fallbacks generally** — `JSON.stringify` of a small object often contains the very token a downstream matcher looks for, so the fallback rung mimics the specific rung.

Highest risk when the branch and the assertion live in different functions or files, and when the assertion is about *behaviour* (a retry, a log, a status) rather than a returned value.

## Examples

**Mutation, both directions — this is the proof, not the reasoning.**

Mutation applied to `scripts/seed-portwatch-port-activity.mjs:267`:

```js
function arcgisErrorInfo(err) {
  return err?.message ?? JSON.stringify(err);   // `?? err?.code` deleted
}
```

- Old, outcome-based assertion (offsets `[0, 1, 1]` plus one 2000 ms sleep): **still passed.** `{"code":429}` matched `\b429\b`, the retry fired, offsets and backoff were identical.
- New, value-based assertion: **failed** — `actual: 'ArcGIS error: {"code":400}'` vs `expected: 'ArcGIS error: 400'`.

Both directions matter. The new test going red under the mutation shows it has teeth; the old test staying green under the same mutation shows what was missing, and is the half that is easy to skip.

**Applying the question elsewhere.** Given a `shouldRetry(err)` with arms for timeout, 5xx, and a network-reset fallback, a test asserting `shouldRetry(resetError) === true` cannot distinguish the reset arm from a catch-all `return true`. Ask the question: delete the reset arm — does it still pass? If the catch-all returns `true`, yes. The fix has the same shape: assert the discriminating value (the reason string, the classified code) rather than the collapsed boolean, or pick an input the catch-all handles differently.

## Related

- [verify-the-verifier-mutation-test-every-detection-layer](verify-the-verifier-mutation-test-every-detection-layer.md) — the parent thesis (a guard is not verified until you have broken it and watched it fail). Same family, different mechanism: there the input shrank to zero, here a downstream classifier merges distinct branches.
- [a-normalizer-that-truncates-at-a-trailing-boundary-blinds-its-own-test](a-normalizer-that-truncates-at-a-trailing-boundary-blinds-its-own-test.md) — sibling: something between the code and the assertion destroys the evidence. There a truncating preprocessor discards it; here a lenient classifier conflates it.
- [hermetic-against-the-env-file-is-not-hermetic-against-the-environment](hermetic-against-the-env-file-is-not-hermetic-against-the-environment.md) — sibling from the same session: there a guarantee was read wider than its implementation, here an assertion was too coarse to separate branches. Both credit a real mechanism with more than it does.
- [mutate-each-call-site-a-global-mutant-hides-per-site-holes](mutate-each-call-site-a-global-mutant-hides-per-site-holes.md) — orthogonal axis. That entry is about mutation *granularity* (where to apply the mutant); this one is about assertion *choice* (what value to pin). Here the single call site was mutated directly and the test still passed.
