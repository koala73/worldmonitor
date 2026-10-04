---
title: "Every quotable homepage answer carries its own build-measured figure"
date: 2026-10-02
category: best-practices
module: "pro-test welcome page GEO citability (en.json, welcome.html, prerender.mjs, depth-stats.json; PR #8784)"
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - "Editing a question-headed passage (H2 answer paragraph, FAQ answer, CTA) on the pro-test welcome page"
  - "Acting on a GEO/citability audit row that asks for a specific figure in each section"
  - "Adding any inventory count (feeds, providers, layers, tools, chokepoints) to marketing copy or llms.txt"
  - "Changing pro-test/src/locales/en.json strings, which stales the other 27 locales and can move the pro bundle budget"
related_components:
  - tooling
  - testing_framework
tags: [geo, citability, faq-jsonld, i18next-interpolation, depth-stats, volatile-inventory-claims, prerender, translate-locales, bundle-budget]
---

# Every quotable homepage answer carries its own build-measured figure

## Context

A third-party GEO (generative-engine optimization) audit flagged rows CIT-02/CIT-03: "add one specific figure to each section, starting with 'How do I start watching the world map?'". Taken literally, that asks for a number in every section. What the rows actually mean for WorldMonitor:

- Answer engines (AI Overviews, ChatGPT search, Perplexity) quote **one passage**, not the page. A stat rail next to an answer is not part of the passage, so it is never quoted with it. A figure published elsewhere on the page does not travel with the answer; the passage written to be quoted has to carry its own.
- A **question-headed passage** an answer engine could lift (H2 answer paragraph, FAQ answer, the CTA question) should answer its question in the first sentence, and when its answer makes a countable claim, the measured figure belongs **inside the passage**. Navigation-only sections are exempt, and so are answers with nothing to count (for example "Do I need an account?").
- **Current coverage, not a guarantee.** As of #8784 and #8787, the passages that carry figures are: the definition, the correlation subhead, the builders paragraph and its MCP bullet, the CTA, and FAQ `a3`, `a4`, `a6` (fixed constants) and `a7`. The other seven FAQ answers carry no figure. The test in Guidance §4 checks only the definition, CTA and builders passages, so extend it when another passage gains a figure.
- The audit's priority was off. The CTA ("How do I start watching the world map?") mattered least. The real gap was "What is World Monitor?", the highest-demand entity question, whose definition had no measured inventory figure.

The obvious fix, typing "461 feeds" into the copy, does not work here. Inventory counts change on main, and the repository rejects hand-typed counts in public copy (see Guidance §2).

PR #8784 fixed this by templating every figure from a generated facts file and verifying the passages at prerender and test time.

## Guidance

### 1. Put figures in passages as i18next tokens, not literals

Locale strings in `pro-test/src/locales/en.json` use `{{token}}` placeholders whose keys match the generated depth-proof stats:

- `welcome.hero.whatIsBody` uses `{{feeds}}`, `{{providers}}`, `{{mapLayers}}`
- `welcome.moments.sub` and `welcome.cta.subtitle` use `{{mapLayers}}`
- `welcome.agents.sub` and `welcome.agents.b1` use `{{mcpTools}}` (the `agents.sub` paragraph gained it in #8787, because the bullet alone sat outside the answer paragraph)
- FAQ `welcome.faq.a3`, `a4` and `a7` use `{{providers}}`, `{{chokepoints}}` and `{{mcpTools}}`

Keys are cited here rather than line numbers, because every copy edit shifts the lines.

Components pass the generated JSON as the interpolation object:

- `pro-test/src/welcome/Hero.tsx:201`: `t('welcome.hero.whatIsBody', depthProofStats)`
- `pro-test/src/welcome/FinalCta.tsx:18`: `t('welcome.cta.subtitle', depthProofStats)`
- `pro-test/src/welcome/Agents.tsx:45`, `pro-test/src/welcome/Moments.tsx:35`, `pro-test/src/welcome/FAQ.tsx:35`: same pattern

`depthProofStats` is `pro-test/src/generated/depth-stats.json`. It is emitted by `scripts/generate-public-product-facts.mjs:229` from `buildDepthProofStats` (`scripts/generate-public-product-facts.mjs:188`), which measures each figure from the source registries (for example `mcpTools: TOOL_REGISTRY.length`, `chokepoints: CHOKEPOINT_REGISTRY.length`) and throws on any non-positive-integer value.

Constants that do not drift ("15 minutes", "$0", "2M+", "AGPL-3.0") may stay literal.

### 2. Tokens are required, not a nicety

`scripts/docs-stats.mjs` runs `validateVolatileInventoryClaims` (`scripts/docs-stats.mjs:1348`) using `VOLATILE_INVENTORY_CLAIM_RE` (`scripts/docs-stats.mjs:1221`). The regex is a union of English, word-number, hyphenated, label-first, table, Chinese and Japanese count patterns (`:1212-1220`). Its scan roots include `pro-test/src/locales`, `pro-test/welcome.html` and the `public/` llms files (`ACQUISITION_CLAIM_ROOTS`, `:1226`); `docs/solutions/` is excluded, which is why this doc may quote counts. A hand-typed "461 news feeds" in any of those files fails the check.

### 3. Keep the FAQPage JSON-LD on the same tokens and fill it at prerender

The FAQPage JSON-LD in `pro-test/welcome.html` mirrors the FAQ strings by hand. Its FAQ answers now carry the same `{{token}}` text as the locale strings. `pro-test/prerender.mjs` loads `depth-stats.json` into `PROOF_FACTS`. `fillProofFacts` replaces each known token and calls `process.exit(1)` if a placeholder stays unfilled. The page loop calls it on the template before the SSR markup is spliced in, so third-party headline text never reaches the substitution.

### 4. Lock the property with a test, not a review note

`tests/pro-welcome-prerender.test.mjs` asserts:

- each JSON-LD answer equals the filled en locale string, and no raw `{{x}}` reaches the built page (`:40-58`)
- the "What is World Monitor?" passage contains `${feeds} news and OSINT feeds from ${providers} attributed providers` and `${mapLayers} map layer types`, the CTA passage contains its figure and names the Resilience exception, and (from #8787) the builders paragraph contains `${mcpTools} live tools`; the test named "question-headed welcome passages state their own measured figures" states the rule
- the definition stays 40–60 words (`:309`)

### 5. Fact-check the sentence around every new figure

Adding a figure invites a precise claim next to it, and the precise claim can be wrong. It took two rounds to get the #8784 copy true.

An independent copy review before merge caught two:

- An FAQ draft said alerts fire only when independent origins corroborate. The code has no corroboration rule; `src/services/breaking-news-alerts.ts:62-64` defines `RECENCY_GATE_MS` (15 min), `PER_EVENT_COOLDOWN_MS` (30 min) and `GLOBAL_COOLDOWN_MS` (60 s).
- A CTA draft said all layer types are "live on first load". `DEFAULT_MAP_LAYERS` (`src/config/variants/full.ts:58`) enables only a subset.

The bot reviews on #8784 (Greptile, CodeRabbit), which were only answered after merge, caught three more in the shipped copy. #8787 corrects them:

- **The `a6` rewrite still listed five alert origins.** The `origin` type in `breaking-news-alerts.ts` names five, but only two producers ever raise the banner: classified news items through `checkBatchForBreakingAlerts`, and OREF sirens through `dispatchOrefBreakingAlert`. The other three are type members nothing emits. Verify a claim against the call path that runs, not against a type union or a doc table.
- **`a6` said every origin passes the same gates.** The siren path checks only the 30-minute duplicate key; it skips the age gate and the cooldown. `isGlobalCooldown` also lets a critical alert through a cooldown that followed a non-critical one.
- **The CTA promised every counted layer free to switch on.** `resilienceScore` is `premium: 'locked'` in `src/config/map-layer-definitions.ts`. A count that includes a Pro-only member needs the exception named next to it.

The hero rail and depth band still publish "5 · Independent alert origins" from a literal in `buildHeroProofStats`. That stat predates #8784; whether to change it is an open product decision raised on #8787.

## Why This Matters

- **Answer engines cite passages.** A figure only earns a citation if it sits in the passage being quoted. A rail beside the passage is never quoted with it.
- **The copy stays correct without edits.** On 2026-10-02 production (checked with curl against www.worldmonitor.app) rendered "86 live tools" and "86 MCP tools". The copy was written when the count was 84. Main re-measured, `depth-stats.json` now reads `"mcpTools": 86`, and the page followed with no copy change.
- **Hand-mirrored JSON-LD cannot drift.** The prerender exit and the test turn "the schema says 84 while the page says 86" into a build failure.
- **Specific claims get checked.** Five false claims reached a quotable homepage passage across the two review rounds. Three of them shipped, because the bot reviews were not answered before merge.

## When to Apply

- Any new or edited question-headed passage, FAQ answer, or CTA on the welcome page, or any copy that ships in `llms.txt`.
- Any audit request to "add a statistic" to a section. First decide whether the section is a quotable answer (do it) or navigation (skip it), then rank by question demand rather than audit order.
- Any count of feeds, providers, layers, tools, chokepoints, languages and the like. If the count is not already in `depth-stats.json`, add it to `buildDepthProofStats`; do not type it.

### Landmines to clear in the same PR

1. **Word budget.** The "What is World Monitor?" definition must be 40–60 words (`tests/pro-welcome-prerender.test.mjs:309`). The first draft had 63.
2. **27 stale locales.** Changing en strings makes every other pro-test locale stale. Key-existence checks will not catch it; see `docs/solutions/logic-errors/key-existence-checks-cannot-detect-stale-translations.md`. Run `node scripts/translate-locales.mjs --pro-test` (needs `ANTHROPIC_API_KEY`; Haiku translator; usage at `scripts/translate-locales.mjs:20`). Then run `python3 scripts/convert-zh-tw.py`, because `zh-TW.json` is generated from Simplified Chinese (`scripts/convert-zh-tw.py` lines 3 and 194). Check that every locale kept every `{{token}}`.
3. **The translator changes meaning, so back-translate.** Haiku rendered "classified news" as "secret news" (機密ニュース) in Japanese, so rewrite ambiguous English before translating. Clear English is not enough, though. Greptile found cs and tr calling every chokepoint a strait, and hu turning military "surge" into "reduction". For #8787, an independent model back-translated all 9 changed strings in 27 locales and found 26 more meaning errors, which were corrected by hand. Examples: de said news alerts must be *older* than 15 minutes, tr said every layer except Resilience is switched *off*, it, ro and ru dropped "free", and hr rendered "cooldown" as "refrigerator". The pass also found stray Cyrillic letters inside Latin-script words. A token-preservation check passes on all of these. Only a meaning check catches them.
4. **Pro bundle budget.** The retranslation added 32.4 KB across the lazy per-language chunks (the CI `bundle:check:pro` report on #8784). That exceeds `TOTAL_TOLERANCE_BYTES = 16384` (`scripts/bundle-budgets.mjs:84`), so `bundle:check:pro` failed in CI job `unit-built-output`. Reseed `scripts/shared/bundle-budgets-pro.json` with `npm run bundle:budgets:pro` (`package.json:63`) from a CI-parity build: build pro with `SENTRY_AUTH_TOKEN` empty, and build the dashboard with `VITE_VARIANT=full ./node_modules/.bin/vite build` after moving `.env`/`.env.local` aside. In this session, a build with the local env present measured +44.5 KB instead of the +32.4 KB CI reported. See `docs/solutions/workflow-issues/vite-bundle-budget-seed-requires-env-clean-build.md`.

## Examples

**CTA subtitle (`welcome.cta.subtitle`)**

Before:
> While you read this page it kept moving — straits, hotspots, markets, curated feeds. One of them is tomorrow's front page. Find it first — free, no account.

After (#8787):
> Open worldmonitor.app/dashboard in any browser, with no account: {{mapLayers}} map layer types, every one except Resilience free to switch on. Click any country for its brief, or press ⌘K / Ctrl-K for the command palette. The map has kept updating while you read this page.

The first sentence answers the question ("open this URL"), the figure sits inside the passage, and the claim matches both `DEFAULT_MAP_LAYERS` (types are switchable, not all on) and the Pro lock on Resilience.

**Entity definition (`welcome.hero.whatIsBody`)**
> World Monitor is a free, open-source (AGPL-3.0) dashboard used by 2M+ people. It streams {{feeds}} news and OSINT feeds from {{providers}} attributed providers onto one live world map with {{mapLayers}} map layer types, ...

It renders with the current `depth-stats.json` (`feeds: 461`, `providers: 757`, `mapLayers: 57`). The literals "2M+" and "AGPL-3.0" pass the volatile-claim scan because they are not inventory counts.

**Wrong:** `"It streams 461 news feeds..."`. `validateVolatileInventoryClaims` rejects it, and if it slipped through it would go stale on the next registry change.

## Related

- `docs/solutions/workflow-issues/vite-bundle-budget-seed-requires-env-clean-build.md` — the budget reseed trap in landmine 4.
- `docs/solutions/logic-errors/key-existence-checks-cannot-detect-stale-translations.md` — why changed English needs the baseline-driven retranslation in landmine 2.
- `docs/solutions/architecture-patterns/a-section-on-two-discovery-surfaces-needs-one-renderer-and-an-idempotent-splice.md` — the neighbouring fail-closed generated-block pattern for `llms.txt`.
