# Correlation panels retain valid snapshots during interruption

## Problem and traced path

Economic Warfare, Force Posture, Escalation Monitor, and Disaster Cascade share
`CorrelationPanel`. Its bootstrap loader required a non-empty domain array,
so a valid `[]` displayed the generic error/countdown screen. A truthy bootstrap
object was memoized for the session, so those retries could read the same empty
array without another request. On-demand bootstrap did not persist this key.

The path is `seed-correlation.mjs` → Redis `correlation:cards-bootstrap:v1` →
public `api/bootstrap?keys=correlationCards&public=1` → `ensureHydrated` → panel.
Separately, `App.runCorrelationEngine` publishes computations from loaded
dashboard signals. Its empty arrays can mean inputs have not loaded. The original
reported request was not captured; these defects do not identify its exact cause.

## Usage and ownership

```ts
// Begin only when the panel reaches the viewport.
const stop = subscribeCorrelationSnapshot(domain, state => render(state));

// Existing App -> panel updateCards call, after a completed local calculation.
publishLocalCorrelationCards(domain, cards);

// Release demand when the panel is destroyed.
stop();
```

`src/services/correlation-snapshots.ts` owns validation, source ordering, saved
data, and one shared recovery timer. Its state is either loading/waiting with no
snapshot, or current/updating with cards, computation time, and seed/local origin.
Connectivity is an offline hint overridden by a successful endpoint probe.
The component owns presentation, map navigation, supplements, and expansion.
Saved cards exclude raw source objects and session-specific premium LLM
assessments. App installs an assessment handler on the panel; the panel passes
the selected evidence to the engine after seed/local ordering, including panels
mounted after engine initialization. The engine does
not assess discarded local computations. Its cache and in-flight sharing match
the prompt evidence, so a shared cluster ID cannot attach an unrelated narrative.
The three-request concurrency limit drains the currently selected cards after
each completion; replaced/closed panels drop queued work. Failed assessments
wait for new selected data rather than immediately retrying. Premium access loss
clears live assessments and their cache, invalidates old request generations,
and repaints the panel. Rendering also checks current premium access.
Status-only updates preserve the card DOM, focus, and expansion. Assessments
and deferred supplements still request content redraws.
No caller coordinates separate read, restore, validate, and save operations.

## Synthesis decision

Two shapes were compared: panel-owned caching/retries and a shared domain service.
The service won because four panels consume one public response and also receive
local calculations. Panel-owned recovery repeated clocks and timers. A generic
`Panel.showError` suppression flag could not distinguish empty from missing data.
The existing circuit breaker timestamps acquisition and does not publish its
background refresh to component subscribers; wrapping it would still leave this
domain's ordering and local producer outside the owner.

Shared domain definitions live in the types layer. Importing values from the
engine directory would pull its manually grouped lazy chunk into initial load.

The selected shape preserves the existing App call site, public bootstrap helper,
legacy slow-tier drain, near-viewport activation, persistent-cache storage, and
Panel content-write helpers. Alternatives were evaluated sequentially under the
repository tool mapping, without an independent model-review claim.

## Recovery contract

| Situation | Display and behavior |
| --- | --- |
| Valid server result, including `[]` | Replace older data; empty is an ordinary content state. |
| Failed, missing, expired, or malformed response | Keep bounded valid data and its original computation time; retry quietly. Validate each domain independently. |
| Reload during interruption | Restore validated saved data while attempting a live read. Storage failure or a stuck read cannot block network recovery. |
| No usable snapshot | Distinct loading/waiting text, no count, no assertion of no activity. |
| Offline hint | Retain valid saved data with an offline label; probe after one minute and at five-minute intervals after failure; retry immediately on reconnect. A successful probe overrides an incorrect offline hint. |
| Hidden tab | Pause polling and status timers; recheck age and fetch if due on return. |
| Delayed cache/network result | Keep the newer result within one source; fresh seed data takes precedence over partial local calculations. Stale seeds cannot displace newer local fallback. |
| Local empty result | Do not clear known activity or claim confirmed absence; local adapters lack input-completeness metadata. A valid server empty can clear it. |
| Local calculation or LLM assessment | Identify loaded dashboard inputs; assessment repaint does not advance computation time. |
| Last panel closes | Remove timers/listeners and ignore late completion. Cleanup is idempotent. |
| Subscriber throws | Log the failure and continue notifying other panels and scheduling recovery. |

Freshness becomes stale after 15 minutes, matching the producer's declared
threshold. Clearly labeled historical snapshots can remain visible for one hour.
This display ceiling is a conservative UI fallback policy, not an extension to
upstream health or Redis TTL. Each minute the service rechecks age, including
while a panel stays mounted and visible. Original server times up to ten minutes
ahead of the client are accepted to tolerate clock skew; the timestamp is never
rewritten. This bounded tolerance means client-clock-based freshness can differ
from actual server age by that clock offset. Local computation time is not proof of source-feed
freshness or completeness.

A fresh server snapshot, including confirmed empty, takes precedence over local
calculations. Local computation time cannot establish that all inputs loaded.
When the seed passes its freshness threshold, a newer non-empty local calculation
can supply fallback cards until a fresh seed arrives.

Successful shared reads recur every five minutes. Failures back off through
15, 30, 60, 120, and 180 seconds, each jittered to 80–100% of that delay. The public helper retains its ten-second request
deadline, CDN shield, and in-flight coalescing. Missing/malformed domain and
storage failures retain console diagnostics. Three consecutive online failures
emit one Sentry warning per failure episode, reset by a valid read; expected
offline failures do not emit it. Telemetry failure cannot stop recovery.

## Verification and limits

The DOM suite exercises valid empty replacement, bounded saved data, malformed
responses, storage failure/hang, source ordering, local empty ambiguity, offline
recovery, false offline hints, clock skew, retry jitter, telemetry, hidden tabs,
request sharing, malformed nested fields, listener removal, and destruction/remount.
It also exercises the real engine's premium assessment path with a mocked RPC;
it does not purchase inference or establish production billing behavior.
The browser fixture uses real
panel classes, hydration, timers, and persistent storage with controlled HTTP
responses. It proves retained interactive cards, reload during failure, first-load
failure/recovery, known empty, and desktop/mobile overflow. It does not prove
upstream acquisition, deployed middleware, or production acceptance.

All shipped language catalogs include the recovery labels. Locale checks cover
key completeness, English provenance, interpolation tokens, and the generated
Traditional Chinese catalog.

This change covers the four shared correlation panels. Other panels need their
own validated empty/failure contracts before adopting the same presentation
policy. Account gates and unrelated data-source behavior are unchanged.
