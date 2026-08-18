---
title: "tesco.com anti-bot block starves GB consumer-prices coverage — fix the roster, not the configs"
module: consumer-prices-core ingestion
date: 2026-08-10
category: integration-issues
problem_type: integration_issue
component: background_job
severity: high
symptoms:
  - "GB consumer-price coverage dropped to COVERAGE_DEGRADED: tesco_gb read 1/12 pages on 2026-08-09 and 0/12 on 2026-08-10, failure reasons {provider-cooldown: 9, provider-error: 3}"
  - "Firecrawl /v1/scrape returned HTTP 500 SCRAPE_ALL_ENGINES_FAILED on every engine (index, chrome-cdp, retry, stealth proxy) for tesco.com"
  - "Exa's crawler stored no page content for tesco.com product URLs — 163-char shells with price null — so the exa extraction fallback was equally dead"
  - "ocado_gb stayed healthy in the same runs, proving the provider accounts were fine and the blockage was domain-specific to tesco.com"
root_cause: missing_validation
resolution_type: seed_data_update
related_components: [service_object, testing_framework]
tags: [consumer-prices, retailer-roster, firecrawl, exa, anti-bot, fallback-independence, coverage-degraded, coverage-floor, seed-freshness, gb]
---

# tesco.com anti-bot block starves GB consumer-prices coverage — fix the roster, not the configs

## Problem

The GB consumer-prices market fell below its coverage floor and blocked the ingestion acceptance gate: `consumerPricesCoverageGB` escalated from its baselined `COVERAGE_PARTIAL` to `COVERAGE_DEGRADED` (records=2), because tesco.com had started blocking every acquisition route we have — both Firecrawl and Exa — so the tesco_gb retailer contributed nothing while still occupying a third of the GB roster's page budget. The fix was roster surgery (disable tesco_gb, onboard probed replacements morrisons_gb and waitrose_gb), shipped in PR #6442 (issue #6358; the PR is open, not yet merged, as of this writing).

## Symptoms

- Seed Freshness Monitor / ingestion acceptance gate red on `consumerPricesCoverageGB=COVERAGE_DEGRADED`, an escalation past the baselined `COVERAGE_PARTIAL` entry (`scripts/seed-freshness-baseline.json:40-45`). The health classifier grades a market degraded when its completion ratio drops below the floor (`api/health.js:1796-1812`), `MIN_MARKET_COMPLETION_RATIO = 0.5` (`consumer-prices-core/src/ops/coverage.ts:13`).
- tesco_gb page counts: 1/12 on 2026-08-09, then 0/12 on 2026-08-10, with failure reasons `{provider-cooldown: 9, provider-error: 3}`.
- Railway scrape logs: every `provider-error` detail was `Firecrawl extract failed: HTTP 500` (the thrown non-OK path in `consumer-prices-core/src/acquisition/firecrawl.ts:157`) for tesco.com URLs across both days, on both the pin path and the discovery path — while ocado_gb extractions in the SAME runs succeeded. Account healthy; block is domain-specific.
- The 9 `provider-cooldown` entries were not a client bug (the issue's initial hypothesis was a client-side backoff defect). They are the half-open cooldown gate doing its job against a hard-down route: two consecutive transport failures open the gate, the next 4 attempts are skipped without a network call, then one probe is allowed through (`consumer-prices-core/src/adapters/provider-cooldown.ts:21-67`); each skipped attempt is recorded as a `provider-cooldown` failure (`consumer-prices-core/src/adapters/search.ts:440-443`).

## What Didn't Work

- **`extractionFallback: exa`** — probed *before* configuring it, and correctly rejected. Exa's crawl of tesco.com has no page content (see the live probe below): the fallback would only convert `provider-error` into `missing-price`, because the fallback shares the blocked resource — the target site itself, not the provider — with the primary. This is the standing "a fallback sharing an upstream is not a fallback" lesson, instantiated: `search.ts:434-435` would happily push `exa` as a second provider, and it would fail for the same upstream reason every time.
- **Firecrawl's stealth proxy tier** — probed live with `proxy: "stealth"` and again with `proxy` + `location: GB`: same HTTP 500 `SCRAPE_ALL_ENGINES_FAILED`, now through `fire-engine;chrome-cdp;stealth`. The block outranks Firecrawl's best evasion tier.
- **Re-enabling sainsburys_gb** — its disable note ("disabled 2026-03: Exa returns 'no pages found'", `consumer-prices-core/configs/retailers/sainsburys_gb.yaml:8`) is stale: discovery NOW works. But Firecrawl extraction still returns an empty ~2.5k-char shell (no product name, no price), so it cannot rejoin the roster. Stale disable notes cut both ways: the recorded reason was wrong, and yet the disable was still correct for a different reason.

## Solution

**1. Fingerprint the block with live probes that mirror the production request bodies.** Both probes reuse the exact shapes the adapters send, so the verdict is the seeder's verdict, not a reimplementation's:

```
# Firecrawl — mirrors FirecrawlProvider.extract() (firecrawl.ts:140-155)
POST https://api.firecrawl.dev/v1/scrape
{ "url": "<tesco.com product URL>", "formats": ["extract","markdown"],
  "extract": { "schema": ..., "prompt": ... }, "timeout": 30000 }
-> HTTP 500 SCRAPE_ALL_ENGINES_FAILED, engines tried [index, chrome-cdp, retry]
-> retried with "proxy": "stealth" (and proxy + GB location): same, via fire-engine;chrome-cdp;stealth

# Exa — mirrors ExaProvider.extract() (exa.ts:99-103)
POST https://api.exa.ai/contents
{ "urls": ["<same tesco.com URL>"], "summary": { "query": ..., "schema": ... },
  "text": { "maxCharacters": 30000 } }
-> HTTP 200, but 163 chars of stored text, price null (Exa's crawler has no content for the domain)

# Control — Firecrawl on an ocado.com product URL -> HTTP 200
```

That trio — Firecrawl `SCRAPE_ALL_ENGINES_FAILED` including stealth, Exa `/contents` returning an empty text shell, a healthy control domain on the same account — is the fingerprint of an unscrapeable domain. No retailer-config tuning can fix it.

**2. Roster surgery, probe-then-onboard.** For each GB grocer candidate, ran domain-restricted Exa discovery AND a Firecrawl extract on a discovered URL before writing any config: morrisons clean on both; waitrose clean; asda/iceland extraction OK but discovery noisy; sainsburys still extraction-blocked. Config diffs:

- `consumer-prices-core/configs/retailers/tesco_gb.yaml` — `enabled: false`, with the evidence and re-probe instructions in the comment (lines 8-16) so a future session doesn't re-diagnose from scratch or blindly re-enable.
- `consumer-prices-core/configs/retailers/morrisons_gb.yaml` — new, `requireStrictValidator: true` from day one.
- `consumer-prices-core/configs/retailers/waitrose_gb.yaml` — new, `requireStrictValidator: true` plus `searchType: keyword` with `numResults: 10` / `maxExtractionCandidates: 4`: Exa's neural ranking drifts to adjacent products on waitrose.com (sugar query -> bread flour, eggs -> pork mince) while keyword search returns the exact product — the same failure shape and fix as `jiomart_in.yaml:19`.

**3. Verified with the repo's own full-pipeline diagnostic** (`consumer-prices-core/src/adapters/extraction.diag.ts`, run with real creds per its header: `EXA_API_KEYS=... FIRECRAWL_API_KEY=... npx tsx src/adapters/extraction.diag.ts <slug>` — it drives the real SearchAdapter, so its verdict is the seeder's): morrisons 11/12 pages; waitrose 6/12 under neural -> 8/12 under keyword.

**4. Review-round hardening (cross-model reviewers):**

- **Strict validator on BOTH new retailers.** In shadow (non-strict) mode a wrong-size accept — Kohinoor 10kg basmati accepted for the 1kg item, Evian 12x330ml for "Still Water 6x1.5L" — still increments `pagesSucceeded` (`consumer-prices-core/src/jobs/scrape.ts:341`) while its match is stored `matchStatus: 'candidate'` (`scrape.ts:316-317,331`), which the aggregate query excludes (`match_status IN ('auto','approved')`, `consumer-prices-core/src/jobs/aggregate.ts:52`). Market coverage can therefore read healthy while contributing zero aggregate-eligible prices. Strict mode rejects the wrong size and escalates to the next candidate URL (the per-target loop at `search.ts:807`). Re-run diagnostics kept the same page counts with the wrong products self-correcting (10kg basmati -> Morrisons 1kg @ 1.79).
- **Deliberately did NOT acknowledge COVERAGE_DEGRADED in `scripts/seed-freshness-baseline.json`.** Three independent reviewers of PR #6442 (cross-model Codex adversarial, in-process adversarial, correctness) converged on the same reasoning: acknowledging DEGRADED would keep the gate green even if this remediation failed (until the global `expiresAt`), while dropping the existing PARTIAL entry would re-red the monitor on mere transition noise. Keeping main's PARTIAL-only entry (`seed-freshness-baseline.json:40-45`) means DEGRADED keeps blocking until recovery is actually observed in production.
- **New real-config parse gate** (`consumer-prices-core/src/config/loader.test.ts:20-52`): every other config-layer test mocks the loader, yet `scrape.ts`/`publish.ts` call the real one uncaught — before this test, a malformed retailer YAML would pass CI green and crash the whole scrape/publish job for all markets. The suite parses the actual `configs/retailers/*.yaml` directory through the zod schema, pins slug-filename agreement, and checks every enabled retailer's market has a basket.

**5. Roster math.** Measured baselines: ocado 11/12 + morrisons 11/12 + waitrose 8/12 = 30/36 = 0.83, comfortably above the 0.5 floor (`coverage.ts:13`). Worst-case single-retailer death: 19/36 = 0.53 — survivable but thin, which is why GB now carries three retailers instead of two, and why a second simultaneously-degraded GB retailer should be treated as a page-worthy event.

## Why This Works

The root cause was never in our client: tesco.com blocks the fetch infrastructure of *both* acquisition providers at the domain level, so every code-side lever — retry shape, cooldown tuning, extraction fallback, proxy tier — either re-asks the same blocked upstream or converts one failure label into another. The cooldown gate behaved exactly as designed for a hard-down route; the `extractionFallback` could not help because Exa and Firecrawl are different *fetchers* of the same blocked *site*, i.e. the fallback shares the failed upstream. The only variable actually under our control is which domains sit in the roster, so the durable fix is substituting scrapeable retailers — validated by probing both providers per domain *before* enabling the config, and measured through the production adapter path.

The hardening makes the recovery honest rather than cosmetic: strict validation closes the gap where `pagesSucceeded` (the coverage numerator) and aggregate eligibility (`match_status IN ('auto','approved')`) can diverge, and leaving the DEGRADED status un-baselined means the gate only goes green when production runs prove the new roster works — the gate verifies the remediation instead of trusting it.

## Prevention

- **Learn the unscrapeable-domain fingerprint** and check it before onboarding or diagnosing any retailer: Firecrawl `SCRAPE_ALL_ENGINES_FAILED` including the stealth tier + Exa `/contents` returning empty text for the domain (with a healthy same-account control domain) = the domain is blocked. Fix the roster; do not tune configs.
- **Probe BOTH providers per domain before enabling a retailer config** — domain-restricted Exa discovery and a Firecrawl extract on a discovered URL. A retailer that passes only one provider inherits a single point of failure on day one.
- **`requireStrictValidator: true` from day one for new search-adapter retailers.** Shadow mode lets wrong-size accepts inflate `pagesSucceeded` while their candidate matches never reach aggregates — coverage that looks healthy and feeds nothing.
- **Disable notes on retailer configs go stale — re-probe before trusting them** (sainsburys' 2026-03 note cited a discovery failure that no longer exists, while a different blocker did). Write disable notes with the evidence and explicit re-probe instructions, as done in `tesco_gb.yaml:8-16`.
- **Never rebaseline a degraded status to clear a gate while its remediation is in flight.** Keep the pre-incident baseline entry; let the escalated status block until recovery is observed in production.
- A structurally related exposure was flagged during the #6182 review round (session history): a fleet-wide loss of provider page content silently disables the anti-fabrication evidence gate while health stays green — the "no-content abstention" path. The tesco.com block is the single-domain version of that scenario; if a whole provider ever goes content-less, expect the same green-while-blind shape at fleet scale.

## Related Issues

- Issue #6358 (GB coverage degraded); fixed by PR #6442 (open, unmerged at the time of writing). Parent: #6355.
- #6182 / #6185 — the half-open provider cooldown whose skip entries were initially misread as a client backoff bug (`consumer-prices-core/src/adapters/provider-cooldown.ts:1-19`), and the evidence-gate era of the same acquisition layer: `docs/solutions/design-patterns/evidence-gate-llm-extracted-values-bypass-classes.md` (prior chapter of this saga — internal fabrication defense vs this doc's external blocking).
- Standing lesson: "a fallback sharing an upstream is not a fallback" — this incident is the canonical acquisition-provider instance.
- `consumer-prices-core/configs/retailers/jiomart_in.yaml:11-26` — the searchType keyword precedent for Exa neural index drift.
