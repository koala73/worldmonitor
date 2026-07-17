# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Caching & Egress

### Bootstrap Tier

The grouping that decides *when* a cached data key is delivered to the client. Keys belong to one of three tiers: **fast** (needed for first paint, delivered immediately), **slow** (needed soon after boot, delivered in a second batch), and **on-demand** (delivered only when a specific panel or map layer actually asks for it). Tier membership is a bandwidth and boot-latency decision: everything in a delivered tier is paid for by every visitor, whether or not their UI renders it. See also: On-Demand Key, Bootstrap View Key.

### On-Demand Key

A bootstrap key excluded from the batched tiers and fetched individually — through a publicly cacheable per-key URL — at the moment a consumer (panel entering the viewport, map layer toggled on) first needs it. The defining property is that the fetch stays behind the CDN: an on-demand key that falls back to a direct database read merely relocates the cost instead of removing it. See also: Bootstrap Tier, The Lever Test.

### Bootstrap View Key

A companion cache key holding a *view* of a dataset sized to what the dashboard actually renders — sliced, projected, and stripped of fields the UI never shows — published alongside the **canonical key**, which remains the full source of truth for RPC, MCP, and analytical consumers. The governing principle is "cache what we show, not the source": the view rides the widely-delivered tiers, the canonical stays on demand-priced paths. A view key that accidentally ships more than the UI renders defeats its own purpose. See also: Bootstrap Tier.

### One-Shot Hydration

The delivery contract of the boot payload: a hydrated value can be read exactly once, and reading it consumes it. Its consequence is the important part — any *recurring* reader (a periodic refresh tick, a retry) is guaranteed to miss hydration and fall through to whatever fallback path exists. When that fallback is not CDN-shielded, one-shot hydration plus a refresh timer silently manufactures origin traffic. Audit every refresh path's fallthrough whenever a payload is one-shot. See also: The Lever Test, On-Demand Key.

### The Lever Test

The project's costing heuristic for cache and egress work: egress ≈ origin-miss count × transferred payload size. Client count, reader count, and total request volume are absorbed by the CDN and do not appear in the formula, so a proposed optimization reduces egress only if it reduces the miss rate or the bytes per miss. Applied before scoping any bandwidth work; proposals whose arithmetic nets to zero (deduplicating identical stored bytes while both read paths survive, flipping a client-side default that never touches the served payload) are discarded on paper. See also: One-Shot Hydration, Bootstrap View Key.

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
