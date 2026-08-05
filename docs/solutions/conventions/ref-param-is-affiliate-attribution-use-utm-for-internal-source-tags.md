---
title: "?ref= on dashboard URLs is affiliate attribution — internal/SEO source tags must use utm_* params"
date: 2026-07-24
category: conventions
module: referral-capture
problem_type: convention
component: frontend
applies_when:
  - "Adding source/attribution query params to any link that lands on the dashboard (static corpus CTAs, blog CTAs, email links, partner links)"
  - "Acting on third-party SEO/analytics audit recommendations that propose a ?ref= convention"
tags: [referral-capture, attribution, utm, seo-corpus, checkout, affonso]
---

# ?ref= on dashboard URLs is affiliate attribution — internal/SEO source tags must use utm_* params

## Context

An external SEO audit of the crawlable corpus (219 static pages under `/countries/`, `/chokepoints/`, `/crises/`, `/tools/`) recommended tagging dashboard-bound CTAs with `ref=seo-country`, `ref=seo-chokepoint`, etc. to measure page→dashboard conversion. The recommendation looked reasonable — `ref=` is a common analytics idiom — but had to be refuted during PR #5555.

## Guidance

`?ref=` (and `?wm_referral=`) on any dashboard URL is consumed by `src/services/referral-capture.ts` as an **affiliate referral code**:

- `REFERRAL_PARAM_NAMES = ['wm_referral', 'ref']` — both params are read at app bootstrap (`captureReferralFromUrl()`, called from `App.ts`), stripped from the URL, and persisted to localStorage under `wm-referral-capture` with a 7-day TTL.
- A later checkout forwards the stored code to Dodo as `affonso_referral`, crediting a "sharer" for the purchase.
- Validation is `/^[a-zA-Z0-9_-]+$/` (≤64 chars) — so a slug like `seo-country` passes and silently becomes a fake affiliate code attached to real purchases for up to a week.

For internal source attribution, use `utm_source=<family>` instead (`seo-country`, `seo-chokepoint`, `seo-crisis`, `seo-tool` in the corpus). Umami reports UTM params natively, and referral-capture ignores them. In the corpus generator this is `withUtmSource()` in `scripts/build-crawlable-corpus.mjs`; dynamically rewritten dashboard links in `scripts/crawlable-live-tools.mjs` (`updateCountryQuery()`) carry the same tag.

## Why This Matters

Attribution pollution is silent and delayed: the fake code rides localStorage across sessions and only surfaces at purchase time, corrupting affiliate payout data with no error anywhere. The failure mode is invisible in any page-level test — only the checkout attribution pipeline sees it.

## When to Apply

Any time a link, campaign, or audit recommendation wants a "source tag" on a URL that can reach the dashboard. Check `REFERRAL_PARAM_NAMES` in `src/services/referral-capture.ts` before adopting any new attribution param name.

## Examples

```js
// WRONG — captured as an affiliate referral code, forwarded to checkout
<a href="/?country=NO&expanded=1&ref=seo-country">

// RIGHT — visible in Umami's UTM report, ignored by referral-capture
<a href="/?country=NO&expanded=1&utm_source=seo-country">
```

Regression guard: `tests/crawlable-corpus.test.mjs` asserts generated corpus pages contain no `[?&]ref=` links (added in PR #5555).
