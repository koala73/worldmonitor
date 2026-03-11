# RAG Failure Checklist

A lightweight troubleshooting guide for World Monitor users who rely on AI summaries, AI deduction, or Headline Memory (RAG) and want a structured way to debug suspicious output.

This guide adapts the ideas from the **WFGY ProblemMap** to common World Monitor workflows: live news summarization, multi-source geopolitical analysis, and browser-local retrieval over recent headlines.

For the full 16-problem reference, see the canonical WFGY map:

- <https://github.com/onestardao/WFGY/blob/main/ProblemMap/README.md>

## When to use this checklist

Use this page when a World Monitor result feels wrong, for example:

- a stale story is described as breaking news
- two countries, cities, or organizations with similar names are mixed together
- a long AI summary slowly drifts away from the underlying headlines
- an explanation sounds confident but does not clearly map back to visible source material
- retrieved headlines are individually relevant, but the final conclusion is still off

The goal is not to prove that the model is "bad". The goal is to quickly isolate **where the failure entered the pipeline**: source selection, retrieval, entity resolution, prompt scope, or final synthesis.

## Fast triage flow

Start with the smallest possible audit before changing prompts or model settings:

1. **Check the raw headlines first**
   - Are the cited or visible stories actually about the same event?
   - Are any articles obviously stale relative to the current situation?
   - Did near-duplicate headlines crowd out an important dissenting source?
2. **Check entity resolution**
   - Are similar names being conflated (country, city, leader, company, militia, or ministry)?
   - Is the summary mixing one region's development with another because the wording overlaps?
3. **Check retrieval scope**
   - Did Headline Memory return semantically similar items that are contextually wrong for the user's question?
   - Is the query too broad, causing the model to combine multiple neighboring stories into one narrative?
4. **Check reasoning drift**
   - Does each sentence in the answer still map to a visible source, or does the write-up become more speculative as it gets longer?
   - Are causal claims stronger than what the headlines support?
5. **Check explainability**
   - Can the analyst point to the exact source items behind the conclusion?
   - If not, treat the answer as a draft hypothesis and re-run with a narrower scope.

## Failure patterns that show up in World Monitor

### 1. Hallucination or chunk drift

**What it looks like:**

- the summary introduces a claim that is not present in the source headlines
- a real headline is stretched into a stronger claim than the source supports
- one partially relevant article causes the whole summary to tilt in the wrong direction

**World Monitor example:**

A cluster of headlines about sanctions, troop exercises, and a diplomatic statement becomes a summary claiming that a military operation has already begun, even though none of the visible sources confirm that.

**Checks:**

- compare every major claim with the visible headline list
- look for one weakly related article that may have anchored the wrong interpretation
- reduce the input set to only the top 5-10 most relevant stories and compare outputs

### 2. Long reasoning chain drift

**What it looks like:**

- the first paragraph is grounded, but later paragraphs become increasingly speculative
- the model blends several adjacent developments into one clean narrative arc
- the conclusion sounds polished but outruns the evidence

**World Monitor example:**

A multi-country regional brief starts from real border incidents, then gradually turns into a confident forecast about alliance behavior or escalation timing without enough supporting evidence in the feed.

**Checks:**

- ask whether each paragraph can be tied back to a specific source cluster
- shorten the question to a single geography or a shorter time horizon
- prefer a bullet summary over a long narrative when evidence is fragmented

### 3. Semantic similarity is not factual equivalence

**What it looks like:**

- retrieved items are "about the same kind of thing" but not the same event
- similar terms cause unrelated stories to be merged
- the model confuses entities with overlapping labels or roles

**World Monitor example:**

Headline Memory retrieves stories about different conflicts, regions, or companies because the language pattern is similar, and the final answer treats them as one continuous thread.

**Checks:**

- inspect whether retrieved headlines share the same actors, place, and date window
- watch for country-name collisions, organization aliases, and similar city names
- tighten the query with a location, actor, or date constraint

### 4. Black-box debugging failure

**What it looks like:**

- the answer may be plausible, but the analyst cannot explain why the system produced it
- there is no simple audit trail from conclusion back to sources
- repeated reruns produce different framing without making the error source obvious

**World Monitor example:**

An analyst sees a strong geopolitical conclusion in the Deduction Panel, but cannot tell whether it came from live headlines, old cached context, loosely related retrieved items, or the model filling gaps on its own.

**Checks:**

- restate the task in terms of explicit evidence: "summarize only what the listed headlines support"
- ask for bullet-point attribution by source item or claim
- treat unexplained confidence as a signal to narrow the task, not to trust the answer more

## Analyst checklist

When a result looks suspicious, walk through this list in order:

- **Source freshness** — are any inputs stale, duplicated, or off-topic?
- **Entity matching** — are the people, places, and organizations actually the same?
- **Scope control** — is the question too broad for the evidence available?
- **Retrieval precision** — did semantic search pull in "similar" but wrong context?
- **Claim traceability** — can each important claim be tied to a visible source?
- **Speculation creep** — does the conclusion go beyond what the sources justify?

If one of those checks fails, fix that layer first before changing providers or prompt wording.

## Suggested debugging prompt

If you want a second-pass diagnosis from an LLM, give it the suspicious output plus the underlying headlines and ask for a structured audit.

Example prompt:

> You are auditing a World Monitor AI summary. Classify the failure, if any, using this checklist: hallucination/chunk drift, long reasoning chain drift, semantic similarity not factual equivalence, or black-box traceability failure. Quote the exact headline(s) that support each major claim, flag unsupported claims, and suggest the smallest scope reduction that would make the answer safer.

## Practical guidance for World Monitor users

- Prefer **shorter, more specific prompts** when the situation is fast-moving.
- For regional questions, verify that the input set is not mixing **neighboring but distinct events**.
- When using Headline Memory, include an explicit **place, actor, or timeframe** in the query.
- If the answer matters operationally, export or copy the relevant headlines and do a **manual claim-to-source pass** before sharing the summary onward.

## Why this helps

World Monitor already exposes a lot of raw evidence: live headlines, source labels, country context, and retrieved items. This checklist gives analysts a shared vocabulary for discussing what went wrong without requiring any product changes.

That makes incident review faster, team handoffs clearer, and future prompt tuning more disciplined.
