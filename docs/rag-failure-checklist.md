# RAG Failure Checklist for LLM-based Monitoring

This page provides a lightweight checklist for debugging suspicious LLM-generated summaries in monitoring workflows.

When a summary looks wrong, the failure usually comes from one of three stages:

1. retrieval
2. deduplication
3. summary generation

The goal is to narrow the failure mode quickly, reduce guesswork, and make follow-up fixes more repeatable.

## How to use this checklist

1. Start from the visible symptom, not from assumptions.
2. Decide which stage is most likely responsible: retrieval, deduplication, or summary.
3. Match the symptom to one or more failure patterns below.
4. Run the first check before changing prompts, feeds, or logic.
5. Only then decide whether the fix belongs in source selection, merge logic, or summarization rules.

## Pipeline view

### Retrieval

This stage decides which source items enter the working set.

Typical failures here:
- the right source never enters the context
- the wrong source is selected
- time ordering is distorted
- related facts are split across boundaries

### Deduplication

This stage decides which items are treated as the same event.

Typical failures here:
- one event is split into several duplicates
- several different events are merged too early
- aliases cause cross-region or cross-organization confusion
- repeated aggregator copies drown out primary reporting

### Summary generation

This stage turns the working set into a readable narrative.

Typical failures here:
- the summary drifts away from the evidence
- unsupported conclusions appear
- ambiguity is hidden instead of surfaced
- analysts cannot easily trace why the conclusion was produced

## 16 common failure patterns

| No. | Failure pattern | What it looks like in monitoring | Primary stage | First check |
| --- | --- | --- | --- | --- |
| 1 | Stale source selected | An older article is presented as if it were current breaking news | Retrieval | Verify publication time, recency sorting, and update timestamps |
| 2 | Relevant source missed | A key actor, location, or development is missing from the summary | Retrieval | Check source coverage, filters, and fetch scope |
| 3 | Chunk boundary split | Cause and consequence appear disconnected or incomplete | Retrieval | Review chunking boundaries and context window size |
| 4 | Temporal context lost | Event order is reversed or escalation timing is misread | Retrieval | Compare timestamps across all contributing items |
| 5 | Entity lookup mismatch | Similar places, agencies, or organizations are confused at intake | Retrieval | Check alias normalization and entity matching rules |
| 6 | Source weighting imbalance | One noisy or repetitive source dominates the result | Retrieval | Review enabled feeds and per-source frequency |
| 7 | Same event split into duplicates | One incident appears multiple times as separate events | Deduplication | Compare titles, URLs, timestamps, and near-duplicate clusters |
| 8 | Different events merged together | Separate incidents are collapsed into one story | Deduplication | Inspect merge threshold and clustering keys |
| 9 | Regional alias collision | Similar country, city, or region names are merged incorrectly | Deduplication | Compare geographic tags and alias handling |
| 10 | Organization name collision | Similar institutions or companies are treated as the same entity | Deduplication | Check canonical naming and entity resolution |
| 11 | Conflicting reports collapsed too early | Uncertainty disappears before the evidence is settled | Deduplication | Preserve conflicting sources until confidence improves |
| 12 | Repeated aggregator dominance | Syndicated copies overpower the original reporting | Deduplication | Separate wire copies and aggregator mirrors from primary sources |
| 13 | Long-summary drift | The narrative gradually moves beyond what the sources support | Summary | Compare each sentence against the source set |
| 14 | Unsupported conclusion | The summary adds claims not directly supported by evidence | Summary | Mark claims that cannot be traced to source text |
| 15 | Ambiguity hidden | Unclear actors, timing, or locations are presented too confidently | Summary | Surface uncertainty explicitly instead of forcing resolution |
| 16 | Missing audit trail | It is hard to explain why the final conclusion was produced | Summary | Keep source attribution and an inspectable reasoning path |

## Quick examples

### Example 1: an old article looks like breaking news

If a summary treats an older article as a new escalation, the first suspects are:

- No. 1 Stale source selected
- No. 4 Temporal context lost

Start by checking publication time, sort order, and whether newer articles were available but excluded.

### Example 2: similar events from different countries are mixed together

If reports from different regions are collapsed into one event, the first suspects are:

- No. 8 Different events merged together
- No. 9 Regional alias collision
- No. 10 Organization name collision

Start by reviewing merge logic, geo labels, and canonical entity handling.

### Example 3: a long brief becomes more confident than the evidence

If a multi-source summary slowly becomes more speculative than the underlying inputs, the first suspects are:

- No. 13 Long-summary drift
- No. 14 Unsupported conclusion
- No. 15 Ambiguity hidden
- No. 16 Missing audit trail

Start by tracing each conclusion back to the source set and marking where uncertainty was dropped.

## Minimal triage flow

When a summary looks suspicious:

1. Ask whether the problem started before summarization.
2. If the wrong inputs entered the context, focus on retrieval.
3. If the right inputs entered but were merged incorrectly, focus on deduplication.
4. If the inputs look correct but the narrative is wrong, focus on summary generation.
5. Record the failure pattern before making changes, so future incidents can be compared consistently.

## What to adjust after diagnosis

### If retrieval is the main problem

Review:
- source selection
- recency rules
- chunking boundaries
- alias normalization
- feed weighting

### If deduplication is the main problem

Review:
- duplicate clustering thresholds
- canonical entity mapping
- geo matching rules
- handling of conflicting reports
- treatment of aggregator copies

### If summary generation is the main problem

Review:
- summary length
- claim-to-source traceability
- uncertainty handling
- attribution visibility
- constraints that prevent unsupported synthesis

## Scope of this page

This is a diagnostic aid, not a replacement for product logic.

It does not change retrieval, deduplication, or summarization behavior by itself.
It provides a shared vocabulary for investigating suspicious outputs in a more repeatable way.
