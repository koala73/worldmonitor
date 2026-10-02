---
module: ci-path-filtering
date: 2026-09-04
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "A generated public artifact is exempted from a merge-blocking scanner, and the test that replaces that scanner never runs on the PR that edits the artifact"
  - "`gh pr checks --watch` prints every job as `pass` or `skipping` and exits 0 while `changes` concluded FAILURE"
  - "A job that should have run for a PR touching `scripts/` and `tests/` reports `SKIPPED` rather than `FAILURE`"
  - "An apostrophe inside an awk comment in `.github/workflows/test.yml` kills the whole `changes` step"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components: [testing_framework, documentation]
tags: [ci-path-filter, green-while-dead, gate-exemption, skipped-not-failed, shell-quoting, awk, mutation-testing, seo]
---

# A gate exemption is only as strong as the job that enforces it

## Problem

`scripts/docs-stats.mjs` runs a merge-blocking scan (`validateVolatileInventoryClaims`) that fails CI when a public marketing or AI-facing surface publishes a hand-authored extensible inventory count — because hand-maintained totals rot.

Issue #6038 needed `public/ai-search.md` to publish exact counts again (747 providers, 760 hosts, 74 MCP tools…) generated from the registries. The block was exempted from that scanner, and the exemption was justified by a *different* guard: a byte-for-byte drift test asserting the committed block matches the generator.

That justification was false in the case that mattered. The drift test lives in `test:data`, which runs only in `test.yml`'s `unit` job, gated on `needs.changes.outputs.code == 'true'`. The `changes` job's CODE filter drops every path matching `/\.md$/`. `public/ai-search.md` matches. **On a PR editing only that file, `unit` never ran — so the exempting scanner was the only gate that executed, and fabricated figures would have merged clean.**

## Symptoms

- A PR touching only `public/ai-search.md` sets `code=false`; the drift test that licenses the scanner exemption is skipped.
- After adding a carve-out to fix it, `changes` concluded FAILURE and every dependent job — including `unit` — rendered as **`skipping`**, not `failed`.
- `gh pr checks 7676 --watch` exited 0 and printed `pass`/`skipping` for all 35 checks. Only `statusCheckRollup` showed the failure.
- Root cause of that second failure: the carve-out comment read `# public/ai-search.md's Data Coverage block …`. The awk program is a single-quoted shell string, so the apostrophe terminated it.

## What Didn't Work

- **Reasoning about the gate instead of the job graph.** The exemption's safety argument was checked against the *scanner's* logic (is the exempt span narrow? does it fail closed?) and every answer was yes. The question never asked was whether the compensating test executes at all. A narrow, correct, fail-closed exemption is worthless if its replacement guard is skipped.
- **Trusting the watch output.** `gh pr checks --watch` exiting 0 with no `fail` line was taken as green. It is not: when the gating job dies, dependents render as `skipping`, which reads like a deliberate path-filter skip rather than a failure.
- **Assuming a comment is inert.** An awk `#` comment is inert *to awk*. It is not inert to the shell that has to parse the single-quoted string containing it.

## Solution

**1. Route the artifact to the job that guards it.** Add a carve-out to the CODE filter in `.github/workflows/test.yml`, before the `/\.md$/ { next }` line — the same treatment four other generated artifacts already had:

```awk
/^public\/ai-search\.md$/ { count++; next }
# A published ranking snapshot is the source of the ranked-country figure
# and captured date in public/ai-search.md.
/^docs\/snapshots\/resilience-ranking-[0-9-]+\.json$/ { count++; next }
/\.md$/ { next }
```

The second rule matters as much as the first: `ai-search.md` publishes a count and date read from the newest `docs/snapshots/resilience-ranking-*.json`, so a snapshot-only PR would land a snapshot the committed page no longer matched — surfacing later as a confusing failure on an unrelated PR.

**2. Write comments in embedded shell programs without apostrophes.** The program is `CODE=$(echo "$FILES" | awk '…')`. Any `'` inside it — including in a comment — ends the string:

```awk
# WRONG — the apostrophe in "md's" ends the shell string
# public/ai-search.md's Data Coverage block is generated from …

# RIGHT
# The Data Coverage block in public/ai-search.md is generated from …
```

**3. Make the workflow's own logic testable.** `tests/ci-code-path-filter.test.mjs` extracts the real awk program out of `test.yml` and runs it through bash exactly as the step does:

```js
function runFilter(program, paths) {
  const script = `FILES=$(cat); printf '%s' "$(echo "$FILES" | awk '${program}')"`;
  return execFileSync('bash', ['-c', script], { input: paths.join('\n'), encoding: 'utf8' });
}

assert.doesNotMatch(program, /'/, 'single-quoted in the shell, so no apostrophes');
assert.equal(runFilter(program, ['public/ai-search.md']), '1');
assert.equal(runFilter(program, ['README.md']), '0');
```

Re-introducing the apostrophe turns all four tests red.

## Why This Works

The exemption and its compensating guard were coupled in *argument* but not in *configuration*. The scanner exemption keys on file content; the guard's execution keys on a path filter in a different file. Nothing linked them, so they could disagree silently — and the disagreement surfaced as a job that quietly did not run rather than a job that failed.

Routing the artifact into the guarding job makes the coupling real. Testing the filter through bash closes the second gap: the workflow's decision logic was previously only ever exercised *by running CI*, which means a syntax error in it could not fail locally and its failure mode in CI was a silent skip.

## Prevention

- **When exempting anything from a gate, name the compensating guard and then verify that guard actually executes for the change class being exempted.** "A test covers this" is a claim about the job graph, not just about the test file. Check the `if:`/`needs:` conditions, not only the assertions.
- **Never conclude CI is green from `gh pr checks --watch`.** Confirm with the rollup, and specifically assert that the jobs you *expect* to run did. `unit: SKIPPED` on a PR that changes `scripts/` or `tests/` is a red flag, not a normal filter outcome.
- **Mutation-test the routing, not just the assertion.** Every guard added here was proven by breaking it: widening the scanner exemption, reverting to the heading-inferred span, transposing two published figures, and re-adding the apostrophe each turn a specific test red. See [verify the verifier](../conventions/verify-the-verifier-mutation-test-every-detection-layer.md) for the general form of this discipline.
- **Treat an embedded awk/sed program in a workflow as code with no compiler.** It has no local test unless you write one. The sibling `DIGEST`, `VALIDATION`, and `UMAMI` programs in the same step carry the same apostrophe hazard.

The rollup query that distinguishes "nothing failed" from "the guard ran":

```bash
gh pr view <n> --json statusCheckRollup --jq \
  '{failing: [.statusCheckRollup[] | select(.conclusion=="FAILURE" or .conclusion=="TIMED_OUT") | .name],
    pending: [.statusCheckRollup[] | select(.status=="IN_PROGRESS" or .status=="QUEUED") | .name],
    unit:    [.statusCheckRollup[] | select(.name=="unit") | .conclusion]}'
```

## Related

- [A --check gate that rebuilt its expectation from the artifact it was checking](../logic-errors/a-check-gate-that-rebuilt-its-expectation-from-the-artifact-it-was-checking.md) — the adjacent failure where the gate's *logic* was self-referential; here the gate's logic was sound and its *execution* was skipped.
- [Railway seeder watch paths can skip deployments](../integration-issues/railway-seeder-watch-paths-can-skip-deployments.md) — the same path-filter-skips-the-thing-you-needed shape, in deploy config rather than CI.
- Issue #6038; PR #7676.
