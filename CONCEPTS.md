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

A cache key whose only writer is a dedicated seeder or relay process; edge endpoints read and serve it but never write it back on a miss — a missing value is answered with a short-TTL computed fallback while the owning seeder's next cycle restores the key. The consequence runs both ways: the reader stays cheap and can never poison the key with a degraded payload, but purging a seed-owned key does not force regeneration at read time — freshness after a purge returns only on the owner's schedule, and a purge issued while an outdated owner is still running is simply overwritten with outdated data. See also: Bootstrap Tier, On-Demand Key, Read Outcome.

### Content-Age Contract

The freshness clock a seeder declares over the *observation dates inside* the payload it just published, as distinct from the clock over its own last run. The two answer different questions and only one of them detects an upstream that has silently stopped moving: a producer whose source freezes — answering successfully, forever, with unchanging observations — keeps its run clock perfectly current, because the cron fires, the fetch succeeds, the record count stays whole, and validation passes. Nothing but the dates in the data reveals it.

Two rules follow from what the contract reduces to. It reports a single newest timestamp, so a payload assembled from *several independently-failing sources* must derive one clock per source and report the **oldest** of them; reducing all their dates together takes the newest, and the still-living source then hides the dead one indefinitely — an alarm that can only fire when every source dies at once. And an undatable payload must report nothing rather than a default, because "we cannot date this" and "this is stale" warrant the same response, while a fabricated recent date warrants none.

Sizing the budget belongs to the source's own publication calendar, measured rather than assumed: the widest gap the source routinely takes — a holiday cluster, a non-working period, a weekend either side — plus room for one missed run. A budget guessed generously enough to never false-alarm has usually also stopped detecting the freeze it exists for. See also: Seed-Owned Key, Activation Marker, Content Clock.

### Activation Marker

A durable, deliberately expiry-free key a producer writes only after its first genuinely successful publish, used to end a deployment-order grace period. It exists because the reader and the producer ship on different clocks — the reader deploys on merge, the producer runs on its own schedule — so a newly registered data key is legitimately absent for a window that can span a full producer cycle, and grading it strictly during that window reports a loud, unactionable failure for something that has simply not happened yet.

The marker's value is that the grace it grants is *self-revoking on evidence* rather than on a date: before it exists, an absent key is soft; from the first publish onward, the same absence is strict forever. That is what separates it from a hardcoded deadline, which must be guessed against an unknown merge time and rots into either a premature alarm or a permanent exemption. Two properties are load-bearing: the marker carries no expiry, because inferring "has ever published" from a key that itself expires reintroduces the grace every time that key ages out; and its meaning is presence, so a read that *fails* must not be treated as absence — an unreadable marker earns nothing and the key is graded normally, since a grace granted on an unknown state is a grace that never ends. See also: Seed-Owned Key, Content-Age Contract.

### Read Outcome

The three-way result a cache read is obliged to report — **hit**, **miss**, or **failure** — as against the two-way present/absent that a bare returned value can express. The distinction exists because it is observable only at the read itself: a helper that answers the same empty value for "the key genuinely holds nothing" and "the read did not complete" has destroyed the difference at its only observation point, and every caller downstream then decides on a fabricated fact.

What makes the collapse expensive is that the two outcomes license opposite actions. A miss is a legitimate empty state — serve the computed fallback, render the empty panel, treat the day as having no records. A failure is an outage, and the correct response is almost always to abstain: skip the tick rather than publish a partial, keep the last good value rather than replace it with nothing, report the read as incomplete rather than as a finding. Collapsing them converts an outage into a confident empty answer, which then propagates as though it were data. Two properties of the cache store's REST interface make this easy to get wrong. A transport-level success status is not evidence the command ran — the store can answer a success status whose body carries a per-command error — so a reader that checks only the status and then reads the result field silently reclassifies every such rejection as a miss. And because the rejection is per command, one command in a batch can fail while its siblings succeed, so an outcome must be tracked per command rather than inferred once for the whole batch. See also: Seed-Owned Key, One-Shot Hydration.

### Source Tag

The field a seeder stamps on its published snapshot naming which rung of its source ladder produced the payload — the credentialed primary, the preferred bulk feed, or an emergency sweep. Consumers of the data itself ignore it, but stateful merge logic keys on it: a run only carries forward accumulated state (such as a rolling event window) from a predecessor snapshot bearing the expected tag, so a single tick published under a different tag resets that accumulation. Inverting which rung is primary changes how often each tag is published and therefore how exposed that accumulated state is. See also: Seed-Owned Key.

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

## Product Analytics Collection

### Write Receipt

The body the analytics collector returns for a write it actually stored, carrying the session and visit identifiers it minted for that write. The receipt — not the status code — is the delivery proof: the collector answers a success status to writes it accepts and then discards, so treating a 2xx as stored is what lets a dropped conversion look delivered. A response that carries a success status but no receipt is undelivered, and whether it is worth reporting depends on *why* the receipt is missing. See also: Bot-Filtered Write, Environment Noise.

### Bot-Filtered Write

A write the collector deliberately discarded because it judged the client non-human, acknowledged with a success status and a fixed sentinel body instead of a Write Receipt. It is a real delivery failure — nothing was stored, so retry policy and any durable conversion marker must treat it exactly as they treat any other missing receipt — but it is not an incident, so it must never raise an alert. That split is the load-bearing part: the distinction belongs in the *alerting* decision, never in the *delivery* classification, because collapsing them turns a silenced alert into a silenced retry. First-party crawlers and headless browsers hitting production pages land in this class, so any browser-side alarm sees the project's own monitoring traffic unless it excludes it. See also: Write Receipt, Environment Noise.

### Environment Noise

The class of collector failures produced by the client's own environment — a blocked request, an unanswered one — rather than by the collector. Locally indistinguishable from a total outage, because a blocked client and a dead collector both fail every write on that page; nothing computable in one browser separates them. The consequence is that the outage signal is the aggregate volume of these reports across users, not any single report, so the reporting policy gates them behind both a minimum sample and a minimum failure rate within a rolling window and admits at most one per page per window. Without the per-page bound, one heavily-blocked session outproduces the incident the gate exists to expose. Failures the origin answered — any non-success status — are outside this class and always reportable, which is what keeps a dead origin loud. See also: Write Receipt, Bot-Filtered Write, Vacuous Guard.

## Company Attribution

### Filer

The company identity that a securities regulator publishes under a stable registry key, and the only unit that corporate intelligence attributes data to. A filer is not a brand, a website owner, or a market ticker: several tickers (share classes) can belong to one filer, and a familiar company name may sit under a legal title that shares its prefix with unrelated filers. Everything the product says about a company — filings, material events, market profile, news — hangs off a resolved filer, so resolving to the wrong one silently misattributes every downstream field at once. See also: Filer Resolution.

### Filer Resolution

Turning a caller's reference into a specific filer. Only two keys are accepted: an exact registry ticker, and a company name that identifies exactly one filer. An ambiguous name resolves to nothing rather than to a tie-break — ranking candidates by title length or any similar proxy is a guess, not a resolution.

The rule that shapes this: uniqueness is not identity. That a label matches exactly one filer answers a question about the registry's contents, not about which company the caller meant — so a low-precision key (a domain, a slug) is admissible only when some field the registry itself publishes can confirm the pairing, and only while failing closed when that evidence is missing. A key with no such confirming field is not offered at all, because a guard that can never pass reads as safety while delivering nothing.

Resolution distinguishes three outcomes, not two: the company resolved, no such company (a real answer, cacheable), and the registry could not be read (an infrastructure failure that must never be cached as an authoritative negative). See also: Filer, Event Attribution.

## Panel Mounting & Layout Stability

### Immediate Tier

The first slice of enabled dashboard panels, up to a fixed per-device boot budget, whose loading starts during the boot pass itself rather than waiting for the viewport. Membership is decided by position in the user's resolved panel order, not by on-screen prominence — a user who reorders panels changes which panels are immediate. "Immediate" describes when loading *starts*, not when the panel appears: the panel body still arrives asynchronously. See also: Deferred Tier, Deferred-Shell Contract.

### Deferred Tier

Every enabled panel beyond the immediate tier's budget. A deferred panel's slot is reserved by a shell at boot, and its real content loads only when the shell approaches the viewport. See also: Immediate Tier, Deferred-Shell Contract.

### Deferred-Shell Contract

The project's rule for any panel that joins the grid asynchronously, in either tier: a footprint-matched placeholder shell must occupy the panel's exact grid slot from the first synchronous layout pass, and the arriving panel replaces the shell in place rather than being inserted as a new grid item. The contract's invariant is that grid geometry never changes when async content arrives — violations register as layout shifts for every panel below the insertion point. Reserving the slot and starting the load early are independent decisions; conflating "loads immediately" with "needs no reservation" is the failure mode that produced the dashboard's dominant desktop layout-shift mechanism. See also: Immediate Tier, Deferred Tier, Shift Mover.

### Late-Mount Window

The interval between a Deferred Tier panel being constructed and its element entering the grid — routinely minutes on a phone, since the panel is built only as its shell nears the viewport while the boot data pass finished long before. Two things cross the window in opposite directions and both need somewhere to wait: data *pushed* to a panel that does not exist yet, and a render *emitted* by a panel whose element is not attached yet.

The project's rule is that neither may be discarded. A push aimed at an absent panel is queued and replayed when the panel loads; a render emitted before attachment is deferred and flushed when the element joins the grid. Both failure modes read as defensive code and are silent — no error, no failed request, no telemetry — so they surface only as a panel that shows its initial placeholder for the whole session. The attachment check is the subtler of the two, because it is genuinely correct *after* attachment (a torn-down panel must not paint) and wrong *before* it; only checking ahead of the work distinguishes "never attached yet" from "detached again". See also: Deferred Tier, Deferred-Shell Contract, Viewport Prime.

### Viewport Prime

The dashboard's demand-driven data pass: on boot, and again on every scroll and resize, it loads data for exactly the panels near the viewport, so a Deferred Tier panel receives its content only as the user approaches it. It re-runs constantly by design, which makes its safety contract the load-bearing part: the pass dedupes *concurrent* loads but does not remember *completed* ones, so every loader it can reach must be cheap to repeat — served from a real cache, or skipped outright when the panel already renders data. A loader that repeats expensively (an uncached network call, a teardown of already-rendered content) turns every scroll into user-visible churn.

Refresh triggers divide into three classes that must not be conflated: input-driven passes (scroll, resize — arbitrarily frequent, carrying no information about data staleness), the staleness clock (each panel's scheduled refresh cadence), and explicit user requests (a retry affordance). Only the latter two justify refetching data a panel already shows; an input-driven pass exists to fill empty panels, never to refresh full ones. See also: Deferred Tier, Immediate Tier.

### Detached Data Sink

A component that keeps the shape of a view — it builds an element, exposes an accessor for it, accepts state updates — while nothing in the app ever mounts that element or reads the component back, so every update it absorbs is invisible by construction. The shape arises by erosion rather than design: a rendering component loses its consumers over time but keeps its element-building constructor, and the surviving write-only wiring reads as a working feature to anyone adding UI onto it.

The defining hazard is that a detached element is fully functional — queries, attributes, and text content behave identically whether or not the tree is rooted in the document — so component-scoped tests cannot distinguish mounted from detached; only an assertion whose query starts at the document can. Accessibility attributes on such a node are a false claim, since the accessibility tree derives from the rendered document. Two compounding factors keep the failure silent: callers that write through optional chaining make an absent component and a detached one byte-identical at every call site, and a subclass that replaces its base class's element after construction opts itself out of every base-class mounting path. The three-grep reachability check — does anything read the element accessor, does the root class name occur beyond its creation site, does anything call the component's read API — proves detachment without a browser. See also: Late-Mount Window, Vacuous Guard.

### Shift Victim

An element that browser and RUM layout-shift attribution names because its *position* changed — it was pushed by something else. Both Chrome's largest-shift-target and RUM per-selector rankings report victims; neither reports causes. A fix aimed at a top-ranked victim is a hypothesis about the pusher, not a confirmed target: prominent above-the-fold elements rank as victims whenever anything above them changes the layout. See also: Shift Mover.

### Shift Mover

The element that *causes* a layout shift by changing its own footprint — growing, shrinking, materializing (insertion), or disappearing (removal). Movers are not reported by shift-attribution APIs; naming one requires diffing element geometry across the shift itself (a cached top/height baseline compared at shift delivery). The victim/mover distinction is load-bearing for all layout-stability work in this project: two shipped fixes aimed at victims had null field effect before mover instrumentation named the true mechanism. See also: Shift Victim, Deferred-Shell Contract.

### Split Layout

The dashboard mode where the map becomes a resizable column beside the panel grid, replacing the **stacked layout** (a full-width map band above the grid). One shared threshold, defined once in code and mirrored by CSS media queries whose literals are pinned by an alignment test, gates the switch for web and desktop alike — the two platforms previously used different thresholds, and their drift shipped a panel-loss bug. Mode-conditional state (which element owns the dashboard scroll, which storage key holds the saved map height) flips with the mode, so anything encoding a viewport-to-behavior expectation — e2e viewport tables included — is part of the threshold's blast radius. *Avoid: ultrawide (the legacy name that survives in code identifiers predating the unified threshold).* See also: Bottom Zone.

### Bottom Zone

The drop zone under the map, available only in the split layout, where a user can dock panels out of the main grid. Its membership is remembered separately from the main panel order, and zone reconciliation moves the remembered panels in or out when the layout mode changes — which is why the zone's CSS visibility and the reconciliation logic must agree on the same threshold: hiding the container while reconciliation still moves panels into it makes those panels vanish. See also: Split Layout.

## Payments Provider Calls

### Retry Ownership

The invariant that exactly one layer owns retry policy for any external provider call — every other layer in the chain (vendor SDK internals, edge gateway, client transport) is either pinned to zero retries or restricted to failure classes the owning layer never retries. Vendor SDKs commonly ship default internal retries that honor a provider's advertised wait verbatim, so a retry layer added above an unpinned SDK silently multiplies raw request volume and turns the owner's attempt counts and wall-clock deadlines into fiction — the owning layer can only bound what it can see. Ownership is asserted by construction (retries pinned off when the client is built, each attempt individually time-bounded) and guarded by a contract test, never by convention. See also: Rate-Limit Outcome.

### Rate-Limit Outcome

The typed value a provider-rate-limited operation returns *instead of throwing*, so every downstream surface renders a deliberate retry state — an HTTP 429 with a retry hint at the service boundary, a structured error code on the public API — rather than collapsing the limit into a generic failure. The outcome only exists after the owning retry layer has exhausted its bounded attempts; a raw rate-limit error escaping before that point is a defect, not an outcome. See also: Retry Ownership.

## Error Telemetry & Suppression

### Trampoline Frame

A stack frame contributed by a monkeypatched global — most often a third-party script's `window.fetch` wrapper — that appears in a trace as though it were a caller but merely passes the call through. Trampoline frames make third-party failures look first-party, which is why suppression gates must classify them; the trap is that their *names* are minifier output, renamed at will across builds and eventually omitted entirely, so any gate that recognizes a trampoline by name shape is on a treadmill. Identity comes instead from build-stable structural facts: which first-party chunk the frame is attributed to, and whether the wrapping script's own frame is present in the same trace. A gate that admits trampoline frames from a chunk is safe only under an *enforced* invariant that the chunk's backing modules perform no network work of their own — enforced meaning a test fails when it stops being true, not a comment asserting it. See also: Vacuous Guard.

### Two-Verifier Seam

The Clerk bearer is checked twice on `/api/user-prefs`: first by the edge (`jose` + cached JWKS in `validateBearerToken`), then again by Convex's OIDC verifier after `client.setAuth`. A token can pass the first check and fail the second. That gap is usually remaining lifetime versus round-trip and clock skew, not JWKS/audience/issuer drift — the edge already accepted the signature. `convex_auth_drift` (WORLDMONITOR-QK) is the Sentry name for the Convex-side rejection; it is the near-expiry face of a leftover token. A token's fate at the seam has three outcomes, not two: still inside `exp` and rejected downstream lands in QK; already past `exp` but inside the edge's bounded `clockTolerance` also reaches Convex and is rejected there, but is deliberately kept out of QK by the `acceptedWithinClockTolerance` capture skip rather than by any edge 401; only a token past `exp` *and* past that tolerance is refused at the edge, which is the XR/XQ face. Because QK's boundary is a capture skip, widening the tolerance moves events out of the bucket without changing what Convex does. Event volume here is failure rate times write volume, so QK also climbs when `CLOUD_SYNC_KEYS` grows, with no auth regression at all. See also: Anonymous Session.

## Timestamps & Hot-Document Writes

### Content Clock

A timestamp whose meaning is "the data beside it was confirmed against its source at this moment" — as distinct from a write stamp, which records only that a write happened. A clock becomes a content clock the moment any consumer compares it against another clock to decide which of two sources holds the fresher content; from then on, two rules bind every writer. Any write that changes the content the clock dates must stamp the clock in the same write, or the clock silently stops dating the content. And the clock may be throttled only for *no-change* writes: skipping a write when the content is identical cannot mis-order a freshness comparison, because whichever side then wins names the same content. The seeder-payload instance of the same idea is the Content-Age Contract — date the observations, never the run. See also: Content-Age Contract, Touch Mutation.

### Touch Mutation

A fire-and-forget mutation that stamps a credential's last-used time as a side effect of validating it. The stamp is telemetry — nothing may treat it as a Content Clock — which is what licenses aggressive suppression of the write. Its discipline is a debounce split across two lines that share one window constant: the *scheduling* site consults the stamp returned by the validation read and schedules nothing while the stamp is fresh, so no queue of touches can accumulate behind a debounce boundary and herd-write the same hot document when the window expires; the mutation re-checks staleness on execution as the second line, turning any straggler that races anyway into a read-only no-op — and in an optimistic-concurrency store, an execution that never writes cannot conflict. Splitting the window's value across the two lines is the failure mode: the halves drift and the herd returns. See also: Content Clock.

## Test & Guard Verification

### Vacuous Guard

A test, CI gate, or static audit that reports success without having examined what it claims to cover, because its *input* silently shrank rather than because its assertion held. The distinguishing property is that it fails open: guards of this shape assert a negative — a violation list is empty, a count is zero, no match was found — and an empty input satisfies a negative assertion perfectly, so the less such a guard actually checks, the greener it looks. Levers that shrink the input include a skip condition gated on a flag nothing sets, a normaliser or comment-stripper that deletes part of the scanned source — whose sharpest form is directional, since a normaliser that *truncates* to a boundary marker keeps a prefix and silently discards an unbounded tail, so any regression landing past that marker is deleted before the assertion sees it, while *excising* the bounded region between the marker and the next one keeps everything else; the excision in turn depends on that next boundary existing, which is its own positive control (assert the ignored region is never last, or the excision quietly no-ops and the ignored region leaks back in), a filter or path-walk predicate that stops matching files — or one authored too narrow from the outset, whose scope silently encodes a false claim about where the target can appear, the everyday instance being a source-only extension glob that never covered the documentation or localized files also carrying the string, so a zero-result search reads as proof of completeness; this lever is not confined to automated gates, and is at its most dangerous inside a human-followed runbook step, where the operator is under time pressure and explicitly looking for permission to proceed — and a test harness that never supplies the input the assertion is written about — an "X is absent" check cannot fail when the fixture could not have produced an X in the first place. Two further levers arise from *substitution* rather than filtering: a stub standing in for the unit under test, which makes every branch inside it — error returns especially — unreachable by a contract assertion that still passes for every other tool in the registry; and a lookup that parses a value out of another file, whose miss branch yields a plausible default (`0`, empty, `null`) instead of raising, so a moved or renamed target reads as a real answer rather than a lost one. Both are refactor-triggered: nothing in the import graph follows a path held as a string, so the compiler and the suite stay silent. A third shape does not shrink the input at all but asserts against the wrong artefact: a *wiring* guard that greps a script's source text for the command it should invoke, rather than executing the decision and observing what ran. Such a guard survives the bug restored verbatim, because inverting the condition that reaches the command, or dropping the `|| exit` that propagates its failure, leaves the grepped token in place — the remedy is to move the decision into something callable and run it against stubbed executables, asserting the invocation. A fourth shape asserts a negative consequence of an action the test never actually performed: a check that some effect did *not* follow a simulated user gesture is satisfied just as well by the gesture never landing, so an input that silently does nothing — a scroll against a container that does not scroll, a click on a detached node — makes "nothing happened" indistinguishable from "the mechanism suppressed it". The remedy is a positive control: assert the trigger was delivered before asserting anything about its absence of effect. A fifth shape corrupts the *comparison value* rather than the input: two writers emit a failure sentinel on the same failure path — a probe command that prints its sentinel to stdout even as it exits non-zero, plus a fallback echo appended inside the same command substitution — and the capture concatenates them, so the captured value never equals the bare sentinel and a "not-sentinel means healthy" check passes for a target that is entirely dead. The remedy is a single sentinel source: rely on the command's own failure output, or branch on the exit status, never both. A sixth shape shrinks nothing and substitutes nothing: it examines the whole input and asserts truthfully, but along the wrong *axis*. A schema gate that diffs emitted field names against declared field names answers only whether every emitted key is declared; it is silent on whether the emitted *values* satisfy the declaration, so a producer writing an explicit null for a field the schema declares as absent-when-missing publishes a declared name carrying an undeclared value, and the gate certifies it green forever. The remedy is to name the axes the gate covers and to enforce the uncovered one somewhere it can be seen — for a serialized contract, on the serialized wire rather than the in-process object, since undefined disappears from JSON and null does not. A seventh shape is a guard-of-a-guard that goes blind in lockstep with its subject: a parser paired with a count pin that shares the parser's own pattern shape drops the same unrecognized forms from both sides, and the two agree at the wrong number rather than disagreeing loudly — a self-check must be strictly looser than the thing it checks. An eighth shape covers every unit a fix touches and still misses the fix: when the corrected behaviour lives in the *seam* that composes those units — which decoding a caller applies to a response before handing it to a parser, which of two overloads it selects — then unit tests over the parts stay green with the seam reverted, and the count of them is no evidence at all. The tell is that the diff's essential line sits in a function no test names; the remedy is to make the composing function callable and drive it against a stub deliberately built to satisfy *both* branches, so only the correct seam produces the correct result. A ninth shape neither shrinks its input nor checks the wrong axis: it derives its *expectation* from the very artifact it is checking. A generator with a `--check`/`--write` pair does this when the check renders its expected output from the committed artifact while the writer renders from a fresh rebuild — the check then compares the artifact against a projection of itself, is self-consistent by construction, and cannot see the artifact drifting away from the source of truth it is supposed to track. The tell is available in one command: run the writer on a clean tree and read `git status`, because any diff is drift the checker could not see. Two properties make the remedy stick. The comparison must be against a *rebuild* (byte-compare the serialized rebuild, since a semantic walk misses whole classes — a deleted row that both sides omit identically), and the writer must be a **fixpoint**, or there is no stable expectation to compare against; a writer that retires a row on one run and deletes it on the next has none. The economic half is inseparable from the correctness half: an honest comparison over a field that churns for unrelated reasons taxes every change and gets reverted, so the drift-prone field that carries no meaning must be removed in the same stroke that makes the check honest. A vacuous guard is worse than no guard, because it also supplies confidence. See also: Mutation Proof, Surviving Mutant, Wiring Guard.

### Mutation Proof

This project's standard of evidence that a guard actually guards: deliberately break the thing the guard protects, observe the guard turn red, then restore the source byte-identically. Reading a guard establishes what it intends; only the mutation establishes what it covers. A guard that stays green when its subject is broken has not been shown to work, regardless of how carefully it was reviewed. The obligation applies recursively — a guard written to protect another guard needs its own mutation proof, and is a common place to skip one, because having just written it supplies the feeling of coverage without the evidence. The proof is only as fine-grained as the mutation: when one shared helper is applied across many call sites, breaking the *helper* breaks every site at once, so a single covered site reds the suite and the result saturates — it establishes that the suite depends on the helper somewhere, never that any particular site is covered. Bulk applications therefore require mutating one call site at a time, which is also the only way a surviving mutant can be attributed to a specific site. See also: Surviving Mutant, Vacuous Guard.

### Surviving Mutant

A deliberately broken call site that the test suite fails to notice — the unit in which guard coverage is actually measured, and the artefact a per-site mutation sweep is run to enumerate. Survivors cluster in two shapes that reading cannot reveal and a whole-helper mutation cannot localize: a *branch no fixture reaches*, typically a fallback whose primary path every realistic fixture satisfies and thereby short-circuits; and a *sibling field* on an output row that interpolates several untrusted values, where poisoning one field proves exactly one of them. Both are properties of the fixtures rather than of the code, so they persist through code review and through a rising test count. The useful discipline is to report coverage as a ratio of sites with no survivor rather than as a count of red tests, since the latter saturates while the former does not. See also: Mutation Proof, Vacuous Guard.

### Wiring Guard

A gate that asserts the project's automation actually *invokes* each regression guard — that every required suite, script, or spec is named by some workflow — closing the failure mode where a guard exists, passes, and is simply never run, which from the outside reads identically to green. Its defining tension appears when invocations are consolidated: folding several guarded commands into one combined entry point correctly trips the wiring guard, and the correct repair moves the pin down a level rather than deleting it — require the combined entry point to be wired *and* pin the list of things it must still invoke, with a Mutation Proof that dropping one member turns the gate red. Repaired any other way, the consolidation becomes the mechanism by which a guard stops running while the gate stays green. See also: Vacuous Guard, Mutation Proof.

### Extraction Evidence Gate

A deterministic check that a value reported by a model-based extractor actually appears in the raw content the same acquisition call returned — the value's digits or text must be present in the fetched source, or the observation is rejected as unproven. The gate exists to break a bistable failure in prompt-only anti-fabrication: wording strict enough to stop invented values also makes the extractor withhold values genuinely present in the source, while wording loose enough to report them lets inventions through; moving safety into a mechanical presence check lets the prompt stay permissive. Two properties define a sound gate. First, its matcher is itself an attack surface: on digit-rich source material, a naive matcher assembles "proof" from unrelated numbers — a fraction lifted out of a nearby rating, a size token certifying a quantity reported as a price — so the matcher needs the same adversarial treatment as any guard, with the bypass shapes pinned as regression tests. Second, its abstain state must be observable: when the acquisition call returns no raw content the gate cannot run, and if that outcome is indistinguishable from a verified pass, a provider quietly dropping content reverts the whole pipeline to unguarded acceptance while every health surface stays green — the Vacuous Guard failure arrived at through a different door. The gate proves presence, not attribution: a value printed elsewhere on the page still passes, so identity checks (title, currency, size plausibility) remain the attribution defense. See also: Vacuous Guard, Mutation Proof.

### Closed-World Gate

A completeness check structured so the universe it covers is mechanically enumerated from the source of truth and every member must be classified — required (mechanically asserted at every consumer) or excluded with a recorded reason — so an unclassified member fails the gate at the moment it is introduced. The inverse of an opt-in allowlist, which can only catch what someone remembered to add and therefore rots silently as the universe grows; a closed world converts each new member into a forced, recorded decision, and the classification record doubles as a decision log distinguishing deliberately-absent from forgotten. Both halves need their own vacuous-pass protection: an enumerator that finds zero members, or an extractor that finds zero consumers, must fail rather than skip. See also: Vacuous Guard, Mutation Proof.

### Ratchet Inventory

A counted census of a known-bad idiom's remaining occurrences, recorded per (file, idiom) pair with an occurrence count, which the guard enforces in *both* directions: a higher count or an unrecorded pair fails as new drift, a lower count fails as a stale record that must be updated. The bidirectionality is what separates it from an allowlist — a plain permission list cannot see a second occurrence added to a file it already forgives, which is the highest-traffic regression shape there is, because new code lands in the files that already carry the pattern. Counts must be measured on normalised source (comment-stripped, at minimum), or a mention of the idiom in prose keeps an entry alive after its last real call is gone and the stale check never asks anyone to delete it.

Two properties are routinely misread. An entry is a *record*, not a permission slip: it says this many occurrences are known and tracked, never that they are sanctioned. And a shrinking entry does not imply zero is the destination — some populations have a floor, where the surviving occurrence is the one that must *not* be migrated, so its count is terminal rather than unfinished. A ratchet cannot distinguish "this count moved" from "this count moved for the wrong reason", so wherever a floor exists it has to be stated in the inventory *and* in the guard's own failure text, which is the only prose the person driving the count to zero will actually read. The behavioural rule underneath the floor needs a separate test; the ratchet enforces the census, not the reason. See also: Closed-World Gate, Vacuous Guard, Mutation Proof.

## News Story Tracking & Trend Detection

### Feed Digest

The server-side pre-aggregation of a variant's news categories into one response, so a client can render headlines without fetching any feed itself. It is per-variant and per-language, and the categories it carries are the ones that variant's preset declares — which makes "is this category in the digest?" the same question as "is this category in the active variant's preset?". Distinct from the brief's digest *cadence*, which is a delivery schedule and shares only the word. Its failure modes are asymmetric: a refused request is obvious, but a successful response carrying no categories is a degraded answer that still looks like data, so any consumer testing the digest for presence rather than for coverage will read an outage as a completed load — and coverage governs not only whether a load landed but whether the response is fit to become the Last-Good Digest. See also: Custom Category, Digest Coverage, Last-Good Digest, Variant Host.

### Last-Good Digest

The most recent Feed Digest a client retains locally so it can still render news when the live digest is unreachable. It is the fallback that exists to survive degradation, which makes what may *enter* it a stricter question than what may be rendered from it, and it is scoped to the variant and language it was built for — an entry from another scope describes a different category set and is not a substitute for one.

Three rules follow, each easy to get wrong in the permissive direction. Eligibility is decided by coverage rather than by a response merely being well-formed, so a degraded answer carrying no categories must not enter however successful it looks. *Using* a response and *retaining* it are separate decisions: one covering fewer categories than the retained entry is still real data for the categories it names and may be rendered, but replacing a wider entry with it trades the fallback down for every later session — so it is used without being retained, a veto that holds only while the retained entry is itself still servable, letting a genuinely narrowed digest take over within one retention window rather than being locked out forever. And because retention is conditional on the entry already there, writing one is a compare-and-swap: concurrent writers that each read the pre-write state will otherwise let the loser land last. See also: Feed Digest, Digest Coverage, Variant Host.

### Digest Coverage

The Feed Digest's self-description of how complete it is, carried as two distinguishable identities: the content state (what body is being served, when it was generated, which categories it covers) and the attempt state (what the latest build attempt achieved, whether it hit its deadline, which categories completed). A closed overall vocabulary — complete, partial, stale, unavailable — is decided from those identities, and the two are kept separate because a served body and the latest attempt can disagree: when older accepted content is served after a failed rebuild, attaching the current attempt's counts to the old body without naming the difference misdescribes both. Coverage gates entry into the Last-Good Digest and is what consumers — dashboard, agents — must condition on before treating a digest as fit for summaries or alerts; its public form carries counts, category states, and closed reasons only, never raw errors or host detail. See also: Feed Digest, Last-Good Digest.

### Custom Category

A news category a session resolves that the active variant's preset does not declare, so the Feed Digest never carries it and a direct client-side fetch is its only path. Custom categories arise from panel customization — enabling a panel belonging to another variant — which is why their cost falls only on sessions that customize. Two consequences follow from being digest-exempt and are easy to miss. The per-feed cap that bounds a digest outage for preset categories is a custom category's *steady state* rather than a degraded ceiling, so whatever the cap allows is what that panel permanently shows. And a category key already claimed by a non-news panel must never resolve as one: there is no panel to render it, so every feed fetched for it is waste that no user can see. See also: Feed Digest, Variant Host.

### Story Accumulator

The rolling corpus of recently-tracked news stories, ordered by when each story was last seen, that downstream consumers read to answer "what has been in the feed lately?". It is a *retention window*, not a queue: entries age out on a fixed horizon rather than being consumed, and several unrelated consumers — the digest cron, trend detection — sample the same corpus independently for different spans. Its retention horizon states how far back entries *may* reach; it says nothing about how many are there, and on a busy feed the corpus holds far more stories than any single consumer intends to read at once. See also: Sampled Span, Seed-Owned Key.

### Keyword Spike

A term — an ordinary word, a vulnerability identifier, or a threat-group designator — appearing materially more often in a recent window than its own recent history predicts. A spike is deliberately harder to earn than "appeared a lot": the term must clear a floor of distinct mentions, exceed its baseline rate by a strict multiplier, and be carried by more than one outlet, so a single prolific source cannot manufacture one. When no baseline exists yet the decision falls back to the floor alone, which is why a corpus that yields no usable baseline silently converts spike detection into simple frequency counting. See also: Sampled Span.

### Sampled Span

The stretch of time a derived statistic was *actually* computed over, as distinct from the retention horizon of the store it drew from. The two diverge whenever a bounded read — a row cap, a page size, a top-N — returns fewer rows than the horizon contains, and the divergence is silent: the read succeeds, the arithmetic runs, and only the result is wrong. Any rate, baseline, or per-unit-time figure must be divided by the span its rows demonstrably cover, and a consumer-facing statistic should report that measured span rather than the horizon constant, since a caller has no other way to tell the two apart. Truncation is also biased rather than random — a newest-first read starves the historical side of a recent-versus-baseline comparison, an oldest-first read starves the recent side. See also: Story Accumulator, Keyword Spike.

## Prediction Markets

### Market Pool

One of the named category buckets a published prediction-market payload is divided into — geopolitical, tech, finance — where every market belongs to exactly one.

The pools are a *partition*, not a set of overlapping views: membership is a single primary category assigned by a fixed precedence, so no market appears twice and no market is dropped. That property is load-bearing rather than incidental, because every consumer selects a pool **by name** — a site variant, an agent-facing category argument, a prompt builder — and a pool that quietly contains everything makes all of those selections meaningless while still looking healthy. Precedence, not tag exclusivity, is what resolves a market carrying signals from several categories; reordering the categories therefore moves real markets between pools. The complete set of markets is deliberately *not* a pool: a reader wanting every market asks for the union explicitly, because reaching for a single pool to mean "all" is only ever correct by accident. See also: Seed-Owned Key.

## MCP & Agent Discovery

### MCP Server Card

A static JSON discovery document that describes the MCP server: its name, version, supported transport, endpoint URL, authentication requirements, and tool/resource/prompt catalogs. It is served at `/.well-known/mcp/server-card.json` and returned by a plain `GET` to the well-known aliases (`/.well-known/mcp`, `/.well-known/mcp.json`). It is the *machine* discovery representation; the *human* one is the server guide. Clients performing a live MCP handshake still `POST` to the transport endpoint.

### Discovery Read vs. Transport Operation

The distinction that lets one URL serve both crawlers and MCP clients. A `GET` carrying neither `Last-Event-ID` nor an `Accept: text/event-stream` is a **discovery read** — a human or crawler opening the endpoint — and receives a document (the markdown server guide at `/mcp`, the JSON card at the well-known aliases). Every other `GET` is a **transport operation**: an SSE stream-open, which must receive the spec-correct `405`, or an authenticated `Last-Event-ID` replay. Request semantics, never user-agent sniffing, decide which. The consequence for caching is load-bearing: because these URLs negotiate on request headers, any cacheable response must declare `Vary: Accept, Last-Event-ID`, or a shared cache keyed on URL alone will replay a stored discovery body to a transport client. The live transport URL goes further and stays `no-store`, so its correctness never depends on an intermediary honoring `Vary`.

### Credential Class

One of the independent doors through which a caller reaches MCP tooling: a pro OAuth token, minted for any entitlement that clears the mint gate (a paid tier with MCP access), or a user API key, available only to plans that include API access. The classes are resolved by different code paths and carry different hardcoded assumptions, but they are not plan boundaries — an API-tier subscriber legitimately holds both.

The load-bearing rule: credential class never determines plan family, so any rule stated per-plan ("API tiers keep the default cap") must discriminate on the plan key, not on which door the request came through — otherwise the other door grants what the rule withheld. Daily metering is per-user, not per-class: every class increments one shared counter because the principal is the key's owner, which means all classes a user can hold must resolve the same limit against that counter. See also: Plan Family, Entitlement.

### Streamable HTTP Transport

The MCP transport this server implements over HTTP: JSON-RPC 2.0 requests via `POST`, with optional Server-Sent Events when the client advertises `Accept: text/event-stream`. Its `405` on a standalone stream-open is not an error but a contract — MCP SDK clients read it as the graceful "no standalone stream" signal and complete the handshake. Anything that converts that `405` into a `200` (including a CDN replaying a cached discovery response) breaks the handshake.

## Routing & Hosts

### Variant Host

One of the product-variant subdomains (`tech`, `finance`, `commodity`, `happy`, `energy`) that serves a themed dashboard entry and metadata. The middleware and Vercel config recognize these hosts explicitly; canonical discovery URLs for shared surfaces (such as `/mcp`) redirect retrieval-method requests from variant hosts to the apex host so discovery signals do not fragment. This is the web half of variant resolution only — see Desktop Variant Selection for the desktop half, which does not use hosts.

## Anonymous Access

### Anonymous Session

The short-lived, server-signed identity that authorizes a key-less browser to read our public API surface, held in an HttpOnly cookie the client cannot inspect — it can only track the expiry and ask for a new one. It is not a user identity: it is freely mintable by anyone, is not bound to an account, and is deliberately refused by tier-gated routes, so a valid anonymous session and an authorized one are different questions. Clerk bearer tokens and user API keys take precedence wherever both are present.

Because the cookie is opaque to JavaScript, the client can only infer its health from responses, and that inference is the fragile part. A rejection observed on one route is evidence about *that route*, not about the session — the two are distinguishable only by whether independent routes fail the same way. See also: Session Blackout, Entitlement.

### Session Blackout

The client-side cooldown during which every anonymous API call is answered locally with a synthetic unavailable response instead of reaching the network, entered when the anonymous session is judged unrecoverable and lifted automatically when the cooldown lapses. Its purpose is to stop a dead session from amplifying into a request-mint-retry storm across every panel.

The blackout is deliberately blunt — it suppresses the whole surface — so what justifies entering it matters more than what it does. Only session-wide evidence qualifies, and that is narrower than "the mint failed": a *server verdict* on the mint alone (see Mint Attempt), or any other failure corroborated across distinct routes *within seconds of each other*. A single route's denial, even one that survives a fresh mint, is route-scoped evidence and earns at most route-scoped suppression; generalizing it blanks a dashboard whose session was never broken.

Two properties make that corroboration mean what it says. It is time-bounded, because the evidence being generalized from is temporal coincidence — denials minutes apart are two endpoint problems, not one session problem. And it is retracted by success: a single credentialed 200 proves the browser is delivering the cookie, which settles the question the blackout was about. Suppression and evidence therefore expire on different clocks, and a sibling's success must retract the evidence without releasing the failing route's own suppression — that suppression is what stops a known-bad endpoint from re-minting on every poll.

One consequence is easy to miss: a request already in flight when a blackout is declared is the only kind that can still reach the recovery path, and re-declaring the blackout from it extends the cooldown rather than being absorbed as a duplicate. A blackout therefore lasts its nominal window only if the paths that were merely *suppressed* by it stay silent. See also: Anonymous Session, Mint Attempt.

### Mint Attempt

One try at obtaining an anonymous session, and — this is the part that carries the meaning — the verdict of that try, which is not the same as whether a session came back. Four outcomes are distinct and need different responses: the mint succeeded; the mint failed and the *server* rendered that verdict (it refused, or answered something unusable); the mint failed in our own transport or threw client-side, so the server rendered no verdict at all; or **no mint was attempted**, because the session was already blacked out or because the mint succeeded and the browser then refused to keep the cookie.

Only the server-verdict case is session-wide on its own; everything else needs corroboration. The distinction that is easiest to lose is the last one — an attempt that never happened is not a failed attempt, and reporting it as one both misdirects diagnosis and re-arms the blackout it was suppressed by. The verdict therefore travels with the attempt's result rather than being recovered afterwards from module state, which would describe whichever attempt finished last. See also: Session Blackout, Anonymous Session.

## Billing & Entitlements

### Entitlement

The per-user record granting feature access — a plan key, feature flags with a tier, and a validity horizon — derived from subscriptions by the server and replicated to clients as a reactive snapshot. An entitlement is evidence of paid access *now*; it says nothing about why access exists or when it will renew. When its validity horizon passes without a renewal being recorded, readers fall back to free-tier defaults, which is the moment stale local state can misrepresent a still-paying customer.

Feature flags are resolved by merging the plan's catalog defaults under the stored row, so a record written before a flag existed still reports that flag's current default for its plan — "the row predates the field" is therefore never on its own a reason a capability would read as absent.

### Affirmative Denial

The rule governing every client-side premium gate: a surface may be withheld only on positive evidence that the session is unentitled — a settled signed-out session, or a loaded entitlement snapshot that fails the access predicate — never on the mere absence of evidence. Reading "no snapshot yet" as "not entitled" is what locks paying customers out, because a snapshot that has not arrived is indistinguishable from one that never will.

Which way an unknown resolves depends on whether waiting terminates. A *bounded* unknown — one guaranteed to settle on its own within a known window, such as auth hydration — may withhold briefly, since the cost is a delay rather than a lockout; it must not be counted as a denial in funnel metrics, because no user was gated. An *unbounded* unknown — one that may simply never arrive, such as an entitlement subscription that gives up silently when its backend is unreachable or unconfigured — must resolve to access. A corollary follows from that asymmetry: a gate that fails open can revoke access mid-use, so any surface reachable during the open window must define what happens when the verdict flips. A fail-open gate is only safe when losing access has a specified behavior instead of stranding the user in a state whose exit affordance was just hidden. See also: Entitlement, Billing UX State.

A gate is also only as live as the signal it reads. A predicate keyed on a field nothing in the system writes denies every caller forever while looking perfectly reasonable in review, and it raises no error and draws no complaint, because the surface never renders for anyone to miss.

### Plan Family

The grouping of plan keys — pro-family (personal and business dashboard plans), API-family (programmatic-access plans), and enterprise — that billing and quota rules discriminate on. Checkout duplicate-detection, seat licensing, and quota scoping are all stated per-family, and a family is not recoverable from the tier number or from which credential a caller presents: tier gates are thresholds, so a higher-tier API-family plan clears every gate written with the pro family in mind, and an API-family subscriber can hold pro-class credentials. Rules written against any proxy for family (tier, credential class, feature flag) will misfire on the plans where the proxy and the family diverge. See also: Credential Class, Entitlement.

### Capability-Gated Deep Link

A link that jumps a user straight into a surface which only exists when they hold a particular capability, so the entry point must be gated on the *same* predicate the destination renders on — never on the plan or tier believed to imply it.

Two rules follow. Plan-to-capability mappings drift while the destination's own condition does not, so gating on the wrong signal yields either an upsell for something the user already bought, or a navigation into a surface that renders nothing at all. And when the opener outlives the moment it was built — captured into a closure that some later affordance replays — the capability must be re-read at click time, falling back to a surface that always renders. When the capability is genuinely absent the correct behavior is to suppress the entry point entirely; pointing it somewhere degraded is not. See also: Entitlement, Activation Interstitial.

### Covering Subscription

A subscription that currently grants paid coverage. Coverage is decided per status, not by the status name's plain-English reading: an active subscription covers; an on-hold subscription (payment failed, provider retrying) still covers through its retry window; a cancelled subscription covers until the end of the period already paid for; an expired subscription never covers regardless of its recorded period end. The server owns these rules; any client-side derivation must mirror them rather than re-deriving from status-string intuition.

The mirror is exact except at one boundary, and the exception is deliberate: the server treats the paid window as open while `currentPeriodEnd > at`, the client while `currentPeriodEnd >= at`. The client is the more permissive of the two for the single instant they differ, which is safe precisely because a Billing UX State changes copy and actions only and never grants access the server would deny — while the reverse rounding would blink a covered plan into looking lapsed between snapshots. Anything that later deduplicates the two implementations must preserve each side's boundary rather than picking one, since the comparison is load-bearing in opposite directions.

Answering "does this row cover?" is also not the same as answering "does this user have access". An `active` or `on_hold` row reports covering on its fields alone whatever its period end, so a row whose renewal webhook was missed still looks covering; only the full Billing UX State derivation resolves that into pending verification or lapse. Coverage predicates are therefore safe for choosing copy and never safe as an entitlement gate. See also: Cancelled-But-Paid-Through, Billing UX State, Renewal Verification.

### Cancelled-But-Paid-Through

The state of a subscription whose auto-renew has been turned off but whose paid period has not yet ended. Colloquially "cancelled" reads as terminal; here it is a covering state until period end, and only afterwards does coverage lapse. UI and copy must not treat it as ended while the paid window is open — telling such a customer their subscription "has ended" invites duplicate checkout. See also: Covering Subscription.

### Renewal Verification

The bounded, on-demand re-check against the payment provider that runs when locally-stale paid evidence would otherwise cause a denial — instead of trusting a possibly-missed webhook, the provider is asked directly. It records a verdict (pending while queued or in flight, failed when the provider check errored, lapsed when the provider confirms coverage ended) that both the denial surfaces and the client UI consume. It shares provider-evidence bookkeeping with the scheduled reconciliation sweep but is deliberately independent of it, so one path failing cannot suppress the other. See also: Billing UX State.

### Billing UX State

The single client-derived state that decides what a customer sees when premium access is in question: free (never paid), active (access works), on-hold (payment failed, retry window), renewal-verification pending or failed (paid evidence went stale and the provider re-check is running or errored), or lapsed (coverage confirmed over). Its purpose is to prevent the misleading collapse of every non-paying state into a generic upgrade prompt — a paying customer whose renewal is being verified must be told that, not sold to. Derived purely from the entitlement and subscription snapshots, it changes copy and actions only; it never grants access the server would deny. See also: Covering Subscription, Renewal Verification.

### Referral Capture

The bootstrap-time process that turns an inbound URL param into checkout attribution: `?ref=` or `?wm_referral=` on any dashboard landing is read once at app boot, stripped from the URL, persisted locally with a bounded TTL, and forwarded to the payment provider at checkout to credit the referring sharer. Because the param names are generic-looking, any other use of `ref=` on dashboard-bound links (SEO tags, campaign labels) is silently captured as a fake affiliate code — internal source attribution must use `utm_*` params, which this process ignores. See also: Entitlement.

### Signed Checkout Identity

The account identifier the checkout flow stamps into the payment provider's subscription and payment metadata, alongside a server-issued signature. It is the authoritative answer to "which account bought this" — independent of every email address on the payment record, because it captures who was *signed in* at the moment of purchase rather than what the buyer typed. Consumers trust it only when the signature verifies; an unsigned or tampered value falls back to matching on the provider's stored customer record. Support triage of any "paid but no access" report starts here, never from an email comparison. See also: Entitlement, Checkout Email.

### Checkout Email

The address a buyer types into the payment provider's checkout form. It is unauthenticated, need not match any account, and is best read as "an inbox the buyer can see," never as an identity: the same person can present one address at checkout, another as their sign-in, and a third in support threads. Any message addressed to it can therefore land in an inbox whose address owns no account — and a message that invites sign-in steers the buyer toward an address the auth provider has never seen. "Who bought" is resolved by the Signed Checkout Identity; the checkout email resolves only "where the invoice went." See also: Signed Checkout Identity, Entitlement.

## Activation & Onboarding

### Brief Loop

The composed state in which a paying subscriber receives the daily AI brief off-app without visiting the dashboard: an enabled Alert Rule with the AI digest on a digest cadence, plus at least one verified delivery channel to carry it. The loop is the unit of activation this project measures — "brief loop live" means all parts are wired and delivery will occur on the next digest cycle, not that any single toggle was flipped. Production data (2026-07) showed feature-touching alone does not predict retention; the brief loop is the recurring-delivery wager that replaces toggle-counting as the leading activation metric. See also: Alert Rule, Activation Interstitial.

### Activation Interstitial

The day-0 post-checkout flow shown to a new Pro subscriber once the payment-to-entitlement settling window resolves: a short sequence of one-click, individually-skippable confirms that wire premium features — the Brief Loop first — rather than teach them. Defined against two constraints from production data: activation that does not happen on day 0 essentially never happens, and nothing may activate without an explicit per-item confirm. Distinct from a tour (education, no state change) and from a persistent checklist (dashboard residue; the interstitial leaves at most a dismissible finish-setup affordance). See also: Brief Loop, Activation Step State, Billing UX State.

### Activation Step State

The disposition of one step in the Activation Interstitial, in two layers: a declared state the step opens with — confirmable, already-done, blocked (the platform will refuse), or unavailable (the device cannot do it) — and a transient overlay for the step the user is currently on, in-flight while a confirm runs and failed when it did not work. The load-bearing distinction is terminal versus retryable, because the failed state is what puts a "Try again" button on screen: a refusal no retry can clear — a denied browser notification permission, which browsers never re-prompt for — must resolve to blocked and show the platform's own out-of-app remedy instead. A step that ends blocked resolves as skipped rather than failed, so the summary never claims a failure that was never attempted; the cost is that a platform refusal is otherwise indistinguishable from disinterest and needs its own event to stay countable. See also: Activation Interstitial, Billing UX State.

## Shipping Gate

### Tiered Gate

The pre-push check suite split into two tiers: a state-dependent tier (secret guards, PR-state and branch-contamination checks, lockfile sync) that runs on every push, and a tree-dependent tier (typechecks, invariant lints, bundle checks, scoped tests) that runs only for the paths the branch diff actually touches. Configuration-file changes, or an unresolvable branch diff, escalate the tree-dependent tier to run everything. The gate is a fast local pre-flight, not the merge gate — CI remains the full-suite authority.

### Green-Tree Cache

The tiered gate's attestation that an exact source tree already passed the full tree-dependent tier: a re-push of an identical tree (remote-side failure, message-only amend) skips those checks instead of re-paying minutes. The attestation is keyed by tree content, so any content change invalidates it, and it is not trusted when the branch diff cannot be resolved — a blind run must not rely on an attestation minted under a scoped plan it can no longer verify. State-dependent checks always run regardless of the cache. See also: Tiered Gate.

### Third-Party Rot

A gate failure caused by an external service being unavailable or answering unusably, rather than by anything in the tree under test — the failure class no author of the change can fix. The project's rule is that a gate must split its exit code by *who can fix the failure*: actor-fixable defects hard-fail, while third-party rot warns loudly and passes, with an opt-in flag to restore strict behaviour where a skipped check costs more than a blocked pipeline.

Two properties keep the soft path from becoming a hole. It may fire only when the external system produced no usable result at all, never when a result exists and reports a genuine problem; and the skip must be annotated with what went unchecked, because an unannounced skip is indistinguishable from a pass. The diagnostic corollary matters as much as the split: because the tree is not the variable, the same commit can pass and then fail with nothing changed, so a gate that reddens repo-wide is diagnosed by comparing *when* each run executed rather than by reading pass/fail — sibling branches showing green are often stale runs from before the outage. See also: Tiered Gate, Vacuous Guard.

### Baselined Advisory

A dependency advisory the security gate knowingly tolerates, recorded per-lockfile with written reasoning for why the vulnerable path is unreachable in this project — typically a build-time-only or dev-tooling chain, or a fix that is semver-major on a parent the project cannot yet move.

The baseline is an exemption list, not a suppression: an advisory outside it fails the gate for every branch at once, which is why a newly published advisory blocks the whole repository until someone either patches or baselines it. Each entry carries its justification inline so a later reader can re-evaluate rather than inherit a bare allowlist, and an entry that no longer matches any live advisory is surfaced as stale so the list does not accrete dead exemptions. See also: Third-Party Rot, Acceptance Baseline.

## Localization & First Paint

### English Shell

The small, byte-budgeted subset of English UI strings inlined so first-paint chrome renders real text before the full locale file loads. Membership is decided by namespace: keys under the shell prefixes and referenced from eager chrome must be mirrored into the shell byte-identically, and the whole shell lives under a hard byte cap that is a first-paint performance budget, not a formatting limit. The consequence cuts both ways: post-boot copy placed in a shell namespace pays first-paint bytes for strings nobody can see yet, while first-paint copy placed outside the shell flashes raw keys until the full locale arrives. Choosing a key's namespace is therefore a rendering-time decision, not a taxonomy one.

### Translation Provenance

The English string a committed translation was produced from, recorded separately from the translation itself.

Provenance is what makes staleness detectable at all: a translation whose recorded English no longer matches the current source is wrong even though it is present, so any check comparing only key sets is structurally blind to it. Advancing the record is the one irreversible act in a translation pass — it certifies every current translation as correct against current English, and nothing re-examines a certified key — so it is permitted only when every locale is complete and free of stale entries. Adopting a record for the first time must be an explicit act rather than an inference from its absence, because a deleted record and a first run are indistinguishable, and inferring adoption from absence silently re-certifies whatever the translations currently say. See also: Stale Translation.

### Stale Translation

A translated value whose English source has changed since the translation was made.

Distinct from a *missing* translation, which has no value at all, and from an *orphaned* one, which is a value the current English no longer has a key for. The distinction is load-bearing because only the stale class is fixable by retranslation — no translation of a source string that no longer exists can be correct, so orphans must be pruned instead. Inserting an element into an English list makes every later entry stale at once, since each index then points at a different source string; removing the last element produces an orphan instead, leaving every earlier index matching so nothing registers as stale. See also: Translation Provenance.

## Military Aviation Posture

### Theater Posture

An aggregated military-activity assessment for a named geographic theater, derived from live military flights and tracked naval vessels inside the theater's bounds and published as a posture level per theater.

Theater posture has two independent producers on different schedules — a loop inside the AIS relay and the military-flights seeder — and each acquires flights from its own ordered list of sources. Ordering a source list is not the same as gating it: only one producer treats its list as a true cascade, entering a lower tier solely when the tier above it failed; the other queries its lower tiers unconditionally and merges whatever they return, so a metered tier there is billed on every cycle regardless of whether the primary already succeeded (see Ungated Tier). A cycle that publishes through an alternate source is still a healthy publication; what it must never be read as is recovery of the primary source. See also: Publication Source, Ungated Tier.

### Publication Source

The upstream that actually fed a published theater-posture cycle, recorded with the publication rather than inferred from which sources are configured.

Each cycle attributes exactly one winning source (or a vessels-only outcome when no flight source contributed), and per-source cycle counts accumulate for the life of the producer process. The attribution answers "who fed this record", not "which sources are healthy" — a primary source that answered healthily with zero relevant traffic is a quiet primary, not a failed one, and its health is judged from its own request counters, never from the attribution. Because the two Theater Posture producers use different vocabularies for their sources, every attribution also names its producer. See also: Theater Posture.

## Metered Upstreams

### Credit Budget

An upstream's allowance of request cost per refill period, spent down by every caller sharing the account rather than by each caller independently. Its defining property is that depletion and burst-throttling both surface as the same rejection status, while demanding opposite remediations: a depleted budget is fixed by spending less per period and is unaffected by waiting or by spacing requests, whereas a burst throttle is fixed by spacing alone and needs no reduction in total volume. The two are told apart by the wait the provider itself advertises on the rejection — a wait on the order of the refill period means the budget is gone, a wait on the order of seconds means the request rate is too high. Application-side counters cannot make this distinction, because they observe rejections rather than the balance; establishing which one is in play requires probing the provider directly with the production credentials and reading its own balance and retry headers. See also: Cost Tier, Ungated Tier.

### Cost Tier

The band a request falls into under an upstream's cost function, where cost is a step function of a request parameter rather than a smooth function of the data returned. The consequential case is the **flat top tier**: past some threshold the cost stops rising, so every request above that threshold — including the widest request the endpoint accepts — is billed identically. Where a top tier is flat, splitting one broad request into several narrower ones that each still exceed the threshold multiplies cost while reducing coverage, and the usual "ask for less to pay less" intuition inverts. Determining the tier boundaries before sizing a request is therefore a correctness step, not an optimization: a parameter tuned without reference to them can be adjusted at length with no effect on spend. See also: Credit Budget.

### Ungated Tier

A source in an ordered chain that is queried regardless of whether an earlier source already succeeded, as distinct from a fallback entered only on the failure of the tier above it. The condition is not observable from published data — the publication is fresh and correctly attributed to the primary either way — so it must be looked for in the call path rather than inferred from output.

Whether it is a defect depends on what the tier does with its results. A tier whose results *replace* the primary's adds nothing when the primary succeeded, so on a metered upstream it spends budget for no marginal records and should be gated. A tier whose results *merge* into the primary's is contributing coverage, and gating it trades that coverage away — dangerously so, because a degraded-but-non-empty primary satisfies a success-gate and suppresses the merging tier precisely when its coverage matters most. For a merging tier the correct remedy is to reduce its cost rather than to stop calling it. See also: Credit Budget, Cost Tier, Theater Posture, Publication Source.

## Consumer Prices Ingestion

### Retailer Roster

The set of enabled retailer configurations for one market. The market's coverage denominator is the pages its roster plans, so roster membership — not scrape tuning — is the operational lever when a retailer's domain becomes unscrapeable to every acquisition provider.

A retailer enters or leaves the roster by flipping its declared enablement; a disabled retailer keeps its configuration and its recorded disable evidence so re-admission starts from the prior verdict rather than a fresh diagnosis (and that evidence goes stale — re-probe before trusting it). Onboarding requires probing every acquisition provider against the retailer's domain first: a retailer only one provider can reach carries a single point of failure from day one. See also: Market Completion Floor.

### Market Completion Floor

The declared minimum share of planned pages a market's scrape must complete for the market to stay operationally healthy; below the floor the market grades degraded rather than merely noisy.

The floor governs the market aggregate, not individual retailers — one retailer can fail outright without degrading the market so long as the remaining roster keeps the completion ratio above the floor. Roster size is therefore floor headroom: the roster should survive the outright loss of any single retailer. See also: Retailer Roster.

### Auto Match

A scraped product accepted for aggregation: validation bound the retailer product to a basket item confidently enough that its price is aggregate-eligible without review.

### Candidate Match

A scraped product admitted with doubt: recorded for later review but excluded from aggregates. A page can scrape successfully yet yield only a candidate match, so page-level success and aggregate eligibility diverge — coverage built on page counts alone can read healthy while contributing no usable prices. Strict validation closes the gap by rejecting the doubtful product and trying the next candidate page instead of admitting the doubt. See also: Auto Match, Market Completion Floor.

## Ingestion Acceptance

### Acceptance Baseline

The accepted-problem list the ingestion acceptance gate consults: each entry acknowledges one known degradation, identified by exactly its source and status, and owned by an open tracking issue.

Matching is exact by design. A source that recovers surfaces its entry as a prune prompt; a source that worsens to a different status escalates and blocks, because a suppression written for a lesser state must not cover a worse one. The list as a whole carries an expiry that forces re-review, and an acknowledgement is never added for a status whose remediation is still in flight — the gate exists to verify the remediation, not to trust it. See also: Baselined Advisory.

## Desktop Distribution

### Desktop Variant Selection

How the desktop app decides which product variant to present: from a locally stored user choice re-read at startup, rather than from the host that served it. Switching is an in-app action that reloads into the chosen variant and survives restart.

The distinction from Variant Host is load-bearing rather than cosmetic. One desktop binary is published and it carries every variant, so there is no per-variant download, no per-variant release, and no variant dimension in the update or download path. An interface that accepts a variant when choosing a desktop artifact is therefore recording an identity, not making a selection — treating it as a selector yields a request that can only resolve to the one artifact or fail, and gating any correctness filter on its presence lets the app's own updater, which sends no variant, bypass that filter. See also: Variant Host, Release Line.

### Release Line

The sequence of published releases the update and download surfaces can address. There is exactly one for desktop, because those surfaces resolve the newest published release rather than searching by name — so a second, differently-named line is unservable by construction no matter how it is built or tagged. Publication is therefore the point at which a release becomes visible to every installed client at once, which is why a release is assembled privately and made visible only once every artifact it advertises exists. See also: Desktop Variant Selection.

## China Market Access

### Northbound Turnover

The daily value of Stock Connect trading in mainland A-shares, counted in both
directions: buys and sells added together. It is a measure of how much foreign
participation occurred, never of how much capital arrived. The distinction is
load-bearing because the exchanges once published the buy and sell legs
separately — so net inflow was derivable — and stopped, leaving only the
combined figure. A surface that labels this "flow", "net buy", or "inflow" is
not merely imprecise, it reports a number that means something else entirely.
Any net-flow figure quoted today is a vendor's reconstruction, not exchange
truth. See also: Trade-Date Agreement.

### Trade-Date Agreement

The requirement that two independent publishers of the same daily series report
the *same* session before their values may be combined. It serves two purposes
at once: it prevents the arithmetic error of summing different days, and it
detects a frozen publisher on the very next run — a source that keeps answering
with a stale session disagrees immediately, rather than waiting out a staleness
budget while looking alive. Because the correctness guard and the liveness
alarm are the same check, the monitoring cannot be disabled without also
breaking the sum. It applies only to sources that genuinely share a publication
clock; series on different schedules would disagree constantly and the check
would degrade into noise.

## Resilience Scoring

### Dimension

One scored facet of a country's resilience — a single question about the
country ("how exposed is its financial system?") answered as a number on a
common scale, so facets that measure unlike things can be combined. A dimension
is not a data source: it is a construct assembled from several inputs, and the
same source can feed more than one.

A dimension can be published dark — computed but deliberately excluded from what
readers see — while its inputs and calibration are proven. Dark is a rollout
state, not a defect state; a dimension that is dark is still expected to be
correct.

### Component Slot

One weighted input to a dimension, together with the weight it carries. A slot
resolves in one of three ways: to an observed reading, to an imputed value
carrying reduced certainty, or not at all.

The third case has a consequence worth stating, because it is the opposite of
the intuition: an unresolved slot is not scored as zero and does not pull the
dimension down. Its weight is redistributed across the slots that did resolve,
so the dimension moves toward whatever survived. Withholding a slot is
therefore never automatically the cautious choice — it raises the score
whenever the withheld slot would have read below its siblings.

### Coverage

How much of a dimension's *designed* evidence actually resolved, expressed on
the same scale for every dimension so sparsely-observed countries are
distinguishable from well-observed ones.

Coverage is measured against the weights the dimension was designed with, not
against the weight that happened to resolve — which is what makes it meaningful
at all. Because the score renormalises onto surviving slots and coverage does
not, the two can move in opposite directions: a country losing an input can show
a rising score and a falling coverage in the same response. When they disagree,
coverage is the one describing the evidence.

### Imputation Class

The typed reason a slot carries an inferred value rather than an observed one.
The distinction is the point: "we do not measure here", "the phenomenon is
genuinely absent", "this indicator does not apply to this country", and "the
source failed" are four different claims that would otherwise all appear as a
missing number, and they justify very different scores. A country nobody
surveys must not be scored like a country where the thing being measured
verifiably does not happen.

## Seed Bundle Orchestration

### Bundle Wall Budget

The total wall-clock time one bundle tick may occupy, chosen to sit below the
container's hard kill so a member is shed cleanly instead of being killed
mid-publish.

The budget only shapes anything while it stays under that kill; at or above it
the container dies first and the budget is decorative. Every member must fit the
budget outright — a member whose worst case cannot fit is not under pressure, it
can never run at all, which is a configuration error rather than load.

### Section Worst Case

The longest wall-clock a member can occupy: its own timeout plus the grace the
runner allows between asking a child to stop and forcing it.

Distinct from expected runtime, which is usually far smaller. Admission is
decided on the worst case, so an over-declared timeout costs the bundle budget
the member will never actually spend.

### Admission Headroom

Slack reserved above a member's worst case to cover the work the runner itself
performs before it admits anything.

Load-bearing rather than defensive: the runner's freshness checks run before the
budget test, so the budget is already partly spent when the first member is
considered. Deriving this from the runner's own per-check bound, rather than
choosing a number, is what keeps the admission rule and the runtime rule from
drifting apart — when they drift, the admission rule accepts a band of
configurations the runtime rejects on every tick.

### Section Deferral

A due member skipped for lack of remaining budget on this tick, expected to run
on a later one.

Deferral is load-shedding, not failure — but it only pays for itself if the
member eventually runs. A member deferred on every tick is a stall wearing
deferral's clothing, and telling those two apart is the whole reason this
vocabulary exists.

### Graceful Skip

A member that hit a transient upstream failure, extended its last-good data
instead of publishing, and lost nothing.

It must not crash the bundle: one rate-limited source firing a deploy-crash
alert is the alert fatigue that makes the alarm worthless. Real staleness is
caught by freshness monitoring on the published data, never by the tick's exit
status.

### Starved Tick

A tick that completed no member while deferring due work — it published nothing
and shed work at the same time.

Indistinguishable from a healthy no-op by exit status alone, which is why it is
named and reported explicitly. A tick where every member was merely fresh is a
healthy no-op and must not be confused with it.

### Chunked Sweep

A member whose full refresh cannot fit one tick, spread across consecutive
ticks: each tick refreshes the slice of records whose rows are oldest and lets
the rest stand.

The published snapshot is the cursor. No separate cursor key is kept, because a
cursor can disagree with the data after a crash or a restore and then skip a
slice indefinitely, whereas a missing or stale row selects itself.

Completion is sweep-scoped, never tick-scoped: the finished-marker advances only
when no record is still owed a refresh. A tick that marked its own slice
complete would stop the member being due and strand every record it did not
touch. The staleness horizon deciding which rows are owed is bounded on both
sides — above the sweep's own duration, or the head expires before the tail
lands and the marker is never written; below the refresh interval, or every row
still reads current when the member next comes due and the sweep completes
having fetched nothing. See also: Section Deferral, Bundle Wall Budget.

## Market Data Claims

### Tape Claim

The label a market surface is allowed to show for a quote, bar, or stream: unconfigured, delayed, end-of-day, historical, stale, or — only after a separate commercial display/rebroadcast confirmation — licensed live. A configured provider key is not a Tape Claim. `Panel.setDataBadge('live')` means a fresh fetch versus a cache hit, not a licensed tape. Yahoo and seeded Finnhub quotes in this product stay delayed or end-of-day even when their keys exist. See also: Entitlement.

## Forecast Resolution

### Judged Resolution

A published forecast whose outcome is decided by language models reading a news-evidence archive, as opposed to a hard resolution, which is decided by comparing a metric against a threshold in the same feed the forecast was scored from. Both carry a hard deadline; only the judged kind requires evidence retrieval and adjudication after that deadline passes.

Sealing a judged forecast to YES or NO requires two independent judges to agree *and* each to cite an archive item by its identifier with a quote that appears in that item's own text. Both halves are load-bearing: agreement alone admits a shared hallucination, and an uncited outcome admits one manufactured from model text or from instructions planted in the archive, which is untrusted third-party content. A judgment failing either half is downgraded to VOID rather than being trusted — so VOID means *not established*, never *established false*. See also: Archive Horizon, Attempt Class.

### Archive Horizon

The instant past which a judged forecast can never again be resolved, because the evidence window it requires reaches further back than the evidence archive is able to serve.

The horizon exists because two spans are anchored to different clocks: required evidence is measured backward from the forecast's own deadline, while the archive's reach is measured backward from the present. As the present advances, the archive's reach slides forward while the requirement stays pinned — so coverage is lost at a computable instant and is never regained. That monotonicity is what makes crossing it a terminal state rather than a retry: an entry past its horizon is not waiting on anything. Crossing it is counted as a cost-control failure, never as a resolution, and the operational goal is to alert while entries are still short of it. A read that is merely unavailable proves nothing about the horizon and must not be treated as crossing it. See also: Judged Resolution.

### Attempt Class

The named reason a single judge attempt failed, recorded per attempt alongside the stage it failed at — evidence retrieval, either judge call, response normalization, agreement, or the terminal transition.

The vocabulary is closed so attempts aggregate into counts that name a dominant failure rather than an undifferentiated backlog; an instrumented failure is still a failure and never counts as progress. The classes separate distinctions that look alike but demand opposite responses: an archive that could not be read versus one that was read but does not cover the required window, a judge that returned nothing versus one whose answer could not be parsed, and a citation naming an item the judge was never shown versus a real item quoted with invented text. Recorded attempt detail is drawn from a fixed vocabulary rather than from provider error text, which can carry credentials and prompt echoes into durable receipts. See also: Judged Resolution.

## Flagged ambiguities

- *"Pool"* had been used for both a labelled market category and the complete set of markets — these are distinct. A pool is always a labelled subset; the complete set has no pool and must be requested as an explicit union.
- *"Variant"* resolves differently per surface — a served host on the web, a locally stored selection on desktop. Only the web sense is addressable by URL; a desktop artifact is never variant-specific, so a variant accompanying a desktop artifact request is an identity label rather than a selector.
- *"wingbits"* as a publication source means different things across the two Theater Posture producers — the military-flights seeder's keyed regional supplement after adsb.lol, but the relay loop's last-resort fallback. The recorded producer disambiguates which reading applies; never compare the token across producers.
