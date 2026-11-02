---
module: comparison-pages
date: 2026-10-16
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Adding or rewriting a /compare/ page that states facts about a competitor (price, plan, MCP support, latency, licence, coverage)"
  - "Changing one vendor's cell on any generated comparison matrix or in comparison narratives"
  - "CI, code review and bot review are green but no step has opened the vendor's own pages"
symptoms:
  - "PR #9149 passed CI, a multi-persona code review and two review bots, yet a live-page check of 114 competitor claims found 43 needing correction"
  - "Compare pages said Recorded Future MCP was unverified while its hosted MCP server was generally available and the repo's own blog guide already documented it"
  - "After the shortlist was fixed, the same vendor's cells still disagreed across the hub, vs, alternatives, travel and MCP pages"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components: [testing_framework, documentation]
tags: [comparison-pages, fact-check, vendor-claims, source-ledger, cross-page-drift, crawlable-corpus, shortlist, mcp, review-gap]
---

# Competitor claims on comparison pages need a per-claim source ledger before shipping

## Context

PR #9149 rebuilt `/compare/best-geopolitical-risk-dashboards/` as a ranked 2026 shortlist of eight platforms (World Monitor, Dataminr, Recorded Future, Seerist, Crisis24, Factal, Liveuamap, Off-Nadir Delta). The seed data, validator, and renderer live in `scripts/comparison-shortlist.mjs`. The PR passed CI, a multi-persona code review, CodeRabbit, Greptile, and the author's own rule that every competitor price has a linked source.

A claim-by-claim fact check against live vendor pages then tested 114 competitor claims: 71 CONFIRMED, 24 PARTLY WRONG, 12 WRONG, 7 UNVERIFIABLE. 43 needed corrections (36 wrong or partly wrong, plus 7 with no supporting source). The worst errors:

- **Recorded Future** made its hosted MCP server generally available on 2026-09-28, after a pilot (`https://mcp.recordedfuture.com/mcp`, per its support article "Recorded Future MCP Overview"). The page said "We have not verified an MCP server", and the hub and vs pages showed `Unverified`. The repo's own guide `blog-site/src/content/guides/best/intelligence-apis-for-developers.md:57` already said "Recorded Future documents ... MCP tools", so the compare pages contradicted the blog.
- **Off-Nadir Delta** was listed as free, open-source, self-hosted imagery tooling. It is a hosted, proprietary event-intelligence service with a hosted OAuth 2.1 MCP. Only its thin MCP client and SDK are Apache-2.0. Its pricing FAQ says "The Free and Starter plans are for personal, educational, and non-commercial use", so commercial use starts at $59/mo, not $0.
- **Dataminr**: "alerts arrive in seconds to minutes" had no source. Its published SLA (`dataminr.com/legal/sla`) commits to 99% monthly availability, not alert speed. The per-seat and "enterprise alert archive" claims were also unsupported.
- **Recorded Future G-Cloud**: "six-figure per-licence sums" appears in no listing. The real listings are £7,650/user, £10,125/user/yr and £67,500/instance/yr.
- **Liveuamap**: "conflict events only" was wrong, because the site also reports protests, disasters and weather.

CI, persona review and bot review had all passed by then; none of them checks an external fact. The errors surfaced only when the live-page check ran before merge, and the corrections landed in the same PR.

## Guidance

**1. Treat external claims as untested until a ledger proves them.** CI, persona review and bot review check code, not vendor websites. A "linked source" rule proves that a URL exists, not that the page says what we claim. Before you ship or materially edit a `/compare/` page, build a claim ledger with one row per claim:

| Field | Content |
|---|---|
| Claim + location | Exact text and `file:line` |
| Source | URL actually fetched |
| Source says | Verbatim quote |
| Verdict | CONFIRMED / PARTLY WRONG / WRONG / UNVERIFIABLE |
| Correction | Replacement wording |

Save every raw fetch (HTML, text dump, browser snapshot) to disk next to the ledger. The PR #9149 ledger was kept as an uncommitted working file; it opened with its method, a verdict key, a tally and the headline findings, followed by a table for each vendor:

```
| # | Line | Claim | Source | Source says | Verdict | Correction |
| D3 | 157 | "Its alerts arrive in seconds to minutes" | dataminr.com, AWS listing | Vendor says "real-time" and "earliest"; it gives no latency figure. | UNVERIFIABLE | "It describes its alerts as real time and publishes no latency figure," |
```

**2. Use the fetch ladder in order.** Try WebFetch first. For JS-rendered or bot-walled pages, use a real browser (`chrome-devtools-axi`). For static pages, use `curl` with a desktop browser User-Agent. For vendors behind Cloudflare Turnstile (Liveuamap blocked both headless and headed automation), use a dated Wayback Machine snapshot and give the snapshot dates in the PR body.

**3. Check more than the price.** For each vendor, read:

- Pricing FAQs and terms for commercial-use limits and the exact plan or listing names. Off-Nadir's limit appeared only in its FAQ. Seerist's "listing name" turned out to be a pricing dimension.
- Recent capability changes, especially MCP launches. Recorded Future's MCP went GA about two weeks before this PR. Crisis24 announced "Horizon MCP" in a September 2026 press release, but `developer.crisis24.com` documents only REST, so the cell stays `Unverified` and cites the release.
- What the repo's own `blog-site/src/content/guides/` pages say about the vendor. A disagreement means one side is wrong.

**4. Re-verify load-bearing claims yourself before applying them.** Grep the saved fetches for each correction that changes a verdict, price or capability. In PR #9149 the fact-check agent overstated twice. It said Recorded Future MCP was limited to unlimited-integration packages, but the support article also offers portal credentials through the end of 2026. It said Off-Nadir "checks events against imagery", but the vendor only records whether each event "could be seen from orbit". It also missed Off-Nadir's commercial-use limit, which the orchestrator found by grepping the saved pricing page.

**5. Fix every row for a vendor in one change.** One vendor appears in matrix rows on several pages built by `scripts/build-comparison-pages.mjs` (across the vendors in PR #9149: the hub master matrix, vs-dataminr, vs-liveuamap, liveuamap-alternatives, vs-recorded-future, travel-risk-intelligence-vs-assistance and mcp-servers-for-geopolitical-data; which pages carry a given vendor varies, so grep the vendor name) and in prose in `scripts/comparison-page-narratives.mjs`, as well as in the shortlist. No test checks that one vendor's cells agree across pages, so in PR #9149 fixing only the shortlist left contradicting rows elsewhere. After editing, grep for the old phrase (for example `seconds to minutes` or `self-hosted`) and the vendor name across `scripts/` and `blog-site/`.

**6. When a vendor gains a verified MCP, update the test allowlist.** In `tests/crawlable-corpus.test.mjs:5217-5237`, every comparison row whose product is not in `verifiedMcpProducts` must have an MCP cell of exactly `'Unverified'` (`MCP_UNVERIFIED`, `scripts/build-comparison-pages.mjs:114`). A row in the list must not read `No` or `Unverified`. Marking Recorded Future as MCP-capable failed this test until `'Recorded Future'` was added with a dated comment (`tests/crawlable-corpus.test.mjs:5226-5227`).

**7. Write "not published" instead of plausible filler.** When no source states a latency, archive depth, seat model or source count, say so: `'Real-time alerting (no latency figure published)'` (`scripts/build-comparison-pages.mjs:133`), `'Not published'` for archive, `'count not published'` for sources. A specific-sounding claim with no source is the failure this doc is about.

### Guards PR #9149 added

These guards catch the mechanical subset. They do not check facts.

- `shortlistPage` (`scripts/comparison-shortlist.mjs:547`) rejects any World Monitor prose amount that is not a catalog price (`CATALOG_PRICES`, `:83`, built from `shared/product-facts.generated.json`). It also rejects any competitor currency amount in prose (`PROSE_AMOUNT_RE`, `:85`) when the entry has no `pricing.sources` (`:581-587`).
- `CHECKED_ON` (`scripts/comparison-shortlist.mjs:118`) puts a "Checked <date>" label next to price sources. Update it when you re-run the ledger.
- `COMPARISON_PAGE_LASTMOD_PATHS` (`scripts/build-crawlable-corpus.mjs:166-176`) now includes `shared/product-catalog.generated.json` and `public/.well-known/mcp/server-card.json`. A test (`tests/crawlable-corpus.test.mjs:1681-1688`) requires every `readRepoJson('...')` input of the shortlist module to be in that list.
- `scripts/vercel-ignore.sh:12` and `:82` lists `scripts/comparison-shortlist.mjs`, and `tests/deploy-config.test.mjs:657` and `:692` pins that entry.

## Why This Matters

Compare pages make public, checkable statements about named competitors. A wrong price, licence or capability is a credibility problem and can expose us to a vendor complaint. Every automated and review layer in PR #9149 approved a page that was wrong on 36 of 114 claims (12 WRONG, 24 PARTLY WRONG); only the live-page check, run before merge, caught them. The errors look plausible: they match how such vendors usually work, so a reviewer without the source has no reason to doubt them. Vendor facts also drift, as the MCP launches two weeks before the PR show. A ledger with saved fetches is the only artifact that makes the claims checkable and re-checkable later.

## When to Apply

- Creating a `/compare/` page or a shortlist entry, or adding a competitor row to any matrix.
- Changing a competitor's price, plan, licence, MCP, API, latency, archive or coverage cell or prose.
- Re-checking an existing page, at least whenever `CHECKED_ON` would move.
- A vendor announcing an MCP server, new pricing or a new plan.
- A blog guide and a compare page disagreeing about a vendor.

## Examples

| Vendor / cell | Before (main before #9149, or an earlier #9149 head) | After | Evidence |
|---|---|---|---|
| Dataminr latency (shortlist prose + matrix) | "Its alerts arrive in seconds to minutes" | `'Real-time alerting (no latency figure published)'` (`scripts/comparison-shortlist.mjs:172`); prose cites the SLA's "99% monthly availability" (`:157`) | No Dataminr source gives a latency; the SLA covers availability |
| Off-Nadir Delta MCP (mcp-servers page) | `MCP_VERIFIED_SELF_HOSTED` = `'Yes (self-hosted)'`, price "Free (open source, self-hosted)" | `'Yes (hosted, OAuth 2.1, all plans)'`, price "Free (200 tokens/mo, non-commercial); Starter $19/mo; Pro $59/mo (commercial)" (`scripts/build-comparison-pages.mjs:352`) | Vendor docs + pricing FAQ commercial-use clause |
| Recorded Future MCP (hub + vs pages) | `MCP_UNVERIFIED` | `'Yes (hosted, customers only)'` (`scripts/build-comparison-pages.mjs:134` and `:294`), plus `'Recorded Future'` in `verifiedMcpProducts` | Support article "Recorded Future MCP Overview", GA 2026-09-28 |

## Related

- [Pinned-value allowlist freezes a snapshot, not the invariant](../design-patterns/pinned-value-allowlist-freezes-a-snapshot-not-the-invariant.md): the same missing cross-producer consistency check, applied to JSON-LD `@id` nodes instead of vendor cells.
- [Publish a formula by tracing each term to its producer](../conventions/publish-a-formula-by-tracing-each-term-to-its-producer.md): published corpus prose traced to its true source before it ships.
- [A section on two discovery surfaces needs one renderer](../architecture-patterns/a-section-on-two-discovery-surfaces-needs-one-renderer-and-an-idempotent-splice.md): how the compare pages reach llms.txt and llms-full.txt.
- Issue #7737: an earlier comparison blog post stated unsourced competitor prices that contradicted `/compare/`.
- PR #9149: the shortlist, its guards, and the corrections described here.
