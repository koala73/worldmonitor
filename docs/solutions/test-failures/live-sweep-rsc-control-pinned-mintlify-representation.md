---
title: "Live sweep's docs RSC control pinned Mintlify's representation instead of the cache invariant"
date: 2026-11-07
category: test-failures
module: live API cache/auth sweep
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "Live API Cache/Auth Sweep fails every graded run with 'an RSC request must receive the flight, not a cached HTML document'"
  - "The assertion reports actual 'text/html; charset=utf-8' for GET /docs/documentation with RSC: 1"
  - "cf-cache-status on the same request reads DYNAMIC, so Cloudflare cached nothing"
root_cause: logic_error
resolution_type: test_fix
related_components: [tooling]
tags: [live-sweep, mintlify, rsc, cloudflare, cache-poisoning, negative-control, upstream-vendor-change]
---

# Live sweep's docs RSC control pinned Mintlify's representation instead of the cache invariant

## Problem

`tests/live-api-cache-auth-regression.test.mjs` sends `RSC: 1` to
`https://www.worldmonitor.app/docs/documentation` as a negative control for the
Cloudflare cache rule. It asserted that the response was a `text/x-component`
flight. Mintlify moved the docs origin off Next.js, the origin began answering
`RSC: 1` with HTML, and the sweep failed on every graded run from at least
2026-11-06 20:54 UTC until PR #10288.

## Symptoms

- `not ok 10 - serves the docs, blog and agent text files from the Cloudflare edge, HTML representation only`
- `error: 'an RSC request must receive the flight, not a cached HTML document'`, `actual: 'text/html; charset=utf-8'`
- The markdown negative controls later in the same subtest never ran, so their status was unknown while the sweep was red.

## Investigation

1. **Through our edge.** `curl -H 'RSC: 1' https://www.worldmonitor.app/docs/documentation`
   returned `text/html` with `cf-cache-status: DYNAMIC`. The failure message implies a
   cached HTML document, but Cloudflare had not cached the request, so this was not
   cache poisoning.
2. **At the upstream origin.** The `/docs/:match*` rewrite in `vercel.json` points at
   `https://worldmonitor.mintlify.dev/docs/:match*`. The same request sent straight to
   that host also returned `text/html`, which rules out our proxy and Cloudflare.
3. **Renderer markers.** The origin HTML contained `/_mintlify/assets` paths and no
   `_next/static` or `self.__next_f` markers. Mintlify had replaced its Next.js
   renderer, so there was no flight left to negotiate. Adding `?_rsc=` and
   `Next-Router-State-Tree` changed nothing.

## Solution

Assert the invariant, not the vendor's choice of representation (PR #10288):

```js
// before
assert.match(flight.resp.headers.get('content-type') || '', /text\/x-component/,
  'an RSC request must receive the flight, not a cached HTML document');

// after
assert.match(flight.resp.headers.get('content-type') || '', /text\/x-component|text\/html/,
  'an RSC request must receive the flight or the HTML document');
```

The existing check stays the real guard: `cf-cache-status` must read `DYNAMIC` or
`BYPASS`. A cached HTML document would read `HIT`, and a request that stored a
negotiated body would read `MISS`.

The RSC exclusion in `scripts/cloudflare-cache-rule.mjs` and its offline tests in
`tests/cloudflare-cache-rule.test.mjs` were left as they were. They cost nothing
and still protect the cache if Mintlify ever serves flights again.

## Why This Works

The control exists to prove that a negotiating request never reaches a shared cache
keyed only on the URL. The origin's representation is the vendor's decision and
can change without notice. The cache status is the property we own and the one
whose failure would harm users.

## Prevention

- In a live negative control, assert the property the guard protects (cache
  eligibility) and allow every representation the upstream may legitimately
  return. Pin a representation only when this repo produces it.
- When a live probe of a proxied route fails, probe the upstream host directly
  before changing the cache rule or the proxy. That isolates vendor behaviour from
  our own layers in a single request.
- Write the assertion message so it describes what was observed. "Not a cached
  HTML document" suggested poisoning, when the cache status showed none.

## Related

- [An origin cache header proves nothing about the layer that honours it](../conventions/an-origin-cache-header-proves-nothing-about-the-layer-that-honours-it.md) explains why RSC and negotiated media types are excluded from the Cloudflare cache rule.
