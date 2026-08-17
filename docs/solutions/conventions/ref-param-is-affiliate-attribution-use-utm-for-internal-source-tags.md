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

The corpus was guarded, the welcome landing page was not: its 12 dashboard CTAs shipped `?ref=welcome-nav`, `?ref=welcome-hero`, `?ref=welcome-depth-n3`, … and every visitor who clicked from the homepage into the dashboard was credited to a fake affiliate for 7 days (#6493).

## Guidance

`?ref=` (and `?wm_referral=`) on any dashboard URL is consumed by `src/services/referral-capture.ts` as an **affiliate referral code**:

- `REFERRAL_PARAM_NAMES = ['wm_referral', 'ref']` — both params are read at app bootstrap (`captureReferralFromUrl()`, called from `App.ts`), stripped from the URL, and persisted to localStorage under `wm-referral-capture` with a 7-day TTL.
- A later checkout forwards the stored code to Dodo as `affonso_referral`, crediting a "sharer" for the purchase.
- Validation is `/^[a-zA-Z0-9_-]+$/` (≤64 chars) — so a slug like `seo-country` passes and silently becomes a fake affiliate code attached to real purchases for up to a week.

For internal source attribution, use `utm_source=<family>` instead (`seo-country`, `seo-chokepoint`, `seo-crisis`, `seo-tool` in the corpus; `utm_source=welcome&utm_content=<slot>` on the welcome landing page). Umami reports UTM params natively, and referral-capture ignores them. In the corpus generator this is `withUtmSource()` in `scripts/build-crawlable-corpus.mjs`; dynamically rewritten dashboard links in `scripts/crawlable-live-tools.mjs` (`updateCountryQuery()`) carry the same tag.

Since #6493 there is also a runtime backstop. `shared/referral-namespaces.ts` reserves the `welcome` and `seo` namespaces (the bare word and anything under it, case-insensitively), and every surface that can mint a referral code applies it:

- `src/services/referral-capture.ts` — on capture, on read, and in `appendRefToUrl`. The read-side check matters because fixing a link does not un-poison the visitors who already clicked it: their code sits in localStorage with up to 7 days left to run, and old bookmarks and cached HTML keep sending it.
- `src/services/checkout.ts` — on the code `startCheckout` actually sends. This is the one that pays out, and it is **not** covered by the two above: a caller-passed code wins over the stored one, and three callers supply a value that never went through referral capture (the failure-retry banner replaying a saved attempt, a resumed pending intent, and `?checkoutReferral=` straight off the URL with no charset check at all).
- `pro-test/src/App.tsx` — `getRefCode()`, the `/pro` page's single entry point for an inbound `?ref=`. That page reaches the same checkout without ever passing through the dashboard's capture guard, so hardening only the dashboard would leave it live.

The policy lives in `shared/` for that last reason: two apps mint referral codes from a URL and both reach checkout, so a per-surface copy would drift and one copy would stay exploitable.

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

Regression guards:

- `tests/crawlable-corpus.test.mjs` asserts generated corpus pages contain no `[?&]ref=` links (PR #5555).
- `tests/deploy-config.test.mjs` bans **both** `ref=` and `wm_referral=` in `pro-test/src/welcome/*.tsx`, the built welcome JS, and the prerendered welcome HTML, and requires each of the 12 welcome dashboard CTAs to carry `utm_source=welcome` (#6493). The prerendered-HTML scan decodes `&amp;` first — React escapes attribute values, so a second-position `ref=` would otherwise be invisible to a `[?&]` character class.
- `tests/referral-capture.test.mts` covers the namespace policy, including eviction of a code captured before the guard existed.
- `tests/checkout-referral-policy.test.mts` asserts on the outgoing create-checkout POST body — the last observable point before Dodo writes `metadata.affonso_referral`. A test that stops at `loadActiveReferral()` passes while all three caller-passed paths ship a poisoned code.

Enforcement is client-side only; `convex/payments/checkout.ts` still accepts `referralCode` as an unconstrained string. This reduces self-inflicted attribution pollution — it is not an affiliate-fraud control.

A caveat when moving a source tag off `ref=`: check what else keys off the old href. The welcome hero CTA was styled above the fold by an inline critical-CSS rule matching `main a[href*="welcome-hero"]` in `pro-test/prerender.mjs`, so changing the URL silently unstyled it on first paint. That rule now keys off `data-umami-event-target`, and a deploy-config guard fails if any critical-CSS anchor selector stops matching a prerendered anchor.
