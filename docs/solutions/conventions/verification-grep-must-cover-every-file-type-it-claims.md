---
module: engineering-process
date: 2026-08-10
problem_type: convention
component: documentation
severity: high
category: conventions
applies_when: "Writing a runbook step, CI check, or migration procedure whose verification is a grep, glob, or find scoped by file type"
tags:
  - verification
  - runbooks
  - migrations
  - false-negative
  - guard-cannot-fire
---

# A verification grep that omits a file type is a guard that cannot fire

## Context

A runbook step required rotating a set of Redis cache-key literals across every file that carried them. The step included its own verification command, and the instruction directly beneath it read:

> re-run the grep against the new values to confirm none was missed

The grep was scoped by extension:

```bash
grep -rln "resilience:score:v25\|resilience:ranking:v25\|resilience:history:v20" \
  --include='*.mjs' --include='*.ts' --include='*.js' --include='*.mts' . | grep -v node_modules
```

The literals also appeared in a published documentation table — in `.mdx`, in two locales. The rotation missed both. The verification grep then returned **zero hits** and read as proof of completeness.

The step that existed specifically to catch an incomplete rotation certified the incomplete rotation as complete.

## Guidance

**A verification command must cover every surface the thing being verified can live on.** When the check is scoped — by extension, by directory, by glob — that scope is a claim about where the target can appear. If the claim is narrower than reality, the check does not merely miss cases: it produces positive evidence of correctness, which is worse than no check at all. A missing check invites a manual look; a passing check ends the investigation.

Three rules follow:

**1. Derive the scope from the target, not from habit.** The literals lived in code *and* in a published key table. The grep was written with a code-migration reflex. Ask: what file types can this string appear in? — then include all of them, and say why in the command's surrounding prose so a later editor does not trim them back:

```bash
grep -rln "<literals>" \
  --include='*.mjs' --include='*.ts' --include='*.js' --include='*.mts' \
  --include='*.mdx' --include='*.md' . | grep -v node_modules
```

**2. Prove the guard can fail before trusting it.** Run the verification against the *pre-change* state and confirm it produces hits. A check that has never been observed failing is an untested branch. Here, running the corrected grep before the rotation would have returned the doc files immediately.

**3. Treat a zero-result verification with suspicion proportional to its importance.** "Zero hits" and "I searched the wrong place" are indistinguishable from the output. The more load-bearing the check, the more it is worth confirming the search space was right — especially when the same prose warns that missing one instance is catastrophic. This runbook literally said *"leaving one behind is worse than not bumping"* two lines below a grep that could not see two of the files.

## Why This Matters

This is the same defect class as a test that cannot fail, a fail-closed threshold sized so it never trips, or an alarm wired to a metric nobody emits — a guard whose passing state carries no information. It is more dangerous in a runbook than in a test suite, because a runbook is followed by a human under time pressure who is explicitly looking for permission to proceed.

The cost asymmetry is stark. Adding two `--include` flags costs nothing. The failure it prevents is a documented Redis namespace that nothing writes, discovered later by someone trusting the docs — or, in the acceptance-evidence case, a validation harness reading an abandoned key namespace and returning a green verdict with no signal behind it.

## When to Apply

Any procedure step whose verification is a scoped search:

- Cache-key, config-key, or feature-flag rotations
- Renames and API migrations verified by grep
- "Confirm no remaining references to X" steps in deprecation runbooks
- CI checks globbing a file set to enforce a rule
- Codemod completeness checks

Especially when the target can appear in documentation, localized content, generated files, or config as well as source. Localized docs are the classic miss: they are hand-maintained, they duplicate tables from the primary locale, and they are invisible to a source-only glob.

## Examples

**Before** — scope narrower than the target, and the prose asserts completeness:

```bash
grep -rln "OLD_KEY" --include='*.ts' --include='*.js' .
# "re-run to confirm none was missed"
```

**After** — scope matched to where the string actually lives, with the reason recorded inline so it survives editing:

```bash
grep -rln "OLD_KEY" \
  --include='*.ts' --include='*.js' \
  --include='*.mdx' --include='*.md' .   # docs carry the key table too, in two locales
# The .mdx/.md includes are load-bearing — do not drop them. An earlier version
# omitted them, so this check returned zero hits while two docs were still stale.
```

Recording *why* the includes exist is the part that makes the fix durable. A bare list of extensions looks arbitrary and gets trimmed by the next person tidying the command.
