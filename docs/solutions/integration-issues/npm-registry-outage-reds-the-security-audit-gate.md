---
title: "An npm registry outage reddened every PR, and `??` hid why"
date: 2026-07-26
category: integration-issues
module: security-audit
problem_type: integration_issue
component: development_workflow
symptoms:
  - "audit-lockfile fails for every workspace, taking security-audit and gate red repo-wide; no PR can merge"
  - "The CI log shows ONE BLANK LINE followed by `##[error]Process completed with exit code 1` — zero diagnostic text"
  - "Other open PRs appear green, so the failure looks specific to the PR being worked on"
  - "The same commit, unchanged, passed the same workflow seven hours earlier"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components: [tooling, testing_framework]
tags: [npm-audit, security-audit, ci-gate, third-party-outage, nullish-coalescing, soft-fail, diagnostics]
---

# An npm registry outage reddened every PR, and `??` hid why

## Problem

On 2026-07-26 at roughly 05:40 UTC, `registry.npmjs.org`'s bulk advisories endpoint
(`/-/npm/v1/security/advisories/bulk`) began answering with a **gzip body where JSON was
expected** — npm's parser hit the gzip magic number (`1f 8b 08`) at byte zero. Every
`npm audit` in the repo failed. The `audit-lockfile` matrix in
`.github/workflows/security-audit.yml` runs one job per production lockfile, the aggregate
`security-audit` job fails if any matrix leg is non-success, and `security-audit` is a
required context in the merge gate. One broken third-party endpoint therefore blocked every
open PR in the repository.

Two independent defects in `.github/scripts/audit-production-dependencies.mjs` turned an
upstream hiccup into a repo-wide outage with no diagnostic trail.

## Symptoms

- All six `audit-lockfile` legs red at once, on every branch, plus `main`.
- The failing step's log was **a single blank line**, then
  `##[error]Process completed with exit code 1`. npm's actual text —
  `npm error audit endpoint returned an error` — never reached the log.
- Other open PRs still showed green checks, which made the failure look local to whichever
  branch you happened to be on.
- `main` itself was red, on a commit that had been green the previous evening.

## What Didn't Work

- **Reading the CI log.** There was nothing in it. The gate threw `Error("")` and the
  top-level handler printed `error.message` — an empty string. The log was structurally
  correct and informationally empty.
- **Trusting other PRs' green checks as a control.** They were green because their runs were
  **stale** — every one had last executed between 19:51 and 22:10 the previous evening,
  before the endpoint broke. A check mark is a claim about the moment it ran, not about the
  code as it stands now.
- **Piping the reproduction through `tail`.** `node script.mjs | tail` reports *`tail`'s*
  exit status, not the script's, so the run looks like it succeeded. Redirect to a file and
  read `$?` instead.

**Two other sessions hit this live and both got it wrong — this is the measured cost of the
blank line.** (session history)

- One session reproduced the script locally, saw the zero-output exit 1, ran `npm audit`
  manually in a scratch dir, recovered the real gzip error, and **correctly** concluded
  "an npm registry failure, not my change... transient third-party rot." Then, one turn
  later, it **talked itself out of the right answer**: "only `blog-site` fails while the
  other five lockfile audits pass, so the registry is fine in CI — my local npm error was a
  local artifact." That reversal rested on weak circumstantial evidence rather than a re-run,
  and the blank-line failure gave it nothing to re-verify against. It later read the merged
  fix `48ba066ae` as vindication of its *abandoned-and-wrong* theory, when the commit title
  confirms the diagnosis it had originally gotten right.
- A second session, on an unrelated PR, never ran the manual `npm audit` step, so it never
  saw the gzip response. Noticing an open PR for a blog-site dependency vuln, it concluded
  "a blog-site dependency vuln; PR #5477 is open to fix it" — a plausible, wrong story
  substituting for the true cause precisely because the script emitted nothing to
  distinguish them.
- Both treated the gate as "pre-existing, not mine" and moved on. Neither filed the outage.
  A silent failure does not merely fail to inform; it actively invites a confident wrong
  answer.

## Solution

Shipped in **PR #5628**, touching only the gate script and its test file. Both fixes were
extracted as **pure exported predicates**, so the behavior is a unit-testable truth table
rather than a convention buried in control flow.

**1. Recover the real message.**

```js
export function resolveAuditErrorMessage(report, workspace) {
  const candidates = [report?.error?.summary, report?.error?.detail, report?.message];
  const found = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return found?.trim() ?? `npm audit failed for ${workspace}`;
}
```

First **non-empty** candidate, including the top-level `message` npm actually populates,
with a named fallback that can never be blank.

**2. Classify upstream rot.** `isUpstreamAuditOutage()` returns true for the advisories/bulk
URL, `audit endpoint returned an error`, `invalid json response body`, the transport error
codes (`ENOTFOUND`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `socket hang up`,
`network timeout`), and bare `502`/`503`/`504`. It returns false on empty text, so "npm told
us nothing" is never softened.

**3. Split the exit code.** The classification is attached to the thrown error at all three
failure sites — no stdout, unparseable stdout, and a structured `report.error`. The first two
classify from **stderr**, because npm writes transport diagnostics there rather than into the
JSON. `main()` then splits the outcome:

```js
if (error?.upstreamOutage && !args.failOnOutage) {
  console.log(`::warning title=Security audit could not run::${args.lockfile} was NOT audited — …`);
  return;                    // exit 0
}
throw error;                 // everything else still hard-fails
```

`--fail-on-outage`, or `AUDIT_FAIL_ON_OUTAGE=1`, restores strict behavior for contexts where
a missed audit costs more than a blocked pipeline.

## Why This Works

**The `??` trap.** npm does not omit the error fields — it sends
`{"error": {"summary": "", "detail": ""}}`, **empty strings**. Nullish coalescing only falls
through on `null`/`undefined`, so `summary ?? detail ?? fallback` evaluated to `""` and won
over both the real fallback and the populated top-level `message`. `??` is the right operator
when `""` is a legitimate value; it is the wrong one when `""` means "upstream had nothing to
say here."

**Why the soft-fail is not a security hole.** The exemption is narrow by construction:

1. It fires **only when npm produced no usable report at all**. It can never fire on a report
   that *exists and contains advisories* — that path is downstream of the try/catch and
   untouched.
2. The skip is **loud, not silent** — a `::warning` annotation naming the exact lockfile that
   was not audited.
3. `security-audit` runs on every push to `main` and nightly, so a genuinely new advisory
   surfaces on the next healthy run rather than being permanently skipped.
4. The alternative makes npm's uptime a hard dependency of every merge in the repo — and,
   before this fix, with a blank line as the only diagnostic. Hard-failing on third-party rot
   is not a stricter security posture; it is the same posture plus an outage.

The security-relevant direction is pinned by test, not by intent.

## Verification

- **13/13 tests green** in `tests/security-audit-baseline.test.mjs`.
- The exact broken payload is frozen as a fixture, and one assertion pins the bug's mechanism
  directly — `assert.notEqual(OUTAGE_REPORT.error.summary ?? 'fallback', 'fallback')` — so the
  test documents *why* `??` failed, not merely that the output is now non-empty.
- The fail-closed direction has its own case (`does NOT classify a real audit failure as an
  outage (must stay hard-fail)`), covering an empty error envelope, `ENOLOCK`, `EUSAGE`, and a
  missing lockfile entry.
- **Against the live outage**, the script exited 0 with the named warning, and
  `--fail-on-outage` exited 1 carrying npm's real message instead of a blank line.
- **Mutation-tested**: restoring the `??` bug reds 2 tests; making the classifier fail open
  reds 1.
- **In CI on PR #5628**, `audit-lockfile (blog-site)` **passed with the warning annotation**
  while the same job was still failing on `main` and on PR #5605. That comparison was captured
  while npm was still broken, so it proves the soft-fail path executed — not that the registry
  had recovered.

## Prevention

- **Diagnose external-dependency failures by comparing run TIMESTAMPS, not pass/fail.** The
  decisive evidence was commit `f73de5b7d` running the *same* workflow twice: success at
  2026-07-25 22:29 UTC, failure at 2026-07-26 05:40 UTC. Same commit, same lockfiles, opposite
  result. That single comparison eliminates the code, the lockfile, and the branch in one step
  and leaves only a live external dependency. The corollary is equally load-bearing: the other
  PRs' green checks were stale runs from the prior evening. When a gate goes red, read the
  check list by **when each run executed**, not by its color.
- **`??` is not a "use a default" operator.** When a field can legitimately arrive as `""` and
  that empty value means "nothing to report," use an explicit non-empty test. Audit any
  `a ?? b ?? fallback` chain whose inputs come from an external JSON payload.
- **An error path that can print nothing is a broken error path.** Any fallback message
  reachable by a gate must be unconditionally non-empty; assert it in a test.
- **Split exit codes in CI gates by who can fix the failure.** Actor-fixable defects
  (advisories found, malformed lockfile, usage errors) hard-fail. Third-party rot warns loudly
  and exits 0, with an escape-hatch flag for strict contexts. This is the same split the
  `test-ci-gotchas` skill prescribes for feed validators and vendor-API smokes.
- **Never read an exit code through a pipe.** `cmd | tail` reports the *last* command's status.
  Redirect to a file and inspect `$?`.
- **Extract the decision into a pure exported predicate.** Both fixes are functions with no
  I/O, so the failure taxonomy is a truth table a test can enumerate — including the negative
  direction — rather than something only reproducible by breaking npm.

## Adjacent, unfixed: the recurring baseline flavor

This gate has gone red repo-wide at least five times before (#5394, #5417, #5423, #5559, and
earlier baseline commits) for a **different** mechanism: a genuinely new advisory needing a
baseline entry. None of those produced a `docs/solutions/` entry despite recurring. PR #5628
deliberately does **not** touch that mechanism — it handles total-outage and malformed-response
only, and an audit that runs fine and finds a real unbaselined advisory still hard-fails, as it
should. The recurring "one lockfile's fresh advisory blocks everyone" fragility remains open.

## Residual risk

`isUpstreamAuditOutage` matches bare `502|503|504` on word boundaries, so an npm message that
happens to contain one of those three numbers in an unrelated position could be misclassified
as an outage. The consequence is bounded — one warned-and-skipped lockfile on one run,
re-audited on the next push to `main` — but if the classifier is extended, prefer anchoring
numeric codes to an HTTP-status context rather than widening the alternation.

## Related

- [Health must not grade a deliberately-unconfigured optional source](../logic-errors/health-must-not-grade-an-unconfigured-optional-source.md)
  — closest conceptual analog: a monitor that conflated a non-actionable state with a genuine
  failure, fixed by adding an explicit exempted classification rather than patching the alarm
  condition inline.
- [Verify the verifier: mutation-test every detection layer](../conventions/verify-the-verifier-mutation-test-every-detection-layer.md)
  — the convention this fix followed; both predicates were mutation-tested before being trusted.
- [git push timeout from a stale core.hooksPath](../performance-issues/git-push-timeout-stale-core-hookspath.md)
  — same theme: a push/merge gate broken repo-wide for a reason unrelated to any PR's code.
- PR #5628 — `fix(ci): stop an npm registry outage from silently redding the security gate`
- Issue #4889 (open) — `deploy-gate` exits 1 while required jobs are pending; another instance
  of a merge gate going red for a non-code reason.
