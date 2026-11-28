---
title: A shared classify-prompt rule can regress a second caller that no headline gate measures
date: 2026-11-27
category: logic-errors
module: relay-classifier
problem_type: logic_error
component: service_object
severity: high
root_cause: logic_error
resolution_type: code_fix
symptoms:
  - "relay labelled threat statements critical and paged realtime subscribers: 3 threats or vows sent 72 alerts in five days (#11432)"
  - "the fix rule (warnings, threats, vows and predictions are high) passed every headline gate but demoted a real Saudi Civil Defense post reporting the Houthi attack on a Riyadh tower: 39/40 critical on main, 7/40 with the rule, when labelled alone"
  - "the Saudi producer's own unit tests stub the classifier, so nothing committed would have caught the demotion"
  - "hand-written siren posts suggested the rule broke siren alerts; the real channel's early-warning posts were info on every prompt, and the real regression was a different post"
related_components:
  - "saudi-civil-defense-alerts"
  - "classify-eval"
tags:
  - "classifier"
  - "prompt-change"
  - "llm-eval"
  - "realtime-alerts"
  - "saudi-civil-defense"
  - "shared-prompt"
---

# A shared classify-prompt rule can regress a second caller that no headline gate measures

## Problem

`CLASSIFY_SYSTEM_PROMPT` in `scripts/ais-relay.cjs` labels news headlines in batches, and it also labels SaudiDCD Telegram posts. `publishSaudiCivilDefenseAlerts` in `scripts/lib/saudi-civil-defense-alerts.cjs` calls `classifyFetchLlm(posts, MAX_POST_CHARS)` without its own `systemPrompt`. That producer publishes only `high` and `critical`, and realtime delivery is for `critical`. A rule written for news headlines therefore also changes which civil-defense posts page users.

## Symptoms

- In the 7-day score log `shadow:score-log:v5`, threat and vow headlines were labelled critical and delivered ("Israel vows to depopulate 70% of Gaza", 25 deliveries).
- The first fix ("critical needs the event to have happened; a warning, threat, vow, condition or prediction is high") passed the batch-boundary gate and the 50-title suites.
- Labelled alone, the way the Saudi producer usually sends one post, the real post "تعرض أحد أبراج المركز المالي بمدينة الرياض لهجوم إرهابي … نتج عنه (11) إصابة" fell from 39/40 critical to 7/40.

## What Didn't Work

- **Hand-written probe posts.** Synthetic siren posts ("Early warning sirens sounded in Riyadh; residents should go to the nearest shelter") said the rule demoted sirens. The real channel's equivalent post ("A warning has been issued by the National Early Warning Platform … to alert of a potential danger") is `info` on main and on every candidate. It never paged users, so there was nothing to regress. The synthetic set measured a post the channel does not publish.
- **A siren rule in the shared prompt.** "Air-raid sirens or an order to take shelter … is critical" fixed the synthetic sirens. It also promoted flood-evacuation and interception-debris posts, and it would promote news like "South Korea tells island residents to take shelter" to realtime critical. A grep of the score-log dump found 3 such headlines currently labelled high.
- **A Saudi-only prompt suffix** appended after the output format pushed debris and flood posts to critical in single-post batches.
- **Iterating wordings against 8 posts with 2 positives.** Five variants each moved a different neighbour. With 5–10 passes per probe, these differences are noise.

## Solution

Keep the rule and add one example for the case it broke, an attack reported by its target:

```text
- "Officials say the grain corridor could shut within days" → a prediction, not a closure → high
- "Civil defence: a drone attack on an office tower in the capital injured 9" → an attack that happened, reported by the target → critical
```

Pin the second caller with real posts in the shapes it sends (PR #11438):

- `tests/fixtures/classify-saudi-civil-defense-posts.json` holds six real SaudiDCD posts. Their bidi marks are stored as JSON `\u` escapes, because the hidden-Unicode pre-commit check rejects raw marks.
- `scripts/eval-classify-saudi-posts.mjs` labels each post alone at `MAX_POST_CHARS` (`--capture relay-current`). With `--batched` it sends all six in one shuffled completion, as the producer does with several cache misses. Like the producer, it discards an index answered more than once.
- `tests/classify-saudi-civil-defense-posts.test.mjs` pins both captures to the prompt hash, model and clip. It requires the attack post to be critical in at least 36 of 40 passes and every other post to be critical in none.

Results on the shipped prompt:

- Attack post: 40/40 critical alone and 40/40 batched.
- Batch-boundary gate, seed 1: ceasefire warning 0/40 (was 23–24/40), false critical 145 against a threshold of 175, clear-critical kept 976/1017.

## Why This Works

The rule's "reported, not happened" logic made the model hedge on first-party reports. The prompt already said "a report that it happened is critical whoever reports it". The model still treated a government reporting an attack on its own city as an unconfirmed claim until an example showed that case. The example is phrased away from the real post (drone, office tower, 9 injured), so the pinned capture still measures generalisation, not recall of the example.

## Prevention

- Before changing `CLASSIFY_SYSTEM_PROMPT`, list every caller of `classifyFetchLlm` that passes no `systemPrompt` and how it delivers. `grep -n "classifyFetchLlm(" scripts/ais-relay.cjs` finds them. Each one needs a measurement in its own batch shape and text clip.
- Probe with the caller's real inputs, not hand-written ones. For a Telegram producer, read the public `t.me/s/<channel>` page and use those posts at the producer's character limit.
- Before adding a trigger-word rule ("sirens", "take shelter"), grep the score-log dump for the trigger words. If it matches news headlines currently labelled high, the rule will page users.
- A relay prompt or model change fails every suite that pins the prompt hash until the runs it names are re-captured:
  - `tests/fixtures/classify-judged-headlines.json`: `relay-after`, `relay-after-rerun` and `relay-after-run3`.
  - `tests/fixtures/classify-judged-statements.json` and `tests/fixtures/classify-judged-shipping-energy.json`: `relay-after` and `relay-after-rerun`.
  - The held-out set, `tests/fixtures/classify-judged-headlines-heldout.json`: capture only `relay-current` and `relay-current-rerun`. Its `relay-after` runs are frozen by `FROZEN.fixtureSha` in `scripts/lib/jev-heldout.mjs`.
  - Each of those is captured with `node --env-file=.env.local scripts/eval-classify-labels.mjs --path relay --fixture <fixture> --capture <run> --force`.
  - `tests/fixtures/classify-batch-boundary.json`: after a prompt-only change, capture `relay-current` with `scripts/eval-classify-labels.mjs --batch-boundary --capture relay-current --force`, and leave `relay-baseline` alone.
  - A model change, or a change to the judged sets, is a new registration, not a re-capture. The test requires `relay-current` and `relay-baseline` to share a model. The registration captures a fresh `relay-baseline` on the new model and re-derives the threshold and the clear-critical floor from it. It also updates, in `tests/classify-batch-boundary.test.mjs`, the `REGISTERED`, `BASELINE` and baseline-prompt constants, the header record, and the hard-coded per-title list in the test "records the false criticals the baseline already carries". Take the list from the new baseline's counts, which `node scripts/eval-classify-labels.mjs --batch-boundary` prints. Follow the registration notes in that file's header.
  - `tests/fixtures/classify-saudi-civil-defense-posts.json`: `relay-current` and, with `--batched`, `relay-current-batched`, via `scripts/eval-classify-saudi-posts.mjs`.
- Run `node --test tests/classify-*.test.mjs tests/jev-heldout-*.test.mjs` before pushing. The jev-heldout suites run only in CI shards.
