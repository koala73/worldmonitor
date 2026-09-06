---
title: "A gate-required check must be an if-gated job, not a path-filtered workflow"
date: 2026-09-06
category: conventions
module: ci-deploy-gate
problem_type: convention
component: development_workflow
severity: high
symptoms:
  - "A lint or verification command blocks merge only because it rides inside a branch-protection job, and moving it into a workflow of its own silently un-enforces it"
  - "A workflow with a top-level `paths:` filter publishes no check run on non-matching PRs, so its job can never be listed in the deploy gate `required` array"
  - "A job whose change filter matches only the edited file type skips on PRs that change the command itself or its pinned tool version"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components: [testing_framework, tooling]
applies_when:
  - "Adding a CI check that must block merge but is not one of the four branch-protection contexts (biome, typecheck, unit, gate)"
  - "Moving a lint or verification step out of a branch-protection job into a job of its own"
  - "Choosing between a top-level `paths:` filter and an `if:`-gated job for a check that should be required"
  - "Adding a name to the `required` list in .github/scripts/deploy-gate.sh"
  - "Writing the change filter for a job whose command is defined in package.json or pins a tool in the lockfile"
tags:
  - ci-gating
  - deploy-gate
  - path-filter
  - skipped-is-passing
  - branch-protection
  - github-actions
  - change-filter
  - markdown-lint
---

# A gate-required check must be an if-gated job, not a path-filtered workflow

## Context

Only four check contexts are enforced by branch protection on `koala73/worldmonitor` main: `biome`, `typecheck`, `unit`, and `gate` (observed 2026-09-06 by reading the GitHub branch-protection API). Every other CI job blocks merge only indirectly, through `gate`, which `.github/scripts/deploy-gate.sh` computes by aggregating the check runs named in its `required` list at `.github/scripts/deploy-gate.sh:140`.

That makes "where does this lint actually run?" a different question from "what stops a bad change merging?". Markdown lint was a live example. It ran in two places: as a step inside the `biome` job, which is a branch-protection context, and again in a separate `.github/workflows/lint.yml` (since deleted by PR #7798) that carried a top-level `paths:` filter on markdown. Issue #7772 proposed deleting the step inside `biome` and giving `lint.yml` a push trigger. Read literally that is a de-duplication. In effect it would have left markdown lint enforced by nothing: the only enforcing copy was the `biome` step, and a path-filtered workflow cannot be gate-required. Nobody would have noticed until a broken markdown change merged clean.

PR #7798 implements the corrected shape for issue #7772. As of this writing it is open; merge is pending.

The shape is not new here (session history): PR #7549 added the `doc-anchors` gate as an unconditional job inside the always-triggered Lint Code workflow and listed it in `required` within the same PR, and PR #7755 chose a job-level `if:` gate over narrowing a workflow trigger after review found that the narrowed trigger stopped the check running on the one merge that mattered. What was new in #7772 was the trap in the other direction: a de-duplication that reads as harmless and deletes the only enforcing copy.

## Guidance

**1. Before moving or deleting a lint step, trace what actually blocks merge.** Two things do, and only two: a branch-protection context, and membership in the deploy gate's `required` list. A step buried inside a branch-protection job is enforced by accident of its host. Moving it out of that job removes the enforcement unless you add the new job's check-run name to `required` in the same change.

**2. A gate-required job must live in an always-triggered workflow and gate itself with `if:`, never with the workflow's `paths:`.** The gate's evaluator draws this asymmetry in two lines:

```python
latest[name] = 'pending'                                    # deploy-gate.sh:424 — no check run at all
print('failed=' + ','.join(... latest[name] not in ('success', 'skipped')))  # deploy-gate.sh:428
```

A required name with no check run on the SHA is `pending`. The 30-minute sweep retries for 24 hours after the latest pending status publication, then leaves the commit blocked and lists it in the run summary. A `skipped` conclusion is accepted as passing. A workflow with a top-level `paths:` filter publishes no check run at all on a PR that does not match it, so any of its jobs in `required` strands every non-matching PR. An `if:`-gated job inside an always-triggered workflow publishes `skipped` instead, which the gate accepts. `desktop-rust` and `umami-postgres` in `.github/workflows/test.yml` already worked this way; the new `markdown` job in `.github/workflows/lint-code.yml:69` now does too.

```yaml
  markdown:
    needs: changes
    if: needs.changes.outputs.markdown == 'true'   # lint-code.yml:71
```

```text
required='[...,"biome","markdown","public-docs",...]'   # deploy-gate.sh:140
```

**3. The `if:` filter must cover every input of the command the job runs, not just the obvious ones.** This is the part that is easy to get wrong, because a too-narrow filter fails silently: the job skips, and the gate reads the skip as passing. `npm run lint:md` reads more than markdown files. `package.json` holds the `lint:md` script and pins `markdownlint-cli2`, so a package-only PR that broke the lint would have skipped the job and sailed through the gate. The filter counts all of it (`.github/workflows/lint-code.yml:39`):

```bash
MARKDOWN=$(printf '%s\n' "$FILES" | grep -cE '\.md$|^\.markdownlint|^package(-lock)?\.json$' || true)
```

That set is `LINT_MD_INPUTS` from `.husky/pre-push:428` plus the lockfile, which the local pre-push gate omits, so CI treats a strict superset of what the local gate treats as a markdown change. Per this session's conclusion, the `.md`-only version of this filter passed the author's own review and was caught only by a multi-reviewer pass that included a cross-model Codex review. The same principle already existed in the workflow: the `VALIDATION` filter counts `package.json` and `package-lock.json` at `.github/workflows/test.yml:184`, and the `CODE` filter carves `src-tauri` node suites back in at `.github/workflows/test.yml:144` because `sidecar` and `unit` both run them and both are gated on `code`.

**4. Expect a transitional pending on previously green PRs after you edit `required`.** The list is hashed into a gate contract stamp, and the sweep uses that stamp to tell current evidence from a success posted against an older list, posting `Required PR gate contract changed; re-evaluation scheduled`. A PR missing the new check stays pending until it runs current CI. This preserves the stale-success protection from #5851.

Scheduled recovery expires when a pending status has been unchanged for 24 hours. Update the branch to run current checks, or use **Deploy Gate → Run workflow → sha** to evaluate that exact commit after resolving its checks. Workflow completion events also evaluate their SHA regardless of this cutoff. Failed or errored gates are already blocked and are not reopened by a contract change; stale successes must still be invalidated at any age.

GitHub can exhaust commit-status capacity on a SHA. If the latest gate is verified as pending, failure, or error, the commit remains blocked and the run reports the required branch update without failing independent recovery. An exhausted success or an unreadable previous gate still fails the run because the gate cannot prove that the commit is blocked. A new commit is required to restore status publication on an exhausted SHA; dispatch alone cannot do that.

## Why This Matters

The two failure modes sit on opposite sides of the same evaluator rule, and both are quiet.

Requiring a name nothing publishes hangs the gate at "Waiting for required PR gates" on every PR forever, because a missing check run reads as pending, not as failure. This is the rejected fix for #7772: adding `Lint` to the `workflow_run` list in `deploy-gate.yml` and `markdown` to `required` would have stranded every PR that touches no markdown.

Requiring a name whose job skips too eagerly is worse, because nothing looks wrong. The gate turns green on a check that never ran. That is the shape the original #7772 proposal would have shipped, and the shape a `.md`-only filter would have re-created for `package.json` changes. A red check gets fixed; a green check that proves nothing gets trusted.

The underlying reason the trap exists at all is that enforcement lived somewhere other than where the reader expects it. Markdown lint appeared to be owned by `lint.yml`. It was actually enforced by a step inside `biome`. Any refactor that trusts the apparent owner deletes the real one.

## When to Apply

- You are moving a lint, test, or check step out of `biome`, `typecheck`, or `unit`, the branch-protection contexts.
- You are adding a new CI job and want a red result to actually block merge.
- You are adding, renaming, or deleting an entry in the deploy gate's `required` list.
- You are writing or narrowing an `if:` change filter for a job that the gate requires.
- You are tempted to add a `paths:` filter to a workflow whose jobs the gate aggregates.

## Examples

**Markdown lint, before.** Enforced only as a step inside the `biome` job, and duplicated in a path-filtered `lint.yml` whose `markdown` check had never been gate-required. It could not be, because that workflow publishes no check run on code-only PRs. A code+markdown PR linted markdown twice.

**Markdown lint, after (PR #7798).** `lint.yml` is deleted. One owner runs `npm run lint:md`, in the `markdown` job of the always-triggered Lint Code workflow, gated on the change filter above and with `timeout-minutes: 10` so a hung `npm ci` cannot hold the gate for the 360-minute default (`.github/workflows/lint-code.yml:69-81`). `markdown` is in `required`, so it blocks merge through `gate`.

**Sibling application in the same PR.** `resilience-validation-smoke` is gated `validation == 'true' && code != 'true'` (`.github/workflows/test.yml:941`), so it runs only when `unit`, which already runs those same files inside `test:data`, is skipped. On a code PR it skips, and the gate counts the skip as passing. Same pattern, different job.

**Guards that keep this from drifting back.** Three tests hold the shape:

- `tests/ci-workflow-coverage.test.mts:1329` ("lints markdown once, in a gate-required job that skips when no markdown changed") pins the `needs`/`if` pair, the absence of `continue-on-error`, the presence of a timeout, that exactly one workflow step runs `lint:md`, that `lint.yml` no longer exists, and that `markdown` is in `required`. It then extracts the `MARKDOWN=` line and executes it under `bash` against synthetic file lists, asserting `true` for a `.md` file, `.markdownlint-cli2.jsonc`, `.markdownlintignore`, `package.json` and `package-lock.json`, and `false` for a code-only PR and for an `.mdx`-only PR. A final assertion (`tests/ci-workflow-coverage.test.mts:1391`) pins the positive glob of the `lint:md` script to exactly `'**/*.md'`, so widening the script fails the test until the filter is widened with it.
- `tests/ci-workflow-coverage.test.mts:985` ("requires every job of every workflow the deploy gate aggregates") fails when a gated job is missing from `required`: a red check that does not block merge, the CI theatre of #5402.
- `tests/ci-workflow-coverage.test.mts:1035` ("keeps the deploy gate required list free of checks no gated workflow publishes") fails on the mirror image: a required name no job publishes, which the gate can never resolve.

The selection logic has its own coverage in `tests/ci-test-selection.test.mjs`: the smoke job's `if` is evaluated against classified file lists at `tests/ci-test-selection.test.mjs:118`, and the `src-tauri` node-suite carve-out at `tests/ci-test-selection.test.mjs:105`.

## Related

- Issue #7772, the de-duplication request that carried the trap.
- PR #7798, the implementation; open, merge pending as of this writing.
- PR #7549, the precedent for adding a Lint Code job and listing it in `required` within the same PR (its `doc-anchors` job is unconditional), and PR #7755, the precedent for a job-level `if:` gate instead of a narrowed workflow trigger (session history).
- #5851, the gate contract stamp and the self-healing sweep that re-evaluates PRs when `required` changes.
- #5402, the "job runs red but the gate posts success" failure this list exists to prevent.
- #5822, why `Test`, `Typecheck` and `Lint Code` each publish their `changes` job under a distinct check-run name.
- `docs/solutions/workflow-issues/a-gate-exemption-is-only-as-strong-as-the-job-that-enforces-it.md`, the sibling rule for the compensating guard: name it, then verify it runs for the exempted change class.
- `docs/solutions/conventions/verification-grep-must-cover-every-file-type-it-claims.md`, the general form of guidance 3.
- `docs/solutions/best-practices/checks-must-fail-closed-when-they-lose-their-target.md`, why a `node --test` list that names a deleted file must fail rather than pass.
