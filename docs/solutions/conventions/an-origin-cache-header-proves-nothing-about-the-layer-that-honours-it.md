---
title: "An origin cache header proves nothing about the layer that honours it"
date: 2026-09-04
category: conventions
module: crawlable corpus / CDN cache configuration
problem_type: convention
component: deploy_config
severity: high
applies_when:
  - "Asserting cache headers in tests/deploy-config.test.mjs and treating that as proof a route is cached"
  - "Adding a new route family to vercel.json with CDN-Cache-Control and expecting the CDN to honour it"
  - "Diagnosing cf-cache-status DYNAMIC on a route whose origin headers look correct"
  - "Changing anything about the crawlable corpus' caching, TTFB, or crawl budget"
  - "Reviewing a fix whose only evidence is a green offline config assertion"
symptoms:
  - "Every corpus route answers with the configured CDN-Cache-Control and Cloudflare still reports cf-cache-status: DYNAMIC"
  - "tests/deploy-config.test.mjs is green on every family while production serves none of them from cache"
  - "CrUX field TTFB stays flat across dozens of windows despite repeated caching 'fixes'"
  - "A route family is configured identically to a working one but behaves differently in production"
---

# An origin cache header proves nothing about the layer that honours it

## The recurrence

The crawlable corpus' `CDN-Cache-Control` header went silently inert **twice in
two days, from two different layers**, and `tests/deploy-config.test.mjs` was
green through both.

| | Layer that broke it | Why the offline assertion missed it |
|---|---|---|
| **#7590** (2026-09-03) | Vercel route matching. `vercel.json`'s `:param*` source compiles under path-to-regexp strict mode and never matches a trailing-slash URL — which is the only form the corpus serves. All ~22 corpus rules were inert. | The test modelled `:param*` as `(?:/.*)?`, which matches both forms. The model was more permissive than Vercel. |
| **#7659** (2026-09-04) | Cloudflare cache rules. A zone rule, "Bypass cache - WWW documents", sets `cache: false` for every extensionless/HTML path on `www`. A cache rule outranks origin cache headers, so the (now correctly delivered) header got no vote. | The test asserts what `vercel.json` declares. It cannot see a CDN that declined to honour it. |

Same header, same corpus, same green suite, two different downstream layers.
Fixing the first made the second visible — and the second had been true the
whole time.

## The convention

**A config assertion proves what you declared, never what a downstream layer
did with it.** Every hop between the config file and the user's browser can
independently nullify it:

```
vercel.json  ->  Vercel route matching  ->  Vercel edge cache  ->  Cloudflare cache rules  ->  browser
   (asserted offline)        #7590                                        #7659
```

So: any change whose *value* is delivered by a layer you do not control needs a
**live probe of the observable outcome**, not just an offline assertion of the
input. For caching that outcome is `cf-cache-status`, and its
`DYNAMIC` / `BYPASS` values are the precise fingerprint of "a rule declared this
ineligible before your header was read".

Note that a Vercel HIT is not evidence here. The corpus was *always*
`x-vercel-cache: HIT`; the live sweep's existing `isSharedCacheHit()` accepts a
Vercel HIT, which is exactly why it could not see this. Only `cf-cache-status`
distinguishes the two caches.

## What this looks like in the repo

- `scripts/cloudflare-cache-rule.mjs` generates the corrective Cloudflare rule
  from `CONTENT_CORPUS_PREFIXES`, so the CDN rule cannot drift from the
  `vercel.json` header rules it mirrors. `--check` compares it to the live zone;
  `--apply` reconciles it through the per-rule endpoints.
- `tests/cloudflare-cache-rule.test.mjs` pins the rule's shape offline **and**
  asserts it covers exactly the families `vercel.json` advertises — the drift
  that caused #7659.
- `tests/live-api-cache-auth-regression.test.mjs` carries the `corpus-edge-cache`
  probe: a real production document must reach a Cloudflare **HIT**, and its
  query-bearing form must stay uncached. This is the assertion neither incident
  had.
- `tests/deploy-config.test.mjs` still asserts the headers, with a comment
  naming both incidents so the next reader knows the assertion is necessary and
  not sufficient.

## Gotchas found while fixing it

- **Cloudflare's `status_code_ttl.value: 0` means `no-cache`, not "do not
  cache".** It *stores* the response and revalidates. Production showed a corpus
  404 sitting at `cf-cache-status: MISS` under `0`, i.e. stored. `-1` is
  `no-store`. This matters wherever a per-request-rendered non-2xx sits under a
  cached prefix — `middleware.ts`'s `originNotFoundResponse` negotiates on
  `Accept`, and Cloudflare honours `Vary` only for `Accept-Encoding`.
- **Cloudflare re-serialises `action_parameters` with keys sorted.** A drift
  check using `JSON.stringify` reports a false difference on a rule it just
  applied unchanged. Compare with a key-order-independent stringify.
- **The phase entrypoint `PUT` replaces every rule in the phase.** Use the
  per-rule endpoints instead: a read-modify-write of the whole ruleset silently
  reverts any concurrent dashboard edit, and round-trips other rules'
  user-owned `ref` values.
- **Changing the ruleset purges the edge cache.** Requests in the seconds after
  an `--apply` legitimately MISS repeatedly; size any retry loop for it.
- **`--apply` and a live probe are different guards.** `--check` catches config
  drift before it changes behaviour; the live probe catches behaviour whatever
  the config says. The probe is the one that would have caught both incidents.

## Related

- `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md`
  — the corpus probe is registered in the sweep's mandatory-probe gate
  (threshold *and* marker list) so it cannot itself go silently missing.
- `docs/solutions/conventions/ref-param-is-affiliate-attribution-use-utm-for-internal-source-tags.md`
  — why the cache rule deliberately excludes query-bearing corpus URLs.
