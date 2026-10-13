---
title: The relay's public /rss proxy fetched allowlisted hosts without vetting where they resolved
date: 2026-10-12
category: security-issues
module: ais-relay
problem_type: security_issue
component: background_job
severity: medium
symptoms:
  - "scripts/ais-relay.cjs served /rss without auth by design and fetched any allowlisted feed host with raw http.get/https.get through the OS resolver, with no private-range check and no address pinning"
  - "The allowlist holds 428 hosts whose DNS belongs to third parties, so one dangling or rebound hostname answering with 169.254.x, RFC 1918 or an fd00::/8 address was a raw read primitive into the Railway network"
  - "The upstream body was buffered with no size cap and a 2xx was CDN-cached for 10 minutes, so a leaked internal response would have been served to every later caller"
  - "The first fix routed a blocked answer through the generic sendError(403), which recorded backoff; the next request for the same feed then served the stale cached body with a 200 before any lookup ran, and in-flight followers got a 502"
root_cause: missing_validation
resolution_type: code_fix
related_components: [notification-relay, redis_cache]
tags: [ssrf, dns-rebinding, dns-pinning, rss-proxy, railway, allowlist, backoff, stale-cache]
---

# The relay's public /rss proxy fetched allowlisted hosts without vetting where they resolved

## Problem

The Railway relay proxies RSS feeds that block Vercel's egress. The route is public on purpose, and its only guard was a hostname allowlist (`shared/rss-allowed-domains.json`, 428 hosts). It then fetched with raw `http.get`/`https.get` and the OS resolver. Nothing asked where the hostname resolved, so the route trusted 428 third parties' DNS to never point at a private address. The Vercel Edge copy of the proxy has the same gap but sits on a network with none of our internal services, so the relay was the exposure.

## Symptoms

- A dangling or rebound allowlisted hostname answering with a link-local, RFC 1918 or `fd00::/8` address would have been fetched, and the body returned raw with the upstream status code.
- No body cap: the response was buffered whole. A 2xx was stored in the in-memory cache and marked `CDN-Cache-Control: public, max-age=600`, so one leaked response would have been served to other callers for ten minutes.
- The route had no tests at all.

## What Didn't Work

**Treating a blocked DNS answer as an ordinary upstream failure.** The first version sent the block through the route's generic `sendError(403, …)`. That helper is written for flaky upstreams: it records a failure, sets exponential backoff, and rejects the in-flight promise. Two review bots caught the consequence. The backoff guard runs before any DNS lookup, and when the feed had an older cached body the relay served it with a 200 and `X-Cache: BACKOFF-STALE` on the very next request. Concurrent callers waiting on the shared promise saw a 502. A security block had turned into "serve the old body for a while, then try the blocked host again".

The general lesson for this route: every failure path in `/rss` falls through to stale-serve and backoff unless it opts out. A verdict about the feed (blocked, disallowed) is not an upstream outage and must take its own exit.

**Trusting the route's own source greps as proof.** The first test file pinned the wiring with regexes over `ais-relay.cjs`. A reviewer who spawned the real relay found that the exact redirect line being edited still parsed `Location` with a bare `new URL()`, so one malformed header from any allowlisted upstream exited the whole process (`TypeError: Invalid URL`, no `uncaughtException` handler). Pre-existing on main, invisible to a grep. The route now has an end-to-end test that drives the real process.

## Solution

`scripts/lib/notification-webhook-ssrf.cjs` gained `createGuardedLookup()`. It is a `lookup` option for `http.request`: it resolves with `dns.lookup({ all: true })`, rejects if ANY answer fails the existing `isBlockedResolvedAddress` classifier, and otherwise hands Node a single vetted address (IPv4 first, or the full vetted list when Node asks with `options.all` for happy-eyeballs). Connecting only to the vetted address closes the rebinding window between check and connect. Errors carry `code: 'ERR_SSRF_BLOCKED'`.

In the relay:

- Every upstream `protocol.get` passes `lookup: rssGuardedLookup`.
- The initial URL and every redirect hop must be `http:` or `https:`.
- A blocked answer takes a dedicated `sendBlocked` exit: it evicts the last good body from `rssResponseCache`, calls `rssResetFailure` so no backoff is recorded, writes a 403 negative-cache entry that answers in-flight followers and the next minute of callers without another lookup, responds 403 with `Cache-Control: no-store`, and resolves the in-flight promise so followers read that entry instead of a 502.
- The buffered body is capped at 5 MiB, the Edge proxy's `MAX_FEED_BYTES`.

The lib is COPY'd into `Dockerfile.relay` and listed in the relay's `watchPatterns`, both of which existing guard tests check.

## Verification

`tests/ais-relay-rss-ssrf-e2e.test.mjs` spawns the real relay with `tests/_lib/ais-relay-rss-ssrf-preload.cjs`, a shim that reroutes one allowlisted host to a local upstream and flips its DNS answer between requests. It proves the first caller, the in-flight follower and a later caller all get 403 after a cached body, nothing stale leaks, the upstream is never contacted, a mixed answer set blocks, the body cap sends one 502 with the relay alive, every bad redirect target is refused, a relative `Location` is followed, and a malformed `Location` is a 502 with the relay alive. It runs in under a second.

`tests/ais-relay-rss-ssrf.test.mjs` covers the lookup helper behaviourally plus a source guard on the route:

- The lookup blocks private, link-local, metadata, IPv6 ULA and IPv4-mapped answers, blocks a mixed public/private answer set, pins IPv4 first and honours `options.all`.
- A real `http.get` with the guarded lookup against a loopback server opens zero connections and fails with `ERR_SSRF_BLOCKED`.
- The source guard pins the single upstream `get` carrying the lookup, the protocol gate on both the initial URL and redirect hops, the body cap, and the blocked path's eviction, no-backoff, 403 negative entry, follower resolution and `no-store`.

The five source-guard tests fail against `main`'s relay file.

## Related

- `server/_shared/ip-address-classification.ts`, `api/_notification-webhook-ssrf.ts` and `scripts/lib/notification-webhook-ssrf.cjs` are the three mirrored classifiers with a parity corpus. New prefixes go into all three.
- `api/mcp-proxy.ts` is the Edge pattern for the same problem: DNS-over-HTTPS pre-check and re-check, because Edge cannot pin a socket.
- `docs/solutions/security-issues/push-notification-click-navigated-the-open-tab-off-origin.md` for the other relay-side validation gap found by review.
