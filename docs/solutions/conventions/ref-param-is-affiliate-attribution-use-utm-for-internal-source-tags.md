---
title: "?ref= on dashboard URLs is affiliate attribution — and a same-site link takes NO query tag at all"
date: 2026-07-24
category: conventions
module: referral-capture
problem_type: convention
component: frontend
applies_when:
  - "Adding source/attribution query params to any link that lands on the dashboard (static corpus CTAs, blog CTAs, email links, partner links)"
  - "Acting on third-party SEO/analytics audit recommendations that propose a ?ref= or ?utm_source= convention for internal links"
tags: [referral-capture, attribution, utm, seo-corpus, checkout, affonso, crawl-budget]
---

# ?ref= on dashboard URLs is affiliate attribution — and a same-site link takes NO query tag at all

## Context

An external SEO audit of the crawlable corpus (219 static pages under `/countries/`, `/chokepoints/`, `/crises/`, `/tools/`) recommended tagging dashboard-bound CTAs with `ref=seo-country`, `ref=seo-chokepoint`, etc. to measure page→dashboard conversion. The recommendation looked reasonable — `ref=` is a common analytics idiom — but had to be refuted during PR #5555.

The corpus was guarded, the welcome landing page was not: its 12 dashboard CTAs shipped `?ref=welcome-nav`, `?ref=welcome-hero`, `?ref=welcome-depth-n3`, … and every visitor who clicked from the homepage into the dashboard was credited to a fake affiliate for 7 days (#6493).

## Guidance

`?ref=` (and `?wm_referral=`) on any dashboard URL is consumed by `src/services/referral-capture.ts` as an **affiliate referral code**:

- `REFERRAL_PARAM_NAMES = ['wm_referral', 'ref']` — both params are read at app bootstrap (`captureReferralFromUrl()`, called from `App.ts`), stripped from the URL, and persisted to localStorage under `wm-referral-capture` with a 7-day TTL.
- A later checkout forwards the stored code to Dodo as `affonso_referral`, crediting a "sharer" for the purchase.
- Validation is `/^[a-zA-Z0-9_-]+$/` (≤64 chars) — so a slug like `seo-country` passes and silently becomes a fake affiliate code attached to real purchases for up to a week.

`utm_*` was the answer here until #8603, and it is not any more. A **same-site** link carries no source tag in a query param at all:

- `middleware.ts` `crawlerCanonicalUrl()` 308s a bot away from any URL carrying `ref`, `wm_referral`, **any** `utm_*` key (by prefix, so `utm_id` counts too), or — on pathname `/` — any of `lat`/`lon`/`zoom`/`view`/`timeRange`/`layers`/`c`/`country`/`chokepoint`. A tagged internal link is therefore a wasted Googlebot fetch that sends link signals to a non-canonical URL, on every page that publishes it. Three generator lines put ~430 of those on the live site.
- The tag bought nothing either: nothing in `src`, `server`, `api` or `convex` ever read `seo-country`, `seo-cii`, `welcome-nav` or any sibling. Umami already records the referrer path for same-site navigation.

Tag a same-site link with **`data-umami-event` + `data-umami-event-target`** instead. It is an attribute, so it costs no redirect hop, it survives the bot 308 that a query param does not, and it is what the welcome CTAs and the research/chokepoint CTAs already use.

Where a same-site link genuinely needs attribution *in the URL* — a cross-surface handoff whose destination must read it — use the `wm_content_*` family (`scripts/build-use-cases.mjs`, `withContentAttribution()`). Those keys are deliberately absent from `INDEX_NOISE_QUERY_KEYS`, answer 200 with a correct `rel=canonical`, and are deliberately not blocked in `robots.txt`.

`utm_*` remains correct for **outbound and off-site** links, which never reach this middleware: `src/embed/embed-url.ts`, `src/utils/utm.ts` (its interceptor early-returns on same-origin), `server/_shared/brief-render.js` source lines, and the `convex/broadcast/*` email campaigns.

`withUtmSource()` in `scripts/build-crawlable-corpus.mjs` is **deleted** (#8603), and `updateCountryQuery()` in `scripts/crawlable-live-tools.mjs` no longer tags the links it rewrites. Do not reintroduce either.

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
// WRONG — `ref=` is captured as an affiliate referral code and forwarded to checkout
<a href="/dashboard?country=NO&expanded=1&ref=seo-country">

// WRONG — `utm_source=` is stripped by a bot 308, so Googlebot never reaches this URL (#8603)
<a href="/dashboard?country=NO&expanded=1&utm_source=seo-country">

// WRONG — `country=` on pathname `/` is a legacy root deep link, also a bot 308 to /dashboard
<a href="/?country=NO&expanded=1">

// RIGHT — no query tag; attribution rides an attribute, and the path is already canonical
<a href="/dashboard?country=NO&expanded=1"
   data-umami-event="welcome-cta" data-umami-event-target="seo-country">
```

Regression guards:

- `tests/crawlable-corpus.test.mjs` asserts generated corpus pages contain no `[?&]ref=` links (PR #5555).
- `tests/deploy-config.test.mjs` bans **both** `ref=` and `wm_referral=` in `pro-test/src/welcome/*.tsx`, the built welcome JS, and the prerendered welcome HTML, and requires each of the 12 welcome dashboard CTAs to carry no query at all (#6493, #8603). The prerendered-HTML scan decodes `&amp;` first — React escapes attribute values, so a second-position `ref=` would otherwise be invisible to a `[?&]` character class.
- `tests/internal-link-redirects.test.mjs` walks every anchor on the ~284 generated corpus pages, the published docs `.mdx`, the blog markdown, the `public/*.md` + `public/*.txt` agent artifacts and `pro-test/src/welcome/*.tsx`, and rejects a same-site href that carries an index-noise key, carries any `utm_*` key by prefix, is a legacy root deep link, equals a `vercel.json` redirect source, is a bare variant host, is the slashless form of a corpus route, or resolves to no published route (#8603). The query-key list and both extra 308 shapes are re-derived from `middleware.ts` rather than copied, and a positive-control case asserts each rule still fires.
- `tests/referral-capture.test.mts` covers the namespace policy, including eviction of a code captured before the guard existed.
- `tests/checkout-referral-policy.test.mts` asserts on the outgoing create-checkout POST body — the last observable point before Dodo writes `metadata.affonso_referral`. A test that stops at `loadActiveReferral()` passes while all three caller-passed paths ship a poisoned code.

Enforcement is client-side only; `convex/payments/checkout.ts` still accepts `referralCode` as an unconstrained string. This reduces self-inflicted attribution pollution — it is not an affiliate-fraud control.

A caveat when moving a source tag off `ref=`: check what else keys off the old href. The welcome hero CTA was styled above the fold by an inline critical-CSS rule matching `main a[href*="welcome-hero"]` in `pro-test/prerender.mjs`, so changing the URL silently unstyled it on first paint. That rule now keys off `data-umami-event-target`, and a deploy-config guard fails if any critical-CSS anchor selector stops matching a prerendered anchor.
