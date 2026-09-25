---
title: The post-merge deploy monitor false-alarmed on a stale GitHub run-listing snapshot, not a dead workflow
date: 2026-09-24
category: integration-issues
module: check-postmerge-deploys
problem_type: integration_issue
component: development_workflow
symptoms:
  - "`postmerge-deploy ERROR: Convex Deploy [NO_RUN_IN_WINDOW] the newest run of convex-deploy.yml on main (34136482776) predates the 168h window — the workflow may have stopped running`"
  - "Post-merge Deploy Monitor failed 21 of its last 120 ticks between 2026-09-23T07:34Z and 2026-09-24T09:54Z, naming the same run id every time"
  - "Convex Deploy ran and succeeded on every push to main throughout the window, and the `convex-deployed` tag showed production current"
  - "The same script run locally against the same `main` was green on every attempt"
  - "`GET /repos/{repo}/actions/workflows/convex-deploy.yml/runs?branch=main&per_page=100` answers HTTP 200 with `total_count` 1366 against a true 3168 and a 17-day-old run as the newest, interleaved with correct answers to the identical URL"
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components: [tooling, development_workflow]
tags: [github-actions, postmerge-monitor, stale-api-response, eventual-consistency, false-alarm, convex-deploy, run-listing, scheduled-workflow]
---

# The post-merge deploy monitor false-alarmed on a stale GitHub run-listing snapshot, not a dead workflow

## Problem

Post-merge Deploy Monitor (`.github/workflows/postmerge-deploy-monitor.yml`, cron `'*/10 * * * *'` at line 20) began failing intermittently on 2026-09-23, always with the same claim: Convex Deploy had not run on `main` inside its 168-hour window, so "the workflow may have stopped running". It had. Convex Deploy fires on every push to `main` and had succeeded minutes before several of the failing ticks.

The alarm rested on a single read of one GitHub REST endpoint, and that endpoint intermittently answers with an index snapshot weeks out of date — as an HTTP 200, indistinguishable from a correct answer.

## Symptoms

21 of the monitor's last 120 ticks failed, starting 2026-09-23T07:34:07Z (run 35832392267) and continuing through 2026-09-24T09:54:09Z (run 35984056173). Every failure named the identical run id, which is what ruled out ordinary replica lag:

```
postmerge-deploy ERROR: Convex Deploy [NO_RUN_IN_WINDOW] the newest run of
convex-deploy.yml on main (34136482776) predates the 168h window — the
workflow may have stopped running
```

The contradicting evidence, all gathered while the monitor was red:

| check | result |
| --- | --- |
| `gh run list --workflow=convex-deploy.yml --branch main` | 10 runs on 2026-09-24 alone, newest `35984047603` at 09:54:04Z, `success` |
| the run the monitor named, `34136482776` | real, `success`, created **2026-09-07T15:05:43Z** — the 520th-newest run, not the newest |
| `git ls-remote --tags origin convex-deployed` | `054bce8ba2…`, with no bundled path changed since — production current |
| `node scripts/check-postmerge-deploys.mjs` locally | `ok: Convex Deploy [DEPLOY_SKIPPED_LEGIT]`, exit 0, every attempt |
| workflow entities matching `convex` | exactly one, id `267207599`, state `active` — not a deleted-and-recreated workflow |

The two other monitored workflows reported fresh runs in the same failing ticks, so nothing was globally wrong with the runner's view of the Actions API.

## What Didn't Work

- **Believing the message.** "The workflow may have stopped running" is the monitor's own hypothesis, not an observation. The observation is only "the listing I read names this run as newest".
- **Reproducing locally.** 25 unauthenticated and 40 authenticated reads of the exact URL, all fresh, all `total_count=3168`. Local reproduction was never going to happen; this only appears from GitHub-hosted runners.
- **Blaming the token.** The workflow declares `permissions: contents: read`, so `GITHUB_TOKEN` carries `actions: none`. It was a plausible cause and it is not the cause — the same job read the other two workflows' listings correctly.
- **Looking for a second workflow entity.** A deleted-and-recreated `convex-deploy.yml` would resolve by filename to an older workflow id. There is only one, and the file has never been deleted (`git log --follow --diff-filter=ADR`).
- **Suspecting a pagination cap.** The named run sits at index 519 of the listing, nowhere near the 1000-result ceiling that endpoint is known for.
- **Suspecting a recent code change.** `scripts/check-postmerge-deploys.mjs` was last touched by #8311 on 2026-09-22, which only appended `shared/checkout-errors.ts` to `skipProofPaths` — a code path evaluated *after* the verdict that was failing.

## Solution

The reproduction had to happen in CI, so a throwaway workflow was pushed to a side branch (no `push:` trigger in this repo matches a non-main branch — every branch-scoped one is `branches: [main]` and the rest fire only on tags — so a side branch runs nothing else) that looped the exact request 30 times in one job. Attempt 2 of 30:

```
1  total=3168 n=100 first_id=35984047603 first_created=2026-09-24T09:54:04Z
2  total=1366 n=100 first_id=34136482776 first_created=2026-09-07T15:05:43Z
3  total=3168 n=100 first_id=35984047603 first_created=2026-09-24T09:54:04Z
```

`total_count` 1366 against a true 3168. GitHub served a **stale index snapshot** — an older view of the same run history — with HTTP 200 and no header distinguishing it from the correct answer (`cache-control: private, max-age=60, s-maxage=60` on both, distinct `x-github-request-id` on every call).

The fix, proposed in PR #8613 and unmerged as of this writing, stops trusting one read. `readRunListingOnce` keeps the old single-read validation and now also returns the listing's `total_count`; `readNewestRun` samples it `RUN_LISTING_SAMPLES` (3) times and decides in two layers.

**Layer 1 — discard the samples a sibling proves are an older view.** Two comparisons are proof, not opinion: a narrower `total_count` (monotonic while runs are not being deleted), and an empty listing beside a sibling that has runs (a run cannot un-happen). A sample that omits `total_count` is kept — unprovable is not disproved.

**Layer 2 — reduce the survivors on a total order.** `created_at` alone is not one, and the gap is the dangerous kind: a re-run keeps the run id *and* the original `created_at` and only bumps `run_attempt`, which is why `readRunJobs` is attempts-scoped in the first place. A bare `created_at >` lets the first sample read win every tie, so a sample holding attempt 1 (success) outranks one holding attempt 2 (failure) — and the monitor then reads attempt 1's green jobs and reports `DEPLOYED` for a deploy that failed. This is not hypothetical: `deploy-worker.yml` run `29382756713`, one of the three monitored workflows, has attempt 1 `failure` and attempt 2 `success` at the identical `created_at` of `2026-07-15T01:53:51Z`. So the order falls through creation time, then run id, then attempt, then a settled record over a still-active one.

```js
function supersedes(candidate, incumbent) {
  const candidateMs = parseTimestamp(candidate?.created_at);
  const incumbentMs = parseTimestamp(incumbent?.created_at);
  if (candidateMs !== incumbentMs) return candidateMs > incumbentMs;
  if (candidate?.id !== incumbent?.id) {
    return Number(candidate?.id ?? 0) > Number(incumbent?.id ?? 0);
  }
  const candidateAttempt = Number(candidate?.run_attempt ?? 1);
  const incumbentAttempt = Number(incumbent?.run_attempt ?? 1);
  if (candidateAttempt !== incumbentAttempt) return candidateAttempt > incumbentAttempt;
  const candidateActive = ACTIVE_RUN_STATUSES.has(candidate?.status);
  const incumbentActive = ACTIVE_RUN_STATUSES.has(incumbent?.status);
  if (candidateActive !== incumbentActive) return incumbentActive;
  return false;
}
```

Three further rules keep the sampling from creating its own failures:

- **A failing sample cannot discard an answering one.** Each read is wrapped; only a listing *nothing* could read rethrows, which is the pre-sampling behaviour. Without this, tripling the reads tripled the chance that one transport failure threw away an already-observed failed deploy and turned a real alarm into a green UNKNOWN.
- **No verdict of any shape rests on fewer than `RUN_LISTING_ALARM_QUORUM` (2) surviving samples.** Below quorum the tick is UNKNOWN: a warning on a green job, never a claim about the deploy either way. This is what the layer-1 discard actually buys — it does not change which run wins (an older view's newest run loses the ordering anyway), it changes which samples are allowed to *vote*, so convicted reads cannot second a verdict only one read really saw. The gate deliberately covers green as well as alarm: a lone stale sample whose newest run still falls *inside* the window resolves as a found run, and a superseded green attempt then grades `DEPLOYED` — the false-green half, which is the half nobody notices.

  **The quorum reduces this risk; it does not eliminate it.** `total_count` proves a sample is an older view *relative to a wider sibling*. Two samples drawing the same stale shard report the same `total_count`, convict nothing, and can meet quorum together. Nothing in a single response — or in several identical ones — distinguishes a stale shard from the truth; only a wider sibling does.
- **The whole walk has a deadline (`MONITOR_WALL_BUDGET_MS`, 8 min), and a per-workflow sampling budget (`RUN_LISTING_SAMPLE_BUDGET_MS`, 90s) underneath it.** A slow-but-*answering* 5xx is the retryable path, so the samples that cost the most are the ones returning nothing. Every factor is a constant in the file, so the worst case is arithmetic rather than a guess:

  | | | |
  |---|---|---|
  | one attempt | `GH_CALL_TIMEOUT_MS` | 30.0s |
  | one read | 3 attempts + 1.5s backoff | 91.5s |
  | one workflow | 2 listing samples + 1 unbudgeted jobs read | 274.5s |
  | three workflows | | **823.5s** |

  Against a 600s job timeout. The per-workflow budget caps how many samples are paid for but not a read already *in flight*, because it is only checked between samples — which is why the walk needs a deadline of its own. The deadline wraps the callee of the retry wrapper, so it is consulted before every *attempt*, and every workflow past it still gets its own UNKNOWN instead of the runner killing the job with no verdict for anything. A killed job is a red monitor — the exact false alarm this work exists to remove.

Twelve tests pin it (`tests/check-postmerge-deploys.test.mjs`), each verified to go red against the code without its guard. Ten mutations were applied and all ten turned the suite red: reverting the tie-break to a bare `created_at >`, making `supersedes` ignore `run_attempt`, dropping either staleness proof, rethrowing a sibling sample's failure, dropping the quorum, lowering the quorum to 1, lowering the sample count to 2, dropping the wall-clock break, and letting `NO_RUN` skip the quorum.

## Why This Works

Taking the maximum across samples is safe in the only direction that matters. A stale snapshot is an *older view of the same history* — every run in it is a real run that really happened. It can omit recent runs; it cannot invent one. So the newest run across N samples is always a real run, and it is the true newest whenever at least one sample is fresh.

`createRetryingGh` could never have helped. It classifies failures by whether GitHub *answered* — a 404 is an answer, a timeout is not. The stale snapshot is an answer, and a successful one. Nothing in the response body or headers marks it; only comparison against another read does.

**Do not size this from the CI loop's rate.** The 30-read probe showed ~1 in 30 (~3%), but production's own telemetry is the better estimator and it disagrees by 5x: 21 alarms in 120 ticks is ~17% per read. At 17%, three purely statistical samples leave ~0.5% per tick — roughly one false alarm a day, not the ~0.003% the 3% figure suggests. That gap is why the fix does not rest on outvoting: layer 1 turns the common case into a *decision* (a narrower `total_count` is proof), and the quorum makes the residual case fail toward UNKNOWN rather than toward a false page. A tight loop from one runner samples a different population than ticks spread over a day; when both exist, believe production.

Cost is 9 listing reads per tick instead of 3. On the `*/10 * * * *` schedule that is 54 listing reads/hour (5.4% of `GITHUB_TOKEN`'s 1,000/hour per-repo budget), or ~72/hour once the job-listing reads are counted (~7.2%) — before any `workflow_dispatch` or retries, which add to it. Measured against this repo's ~134 workflow runs/hour.

The same defect had a second, worse direction that the fix also closes once merged. Convex Deploy's window is 7 days (`scripts/check-postmerge-deploys.mjs:98`), so a 17-day-old stale run fell outside it and produced a loud false alarm. The other two monitored workflows use 14-day windows, where a stale snapshot can land *inside* the window — and the monitor would then have judged an old green run and reported `DEPLOYED` while a recent deploy actually failed. A false green on precisely the alarm this monitor exists to raise, and one nobody would have noticed.

## Prevention

- **Never derive an alarm — or a green — from one read of the Actions run-listing API.** Sample it and reduce. This generalises past this endpoint: any read whose "nothing here" answer is indistinguishable from "I could not see it" needs corroboration before it becomes a verdict.
- **A monitor's message is a hypothesis; the read is the observation.** When a monitor contradicts directly observable reality, suspect the monitor's input before its logic. The tell here was that it named the *same* run every time — genuine replica lag drifts, a pinned value means a reproducible bad answer.
- **A CI-only anomaly needs a CI-side reproduction.** Push a throwaway workflow to a side branch that loops the exact request 30× and prints the discriminating fields (`total_count` and the first run id). No `push:` trigger in this repo matches a non-main branch — the branch-scoped ones are all `branches: [main]`, the rest are tag-scoped — so a side branch costs one job. Delete the branch afterwards.
- **Read the field that would have revealed it.** The monitor received `total_count` on every call and never looked at it. It is now the primary staleness proof — the difference between outvoting a bad answer and proving it bad. When an endpoint hands you a cheap consistency witness, use it before reaching for statistics.
- **This is the same shape as a silently partial upstream answer**, which this project has hit before in other systems: an API that returns fewer rows than exist, successfully, and a consumer that treats "what I got" as "what there is".
- **Sampling an unreliable read introduces its own failure modes; budget for them.** Three of the defects found while reviewing this fix were created by the fix: a failing sample discarding a good one, an alarm resting on a single surviving sample, and a worst case that outran the job timeout. Redundancy is not free, and each added read is another chance to fail.
- **Sibling readers need the same protection (#8617).** The post-merge, pulse, and Railway monitors share `scripts/lib/gh-run-listing.mjs`: three samples, count and empty-list rejection, two surviving observations, attempt-aware ordering, and a 90-second sampling budget. The pulse monitor leaves an existing issue unchanged on UNKNOWN unless the committed snapshot independently proves staleness. Railway emits an UNKNOWN warning instead of claiming STALE from an unreadable listing, including incomplete pagination. The stacked-merge guard retries an invisible run up to three times and sends its rerun POST only once. These guards cannot detect three identical stale samples; scheduled-run observation remains necessary after merge.

## Related

- [`umami-answers-http-200-when-it-drops-a-bot-write.md`](./umami-answers-http-200-when-it-drops-a-bot-write.md) — the closest root-cause twin: a vendor endpoint answers HTTP 200 while silently dropping the substance, and the alarm built on it inherits the lie.
- [`upstash-max-request-size-counts-one-command-and-answers-http-200.md`](./upstash-max-request-size-counts-one-command-and-answers-http-200.md) — same family, and the same lesson that a diagnostic script built on a successful-looking read names the wrong cause.
- [`actions-cannot-open-a-review-pr-and-the-monitor-realerts-after-the-fix.md`](./actions-cannot-open-a-review-pr-and-the-monitor-realerts-after-the-fix.md) — the other scheduled monitor in this repo that alarmed on a stale view of GitHub state rather than on reality.
- [`../best-practices/checks-must-fail-closed-when-they-lose-their-target.md`](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — the mirror image. That doctrine covers a check that can no longer see its target; this one covers a check that sees a *wrong* target and believes it.

## Related Issues

- #6376 — the issue that created Post-merge Deploy Monitor, after `main` went green while a production deploy failed.
- #6479 — the first time this same monitor needed hardening against GitHub API unreliability, that time a transport blip; fixed by adding `createRetryingGh` and an UNKNOWN vocabulary distinct from ALARM. That retry budget is exactly what cannot see the failure documented here, because a stale snapshot is a success.
- #8613 — the PR carrying this fix.
