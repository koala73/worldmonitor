---
title: "Source-label RRF needs independent corroboration before ranking promotion"
date: 2026-08-02
category: best-practices
module: "Digest and World Brief ranking (#5991, Epic #5981)"
problem_type: best_practice
component: digest_ranking
severity: medium
applies_when: "Evaluating source-vote or reciprocal-rank-fusion ordering for a delayed news digest"
status: reject-naive-source-label-rrf
tags: [ranking, reciprocal-rank-fusion, corroboration, syndication, freshness, replay-log]
---

# Source-label RRF needs independent corroboration before ranking promotion

## Decision

**Reject promotion of the current naive source-label reciprocal-rank-fusion (RRF) candidate. Defer any RRF-based ranking change until the reconsideration prerequisites below are met.** This is a decision about the candidate method, not a rejection, closure, or comment on issue [#5991](https://github.com/koala73/worldmonitor/issues/5991).

This record makes the discovery result durable. It does not implement ranking, add a ranking abstraction, change runtime configuration, or expand into [#5992](https://github.com/koala73/worldmonitor/issues/5992).

## User surface and failure

The affected surface is the delayed WorldMonitor Brief/digest ranking that feeds the user's capped story cards and digest notifications. The ranking is supposed to keep high-importance, fresh developments visible while grouping related stories.

The failure mode is **syndication being counted as independent corroboration**. In the fixed sample, a Spain–Morocco story has 18 hydrated feed labels and 42 merged title variants, but `entityCorroborationCount=0` because the configured entity-level heuristic did not fire. A raw source-label vote treats that breadth as ranking evidence and moves it from baseline position 12 to RRF position 3. The same candidate removes a fresh 2.26-hour-old score-63 story and a 5.17-hour-old score-69 story from the top 12. That is a user-visible freshness and quality regression, not evidence that the Spain–Morocco event deserves promotion.

## Evaluation contract

- **Primary outcome:** preserve high-importance, fresh, distinct developments in the capped top 12 while retaining the existing topic-grouping quality. The measured proxies are current score, publication age, top-N displacement/order changes, and the repository's existing labeled quality report when labels exist.
- **Minimum acceptable result:** no regression in mean score or publication freshness, no displacement of fresher higher-scoring stories without a measured quality or user-outcome gain, and no promotion justified only by syndicated feed-label breadth.
- **Opportunity cost:** implementing or flipping naive RRF now would spend ranking, replay, and operational-validation capacity on a candidate that lacks publisher-family evidence and a remote-embedding shadow lane. Deferring preserves the current user surface while the missing evidence is collected.

## Fixed representative sample

The comparison was rerun read-only on 2026-08-02 against the retained production replay data:

| Field | Value |
| --- | --- |
| Replay key | `digest:replay-log:v1:full:en:all:2026-07-31` |
| Fixed tick | `full:en:all:1785540882342` (`2026-07-31T23:34:42.342Z`) |
| Retained records / ticks in the day key | 100,000 / 137 |
| Selected tick | 675 records, 418 dedup representatives |
| Score floor / primary pool | `DIGEST_SCORE_MIN=63` / 30 reps |
| Topic-grouped baseline | 14 topics, 3 multi-member topics, 17 reps with cached vectors |
| User-facing cap under evaluation | 12 stories (`DIGEST_MAX_STORIES_PER_USER=12`) |

The replay record fixes the tick, representative set, source labels, merged hashes, scores, and embedding cache keys/availability. It does not persist vector payloads or a vector digest: the current harness stores `embeddingCacheKey` and `hasEmbedding`, then hydrates whatever vector is currently available under that key. The comparison is therefore reproducible only within the cache-backed rerun window; a durable replay needs a vector snapshot or digest, or an explicit statement that the comparison is scoped to that window. The record does not persist `publishedAt`; the publication ages below are therefore a read-only join to the current `story:track:v1` rows for those fixed hashes. They are evidence for this rerun, not immutable replay fields.

### Baseline top 12

The baseline is the existing score-floor, 30-item pool followed by the current embedding topic-grouping order. It is the ordering that the candidate must improve without sacrificing freshness or quality.

| Rank | Story (shortened) | Score | Age (h) | Feed labels | Merged variants | Entity corr. |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | As diplomacy falters, US-Iran war expands | 96 | 14.11 | 39 | 49 | 2 |
| 2 | US stands on the brink of a regional war | 63 | 2.26 | 1 | 1 | 0 |
| 3 | Poland reacts after apparent Russian missile breaches NATO airspace | 69 | 8.47 | 4 | 4 | 0 |
| 4 | Russia and Ukraine report casualties as they continue to trade attacks | 68 | 9.20 | 3 | 3 | 0 |
| 5 | Russia’s Africa Corps killed Mali civilians in air strike | 68 | 19.58 | 3 | 3 | 0 |
| 6 | Sudan civil war: When drones strike the classroom | 66 | 8.95 | 1 | 1 | 0 |
| 7 | Former Gov. Sylva allegedly became coup convert | 81 | 10.18 | 1 | 1 | 0 |
| 8 | Gaza disarmament / Board of Peace claim | 79 | 24.36 | 18 | 30 | 2 |
| 9 | Trump says US has not agreed to Ukraine Patriot missiles | 77 | 0.98 | 5 | 2 | 0 |
| 10 | Croatia’s war-crimes prosecutions are stagnating | 71 | 8.85 | 1 | 1 | 0 |
| 11 | Nigerian soldiers killed 102 suspected terrorists | 69 | 5.17 | 1 | 1 | 0 |
| 12 | Spain–Morocco border clashes | 68 | 11.82 | 18 | 42 | 0 |

Baseline top-12 means are **72.92 score** and **10.33 hours publication age**. The existing quality report for this tick reports `quality_score=0.321`, 14 topics, and no labeled cluster/separate pairs evaluated. It does not establish a quality win for a new ranking method.

## Corroboration is not syndication

The sample has three different signals that must not be collapsed into one vote:

- `sources` in the replay record are hydrated feed labels such as `BBC World`, `Reuters World`, or `AP News`. They are not a publisher-family or ownership map, and several labels can represent the same wire story or syndication chain.
- `mergedHashes` are the title-identity members already merged into one representative. A large value is evidence of repeated identity variants, not independent reporting.
- `entityCorroborationCount` is the existing narrow entity-level signal. Within the 24-hour freshness window, it fires only for configured diplomacy/flashpoint entity-action pairs or the generic diplomacy-flashpoint key, and only when at least two distinct feed sources hit the same key. It is closer to independent event corroboration, but it is not a complete publisher-independence truth set: zero means the configured heuristic did not fire, not that independent reporting is absent.

For the two diagnostic cases:

| Story | Feed labels | Merged variants | Entity corr. | Baseline → RRF | Interpretation |
| --- | ---: | ---: | ---: | --- | --- |
| Spain–Morocco border clashes | 18 | 42 | 0 | 12 → 3 | Syndication breadth is being mistaken for corroboration; the configured entity-level heuristic did not fire (`0`), which is not evidence that independent reporting is absent. |
| Gaza / Board of Peace claim | 18 | 30 | 2 | 8 → 2 | Existing corroboration exists, but the candidate also promotes a 24.36-hour-old story. |

## Candidate comparison

The candidate is intentionally naive standard RRF with `k=60`:

```text
RRF(story) = Σ over feed labels L of 1 / (60 + rank of story within L)
```

Each feed-label list ranks the 17 score-floor representatives by a deterministic order: `currentScore` descending, then stable `repHash` ascending; ranks are 1-based before applying RRF. The fixed tick was rerun read-only with this order; all 17 representatives had cached vectors, and the reported top 12 and metrics below remain unchanged. This is an offline comparison only; no runtime path uses it.

| Metric | Existing topic-grouped baseline | Naive source-label RRF | Delta |
| --- | ---: | ---: | ---: |
| Top-12 mean score | 72.92 | 72.83 | -0.09 |
| Top-12 mean publication age | 10.33 h | 11.86 h | +1.53 h older |
| Top-12 overlap | — | 10 / 12 | 2 stories displaced |
| Shared-story moves | — | 9 | — |
| Pairwise inversions on shared top 12 | — | 19 | — |
| Feed labels represented in the 17-rep pool | — | 54 | — |

The RRF top 12 is: **Iran/US (96), Gaza (79), Spain–Morocco (68), Ukraine Patriot (77), Poland/NATO (69), DeepSeek V4 (63), Russia–Ukraine (68), Mali (68), Netflix/Fortitude (68), Sylva (81), Croatia (71), Sudan (66)**. It drops the fresh `US stands on the brink of a regional war` story and the 5.17-hour-old Nigerian story while promoting source-label-heavy clusters.

The result fails the required non-regression direction: lower mean score, older mean publication age, displaced fresh stories, and no labeled quality evidence. The source-label and merged-variant counts also do not prove independent corroboration.

## Current ranking and embedding state

The current `origin/main` at refresh is `ab798e6284544e42749a3b62be73c0044dfa5f9d`. Relevant ranking behavior is unchanged by the refreshed base: `DIGEST_DEDUP_MODE=embed`, single-link event clustering at cosine `0.60`, entity veto enabled, then score floor 63, primary pool 30, and existing topic grouping at threshold `0.45` before the user cap of 12. `shared/story-identity.js` remains an edit-tolerant lexical identity seam with a replaceable vectorizer; it is not a semantic-ranking implementation.

The production embedding path is the existing cached OpenRouter `text-embedding-3-small` 512-dimensional vector path. The 17 fixed-sample representatives all had cached vectors. The repository has no consumer for `DIGEST_DEDUP_REMOTE_EMBED_ENABLED`; production currently exposes that variable as `1`, but there is no separate remote-embedding shadow lane, comparison writer, or effective flip state to observe. The effective state is therefore **no remote-embedding rollout**.

At the same production refresh, `DIGEST_DEDUP_REPLAY_LOG=0`, so the frozen sample remains readable but no new replay coverage can be claimed. The `digest-notifications` Railway service was reported queued/stopped with its latest build waiting for a slot; the last successful deployment was not the refreshed `origin/main` SHA. This is operational residual state, not evidence to promote a ranking change.

## Reject and reconsideration gates

Reject a source-label RRF candidate when any of these are true:

- mean score or publication freshness regresses against the existing baseline;
- a candidate promotes a story because of repeated feed labels or merged title variants without independent corroboration evidence;
- fresh, higher-scoring stories leave the fixed top-N without a measured quality or user-outcome gain;
- the comparison has no labeled ranking/relevance outcome and no representative multi-tick replay evidence.

Reconsider only after all of the following are available:

1. A source-to-publisher-family/syndication map or an equivalent existing project signal that can distinguish independent reporting from repeated distribution.
2. Replay records that preserve publication time, the source-independence fields needed by the comparison, and either immutable vector snapshots/digests or an explicit cache-backed validity window, with the existing replay harness's required multi-day coverage rather than one selected tick.
3. Labeled story-ranking outcomes or an existing user-quality signal. Do not substitute invented thresholds, hand-picked stories, or source-label counts.
4. A held-out comparison against the current topic-grouped baseline covering score, freshness, independent corroboration, and labeled quality, with non-regression rules and the deterministic ranking/tie contract declared before the run.
5. A separate outcome review before any runtime or configuration proposal. This discovery record does not authorize such a proposal.
6. An operationally verified shadow or equivalent validation lane for the candidate, with deployment health, error/freshness monitoring, comparison-output availability, and rollback criteria recorded. If the lane or any required evidence is absent, fail closed and do not propose a runtime or configuration change.

## Final decision

**Reject the current naive source-label RRF candidate; defer RRF promotion.** Keep the existing ranking path and gather the prerequisites above before reopening the method. Issue #5991 remains open and discovery-only; this record does not satisfy or change #5992's prerequisite because #5992 is a separate blocked implementation issue.
