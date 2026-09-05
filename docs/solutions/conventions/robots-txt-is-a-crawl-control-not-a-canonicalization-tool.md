---
title: "robots.txt is a crawl control, not a canonicalization tool — block only what nothing else can consolidate"
date: 2026-09-05
category: conventions
module: seo-crawlability
problem_type: convention
component: infrastructure
applies_when:
  - "Adding a Disallow rule to public/robots.www.txt or public/robots.variant.txt to reduce crawl waste"
  - "Acting on a Search Console report where 'Page with redirect' or 'Alternate page with proper canonical' is large and rising"
  - "Reviewing a change that blocks parameterised URLs to save crawl budget"
tags: [seo, robots-txt, crawl-budget, canonicalization, referral-capture, search-console]
---

# robots.txt is a crawl control, not a canonicalization tool — block only what nothing else can consolidate

## Context

Search Console reported ~4,153 URLs not indexed against a declared inventory of 845, with "Page with redirect" rising 199 → 1,271 in three months (#7660). The obvious lever is a `Disallow` on the query params generating the space, and the issue's own plan proposed exactly that for six families: `lat`, `zoom`, `layers`, `wm_content_*`, `ref`, `utm_*`, on the reasoning that "canonicals already handle consolidation, so disallowing these costs nothing in indexing."

That reasoning is inverted, and shipping it would have caused more damage than the crawl waste it removed. Three independent reviewers on PR #7689 converged on the same objection.

## Guidance

**A disallowed URL is never fetched, so Google reads neither its `rel=canonical` nor its redirect.** robots.txt suppresses crawling, not indexing — a blocked URL can still be indexed URL-only from an inbound link, and it can never be folded into anything, because the signal that would fold it is in a response nobody requested. Blocking a URL that *already consolidates correctly* replaces a working mechanism with a worse one.

So the test is not "is this URL crawl waste?" but **"can any mechanism ever finish consolidating it?"**

| Block it | Leave it crawlable |
|---|---|
| The space is unbounded — consolidation never converges because every new share mints a new URL | The space is bounded and already consolidates via a 301/308 or a `rel=canonical` |
| Nothing links to it, so no signal is stranded by not crawling | External links point at it, so blocking strands their equity |

For this repo that resolved to: block `lat`, `lon`, `zoom`, `layers` (`public/robots.www.txt:91-94`) and nothing else. The attribution families stay crawlable because:

- `ref` and `wm_referral` are **affiliate codes with revenue semantics** — see [?ref= is affiliate attribution](./ref-param-is-affiliate-attribution-use-utm-for-internal-source-tags.md). `src/services/referral-capture.ts:33` reads both, and affiliates paste `/pro?ref=<code>` onto third-party sites. `middleware.ts:211` (`crawlerCanonicalUrl`) already 308s a crawler off them to the clean document, and a 308 passes that link equity. Disallowing means the crawler never issues the request, so the 308 is never seen and the equity is stranded on the conversion page.
- `wm_content_*` URLs answer 200 with a correct canonical.
- `utm_*` is on the primary CTA of nearly every generated page (`withUtmSource()`, `scripts/build-crawlable-corpus.mjs:520`).

### Corollary: never block a link shape your own build emits

The `utm_*` rule would have disallowed the dashboard CTA on ~240 of 263 sitemap-declared pages. Blocking a link you keep publishing does not remove the crawl volume — it relabels it "Blocked by robots.txt" and tells Google not to follow your own internal graph. `tests/deploy-config.test.mjs:4403` now resolves twelve shapes taken from the corpus builders and fails if any is blocked.

The same class caught `/embed`: `docs/embed-live-map.mdx:53` publishes a direct iframe at `/embed?layers=…&zoom=…`, so the map-param rules would have stopped Googlebot fetching the widget while rendering a *partner's* page. Carved back out with longer `Allow:` rules that win the longest match on `/embed` alone.

## Why This Matters

Every mistake in this class is silent and compounding. Nothing errors, no test fails, and the damage appears weeks later as a Search Console bucket moving sideways rather than down. The buckets in #7660 grew 2.5–6× over three months with nobody noticing.

The failure is also asymmetric: crawl waste costs budget, but blocking a consolidating URL costs the consolidation itself — and on `/pro?ref=`, real inbound link equity on the conversion page.

## When to Apply

Any time a `Disallow` is proposed to reduce crawl waste. Ask in order:

1. Does something already consolidate this URL — a redirect, or a canonical on a 200? If yes, do not block it.
2. Is the space actually unbounded, or merely large? Bounded spaces converge on their own.
3. Does anything external link to it? If yes, blocking strands that signal.
4. Does our own build emit this shape as an internal link? If yes, blocking it is self-harm.

## Verification Notes

Three traps, all hit while shipping #7689.

**1. Rule presence is not the contract — resolve real paths.** On the variant host, `Allow: /dashboard` is a 10-character longest-match win over `Disallow: /*?*lat=` (8), so the new rules were dead on exactly the path that generates the space. Only resolving actual request paths through a matcher found it; `Allow: /dashboard$` fixes it.

**2. `/*?*token=` is a substring match, and cannot be improved.** It also catches params merely *ending* in the token (`?colon=` matches `/*?*lon=`) and value-side text (`?q=flat=earth`). The apparent fix — name-anchoring to `/*?lat=` plus `/*&lat=` — is not implementable: **a literal `&` in a robots.txt rule path never matches.**

```
rule /*&lat=   vs /d?view=g&lat=1 : ALLOW   <- does not match
rule /*?*lat=  vs /d?view=g&lat=1 : BLOCK
```

Anchoring would have silently stopped blocking every map URL whose `lat` is not the first parameter — a regression dressed as a precision improvement. Guard it from the only side robots.txt can reach instead: `tests/deploy-config.test.mjs:4326` asserts that no query parameter the app *reads* ends in a blocked token.

**3. Python's `urllib.robotparser` is not a valid oracle for Google semantics.** It strips the `$` end-anchor, percent-encodes `&` in rule paths, and is not longest-match — it blocks where Google allows, so it silently "agrees" without ever exercising the precedence logic these rules turn on. Use [Protego](https://github.com/scrapy/protego), which implements Google's spec (wildcards, `$`, longest-match, Allow-wins-ties):

```python
from protego import Protego
rp = Protego.parse(open("public/robots.www.txt").read())
rp.can_fetch("https://www.worldmonitor.app/dashboard?lat=20", "Googlebot")
```

## Related

- [?ref= on dashboard URLs is affiliate attribution](./ref-param-is-affiliate-attribution-use-utm-for-internal-source-tags.md) — why `ref`/`wm_referral` carry revenue semantics, and why `utm_*` is the internal tag
- [MCP crawler GET and method-aware canonical redirects](../integration-issues/mcp-crawler-get-and-method-aware-canonical-redirects.md) — the `cacheable(response) ⇒ Vary ⊇ {headers the branch read}` rule, which a UA-conditioned redirect in `middleware.ts:240` also depends on
- Issue #7660; PR #7689 (open as of this writing)
