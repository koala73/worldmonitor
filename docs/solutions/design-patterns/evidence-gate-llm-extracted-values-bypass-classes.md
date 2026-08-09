---
title: "Evidence-gating LLM-extracted values: prove the value on the source, then attack the prover"
date: 2026-08-08
category: design-patterns
module: consumer-prices-core extraction pipeline (search adapter, price-evidence gate)
problem_type: design_pattern
component: service_object
severity: high
applies_when:
  - "An LLM extractor returns a scalar (price, count, date) read from content the same call fetched, and downstream treats it as ground truth"
  - "A prompt-only anti-fabrication rule ('never invent a value') is producing false negatives on values that ARE printed on the page"
  - "A schema change makes the extracted field nullable AND required, handing the model a sanctioned null escape hatch"
  - "Designing a deterministic verifier that checks an extracted value against raw content (digit matching, substring proof)"
  - "A guard's abstain path ('could not verify') is behaviorally identical to its pass path"
tags:
  - llm-extraction
  - anti-fabrication
  - evidence-gate
  - regex-verification
  - fail-open-observability
  - scraping
---

# Evidence-gating LLM-extracted values: prove the value on the source, then attack the prover

## Context

WorldMonitor's consumer-price extractor (Firecrawl/Exa structured extraction over retailer pages) went through three failure generations in one week (#6182):

1. **Fabrication era**: a worked numeric example in the extraction prompt became an anchor the model emitted verbatim for priceless pages (#6270) — fabricated observations that passed every downstream gate because the model also echoed the title and currency.
2. **False-negative era**: the fabrication fix hardened the prompt ("never invent, return null") *and* a schema change made `price` nullable+required. Together they handed the extractor a sanctioned null escape hatch, and fleet-wide `missing-price` failures surged the very next scheduled run — the extractor nulled prices that were literally printed on the page (Carrefour BR prints `R$ 7,90` above an out-of-stock notice; prod extracted `null`).
3. **Evidence era** (PR #6343): the prompt was softened back ("a printed price wins, even next to an Out of Stock notice") and safety moved from prompt fear to proof — an accepted price must have its digits present in the rendered content returned by the *same* provider call (`consumer-prices-core/src/adapters/price-evidence.ts`).

The reusable pattern is the third design — plus the bypass classes an 8-persona + cross-model review found in the first draft of the prover itself.

## Guidance

**1. Behavioral rules belong in the prompt; safety belongs in a deterministic gate.** Let the extractor report what it sees ("a printed price wins"), and verify acceptance mechanically: the value's digits must appear in the rendered content captured by the same call (`ExtractResult.pageContent`). A fabricated value has no source digits and dies at the gate regardless of prompt wording.

**2. Ship the evidence in the same provider call that produced the value.** Firecrawl: request `formats: ['extract', 'markdown']` in one render. Exa `/contents`: request `text` alongside the structured `summary`. Evidence fetched separately can come from a different render and prove nothing.

**3. The prover is itself an attack surface — adversarially test it before trusting it.** Three independent reviewers (two model families) found these bypass classes in a first-draft digit matcher, each reproduced live:

- **Split-adjacency digit-stealing**: matching whole and fraction as *separate nearby tokens* (needed for split renders like `49` / `.79` / `AED`) will stitch a price out of unrelated numbers — `priceEvidenceOnPage(49.79, '49 in stock, rated 4.79 by 1200 users')` verified. Guard *both* halves: the whole must not be the integer part of a different decimal (`(?!\d|[.,]\d)`), the fraction must not be lifted out of another number (`(?<!\d)[.,]`).
- **Unit-token collision**: a trailing-letter-tolerant boundary (`(?!\d)`) lets the page's own size token certify a quantity-as-price fabrication — `455` "verified" by `455g`, `1.5` by `1.5L`, `4.6` by `save 4.6%`. Reject unit/percent-suffixed matches explicitly.
- **Same-separator thousands**: generating grouping variants (`1,234` / `1.234`) crossed with both decimal separators accepts non-numbers like `1.234.56`. Pair comma-grouped wholes only with dot decimals and vice versa.

**4. The abstain path must be observable, never silent.** When the provider returns no rendered content the gate cannot run. Passing through is a defensible compatibility choice, but if 'no-content' is byte-identical to 'verified' downstream, a provider quietly dropping content from its responses reverts the whole fleet to unguarded acceptance while every dashboard stays green. Log the abstention per occurrence and persist the verdict (`priceEvidence: 'verified' | 'no-content'`) in the stored payload so an audit — or a later health rule — can see the gate's live coverage.

**5. Presence is not attribution — keep the other gates.** The evidence check proves the digits exist *somewhere* in the content; a carousel price or "was" price also passes. Title plausibility, currency, and size/validator checks carry attribution. The evidence gate's single job is making values-with-no-source impossible.

## Why This Matters

Prompt-only anti-fabrication is a bistable failure: tighten the wording and the model nulls real values (a coverage collapse that looks like source rot); loosen it and fabrications flow into the dataset (worse than missing data in a price index). A deterministic evidence gate breaks the bistability — the prompt can be permissive because acceptance requires proof. But a naive prover silently converts "proof" into "coincidence": on digit-rich commerce pages (counts, ratings, sizes, carousels), an unguarded matcher verifies almost any plausible fabrication. The bypass classes above came from a *reviewed, tested* first draft — they are the default state of a digit matcher, not an exotic edge.

## When to Apply

- Any pipeline that persists LLM-extracted scalars from fetched content: prices, stock counts, dates, statistics, quotes.
- When a "never invent" prompt rule is suspected of causing false negatives — check whether the field is schema-nullable+required; that combination is the escape hatch.
- When reviewing an evidence/verification matcher: probe it with digit-stealing, unit-suffix, and mixed-separator inputs before trusting a green suite that only tests distance and happy paths.
- When a guard has an abstain path: ask "if this guard silently stopped running fleet-wide, what signal would fire?" If the answer is none, add the signal before shipping.

## Examples

Rejected (fabrication-shaped) vs accepted, from `consumer-prices-core/src/adapters/price-evidence.test.ts`:

```ts
// Digit-stealing: fabricated 49.79 must not verify from count + rating furniture
expect(priceEvidenceOnPage(49.79, '49 in stock, rated 4.79 by 1200 users')).toBe('unverified');
// Unit collision: the page's size token is not price evidence
expect(priceEvidenceOnPage(455, 'Tesco Bread 455g loaf')).toBe('unverified');
// Locale-inconsistent separators are not numbers
expect(priceEvidenceOnPage(1234.56, 'ref 1.234.56 item')).toBe('unverified');

// Legitimate split render (whole and fraction in separate DOM nodes) still passes
expect(priceEvidenceOnPage(49.79, 'Jumbo Pack 68 Diapers\n\n49\n\n.79\n\nAED')).toBe('verified');
// OOS page with a printed price is a real observation (price + inStock=false)
expect(priceEvidenceOnPage(7.9, 'Leite Integral 1 Litro\n\nR$ 7,90\n\nOps! sem estoque')).toBe('verified');
```

Observable abstention (`consumer-prices-core/src/adapters/search.ts`): the gate's `'no-content'` outcome warn-logs `[search:price-evidence] … evidence gate skipped` and stamps `priceEvidence` into the persisted `rawPayload`, so verified and unchecked acceptances are distinguishable forever after.
