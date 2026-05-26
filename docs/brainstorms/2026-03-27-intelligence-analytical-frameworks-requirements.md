---
date: 2026-03-27
topic: intelligence-analytical-frameworks
---

# Intelligence Analytical Frameworks

## Problem Frame

WorldMonitor's AI intelligence panels (WorldBrief, Country Brief, Market Brief) generate analysis using a single neutral LLM prompt. Users who want to apply structured analytical lenses — Ray Dalio macroeconomic cycles, Buffett value frameworks, adversarial geopolitical equilibrium models — have no way to do so. Every user gets the same generic framing regardless of their decision-making context. This limits the depth and usefulness of the intelligence layer for sophisticated users and reduces differentiation for premium tiers.

## Requirements

- **R1.** Each AI intelligence panel (WorldBrief, CountryBrief, MarketBrief, and panels to be confirmed during planning) displays a framework selector in its header toolbar.
- **R2.** The selector always includes a "Default (Neutral)" option plus all frameworks in the user's skill library.
- **R3.** A curated built-in skill library ships with a minimum of 5 analytical frameworks, including at minimum: Ray Dalio Macroeconomic Cycles, Buffett Value & Risk Framework, and an Adversarial Geopolitical Equilibrium model. The full list is defined during planning.
- **R4.** When an active framework is selected, its analytical instructions augment the LLM prompt for that panel's intelligence generation — shaping how events are interpreted through that lens.
- **R5.** Switching a framework on a panel immediately triggers a fresh analysis with the new lens applied; the panel updates in place.
- **R6.** Framework selection per panel persists across sessions.
- **R7.** Premium users can import additional frameworks from agentskills.io by entering a skill URL/ID or by pasting a compatible skill definition; imported skills are saved to the user's skill library.
- **R8.** The skill library is accessible and manageable (view, rename, delete) from the Settings panel.
- **R9.** Non-premium users see the default neutral analysis only. The framework selector is visible but locked, with an upgrade prompt.

## Success Criteria

- A premium user can switch CountryBriefPanel to the Ray Dalio framework and receive an analysis structured around economic seasons, risk parity, and root-cause diagnosis rather than neutral summarization.
- A custom skill can be imported from agentskills.io, saved to the library, and applied to a panel within the same session.
- Switching frameworks triggers a re-analysis within the same latency window as a normal panel refresh.
- Non-premium users encounter a locked selector with a clear upgrade CTA — not a hidden feature.

## Scope Boundaries

- agentskills.io `tools` (callable functions) are **not executed** in this phase; only the `instructions` field is used for prompt augmentation.
- Framework selection applies only to AI intelligence panels, not to MCP data panels.
- No server-side skill execution in this phase.
- No community marketplace or cross-user skill sharing in this phase.
- One framework active per panel at a time (no stacking).

## Key Decisions

- **Per-panel selection over global:** Different panels serve different contexts (macro vs. country vs. market); a single global lens would be too blunt.
- **Auto re-run on switch:** Waiting for a manual refresh creates confusion about whether the framework is applied; immediate re-analysis makes the effect visible and the feature feel alive.
- **Premium only:** Framework extensibility is a differentiated capability that justifies the premium tier; neutral analysis remains available to all.
- **Instructions-only from agentskills.io (phase 1):** Tool/function execution requires server-side orchestration and is a meaningful scope expansion; deferring keeps this phase lightweight and shippable.

## Dependencies / Assumptions

- The existing summarization/LLM prompt chain supports prompt augmentation at the panel level (to be confirmed during planning).
- agentskills.io skills can be fetched or pasted as JSON/YAML and their `instructions` field extracted.

## Outstanding Questions

### Resolve Before Planning

_(none blocking — proceed to planning)_

### Deferred to Planning

- [Affects R1][Technical] Which additional panels beyond WorldBrief/CountryBrief/MarketBrief should support framework selection? (DeductionPanel, GdeltIntelPanel candidates)
- [Affects R4][Technical] Where in the LLM prompt chain is the framework injected? (system prompt prepend, separate layer, or alongside existing instructions)
- [Affects R7][Needs research] How are imported skills persisted for premium users — localStorage only, or synced to backend? Evaluate cost/complexity tradeoff.
- [Affects R3][Needs research] Finalize the built-in framework list: confirm Ray Dalio, Buffett, Geopolitical Equilibrium; evaluate Sun Tzu / conflict theory, psychohistory (Seldon/Dalio hybrid), and others from issue #2291.

## Next Steps

→ `/ce:plan` for structured implementation planning
