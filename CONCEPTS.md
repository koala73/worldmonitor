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

### Shift Victim

An element that browser and RUM layout-shift attribution names because its *position* changed — it was pushed by something else. Both Chrome's largest-shift-target and RUM per-selector rankings report victims; neither reports causes. A fix aimed at a top-ranked victim is a hypothesis about the pusher, not a confirmed target: prominent above-the-fold elements rank as victims whenever anything above them changes the layout. See also: Shift Mover.

### Shift Mover

The element that *causes* a layout shift by changing its own footprint — growing, shrinking, materializing (insertion), or disappearing (removal). Movers are not reported by shift-attribution APIs; naming one requires diffing element geometry across the shift itself (a cached top/height baseline compared at shift delivery). The victim/mover distinction is load-bearing for all layout-stability work in this project: two shipped fixes aimed at victims had null field effect before mover instrumentation named the true mechanism. See also: Shift Victim, Deferred-Shell Contract.

## Test & Guard Verification

### Vacuous Guard

A test, CI gate, or static audit that reports success without having examined what it claims to cover, because its *input* silently shrank rather than because its assertion held. The distinguishing property is that it fails open: guards of this shape assert a negative — a violation list is empty, a count is zero, no match was found — and an empty input satisfies a negative assertion perfectly, so the less such a guard actually checks, the greener it looks. Levers that shrink the input include a skip condition gated on a flag nothing sets, a normaliser or comment-stripper that deletes part of the scanned source, a filter or path-walk predicate that stops matching files, and a test harness that never supplies the input the assertion is written about — an "X is absent" check cannot fail when the fixture could not have produced an X in the first place. Two further levers arise from *substitution* rather than filtering: a stub standing in for the unit under test, which makes every branch inside it — error returns especially — unreachable by a contract assertion that still passes for every other tool in the registry; and a lookup that parses a value out of another file, whose miss branch yields a plausible default (`0`, empty, `null`) instead of raising, so a moved or renamed target reads as a real answer rather than a lost one. Both are refactor-triggered: nothing in the import graph follows a path held as a string, so the compiler and the suite stay silent. A third shape does not shrink the input at all but asserts against the wrong artefact: a *wiring* guard that greps a script's source text for the command it should invoke, rather than executing the decision and observing what ran. Such a guard survives the bug restored verbatim, because inverting the condition that reaches the command, or dropping the `|| exit` that propagates its failure, leaves the grepped token in place — the remedy is to move the decision into something callable and run it against stubbed executables, asserting the invocation. A vacuous guard is worse than no guard, because it also supplies confidence. See also: Mutation Proof.

### Mutation Proof

This project's standard of evidence that a guard actually guards: deliberately break the thing the guard protects, observe the guard turn red, then restore the source byte-identically. Reading a guard establishes what it intends; only the mutation establishes what it covers. A guard that stays green when its subject is broken has not been shown to work, regardless of how carefully it was reviewed. The obligation applies recursively — a guard written to protect another guard needs its own mutation proof, and is a common place to skip one, because having just written it supplies the feeling of coverage without the evidence. See also: Vacuous Guard.

## News Story Tracking & Trend Detection

### Story Accumulator

The rolling corpus of recently-tracked news stories, ordered by when each story was last seen, that downstream consumers read to answer "what has been in the feed lately?". It is a *retention window*, not a queue: entries age out on a fixed horizon rather than being consumed, and several unrelated consumers — the digest cron, trend detection — sample the same corpus independently for different spans. Its retention horizon states how far back entries *may* reach; it says nothing about how many are there, and on a busy feed the corpus holds far more stories than any single consumer intends to read at once. See also: Sampled Span, Seed-Owned Key.

### Keyword Spike

A term — an ordinary word, a vulnerability identifier, or a threat-group designator — appearing materially more often in a recent window than its own recent history predicts. A spike is deliberately harder to earn than "appeared a lot": the term must clear a floor of distinct mentions, exceed its baseline rate by a strict multiplier, and be carried by more than one outlet, so a single prolific source cannot manufacture one. When no baseline exists yet the decision falls back to the floor alone, which is why a corpus that yields no usable baseline silently converts spike detection into simple frequency counting. See also: Sampled Span.

### Sampled Span

The stretch of time a derived statistic was *actually* computed over, as distinct from the retention horizon of the store it drew from. The two diverge whenever a bounded read — a row cap, a page size, a top-N — returns fewer rows than the horizon contains, and the divergence is silent: the read succeeds, the arithmetic runs, and only the result is wrong. Any rate, baseline, or per-unit-time figure must be divided by the span its rows demonstrably cover, and a consumer-facing statistic should report that measured span rather than the horizon constant, since a caller has no other way to tell the two apart. Truncation is also biased rather than random — a newest-first read starves the historical side of a recent-versus-baseline comparison, an oldest-first read starves the recent side. See also: Story Accumulator, Keyword Spike.

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

One of the product-variant subdomains (`tech`, `finance`, `commodity`, `happy`, `energy`) that serves a themed dashboard entry and metadata. The middleware and Vercel config recognize these hosts explicitly; canonical discovery URLs for shared surfaces (such as `/mcp`) redirect retrieval-method requests from variant hosts to the apex host so discovery signals do not fragment.

## Anonymous Access

### Anonymous Session

The short-lived, server-signed identity that authorizes a key-less browser to read our public API surface, held in an HttpOnly cookie the client cannot inspect — it can only track the expiry and ask for a new one. It is not a user identity: it is freely mintable by anyone, is not bound to an account, and is deliberately refused by tier-gated routes, so a valid anonymous session and an authorized one are different questions. Clerk bearer tokens and user API keys take precedence wherever both are present.

Because the cookie is opaque to JavaScript, the client can only infer its health from responses, and that inference is the fragile part. A rejection observed on one route is evidence about *that route*, not about the session — the two are distinguishable only by whether independent routes fail the same way. See also: Session Blackout, Entitlement.

### Session Blackout

The client-side cooldown during which every anonymous API call is answered locally with a synthetic unavailable response instead of reaching the network, entered when the anonymous session is judged unrecoverable and lifted automatically when the cooldown lapses. Its purpose is to stop a dead session from amplifying into a request-mint-retry storm across every panel.

The blackout is deliberately blunt — it suppresses the whole surface — so what justifies entering it matters more than what it does. Only session-wide evidence qualifies: a failure to mint at all, or the same failure corroborated across distinct routes *within seconds of each other*. A single route's denial, even one that survives a fresh mint, is route-scoped evidence and earns at most route-scoped suppression; generalizing it blanks a dashboard whose session was never broken.

Two properties make that corroboration mean what it says. It is time-bounded, because the evidence being generalized from is temporal coincidence — denials minutes apart are two endpoint problems, not one session problem. And it is retracted by success: a single credentialed 200 proves the browser is delivering the cookie, which settles the question the blackout was about. Suppression and evidence therefore expire on different clocks, and a sibling's success must retract the evidence without releasing the failing route's own suppression — that suppression is what stops a known-bad endpoint from re-minting on every poll. See also: Anonymous Session.

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

A subscription that currently grants paid coverage. Coverage is decided per status, not by the status name's plain-English reading: an active subscription covers; an on-hold subscription (payment failed, provider retrying) still covers through its retry window; a cancelled subscription covers until the end of the period already paid for; an expired subscription never covers regardless of its recorded period end. The server owns these rules; any client-side derivation must mirror them rather than re-deriving from status-string intuition. See also: Cancelled-But-Paid-Through, Billing UX State.

### Cancelled-But-Paid-Through

The state of a subscription whose auto-renew has been turned off but whose paid period has not yet ended. Colloquially "cancelled" reads as terminal; here it is a covering state until period end, and only afterwards does coverage lapse. UI and copy must not treat it as ended while the paid window is open — telling such a customer their subscription "has ended" invites duplicate checkout. See also: Covering Subscription.

### Renewal Verification

The bounded, on-demand re-check against the payment provider that runs when locally-stale paid evidence would otherwise cause a denial — instead of trusting a possibly-missed webhook, the provider is asked directly. It records a verdict (pending while queued or in flight, failed when the provider check errored, lapsed when the provider confirms coverage ended) that both the denial surfaces and the client UI consume. It shares provider-evidence bookkeeping with the scheduled reconciliation sweep but is deliberately independent of it, so one path failing cannot suppress the other. See also: Billing UX State.

### Billing UX State

The single client-derived state that decides what a customer sees when premium access is in question: free (never paid), active (access works), on-hold (payment failed, retry window), renewal-verification pending or failed (paid evidence went stale and the provider re-check is running or errored), or lapsed (coverage confirmed over). Its purpose is to prevent the misleading collapse of every non-paying state into a generic upgrade prompt — a paying customer whose renewal is being verified must be told that, not sold to. Derived purely from the entitlement and subscription snapshots, it changes copy and actions only; it never grants access the server would deny. See also: Covering Subscription, Renewal Verification.

### Referral Capture

The bootstrap-time process that turns an inbound URL param into checkout attribution: `?ref=` or `?wm_referral=` on any dashboard landing is read once at app boot, stripped from the URL, persisted locally with a bounded TTL, and forwarded to the payment provider at checkout to credit the referring sharer. Because the param names are generic-looking, any other use of `ref=` on dashboard-bound links (SEO tags, campaign labels) is silently captured as a fake affiliate code — internal source attribution must use `utm_*` params, which this process ignores. See also: Entitlement.

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

The baseline is an exemption list, not a suppression: an advisory outside it fails the gate for every branch at once, which is why a newly published advisory blocks the whole repository until someone either patches or baselines it. Each entry carries its justification inline so a later reader can re-evaluate rather than inherit a bare allowlist, and an entry that no longer matches any live advisory is surfaced as stale so the list does not accrete dead exemptions. See also: Third-Party Rot.

## Localization & First Paint

### English Shell

The small, byte-budgeted subset of English UI strings inlined so first-paint chrome renders real text before the full locale file loads. Membership is decided by namespace: keys under the shell prefixes and referenced from eager chrome must be mirrored into the shell byte-identically, and the whole shell lives under a hard byte cap that is a first-paint performance budget, not a formatting limit. The consequence cuts both ways: post-boot copy placed in a shell namespace pays first-paint bytes for strings nobody can see yet, while first-paint copy placed outside the shell flashes raw keys until the full locale arrives. Choosing a key's namespace is therefore a rendering-time decision, not a taxonomy one.

### Translation Provenance

The English string a committed translation was produced from, recorded separately from the translation itself.

Provenance is what makes staleness detectable at all: a translation whose recorded English no longer matches the current source is wrong even though it is present, so any check comparing only key sets is structurally blind to it. Advancing the record is the one irreversible act in a translation pass — it certifies every current translation as correct against current English, and nothing re-examines a certified key — so it is permitted only when every locale is complete and free of stale entries. Adopting a record for the first time must be an explicit act rather than an inference from its absence, because a deleted record and a first run are indistinguishable, and inferring adoption from absence silently re-certifies whatever the translations currently say. See also: Stale Translation.

### Stale Translation

A translated value whose English source has changed since the translation was made.

Distinct from a *missing* translation, which has no value at all, and from an *orphaned* one, which is a value the current English no longer has a key for. The distinction is load-bearing because only the stale class is fixable by retranslation — no translation of a source string that no longer exists can be correct, so orphans must be pruned instead. Inserting an element into an English list makes every later entry stale at once, since each index then points at a different source string; removing the last element produces an orphan instead, leaving every earlier index matching so nothing registers as stale. See also: Translation Provenance.
