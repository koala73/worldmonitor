---
title: "Pre-register a classifier go/no-go before the candidate answers the held-out set"
date: 2026-09-25
category: best-practices
module: "Headline threat classification eval (#8478, #8336)"
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "Deciding whether a new classifier or model replaces an incumbent labeller on a human-judged set"
  - "Scoring a candidate against captured incumbent runs where the set must not be tuned on"
tags: [classify, jev, held-out, pre-registration, go-no-go, eval, alert-precision]
---

# Pre-register a classifier go/no-go before the candidate answers the held-out set

## Context

#8478 asked whether Jev (`jev-1.13.0`) plus an easing/violence/commentary Noul veto could replace the #8341 relay as the headline labeller. It was scored on the held-out human-judged set from #8363 (`tests/fixtures/classify-judged-headlines-heldout.json`). Once the candidate has answered that set, nothing about the rule can change without tainting it: the next change would be tuned on those labels, and a new human set would be owed.

Three things went wrong or nearly went wrong before any Jev answer existed (PR #8625):

- **The planned predicate was unwinnable.** The plan said Jev's worst run must beat the relay's best run on both the full set and the clear-cut slice. Both captured relay runs are at 100% alert precision on the clear-cut slice, so nothing could beat them there. The implementing agent found this only by pushing the relay's own runs through the scorer.
- **A three-model adversarial review (Opus, Fable, Sonnet) found four more holes:**
  - The run count was not pinned, so one lucky run could return GO.
  - The capture was tied only to the question text. The thresholds, the arm code and the judged fixture could move under it.
  - The eval retried timeouts and 5xx three times, where production gives up. Titles production would leave unanswered got answered.
  - An unanswered title could never be a false alert, so up to 5% of skipped titles raised precision for free.
- **The veto's criteria were never committed.** They survived only in a local session transcript from 2026-09-18.

## Guidance

Freeze these in one commit and push it before the first paid run on the held-out set:

1. **Score the incumbent through the exact predicate first.** Where the incumbent sits at a ceiling (100% precision, 0 misses), "beat" is impossible. Use non-inferiority there ("hold": no worse than the incumbent's worst run). Keep "beat" for the slice where improvement is possible. #8625 uses beat on the full set and hold on the clear-cut slice (`SLICE_RULE` in `scripts/lib/jev-heldout.mjs`).
2. **Name one primary arm.** Diagnostic arms are reported but never decide. Three arms that could each pass are three tries at GO.
3. **Pin the run count and pair the runs.** `JEV_RUNS = ['jev-1', 'jev-2']` is paired index-wise with `RELAY_RUNS`. `verdict()` returns INCOMPLETE for any other set of runs, so a bad run cannot be dropped and a lucky one cannot be added.
4. **Pin every input the verdict reads, and check it at import.** The module computes three SHAs and refuses to load if they differ from literals in the file:
   - the question set;
   - the rule, which covers the thresholds, arm and run names, and the source text of the scoring functions;
   - the fixture, which covers titles, judge, borderline and the relay runs' labels.

   The capture stores all three, plus the freeze commit taken from git.
5. **Use production's transport, and score unanswered titles as production would.** The level request calls production's `fetchJevLabel`. A title with no candidate answer takes the paired incumbent run's label, because a candidate labeller would fall back to the incumbent there. Refuse to capture only on systemic failure (more than 5% unanswered, or any 401/403).
6. **Recover off-tree criteria by script, never by hand.** The Noul text was extracted from the transcript and diffed against the committed module, with an empty diff. The transcript held a shorter earlier draft; the measured version was the one the scoring script had written to disk.
7. **Post the frozen SHAs on the issue before running.** The comment's timestamp is the public record that the rule preceded the answers.

## Why This Matters

The verdict was NO-GO on every condition. On the full set, `jev-veto` scored 67.9% precision and missed 20 of 39 alerts, against the relay's 85.4% and 4–5 missed. On the clear-cut slice it scored 92.9% and missed 13 of 26. Because the rule was frozen and published first, nobody can argue the threshold was chosen to produce that answer. Without the ceiling fix, the result would have been NO-GO no matter what Jev said. Without the fallback rule, unanswered titles could have produced a GO.

The run also exposed a design conflict worth knowing before the next veto attempt. The `worsening` Noul lists "an agreement reached" among its false criteria. The #8341 rubric calls a major announcement or approval `high`. Greenland security-deal headlines, judged `high`, account for 12 or 13 of the veto's 20 misses. A veto that treats deals as easing cannot pass a rubric that pages on them. That question is open in #8336.

## When to Apply

- Any go/no-go that replaces an incumbent classifier, labeller or ranker on a human-judged set.
- Any eval where the judged set is meant to stay out of sample.
- Before the first paid run, not after the first result.

## Examples

Reproduce the verdict offline, with no key:

```bash
node scripts/eval-jev-heldout.mjs
# VERDICT jev-veto: NO-GO
#   full: worst jev-veto precision 67.9% is not above best relay 85.4%; worst jev-veto run missed 20, worst relay run 5
#   clearCut: worst jev-veto precision 92.9% is below worst relay 100.0%; worst jev-veto run missed 13, worst relay run 1
```

The check to run before freezing (item 1): feed the incumbent's captured runs and a synthetic perfect candidate through `verdict()`. If the perfect candidate fails a slice, the predicate is wrong for that slice.

## Related

- #8478 (the pre-registration comment and the verdict), PR #8625, #8363 (held-out set), #8341 (incumbent), #8336 (epic)
- [Source-label RRF needs independent corroboration before ranking promotion](source-label-rrf-needs-independent-corroboration.md), another promotion decision recorded against a replayable set
