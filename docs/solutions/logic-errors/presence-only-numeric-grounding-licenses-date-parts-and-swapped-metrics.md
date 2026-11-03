---
title: Presence-only numeric grounding licenses date parts, the scale, and swapped metrics
date: 2026-09-23
category: logic-errors
module: shared/brief-llm-core.js, shared/brief-claim-rules.js, server/worldmonitor/intelligence/v1/get-country-intel-brief.ts, scripts/crawlable-developments.mjs
problem_type: logic_error
component: brief_system
severity: high
symptoms:
  - "A claim citing the fact text 'score of 62.3 of 100, in the Elevated band, as of Sep 23, 2026' passed the numeric validator while stating 'score of 23 of 100', 'score of 100' or 'scores 2026'"
  - "A claim citing 2 data points (CII 62.3, fiscal space 28) passed with the values swapped between the metrics"
  - "The server validator and the corpus publish gate disagreed: a claim citing 2 headlines passed the server and withheld the whole country brief at the gate"
root_cause: missing_validation
resolution_type: code_fix
related_components: [testing_framework]
tags: [llm-hallucination, output-validation, numeric-grounding, evidence-binding, country-brief, crawlable-corpus, shared-rules]
---

# Presence-only numeric grounding licenses date parts, the scale, and swapped metrics

## Problem

The evidence-grounded country brief (PR #8548) validates each LLM claim against the World Monitor data points it cites. The numeric check it first used, `validateNoHallucinatedFacts` in `shared/brief-llm-core.js`, only asks whether each number in the claim appears somewhere in the ground text. That let invented scores through whenever the digits happened to exist elsewhere in the cited text.

## Symptoms

- `extractNumericFacts` turns a date into both a date fact and its components as bare numbers. The fact text "as of Sep 23, 2026" yields `number:9`, `number:23` and `number:2026`, so "a score of 23 of 100" is grounded by the as-of day.
- "62.3 of 100" also yields `number:100`, so "a score of 100" passes.
- With 2 data points cited, the ground is the union of both fact texts, so "28" and "62.3" can trade places between the metrics.
- The corpus publish gate (`briefCitationGroundingGap`) checked a claim citing `[1][2]` against each title separately, while the server checked the joined titles. Claims the server published got whole briefs withheld on the page.

Reproduced in the session with a node probe before the fix:

```js
validateNoHallucinatedFacts(
  'Egypt has a Country Instability Index score of 23 of 100.',
  'Egypt has a Country Instability Index score of 62.3 of 100, in the Elevated band, as of Sep 23, 2026.',
); // { ok: true }
```

## What Didn't Work

- Checking numbers against the cited fact texts only (instead of headline titles) closed the headline-to-evidence laundering path ("85 killed" in a headline licensing "CII is 85"), but not date parts, the scale, or cross-metric swaps: all of those digits live inside the cited evidence itself.
- Changing `extractNumericFacts` was rejected: the digest brief validators rely on date components matching prose such as "in 2026".

## Solution

`shared/brief-claim-rules.js` binds numbers to the data point that owns them, for claims that cite evidence:

- Whole dates in the claim (the "Sep 23, 2026" forms fact texts use, plus ISO dates) must match a date fact in a cited fact text. They are then blanked, so their parts can never license a number.
- The "X of 100" scale is stripped back to X before numbers are read.
- Every remaining number must equal the cited item's own value (the first number in its `value` field), and a numeric claim may cite only a single data point that carries a value. Swaps become impossible. The prompt tells the model to put each data point's number in its own sentence.

```js
evidenceNumbersGrounded('Egypt has a Country Instability Index score of 23 of 100.', [cii]); // false
evidenceNumbersGrounded('Egypt has a Country Instability Index score of 62.3 of 100 as of Sep 23, 2026.', [cii]); // true
evidenceNumbersGrounded('Egypt scores 28 of 100 on the Country Instability Index and 62.3 of 100 on fiscal space.', [cii, fiscal]); // false
```

The same module holds `isEvidenceLimitClaim`, which drops sentences about the material ("the supplied headlines do not establish this") rather than about the country. The server renderer (`get-country-intel-brief.ts`) and the corpus gate (`scripts/crawlable-developments.mjs`) both import it. For evidence-format briefs the gate now checks a claim once against everything it cites, as the server does. Section headings moved to `shared/brief-sections.js` for the same reason.

## Why This Works

A presence check answers "does this digit exist in the evidence?", not "is this the value the claim attributes to this metric?". Binding each number to the single cited item's `value` field, after removing the date and scale tokens that are not values, makes the check answer the second question. Putting the rules in a single shared module removes the class of bug where the generator and the downstream gate each re-implement "grounded" and drift.

## Prevention

- Tests in `tests/brief-claim-rules.test.mjs` pin the date-part, scale and swap cases. `tests/country-intel-brief-sources.test.mjs` pins the same through the renderer, and includes a render-then-parse round trip: the server's rendered text parsed by `parseBriefSections` must yield the same sections and claims.
- When a fixture's as-of day or month equals the invented number, the test proves the binding. The earlier "23 of 100" rejection passed only because the fixture date was Aug 29.
- Any new consumer that re-validates brief claims imports `shared/brief-claim-rules.js` rather than composing `brief-llm-core` validators itself.

## Related Issues

- [recall-only-grounding-cannot-see-an-invented-status-qualifier.md](recall-only-grounding-cannot-see-an-invented-status-qualifier.md): the status-qualifier validator this brief also applies (#8441).
- [../design-patterns/evidence-gate-llm-extracted-values-bypass-classes.md](../design-patterns/evidence-gate-llm-extracted-values-bypass-classes.md): the digit-stealing bypass class this is an instance of.
- PR #8548 (evidence-grounded country brief), found by the adversarial and cross-model code review passes.
