# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Caching & Egress

### Bootstrap Tier

The grouping that decides *when* a cached data key is delivered to the client. Keys belong to one of three tiers: **fast** (needed for first paint, delivered immediately), **slow** (needed soon after boot, delivered in a second batch), and **on-demand** (delivered only when a specific panel or map layer actually asks for it). Tier membership is a bandwidth and boot-latency decision: everything in a delivered tier is paid for by every visitor, whether or not their UI renders it. See also: On-Demand Key, Bootstrap View Key.

### On-Demand Key

A bootstrap key excluded from the batched tiers and fetched individually — through a publicly cacheable per-key URL — at the moment a consumer (panel entering the viewport, map layer toggled on) first needs it. The defining property is that the fetch stays behind the CDN: an on-demand key that falls back to a direct database read merely relocates the cost instead of removing it. See also: Bootstrap Tier, The Lever Test.

### Bootstrap View Key

A companion cache key holding a *view* of a dataset sized to what the dashboard actually renders — sliced, projected, and stripped of fields the UI never shows — published alongside the **canonical key**, which remains the full source of truth for RPC, MCP, and analytical consumers. The governing principle is "cache what we show, not the source": the view rides the widely-delivered tiers, the canonical stays on demand-priced paths. A view key that accidentally ships more than the UI renders defeats its own purpose. See also: Bootstrap Tier.

### Seed-Owned Key

A cache key whose only writer is a dedicated seeder or relay process; edge endpoints read and serve it but never write it back on a miss — a missing value is answered with a short-TTL computed fallback while the owning seeder's next cycle restores the key. The consequence runs both ways: the reader stays cheap and can never poison the key with a degraded payload, but purging a seed-owned key does not force regeneration at read time — freshness after a purge returns only on the owner's schedule, and a purge issued while an outdated owner is still running is simply overwritten with outdated data. See also: Bootstrap Tier, On-Demand Key.

### One-Shot Hydration

The delivery contract of the boot payload: a hydrated value can be read exactly once, and reading it consumes it. Its consequence is the important part — any *recurring* reader (a periodic refresh tick, a retry) is guaranteed to miss hydration and fall through to whatever fallback path exists. When that fallback is not CDN-shielded, one-shot hydration plus a refresh timer silently manufactures origin traffic. Audit every refresh path's fallthrough whenever a payload is one-shot. See also: The Lever Test, On-Demand Key.

### The Lever Test

The project's costing heuristic for cache and egress work: egress ≈ origin-miss count × transferred payload size. Client count, reader count, and total request volume are absorbed by the CDN and do not appear in the formula, so a proposed optimization reduces egress only if it reduces the miss rate or the bytes per miss. Applied before scoping any bandwidth work; proposals whose arithmetic nets to zero (deduplicating identical stored bytes while both read paths survive, flipping a client-side default that never touches the served payload) are discarded on paper. See also: One-Shot Hydration, Bootstrap View Key.

### Shadow Measurement

Running a candidate read path against real production traffic while continuing to serve from the incumbent — the candidate's result is timed and discarded, never delivered — so a storage or routing cutover is decided on this project's own traffic rather than on a vendor's published performance characteristics.

Two rules make a shadow comparable rather than merely reassuring. The candidate must be measured entirely off the response path, so enabling it on live traffic cannot change what any client receives. And the incumbent must be measured on the *same* traffic over the *same* window, because a candidate's latency means nothing against a baseline drawn from different requests or a different hour. A shadow that clears its gate answers only "is the candidate faster here"; the serving path's own failure and slowness handling still has to be proven separately, since a shadow never exercises them. See also: The Lever Test, Bootstrap Tier.

## Notifications & Alert Delivery

### Alert Rule

A per-user notification subscription that decides which published events reach that user's channels. A rule combines a sensitivity floor, a delivery mode (realtime or a digest cadence), and optional scopes — countries and tickers. Rules are fan-out targets: one published event is tested against every enabled rule independently. See also: Country Scope, Event Attribution.

### Country Scope

An Alert Rule's optional country restriction. Empty means unscoped — every event qualifies. Populated means opt-in narrowing: an event attributed to a country matches only if that country is in the scope, and an *unattributed* event is dropped unless its type is on the explicit news-permissive allowlist (breaking-news origins, whose publishers cannot reliably attribute yet) or it is region-scoped and one of the rule's countries belongs to that region. The default for unknown or unattributed event types is drop, not deliver — the filter fails closed. See also: Event Attribution, Alert Rule.

### Event Attribution

The country identity a notification publisher attaches to an event at publish time, normalized to ISO-3166 alpha-2 through the shared country-name map. Attribution is the publisher's job, not the dispatcher's: a publisher that knows the country must attach it, because a missing or unresolvable attribution is indistinguishable downstream from a genuinely global event. A name-normalization miss that silently omits the attribution converts "lookup failed" into "field never existed" — the failure mode that lets scoped delivery leak. See also: Country Scope.

## Panel Mounting & Layout Stability

### Immediate Tier

The first slice of enabled dashboard panels, up to a fixed per-device boot budget, whose loading starts during the boot pass itself rather than waiting for the viewport. Membership is decided by position in the user's resolved panel order, not by on-screen prominence — a user who reorders panels changes which panels are immediate. "Immediate" describes when loading *starts*, not when the panel appears: the panel body still arrives asynchronously. See also: Deferred Tier, Deferred-Shell Contract.

### Deferred Tier

Every enabled panel beyond the immediate tier's budget. A deferred panel's slot is reserved by a shell at boot, and its real content loads only when the shell approaches the viewport. See also: Immediate Tier, Deferred-Shell Contract.

### Deferred-Shell Contract

The project's rule for any panel that joins the grid asynchronously, in either tier: a footprint-matched placeholder shell must occupy the panel's exact grid slot from the first synchronous layout pass, and the arriving panel replaces the shell in place rather than being inserted as a new grid item. The contract's invariant is that grid geometry never changes when async content arrives — violations register as layout shifts for every panel below the insertion point. Reserving the slot and starting the load early are independent decisions; conflating "loads immediately" with "needs no reservation" is the failure mode that produced the dashboard's dominant desktop layout-shift mechanism. See also: Immediate Tier, Deferred Tier, Shift Mover.

### Shift Victim

An element that browser and RUM layout-shift attribution names because its *position* changed — it was pushed by something else. Both Chrome's largest-shift-target and RUM per-selector rankings report victims; neither reports causes. A fix aimed at a top-ranked victim is a hypothesis about the pusher, not a confirmed target: prominent above-the-fold elements rank as victims whenever anything above them changes the layout. See also: Shift Mover.

### Shift Mover

The element that *causes* a layout shift by changing its own footprint — growing, shrinking, materializing (insertion), or disappearing (removal). Movers are not reported by shift-attribution APIs; naming one requires diffing element geometry across the shift itself (a cached top/height baseline compared at shift delivery). The victim/mover distinction is load-bearing for all layout-stability work in this project: two shipped fixes aimed at victims had null field effect before mover instrumentation named the true mechanism. See also: Shift Victim, Deferred-Shell Contract.

## Test & Guard Verification

### Vacuous Guard

A test, CI gate, or static audit that reports success without having examined what it claims to cover, because its *input* silently shrank rather than because its assertion held. The distinguishing property is that it fails open: guards of this shape assert a negative — a violation list is empty, a count is zero, no match was found — and an empty input satisfies a negative assertion perfectly, so the less such a guard actually checks, the greener it looks. Levers that shrink the input include a skip condition gated on a flag nothing sets, a normaliser or comment-stripper that deletes part of the scanned source, and a filter or path-walk predicate that stops matching files. A vacuous guard is worse than no guard, because it also supplies confidence. See also: Mutation Proof.

### Mutation Proof

This project's standard of evidence that a guard actually guards: deliberately break the thing the guard protects, observe the guard turn red, then restore the source byte-identically. Reading a guard establishes what it intends; only the mutation establishes what it covers. A guard that stays green when its subject is broken has not been shown to work, regardless of how carefully it was reviewed. The obligation applies recursively — a guard written to protect another guard needs its own mutation proof, and is a common place to skip one, because having just written it supplies the feeling of coverage without the evidence. See also: Vacuous Guard.

## MCP & Agent Discovery

### MCP Server Card

A static JSON discovery document that describes the MCP server: its name, version, supported transport, endpoint URL, authentication requirements, and tool/resource/prompt catalogs. It is served at `/.well-known/mcp/server-card.json` and returned by a plain `GET` to the well-known aliases (`/.well-known/mcp`, `/.well-known/mcp.json`). It is the *machine* discovery representation; the *human* one is the server guide. Clients performing a live MCP handshake still `POST` to the transport endpoint.

### Discovery Read vs. Transport Operation

The distinction that lets one URL serve both crawlers and MCP clients. A `GET` carrying neither `Last-Event-ID` nor an `Accept: text/event-stream` is a **discovery read** — a human or crawler opening the endpoint — and receives a document (the markdown server guide at `/mcp`, the JSON card at the well-known aliases). Every other `GET` is a **transport operation**: an SSE stream-open, which must receive the spec-correct `405`, or an authenticated `Last-Event-ID` replay. Request semantics, never user-agent sniffing, decide which. The consequence for caching is load-bearing: because these URLs negotiate on request headers, any cacheable response must declare `Vary: Accept, Last-Event-ID`, or a shared cache keyed on URL alone will replay a stored discovery body to a transport client. The live transport URL goes further and stays `no-store`, so its correctness never depends on an intermediary honoring `Vary`.

### Streamable HTTP Transport

The MCP transport this server implements over HTTP: JSON-RPC 2.0 requests via `POST`, with optional Server-Sent Events when the client advertises `Accept: text/event-stream`. Its `405` on a standalone stream-open is not an error but a contract — MCP SDK clients read it as the graceful "no standalone stream" signal and complete the handshake. Anything that converts that `405` into a `200` (including a CDN replaying a cached discovery response) breaks the handshake.

## Routing & Hosts

### Variant Host

One of the product-variant subdomains (`tech`, `finance`, `commodity`, `happy`, `energy`) that serves a themed dashboard entry and metadata. The middleware and Vercel config recognize these hosts explicitly; canonical discovery URLs for shared surfaces (such as `/mcp`) redirect retrieval-method requests from variant hosts to the apex host so discovery signals do not fragment.

## Billing & Entitlements

### Entitlement

The per-user record granting feature access — a plan key, feature flags with a tier, and a validity horizon — derived from subscriptions by the server and replicated to clients as a reactive snapshot. An entitlement is evidence of paid access *now*; it says nothing about why access exists or when it will renew. When its validity horizon passes without a renewal being recorded, readers fall back to free-tier defaults, which is the moment stale local state can misrepresent a still-paying customer.

### Covering Subscription

A subscription that currently grants paid coverage. Coverage is decided per status, not by the status name's plain-English reading: an active subscription covers; an on-hold subscription (payment failed, provider retrying) still covers through its retry window; a cancelled subscription covers until the end of the period already paid for; an expired subscription never covers regardless of its recorded period end. The server owns these rules; any client-side derivation must mirror them rather than re-deriving from status-string intuition. See also: Cancelled-But-Paid-Through, Billing UX State.

### Cancelled-But-Paid-Through

The state of a subscription whose auto-renew has been turned off but whose paid period has not yet ended. Colloquially "cancelled" reads as terminal; here it is a covering state until period end, and only afterwards does coverage lapse. UI and copy must not treat it as ended while the paid window is open — telling such a customer their subscription "has ended" invites duplicate checkout. See also: Covering Subscription.

### Renewal Verification

The bounded, on-demand re-check against the payment provider that runs when locally-stale paid evidence would otherwise cause a denial — instead of trusting a possibly-missed webhook, the provider is asked directly. It records a verdict (pending while queued or in flight, failed when the provider check errored, lapsed when the provider confirms coverage ended) that both the denial surfaces and the client UI consume. It shares provider-evidence bookkeeping with the scheduled reconciliation sweep but is deliberately independent of it, so one path failing cannot suppress the other. See also: Billing UX State.

### Billing UX State

The single client-derived state that decides what a customer sees when premium access is in question: free (never paid), active (access works), on-hold (payment failed, retry window), renewal-verification pending or failed (paid evidence went stale and the provider re-check is running or errored), or lapsed (coverage confirmed over). Its purpose is to prevent the misleading collapse of every non-paying state into a generic upgrade prompt — a paying customer whose renewal is being verified must be told that, not sold to. Derived purely from the entitlement and subscription snapshots, it changes copy and actions only; it never grants access the server would deny. See also: Covering Subscription, Renewal Verification.

## Localization & First Paint

### English Shell

The small, byte-budgeted subset of English UI strings inlined so first-paint chrome renders real text before the full locale file loads. Membership is decided by namespace: keys under the shell prefixes and referenced from eager chrome must be mirrored into the shell byte-identically, and the whole shell lives under a hard byte cap that is a first-paint performance budget, not a formatting limit. The consequence cuts both ways: post-boot copy placed in a shell namespace pays first-paint bytes for strings nobody can see yet, while first-paint copy placed outside the shell flashes raw keys until the full locale arrives. Choosing a key's namespace is therefore a rendering-time decision, not a taxonomy one.
