---
title: "Mutate each call site: a global mutant proves the helper is reachable, not that each site is covered"
date: 2026-07-30
category: conventions
module: prompt-boundary sanitization and its test coverage
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Applying one shared guard helper across many call sites in a sweep, then claiming the sweep is tested"
  - "Mutation-testing a fix by neutering the shared helper rather than the individual call sites"
  - "Writing fixtures for a formatter whose output row interpolates several untrusted fields"
  - "Writing fixtures for a function with a primary path and a fallback path, where the fixture satisfies the primary"
  - "Reviewing a security sweep whose test count went up a lot but whose per-site coverage was never measured"
symptoms:
  - "Neutering the shared helper turns many tests red, so the sweep looks covered — but individual call sites have no test at all"
  - "Reverting the guard on one field of a multi-field output row leaves the whole suite green"
  - "A guard inside a fallback branch is never exercised because every fixture supplies the primary path that short-circuits it"
  - "A reviewer's targeted single-site mutation goes green on a suite that a global mutation reds"
related_components:
  - testing_framework
  - development_workflow
  - authentication
tags:
  - mutation-testing
  - guard-coverage
  - test-teeth
  - prompt-injection
  - fixture-design
  - fallback-branches
  - security-testing
---

# Mutate each call site: a global mutant proves the helper is reachable, not that each site is covered

## Context

Issue #5857 (PR #5884) swept a prompt-injection guard across `server/worldmonitor/intelligence/v1/chat-analyst-context.ts`. `sanitizeForPrompt` deliberately preserves a lone newline, so every `- ${x}`-joined-by-`\n` block in that file let one feed item forge an extra bullet the analyst reads as a real story. The fix adds `sanitizeForPromptLine` (`server/_shared/llm-sanitize.js:122`) and applies it at **32 call sites** (31 lines — `:318` carries two).

The issue's own acceptance criteria demanded proof of teeth: *"reverting it must turn the test red."* So the guard was mutation-tested. The mutation chosen was the obvious one — neuter the shared helper:

```js
export function sanitizeForPromptLine(input) {
  return sanitizeForPrompt(input); // MUTANT: guard removed
}
```

**17 tests went red.** That looked like proof, and the sweep was declared covered. It was not. An independent adversarial review pass (a different model family, via the Codex CLI) reported that mutating three *individual* assignments — `card.ticker`, `card.direction`, `card.confidence` at `chat-analyst-context.ts:152,154,155` — left the entire suite green. Reproduced directly: with all three unguarded, `tsx --test tests/chat-analyst.test.mts` reported `pass 105 / fail 0`.

Scripting the mutation **per occurrence** then found a fourth: `:436`, the `dataMonth` guard in `buildProductSupply`'s direct-key fallback.

**4 of 32 call sites had zero coverage, and the global mutant showed none of them.**

## Guidance

> **A global mutation of a shared helper proves only that the suite depends on that helper *somewhere*. It says nothing about any individual call site.** When one guard is applied in bulk, the unit of mutation must be the call site, not the helper.

The reasoning is mechanical. With N call sites and a helper-level mutant, *all N* sites break at once, so any single covered site is enough to red the suite. The signal saturates at one. Per-site mutation is the only way to distinguish "this suite covers 28 of 32 sites" from "this suite covers 32 of 32" — and the difference is exactly where an attacker-controlled field is still unguarded.

The check is about fifteen lines of shell and runs unattended:

```bash
N=$(grep -o 'guardFn(' pristine.ts | wc -l)
for i in $(seq 1 "$N"); do
  perl -0pe '$n=0; s/guardFn\(/++$n=='"$i"' ? "__mut(" : "guardFn("/ge' pristine.ts > src.ts
  run_tests   # fail==0  =>  surviving mutant  =>  site i is untested
done
cp pristine.ts src.ts   # restore from the COPY, never `git checkout`
```

Two details that matter:

- **`__mut` must be the *unguarded original*, imported under an alias** — here `import { sanitizeForPrompt as __mut }`. A no-op stub (`(v) => String(v)`) also strips the injection-phrase filtering, so unrelated injection tests fail and every site looks "covered" for the wrong reason. The mutant must change exactly the one property under test.
- **Restore from a file copy, not `git checkout`** — `git checkout` reverts to HEAD and destroys any uncommitted work in the same file.

### The two blind spots this surfaces

Both are invisible to reading and to a global mutant, and both are fixture-shape problems rather than code problems:

**1. A fallback branch every fixture short-circuits.** `buildProductSupply` reads the energy spine first and only falls back to `energy:jodi-oil:v1:<iso2>` when the spine lacks JODI-oil coverage (`chat-analyst-context.ts:416`). The end-to-end fixture supplied a complete spine — realistically, helpfully — so the fallback's own guard at `:436` never executed in any test. **A fixture that populates the happy path silently skips every fallback beneath it.** The fix is a fixture that *forces* the fallback (here: delete the spine key, supply the direct key).

**2. Sibling fields on a multi-field row.** `buildMarketImplications` emits `- ${ticker} ${direction} (${confidence}): ${title}` — four untrusted interpolations, one row. The fixture poisoned `title`, so the row-count assertion went red whenever `title`'s guard was removed and stayed green for the other three. **Poisoning one field proves exactly one guard.** The fix is to poison each field independently:

```ts
const benign = { ticker: 'GLD', title: 'Gold thesis', direction: 'LONG', confidence: 'HIGH' };
for (const field of ['ticker', 'title', 'direction', 'confidence'] as const) {
  const out = buildMarketImplications({
    cards: [{ ...benign, [field]: `${benign[field]}${FORGED_BULLET}` }],
  });
  assertNoForgedBullet(out, 1, `buildMarketImplications via ${field}`);
}
```

### Pair the sweep with a preservation test

Widening sanitization across many sites has a second failure mode the row-count assertions cannot see: **over**-sanitization. Every "does it block the attack?" assertion is satisfied by a function that mangles everything. Pin the normal case byte-for-byte alongside them, choosing inputs most likely to trip a structural pattern — here ticker symbols with punctuation (`^GSPC`, `CL=F`) and non-ASCII names (`Côte d'Ivoire`).

## Why This Matters

The stakes are the reason the granularity matters. These strings feed the analyst's **system prompt** (#3724). An unguarded `direction` field is not a cosmetic gap: it is a feed-controlled string that can open a `- bullet` or a `## section` the model reads as a real datum. Shipping the sweep with 4 of 32 sites unguarded would have closed the issue, passed CI, and left four live injection paths behind a doc claiming the class was fixed — strictly worse than not sweeping, because the issue would be closed.

The trap is specifically that the global mutant produced a *large, convincing* number. Seventeen red tests reads as thorough. It is the same shape as the vacuous-guard family in [`verify-the-verifier-mutation-test-every-detection-layer.md`](./verify-the-verifier-mutation-test-every-detection-layer.md), one level up: there, a guard's *input* silently shrank; here, a mutation's *blast radius* silently widened until a single covered site could stand in for all of them. Both make a weak signal look strong.

Worth noting what actually caught it: an independent review pass from a different model family, which ran a targeted single-site mutation rather than the helper-level one. The per-site sweep then generalized that one finding into a systematic check and found a fourth site the reviewer had not flagged. Independent review found the *shape* of the gap; the script found its *extent*.

## When to Apply

Run per-call-site mutation whenever:

- One helper is applied across more than a handful of call sites in a single change — a sanitization sweep, an escaping pass, an authorization check added to many handlers, a rate-limit call added to many routes.
- A function has a primary path and a fallback, and the fixtures satisfy the primary. Ask directly: *which branch does my fixture not reach?*
- An output row interpolates more than one untrusted value. Count the interpolations, then count the fixtures that poison each one.
- The change is security-relevant, where an uncovered site is a live vulnerability rather than a missing test.

Skip it when the guard has one or two call sites — there the global mutant and the per-site mutant are the same thing.

For a single fix rather than a bulk sweep, the standing rule still applies unchanged: revert the fix, re-run, and require red. This convention is the bulk-application corollary of it.

## Examples

**The saturating global mutant** — neuter the helper, watch a big number appear, learn nothing about any individual site:

```
$ # sanitizeForPromptLine -> return sanitizeForPrompt(input)
$ tsx --test tests/chat-analyst.test.mts tests/llm-sanitize.test.mjs
ℹ pass 132
ℹ fail 17
```

**The same suite against a single-site mutant**, before the fixtures were fixed — three unguarded feed fields, nothing red:

```
$ # ticker/direction/confidence -> safeStr(...) at chat-analyst-context.ts:152,154,155
$ tsx --test tests/chat-analyst.test.mts
ℹ pass 105
ℹ fail 0
```

**The per-site sweep**, which reports coverage as a ratio instead of a vibe. First run (after the sibling-field fixtures landed) still found the fallback:

```
site 23 (line 419): ℹ fail 2
site 24 (line 437): ℹ fail 0      <- surviving mutant: no test covers this guard
site 25 (line 551): ℹ fail 2
```

After adding a fixture that deletes the spine key so the direct-key fallback actually runs:

```
call sites: 32
SURVIVING MUTANTS (uncovered guards): NONE
```

**Status:** shipped in PR #5884, CI-green, merged state pending as of 2026-07-30. Line references are to that branch's tree.

## Related

- [`conventions/verify-the-verifier-mutation-test-every-detection-layer.md`](./verify-the-verifier-mutation-test-every-detection-layer.md)
  — the parent lesson: a guard is not verified until you have broken it and watched it fail. That doc
  covers guards that fail open because their *input* shrank. This one covers the complementary error
  in the *verification* step — choosing a mutation whose blast radius is too wide to localize.
- [`logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md`](../logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md)
  — the "mirror test": a test that verified its own reimplementation rather than the real function.
  Same family (a test that cannot fail for the reason you believe), different mechanism.
- [`best-practices/test-guard-assertions-and-module-state-reset.md`](../best-practices/test-guard-assertions-and-module-state-reset.md)
  — "confirm the guard is covered by temporarily removing it: the test must fail." This doc supplies
  the *granularity* rule for when "the guard" is one helper behind many call sites.

Standing rules this extends: *mutation-test every security fix before claiming coverage* (PR #5290)
and *test the real function against real data* (PR #5311).

Issues: #5857 (the sweep), #5884 (the PR), #5850/#5856 (the `liveHeadlines` fix this generalizes),
#3724 (the hard-sanitization policy these strings are governed by). Filed during the sweep and
deliberately left for follow-up: #5881 (three sibling prompt-context modules with the same weakness),
#5890 (a `variant-smoke-full` flake this PR had to clear by bisecting base vs head).
