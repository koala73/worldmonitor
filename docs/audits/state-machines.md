# Application state machines

Audit started 2026-11-06 from `5c3feba8d7` (current `origin/main` at task start).

## Goal and acceptance

Keep one source-linked inventory of explicit state unions and implicit state held by flags,
handles, caches, generations, and persisted records. Record states, invariants, and transition
tables. Replay suspected invalid paths against production modules with controlled async
settlements. Rank only demonstrated bugs, group related repairs into issues, and retain
regression tests. Changes must preserve account isolation, retry policy, and public contracts.

Repair files: `src/services/entitlements.ts`, `src/services/billing.ts`, their focused
DOM tests, and this document. Expansion: the ML readiness promise leak was independently reproduced;
`src/services/ml-worker.ts` and its existing recovery test are also necessary. A later
widget close/reopen trace proved deadline loss; `src/components/WidgetChatModal.ts` and its
existing preflight tests are necessary to enforce request ownership across retries. Review
follow-up also requires `src/app/panel-layout.ts` and the existing app-destroy DOM suite to
distinguish final teardown from an account handoff. `src/App.ts` and the existing Convex
auth-handoff suite also bind that handoff to App lifetime.
No merge, deployment, provider calls, production writes, or external notification is in scope.

## Reading the inventory

A state is a combination of values, not just a string named `state`. Independent regions
(e.g. playback plus mute, entitlement data plus verification) are listed separately instead
of enumerating their Cartesian product. A classified input such as a flight's operational
status is data, not a lifecycle controlled by this app. Shared request machines cover their
service consumers; generated RPC types are not separate machines.

The audit uses source inspection and deterministic tests, not a formal proof of all possible
JavaScript executions. Source-reviewed entries do not establish live service correctness.
Coverage and remaining verification limits are recorded at the end.

## Confirmed defects and repair groups

| Priority | Group | Reachable invalid path | Impact | Status |
|---|---|---|---|---|
| P2 | Watch lifecycle ownership | Two initializers pass `initialized=false`, both await, both attach, one unsubscribe handle overwrites the other. Destroy while initializing does not cancel attachment. A queued callback after destroy still passes the same-account guard. | Orphan billing/entitlement watches, state updates after teardown, duplicate notifications/reloads. No demonstrated cross-account grant: account checks remain in place. | Fixed locally; regression passes |
| P2 | Billing notification isolation | First subscription listener throws; remaining listeners never receive the committed paid/empty/error snapshot. | Independent billing surfaces retain stale subscription state until another update. Entitlements already isolate listeners. | Fixed locally; regression passes |
| P2 | Widget request ownership | Closed request A settles after reopened request B starts; A clears B's deadline. | Hung generation and stale completion during retries; repeated send can lose cancellation. | Fixed locally; regression passes |
| P3 | ML readiness ownership | Re-register a caller while initialization is pending; replacing the resolver leaves the first promise permanently pending. | Awaiting that earlier result can hang; current app callers use distinct labels, so production frequency is unproven. | Fixed locally; regression passes |

Issues: [#10236](https://github.com/koala73/worldmonitor/issues/10236) (watches),
[#10237](https://github.com/koala73/worldmonitor/issues/10237) (billing listeners),
[#10239](https://github.com/koala73/worldmonitor/issues/10239) (widget requests), and
[#10238](https://github.com/koala73/worldmonitor/issues/10238) (ML readiness).

## Account and paid-access machines

### 1. Authentication and Convex identity (implicit)

Owners: [`auth-state.ts`](../../src/services/auth-state.ts),
[`clerk.ts`](../../src/services/clerk.ts), [`convex-client.ts`](../../src/services/convex-client.ts),
[`account-auth-handoff.ts`](../../src/app/account-auth-handoff.ts).
States: browser session pending / anonymous / account A; Convex client absent / loading /
ready; identity barrier pending / authenticated / rejected / timed out / retired.
Invariant: a response or token from A cannot settle B's barrier. A destroyed App cannot
resume its account handoff or attach watches, even when account and generation still match. Pending authentication is
not affirmative denial. Client initialization is shared; authentication is generation-scoped.

| From | Event / guard | To / effect |
|---|---|---|
| Session pending | Clerk disabled | Anonymous immediately |
| Session pending | Deferred Clerk resolves | Anonymous or selected account |
| Client absent | First consumer | Loading; concurrent consumers join initialization |
| Identity pending | Matching server auth callback | Authenticated; attach account watches |
| Identity pending | Deadline or rejected auth | Bounded retry / unavailable when exhausted |
| Any identity | App destroyed | App lifetime guard retires pending handoff; late authentication cannot attach watches |
| Any identity | Sign-out or account switch | Retire barrier, invalidate token, create new identity generation |
| Retired identity | Late callback | Ignore |

### 2. Entitlement and subscription watch ownership (implicit; repaired)

Owners: [`entitlements.ts`](../../src/services/entitlements.ts),
[`billing.ts`](../../src/services/billing.ts). Callers: panel-layout initialization and
`startAccountAuthHandoff`; teardown: `PanelLayoutManager.destroy` and account changes.
States: idle / initializing (possibly several waiting callers) / attached / retired.
Independent entitlement verification region: idle / pending / ready / unavailable.
Independent data region: null / last snapshot. Billing additionally distinguishes
unloaded null from loaded null using `subscriptionLoaded`.

Invariants: one attached watch per lifecycle; every attached watch has a retained unsubscribe;
retired work cannot attach or publish, including after a same-account reconnect; failure must
leave retry possible. Final panel teardown publishes unavailable when no snapshot exists.
Transport retirement during an account handoff preserves pending until that handoff settles. Destroy preserves entitlement data for reconnect, while explicit reset
clears it for an account transition. Billing destroy clears its snapshot and loaded flag.

| From | Event / guard | To / effect |
|---|---|---|
| Idle | Initialize for expected account | Initializing; load client/API; entitlement also waits for auth |
| Initializing | Dependencies ready, generation current, no attached watch | Attached; retain unsubscribe |
| Initializing | Another caller already attached | Complete without a second watch |
| Initializing | Failure | No watch; a later initialize may retry |
| Any | Destroy transport | Increment lifecycle generation before unsubscribe; idle transport; caller owns verification |
| Pending verification | Final panel teardown, no snapshot | Unavailable; notify current and late subscribers |
| Pending verification | Account handoff retires old transport | Remain pending while the new auth lifecycle runs |
| Retired | Dependency completion / queued update / queued error | Ignore |
| Attached | Current update | Commit snapshot, then notify each listener independently |
| Attached | Current query error | Entitlement: unavailable if no snapshot; billing: loaded null |

### 3. Entitlement grant and billing UX (explicit derived state)

Owners: [`billing-state.ts`](../../src/services/billing-state.ts),
[`entitlements.ts`](../../src/services/entitlements.ts),
[`entitlement-check.ts`](../../server/_shared/entitlement-check.ts).
Billing UX states: free / active / on_hold / renewal_verification_pending /
renewal_verification_failed / lapsed. Grant region: active / expired / missing.
Invariant: a cached row or a successful checkout return alone does not grant access;
coverage and validity must be checked at grant time. Verification failure is distinct
from a known lapse. These are recomputed views of snapshots, not a linear payment pipeline.

| From | Input change | To / effect |
|---|---|---|
| Any UX state | Current valid paid coverage | Active (or hold/renewal classification from row) |
| Active | Coverage expires without verified renewal | Pending / failed / lapsed according to verification evidence |
| Pending / failed | Verified renewal | Active |
| Any | No paid row or entitlement | Free, subject to explicit loading override |
| Any grant | Time / snapshot changes | Recompute validity; deny expired evidence |

### 4. Self-host key service (explicit plus implicit)

Owner: [`self-host-key.ts`](../../src/services/self-host-key.ts).
Unlock: unknown / unlocked / locked; host detection: unknown / self-hosted / not-self-hosted;
transport: idle / reading / write in flight; error is independent of the last verdict.
Invariant: only active evidence inside the 24-hour grace grants; transient failure preserves
valid evidence; a status read cannot overwrite a newer key write.

| From | Event / guard | To / effect |
|---|---|---|
| Unknown / locked | Active verdict within grace | Unlocked |
| Unlocked | Explicit inactive verdict | Locked |
| Any | Transport error / unavailable verdict | Preserve last valid unlock; mark failed |
| Unlocked | Grace expires | Unknown on read/check |
| Any | 404 | Not-self-hosted; stop polling; clear verdict |
| Idle | Refresh | One shared GET; concurrent reads join |
| Any read | Save/remove begins or finishes | Generation changes; stale read result ignored |

### 5. Checkout attempt, return delivery, and activation wait

Owners: [`checkout-attempt.ts`](../../src/services/checkout-attempt.ts),
[`checkout-return.ts`](../../src/services/checkout-return.ts),
[`checkout-return-state.ts`](../../src/services/checkout-return-state.ts),
[`checkout-entitlement-wait.ts`](../../src/services/checkout-entitlement-wait.ts).
Attempt: absent / stored / expired. Return classification: none / success / failed.
Delivery has parallel mission pending/settled and panel not-required/pending/focused regions.
Banner: pending / timeout / active, with stopped watcher state after cleanup or grace expiry.
Invariants: failure retains retry context; a return URL cannot mint entitlement; delivery
is removed only once both regions settle; timeout can recover to active during grace.

| From | Event / guard | To / effect |
|---|---|---|
| No attempt | Start checkout | Store product/context for retry |
| Stored | Failure return | Failed banner; retain attempt |
| Stored | Success / dismissal / expiry | Clear according to explicit clear reason |
| No delivery | Valid mission checkout return | Arm mission and optional panel delivery |
| Delivery pending | Mission delivered / panel focused | Set corresponding region; clear record only when both done |
| Banner pending | Entitlement event, poll, or deadline recheck says active | Active; remove all watchers |
| Banner pending | Deadline without entitlement | Timeout; report once; continue grace monitoring |
| Timeout | Activation before grace ends | Active; remove watchers |
| Pending / timeout | Cleanup / grace expires | Stop; late callbacks cannot settle |

### 6. Activation, passkey, and onboarding prompts

Owners: [`pro-activation-state.ts`](../../src/services/pro-activation-state.ts),
[`pro-activation-controller.ts`](../../src/app/pro-activation-controller.ts),
[`passkey-offer-state.ts`](../../src/services/passkey-offer-state.ts),
[`onboarding-prompt.ts`](../../src/services/onboarding-prompt.ts),
[`passkey-offer-reservation.ts`](../../server/_shared/passkey-offer-reservation.ts).
Activation decision: keep / mount / clear / none; stored marker absent/pending/expired;
subscription presentation unclaimed/claimed/presented/ineligible. Passkey: eligible /
reserved / offered / suppressed. About-you: due / answered / skipped, with activation
unknown / will-open / not-due and account-bound mounted/removed prompt.
Invariants: account-scoped records; unresolved auth abstains; only eligible Pro mounts;
server reservation caps durable offers. Local passkey suppression is explicitly best effort
across tabs, not a globally atomic claim. Preserve that product tradeoff.

| From | Event / guard | To / effect |
|---|---|---|
| Activation pending | Missing auth/entitlement/subscription | Keep; reevaluate |
| Activation pending | Eligible account, no matching presentation | Claim, then mount if still current |
| Activation pending | Expired marker / ineligible / already presented | Clear or none |
| Passkey eligible | Atomic server slot available | Reserved; mount records offered locally |
| Passkey eligible | Cap reached or local offered record | Suppressed |
| About-you due | Activation definitely not opening, no blocking prompt | Mount full or return questions |
| Mounted prompt | Account changes / cleanup | Remove and dispose subscription |

## Data acquisition and execution machines

### 7. Bootstrap and consume-once hydration

Owners: [`bootstrap.ts`](../../src/services/bootstrap.ts),
[`bootstrap-prefetch.ts`](../../src/services/bootstrap-prefetch.ts),
[`hydration-handoff.ts`](../../src/services/hydration-handoff.ts).
Per tier: reserved / fetching / settled / cancelled; source none / live / cached / mixed.
Per hydrated key: absent / available / consumed. Handoff: empty / retained / loading / expired.
Invariants: consume-once bootstrap is not a recurring cache; persistent fallback respects age;
only current bootstrap generation commits; slow-tier reservation must settle on cancellation.

| From | Event / guard | To / effect |
|---|---|---|
| Reserved fast tier | Adopt pending prefetch / boot fetch | Fetching within remaining request budget |
| Primed fast response headers received before App | Adopt response | Read body within a fresh tier budget |
| Fetching | Valid live response | Set live keys; fill missing keys from eligible cache |
| Fetching | Failure/deadline | Cached or none; preserve source attribution |
| Reserved slow tier | Post-paint start | Fetching |
| Any bootstrap | New generation / cancel | Abort or retire old work; release waiters |
| Key available | `getHydratedData` | Consumed; delete from bootstrap map |
| Handoff empty / expired | `getOrLoad` | Shared loading; validated success retained, failure returns fallback |
| Retained | TTL exceeded | Empty; next caller may refresh |

Verification follow-up: CI run `42278927402` exposed a test fixture race, not a
production timeout defect. Its fast tier returned HTTP 200 after 2.73 seconds before
App adopted the primed response, so fallback requests correctly stayed at zero. A cold
App import reproduces the old assertion failure locally. The browser abort fixture now
withholds headers until it observes the application's actual `net::ERR_ABORTED`, including
with that cold import, before asserting fallback and independent slow-tier hydration.
Production timeout values remain unchanged and are pinned by the existing budget suite.

### 8. Circuit breaker and cache (explicit data mode, implicit control state)

Owner: [`circuit-breaker.ts`](../../src/utils/circuit-breaker.ts).
Control: closed / open-cooldown / probe-required / half-open probe. Per-key data:
absent / fresh / stale / disallowed; output mode live / cached / unavailable plus offline.
Invariants: one recovery probe across the breaker; same-key callers may share its result;
other keys must never receive its payload; timeout retires late probe results; unavailable
has null timestamp; caller cancellation does not count as upstream failure.

| From | Event / guard | To / effect |
|---|---|---|
| Closed | Fresh admissible cache hit | Cached; touch LRU |
| Closed | Stale or forced refresh | One SWR refresh per key; background return or await |
| Closed | Failure threshold | Open until cooldown deadline |
| Open | Read | Cached fallback if eligible; otherwise unavailable/default |
| Open expired / probe-required | New upstream execution | Half-open; one bounded probe |
| Half-open | Success | Closed; cache admissible result |
| Half-open | Failure / timeout | Reopen cooldown; ignore late settlement |
| Half-open | Ignored caller abort | Probe-required; permit next bounded attempt |
| Any cache | Predicate / maxServeAge rejects entry | Evict; do not serve rejected entry |

### 9. Poll loop, visibility, and refresh lane leases

Owners: [`smart-poll-loop.ts`](../../src/services/smart-poll-loop.ts),
[`refresh-scheduler.ts`](../../src/app/refresh-scheduler.ts),
[`prime-retry.ts`](../../src/utils/prime-retry.ts), panel-layout viewport priming.
Poll states: scheduled / running / hidden-paused / stopped; backoff is an independent counter.
Lane: free / held / lease-expired. Priming: unprimed / loading / primed / retry-not-due.
Invariants: one callback per active loop; stopped loops cannot reschedule; cooperative hide
aborts the request; failed prime is not recorded as successful. A lane lease releases a
wedged callback without proving its underlying work was cancelled.

| From | Event / guard | To / effect |
|---|---|---|
| Scheduled | Timer/manual/startup, visible and eligible | Running; own AbortController |
| Running | Additional trigger | No overlapping callback; schedule next opportunity |
| Running | Success / false / error | Scheduled; reset or double capped backoff |
| Any active | Hidden with pause enabled | Clear timer; abort cooperative callback |
| Hidden | Visible | Resume now or schedule, per option |
| Any active | Stop | Stopped; remove listeners/timers and abort |
| Lane held | Callback settles / lease expires | Release latch in finally; late rejection handled |
| Prime loading | Reject | Retry-not-due with capped delay; later viewport attempt allowed |

### 10. Server cache coalescing and outage recovery

Owner: [`redis.ts`](../../server/_shared/redis.ts), `cachedFetchJsonCore`.
States: hit / miss / read-error; per inflight key idle / admission / leader / follower;
result positive / negative-sentinel / unavailable-backoff; local outage fallback is separate.
Invariants: admission awaits must recheck leadership; caller-local errors do not poison shared
provider cache; bounded fetcher timeout releases the slot; source/leader metadata is accurate.

| From | Event / guard | To / effect |
|---|---|---|
| Read | Positive / sentinel hit | Return cached data / null |
| Read error | Valid local fallback/cooldown | Return fallback / null |
| Miss | Existing leader | Follower waits for same inflight result |
| Miss | Admission passes | Recheck inflight, then elect leader |
| Leader | Positive result | Cache unless explicitly no-store; optionally bridge Redis outage locally |
| Leader | Empty/provider failure | Sentinel or unavailable-backoff according to policy |
| Follower | Caller-local leader error | Loop through own admission; may become leader |
| Leader | Any settlement including timeout | Delete inflight entry; permit retry |

### 11. Request cancellation and supersession

Owners: [`x-intel.ts`](../../src/services/x-intel.ts),
[`latest-request-guard.ts`](../../src/utils/latest-request-guard.ts).
X feed: absent/fresh/expired cache; per-limit idle/inflight/settled, with subscriber count.
Latest request guard: current/retired generation.
Invariant: one caller's abort cannot cancel another subscriber; the last departing subscriber
aborts upstream; an aborted response cannot populate cache; retired work must be checked by
its consumer before commit. A guard alone does not cancel network work.

| From | Event / guard | To / effect |
|---|---|---|
| Idle | Fetch uncached limit | Inflight; first subscriber |
| Inflight | Same-limit caller | Increment subscribers; join |
| Inflight | One abort | Reject that caller; decrement once |
| Inflight | Last subscriber departs before settlement | Remove owned entry; abort controller |
| Inflight | Valid non-aborted response | Cache and resolve subscribers; remove owned entry |
| Current generation | New request begins | Retire earlier generation; late commit checks fail |

### 12. Serialized and yielding queues

Owners: [`serialized-async-queue.ts`](../../src/utils/serialized-async-queue.ts),
[`yielding-work-queue.ts`](../../src/utils/yielding-work-queue.ts).
States: idle / executing / queued. Invariants: FIFO; at most one active task; a failed task
must not poison the queue; serialized queue starts first work synchronously for keepalive.

| From | Event / guard | To / effect |
|---|---|---|
| Idle | Enqueue | Execute first task (yielding queue yields first) |
| Executing | Enqueue | Append FIFO |
| Executing | Resolve / throw / reject | Settle caller and start next; return idle when empty |

### 13. Cloud preference reconciliation and upload

Owners: [`cloud-prefs-sync.ts`](../../src/utils/cloud-prefs-sync.ts),
[`cloud-prefs-retry.ts`](../../src/utils/cloud-prefs-retry.ts),
[`cloud-prefs-flush.ts`](../../src/utils/cloud-prefs-flush.ts).
States: signed-out / pending / syncing / synced / conflict / offline / error.
Orthogonal state: auth generation, dirty-key ownership, debounce/retry timer, queued upload,
sync version and serialized operation ownership.
Invariants: never apply A's data/version to B; version acknowledgement must persist before
dirty keys are cleared; temporary failures retain pending edits; only the queue owner writes.

| From | Event / guard | To / effect |
|---|---|---|
| Signed-out | Sign-in | New generation, account provenance check, hydrate dirty keys, queue reconcile |
| Synced / pending | Local preference changes | Dirty + pending; debounce upload |
| Pending | Queue acquired, token owns account | Syncing; snapshot and POST expected version |
| Syncing | Success with accepted durable version | Settle only captured dirty keys; synced if idle |
| Syncing | 409 | Conflict/reconcile; preserve local edits |
| Syncing | 429 / 503 | Pending; honor clamped Retry-After in same auth generation |
| Any | Sign-out / direct account switch | Retire timers/generation; preserve recoverable dirty evidence |
| Retired operation | Response or retry timer | Ignore |

### 14. Correlation snapshot subscription and freshness

Owner: [`correlation-snapshots.ts`](../../src/services/correlation-snapshots.ts).
Display: loading / waiting with null snapshot, or current / updating with a valid snapshot;
offline is independent. Runtime: inactive / active-idle / pending-refresh.
Invariant: old lifecycle cannot commit; historical data expires at MAX_AGE; empty local
adapters cannot clear observed activity; authoritative validated seed can clear it.

| From | Event / guard | To / effect |
|---|---|---|
| Inactive | First listener | New generation; restore cache, attach events, tick |
| Active-idle | Due and visible | Pending-refresh; fetch snapshots |
| Pending-refresh | Current generation settles | Notify, set retry/fresh deadline, clear pending |
| Active | Hidden / offline | Pause visible ticks / delay offline probes |
| Current | Time exceeds fresh threshold / refresh pending | Updating; retain valid historical snapshot |
| Current / updating | Max age exceeded | Waiting, null snapshot |
| Active | Last listener leaves | Inactive; generation retires pending work; remove events |

### 15. ML worker and model lifecycle

Owner: [`ml-worker.ts`](../../src/services/ml-worker.ts).
Worker: disabled / initializing / ready / recovering / recovery-blocked; models desired /
loading / restored / unloading; requests pending / resolved / rejected / timed-out.
Invariants: lifecycle/worker generations reject retired messages; cleanup settles pending
requests; every readiness promise must settle when superseded; recovery is bounded; worker readiness includes restoration of desired models.

| From | Event / guard | To / effect |
|---|---|---|
| Disabled / blocked | Explicit init | Enable; reset recovery budget; initialize |
| Initializing | Worker ready and desired models restored | Ready; settle current readiness waiters |
| Initializing | Same caller registers again | Resolve old waiter false; retain only the new waiter |
| Ready | Runtime error | Cleanup old worker; schedule bounded recovery |
| Recovering | Initialization/model restore succeeds | Ready |
| Recovering | Attempts exhausted | Recovery-blocked; no automatic restart |
| Any | Terminate / destroy | Retire generation; clear timers; reject requests; settle waiters false |

## Presentation and stored-layout machines

### 16. Live video chain and transport

Owners: [`live-video/model.ts`](../../src/services/live-video/model.ts),
[`live-video/session.ts`](../../src/services/live-video/session.ts).
Chain: connecting / live / recording / unverified / offline. Independent mute and pause
regions persist across candidate mounts. Transport: absent / mounted / destroyed.
Invariants: candidate index belongs to parsed source; candidate failure advances once;
retired transport cannot dispatch; recording is not labelled live; retry clears failure memory.

| From | Event / guard | To / effect |
|---|---|---|
| Start | No valid candidates | Offline; unmount |
| Start | Candidate available | Connecting; mount, start observation poll |
| Connecting | Live verdict | Live; keep transport, stop classification poll |
| Connecting | Recording custom video | Recording; keep transport |
| Connecting | Failed / builtin recording / builtin silent API | Next untried candidate or offline |
| Connecting | Blocked API / missing signal | Try untried HLS or unverified |
| Live | Live lost | Reconnect from top once; repeated loss inside relock window goes offline |
| Settled | Retry | Clear failure memory; connecting from first candidate |
| Any | Destroy | Unmount and stop poll; ignore late callbacks |

### 17. Heavy map commit and render recovery

Owners: [`deferred-layer-commit.ts`](../../src/components/map/deferred-layer-commit.ts),
[`deck-loop-recovery.ts`](../../src/components/map/deck-loop-recovery.ts),
[`MapContainer.ts`](../../src/components/MapContainer.ts).
Layer: absent / committed / staged; flush absent/scheduled. Renderer: initializing /
deck or globe / SVG fallback / destroyed; recovery check idle/queued and restart budget.
Invariants: immediate frame retains committed data; coalesced flush must check map lifetime;
recovery restarts only a dead live renderer and is bounded within its time window.

| From | Event / guard | To / effect |
|---|---|---|
| Committed / absent | Stage changed value | Pending; schedule/coalesce deferred flush |
| Staged | Stage equals committed | Drop redundant pending value; cancel empty flush |
| Staged | Flush while alive | Commit all staged values; notify changed keys |
| Staged | Cancel / flush while not alive | Drop pending values |
| Renderer running | Error | Queue one post-error animation-loop check |
| Check queued | Still alive, no frame, budget available | Restart; record attempt |
| Check queued | Budget exhausted / restart throws | Give up through owner fallback |

### 18. Panels, tabs, pins, and dashboard actions

Owners: [`panel-layout.ts`](../../src/app/panel-layout.ts),
[`tab-store.ts`](../../src/services/tab-store.ts),
[`webcams/pinned-store.ts`](../../src/services/webcams/pinned-store.ts),
[`agent-bus-applier.ts`](../../src/app/agent-bus-applier.ts).
Panel regions: configured enabled/disabled, entitled/gated, lazy unregistered/registered/
loading/mounted/destroyed, expanded/collapsed. Tabs: stored/active/removed. Webcam pin:
unpinned/hidden/active. Actions: applied/denied/invalid/skipped (terminal per action).
Invariants: configured enablement differs from runtime entitlement; only successful
persistence is reported as persisted; destroyed app rejects mutation; active pin is configured
and visible; collapse state must survive layout changes.

| From | Event / guard | To / effect |
|---|---|---|
| Disabled / gated | Enable or entitlement changes | Reconcile effective enabled state; mount if eligible |
| Lazy registered | Viewport admission | Loading; mount once if current; failure permits backoff retry |
| Expanded / collapsed | Collapse control | Toggle stored/layout collapse state |
| Active tab | Switch | Capture current layout, persist, apply selected tab |
| Unpinned / hidden | Pin/show | Active if eligible; persist pin/visibility |
| Active pin | Hide / unpin | Hidden / unpinned |
| Action requested | Invalid args / denied gate / valid execution | Invalid / denied / applied; report concrete target result |
| Mounted | App destroy | Dispose panels, bindings, watches and registries |

### 19. Freshness, provenance, and corroboration

Owners: [`data-freshness.ts`](../../src/services/data-freshness.ts),
[`giving/model.ts`](../../src/services/giving/model.ts),
[`label-history.ts`](../../server/_shared/label-history.ts),
[`seed-envelope.ts`](../../server/_shared/seed-envelope.ts).
Freshness: fresh / stale / very_stale / no_data / disabled / error; evidence session/seed-health.
Giving separates published/partial estimates from unavailable/stale/failure provenance.
Story label history records only single-publisher/corroborated; unknown/tier4-only becomes
untracked. Seed envelope distinguishes successful empty data from acquisition failure.
Invariants: no data is not an all-clear; source timestamp is distinct from consumer fetch time;
corroboration means publisher coverage, not factual confirmation; concurrent digest writes
must claim a transition before logging it.

| From | Event / guard | To / effect |
|---|---|---|
| No data / error | Valid producer/session evidence | Reclassify from its timestamp and enabled state |
| Fresh | Clock crosses thresholds | Stale then very_stale |
| Any source | Disabled / fetch error | Disabled / error; retain provenance fields |
| Any label | Assessed publisher set changes | Recompute label; tracked change uses atomic dedup guard |
| Tracked label | Unknown/tier4-only assessment | Untracked; do not invent a tracked-to-tracked transition |
| Seed acquisition | Valid zero rows / failure | Successful-empty / error; readers preserve distinction |

## Durable server and desktop workflows

### 20. OAuth authorization, code exchange, refresh, and replay

Owners: [`authorize.js`](../../api/oauth/authorize.js), [`token.ts`](../../api/oauth/token.ts),
[`_refresh-recovery.ts`](../../api/oauth/_refresh-recovery.ts),
[`_browser-binding.js`](../../api/oauth/_browser-binding.js).
Authorization: pending/bound/approved/denied; code unused/consumed/expired.
Refresh token: active / attempt-claimed / rotated-with-grace / failed-recovery tombstone /
replayed; family active/revoked.
Invariants: client/redirect/PKCE/browser binding checks precede issuance; consumption is atomic;
a transient or in-flight refresh is not automatically proven replay; grace only returns the
successor pair for the same client while that successor remains unused.

| From | Event / guard | To / effect |
|---|---|---|
| Pending auth | Valid bound browser approval | Issue short-lived code |
| Unused code | Valid exchange, atomic consumption | Consumed; issue token pair |
| Active refresh | Valid client, atomic consume | Attempt claimed; recovery marker installed |
| Claimed attempt | Token write commits | Rotated; successor pair + short grace receipt |
| Rotated within grace | Same client, successor still unused | Return same successor pair |
| Claimed / ambiguous failure | Retry | Retryable response/recovery; avoid false family revocation |
| Consumed outside permitted grace | Proven reuse | Revoke family |

### 21. Account deletion and company-monitor purge

Owners: [`account-deletion.ts`](../../src/services/account-deletion.ts),
[`erase.ts`](../../convex/accountDeletion/erase.ts),
[`accounts.ts`](../../convex/companyMonitoring/accounts.ts).
Deletion: pending/failed/complete plus persisted step cursor. Company purge phases:
none/pending/scan/companies/finalizing/complete, guarded by `purgeGeneration`.
Invariants: lost Clerk session alone does not prove deletion; steps resume from durable progress;
stale scheduled purge cannot delete a reactivated account; final deletion checks current fences.

| From | Event / guard | To / effect |
|---|---|---|
| Active account | Confirmed delete request | Pending; create/resume durable erasure work |
| Pending deletion | Step completes / fails | Advance cursor / persist failure for retry |
| Client polling | Server confirms complete or completed external deletion | Report complete |
| Client polling | Session absent without completion evidence / deadline | Report still-running failure; never fabricate success |
| Purge none | Deactivation/deletion | Increment generation; pending with grace deadline |
| Purge pending | Deadline and ownership checks pass | Scan then companies then finalizing |
| Any scheduled purge | Generation mismatch | Stale no-op |
| Pending/finalizing | Valid reactivation | None; preserve current account |
| Finalizing | Terminal fence remains valid | Complete |

### 22. Broadcast wave lease and recovery

Owners: [`waveRuns.ts`](../../convex/broadcast/waveRuns.ts),
[`rampRunner.ts`](../../convex/broadcast/rampRunner.ts).
Run: picking/segment-created/pushing/broadcast-created/sent/failed; contacts:
pending/pushed/failed/suppressed. Ramp: inactive/eligible/wave-in-flight/stalled/
blocked-on-partial-failure/kill-gate-tripped/complete (derived control outcomes).
Invariants: lease owns one run; uncertain external send does not authorize blind resend;
operator discard/resume paths preserve receipts and suppression; retries respect failure stage.

| From | Event / guard | To / effect |
|---|---|---|
| No run | Atomic lease claim, label available | Picking |
| Picking | Segment created and persisted | Segment-created |
| Segment-created | Export begins | Pushing; track per-contact outcomes |
| Pushing | Eligible batch/export completed | Broadcast-created after external create receipt |
| Broadcast-created | Confirmed send | Sent |
| Any active stage | Stage failure | Failed with substatus; retain/release lease per policy |
| Failed | Explicit permitted recovery | Resume recorded stage / reconcile receipt / discard |
| Ramp eligible | Prior statistics healthy and lease available | Schedule one wave |
| Ramp eligible | Kill gate, partial failure, stale lease, or active run | Stop/wait; do not launch duplicate wave |

### 23. Shipping webhook occurrence and delivery

Owners: [`shipping-webhook-worker.mjs`](../../scripts/shipping-webhook-worker.mjs),
[`shipping-webhook-delivery.mjs`](../../scripts/lib/shipping-webhook-delivery.mjs).
Subscriber active/disabled/deleted; event unseen/pending/delivered/expired; worker
unlocked/lease-held/lease-lost; transport success/http-failure/timeout.
Invariants: retry retains delivery identity; pending retry does not count as a new event;
lease-lost worker cannot commit over replacement; consecutive failure ceiling disables delivery;
HTTP side effect can be uncertain, so receiver deduplication remains necessary.

| From | Event / guard | To / effect |
|---|---|---|
| Unseen event | Trigger and cap admission | Pending with durable delivery ID/payload |
| Pending | Successful POST | Delivered; reset consecutive failures |
| Pending | Failed POST | Retain same identity for retry; increment failure count |
| Pending | Pending TTL expires | Expired |
| Active subscriber | Failure ceiling reached | Disabled |
| Lease-held | Renewal fails / subscriber replaced | Stop commits; compare ownership before write |

### 24. Desktop sign-in and local API startup

Owners: [`desktop_sign_in.rs`](../../src-tauri/src/desktop_sign_in.rs),
[`main.rs`](../../src-tauri/src/main.rs), [`runtime.ts`](../../src/services/runtime.ts).
Sign-in: flow-created/listening/code-received/exchanging/session-ready/failed/expired;
Clerk may return intermediate MFA state. Local API: unresolved/resolving/port-known/
ready/unavailable.
Invariants: loopback callback validates exact state and PKCE; malformed probes do not consume
valid flow; session success requires usable session/token evidence; fallback port is not proof
of sidecar readiness; a failed port resolution remains retryable.

| From | Event / guard | To / effect |
|---|---|---|
| New flow | Generate secrets, bind listener | Open sign-in URL; await bounded callback |
| Listening | Invalid callback | Keep listening within deadline |
| Listening | Correct state and well-formed code | Exchange code with verifier |
| Exchanging | Valid complete session / intermediate challenge | Activate session / continue authentication |
| Any sign-in | Error/deadline | Fail/expire and clean flow |
| Unresolved port | Concurrent callers | Share IPC resolution |
| Resolving | Valid IPC port | Cache port |
| Resolving | IPC fails | Return default without caching success; later call can retry |

## Additional browser machines

### 25. Analyst streaming and widget composition

Owners: [`ChatAnalystPanel.ts`](../../src/components/ChatAnalystPanel.ts),
[`WidgetChatModal.ts`](../../src/components/WidgetChatModal.ts).
Analyst: idle/streaming/complete/incomplete/cancelled/failed, with independent history and
control-action receipts. Widget: checking/ready_to_prompt/fetching/composing/complete/error;
request idle/running/retired; save absent/ready. Invariants: only the current request may
publish or release shared controls; timeout, close and reopen retire old continuations;
a `done` event produces a save candidate, not an automatic save.

| From | Event / guard | To / effect |
|---|---|---|
| Widget checking | Authenticated healthy preflight | Ready-to-prompt; enable send |
| Widget checking | Offline / missing signed-in token / failure | Error; bounded preflight retry or online recheck |
| Ready / error after timeout | Submit with preflight ready | Fetching; local controller and deadline |
| Fetching | Tool / HTML events | Fetching / composing; render current request only |
| Composing | Done event | Complete; store save candidate and enable apply |
| Running | Deadline | Error; abort that request, allow retry |
| Running | Close / replacement | Retired; abort; late token/response/body/finally cannot affect successor |
| Analyst streaming | Clear / account reset / destroy | Retire generation, abort owned stream |
| Analyst streaming | Final / truncated / failed stream | Complete / incomplete / error; release controls only if owner |

### 26. Browser notification permission and registration

Owners: [`push-notifications.ts`](../../src/services/push-notifications.ts),
[`notifications-settings.ts`](../../src/services/notifications-settings.ts),
[`notification-channels.ts`](../../src/services/notification-channels.ts).
Permission: default/granted/denied/unsupported. Registration: absent/existing/pending/registered/
removing/failed; settings availability: available/denied/unsupported. Invariants: permission
is not server registration; auth/account must remain current across registration awaits;
a stale subscription may need replacement rather than blind reuse.

| From | Event / guard | To / effect |
|---|---|---|
| Default permission | User requests push | Granted or denied browser decision |
| Unsupported / denied | Connect | Surface unsupported/blocked; do not fabricate registration |
| Granted | Service worker ready and subscription obtained | Register payload with current account |
| Existing stale subscription | Re-registration | Unsubscribe stale browser subscription, obtain new one |
| Registered | Remove | Delete channel and best-effort browser unsubscribe |
| Notification operation | Retryable billing gate | One allowed retry after server delay; assert account again |

### 27. Bundle and service-worker update recovery

Owners: [`chunk-reload.ts`](../../src/bootstrap/chunk-reload.ts),
[`stale-bundle-check.ts`](../../src/bootstrap/stale-bundle-check.ts),
[`sw-update.ts`](../../src/bootstrap/sw-update.ts).
Chunk guard: unspent/spent/unpersistable. SW: initial-claim/update-available/dismissed/reload;
visible dwell unarmed/armed; blocking modal present/absent. Invariants: durable claim before
reload prevents loops; another listener may claim preload error; hidden-only startup cannot
arm auto reload; open blocking modal delays background update reload.

| From | Event / guard | To / effect |
|---|---|---|
| Chunk unspent | Unclaimed preload error and durable write verified | Spent; reload once for build |
| Chunk spent / unpersistable | Preload error | No reload |
| SW initial claim | Controller change | Track controller without treating initial claim as update |
| Existing controller | Replacement controller | Update toast; replace prior dwell/listener |
| Toast visible | Continuous dwell budget completed | Armed for hide reload |
| Armed | Tab hides, no blocking modal | Reload |
| Toast | Dismiss / newer update | Remove old toast/timers; future update remains eligible |

### 28. Anonymous browser session and key-session mutation

Owners: [`wm-session.ts`](../../src/services/wm-session.ts),
[`browser-key-session.ts`](../../src/services/browser-key-session.ts).
Session: absent/minting/valid/recovering/dead-cooldown; route strikes and global dead status
are separate. Key-session: queued/exchanging/accepted/rejected/failed/clearing.
Invariants: concurrent mints share work; public and premium denials are not anonymous-cookie
failure evidence; route-local denial must not become global failure without corroboration;
clear waits for accepted exchanges to finish so a late Set-Cookie cannot restore removed key.

| From | Event / guard | To / effect |
|---|---|---|
| Absent / expired | Anonymous API requires session | Shared mint |
| Minting | Confirmed mint | Valid expiry marker; include HttpOnly credentials on API fetch |
| Valid | Eligible anonymous route 401 | One forced refresh and replay |
| Recovering | Fresh cookie rejected | Route strike / corroborated dead cooldown; suppress mint storm |
| Dead cooldown | Cooldown expires / permitted recovery | Retry under bounded recovery policy |
| Key exchange | Accepted / explicit rejection / transport failure | Update hints / remove rejected legacy key / retain retry evidence |
| Exchanging | Clear requested | Queue clear after exchange; avoid credential resurrection |

## Reachability evidence and verification

The new suite imports the real services and replaces only Convex/Clerk transport and deferred
telemetry. It controls dependency settlement, records every watch and unsubscribe, and delivers
retired callbacks explicitly. This proves acceptance of a callback if delivered; it does not
claim that the Convex SDK always delivers callbacks after unsubscribe.

Pre-fix on `5c3feba8d7`: `account-watch-lifecycle.test.mts` had **7 failures / 2 passes**:

* Each service: `start(A), start(A), resolve dependencies` attached **2** watches instead of 1.
* Each service: `start(A), destroy(), resolve dependencies` attached **1** watch instead of 0.
* Each service: `attach(A), destroy(), attach(A), current update, retired update/error` replaced
  the current snapshot with null instead of retaining the new snapshot.
* Billing: `throwing listener, observer, update` threw `broken consumer` and skipped observer.
* Each service's failed-init-then-retry control already passed.

After repair, the same suite and existing entitlement fan-out suite passed **12/12**.
The lifecycle fix adds a generation captured by initialization and callbacks, a second
`initialized` check immediately before attachment, and cleanup of a watch if synchronous
notification retires it during attachment. It adds no retry delay, dependency, or public API.
Billing now commits the snapshot then isolates each notification on both update and query-error.

Issue groups: [watch ownership #10236](https://github.com/koala73/worldmonitor/issues/10236),
[billing listener isolation #10237](https://github.com/koala73/worldmonitor/issues/10237).
Review follow-up: destroying a pending entitlement initializer left verification `pending`
although its generation could never complete. The new test failed before the repair
(**1 failure / 13 passes** in the expanded watch suite). The first follow-up published `unavailable` from transport teardown.
A second runtime trace found that A-to-B handoff consequently emitted `unavailable` before
its next `pending` notification (**1 failure / 29 passes** across watch and app-teardown tests).
The terminal notification now belongs to `PanelLayoutManager.destroy()`, which calls
`markEntitlementVerificationUnavailable()` after retiring the transport. Account handoff
preserves pending until auth succeeds or fails; final app teardown notifies current and late
subscribers when no snapshot exists. Ready snapshots remain intact, retired completion cannot
republish, and retry can reach ready. No new teardown option or status is introduced.

Latest-head review found a separate caller gap: after `App.destroy()` sets `isDestroyed`,
the account handoff still considered itself current if Clerk identity and handoff generation
matched. A delayed auth confirmation could then call a fresh initializer after transport
teardown, creating a new watch lifetime. `App` now includes `!this.state.isDestroyed` in the
existing handoff predicate, propagated through rebind and watch callbacks. The existing
App-to-controller wiring assertion failed before this one-line change; a runtime test drives
the real Convex rebind with delayed confirmation and a retired app lifetime and confirms no
watch attaches. The wiring assertion is source-level; it does not execute full App boot.
This remains watch-ownership issue #10236, with no transport or retry-policy change.

The watch suite also switches Clerk from A to B during pending initialization for both services,
proving no stale A watch attaches and B can start. These changes remain in issue #10236.

Both fixes are locally implemented; delivery and CI status are recorded below when complete.

## Audit boundaries and maintenance

The tables describe shared runtime machines and important durable workflows. They are a
source-linked architectural inventory, not a claim that every component-local boolean or
external provider's state has been exhaustively model-checked. Per-panel loading/empty/error
views are instances of request, lifecycle and freshness machines above. Provider operational
labels (flight status, road condition, plant construction, conflict classifications) are input
data. RPC action result unions describe terminal outcomes, not additional persistent machines.

Concurrency is inspected at awaits, ownership changes, timers, cache writes, and durable claims.
No higher-impact security or financial bug is claimed without a reproducer. Cross-tab passkey
presentation is a documented best-effort limit; the scheduler lease deliberately permits
underlying expired work to remain alive. Neither is silently rewritten by this repair.

Unverified: production/preview behavior; external service atomicity beyond the code and test
adapters; real OAuth/browser billing sessions; native desktop integration; exhaustive interleaving
coverage for all inventory entries. Existing regression suites provide additional bounded proof,
listed with results below. Update this file with any newly confirmed trace, issue and regression;
keep possible risks separate from confirmed defects.

### Additional confirmed trace: ML readiness ownership

`init()` with delayed worker readiness, then two `whenReady('same-caller')` calls, then
`worker-ready`: the first promise's observer was called **0** times after all readiness
continuations settled. Existing recovery suite: **1 failure / 10 passes** before repair.
The map replacement discarded the only resolver for that promise, so terminate could not
settle it either. The repair resolves the replaced waiter false before storing its successor.
No worker scheduling, retry budget or model behavior changes. The existing test harness
controls Worker messages and capability detection; the manager is the production module.

### Additional confirmed trace: widget request deadline ownership

Real modal test, with fetch settlement controlled: submit A, close, reopen, submit B, reject A,
advance 200 seconds. Before repair B's signal remained un-aborted (**1 failure / 10 passes**).
The old `finally` cleared the module-global timeout belonging to B. After repair this exact
suite passes **11/11**. Local controller/timer handles and ownership checks after token,
response and stream-body awaits prevent retired sends, rendering and cleanup. The deadline
and existing translated error copy are unchanged. Browser evidence uses a controlled delayed
AbortError and hung successor response; it does not measure provider timeout behavior.

## Verification ledger

| Check | Result and boundary |
|---|---|
| Repair preflight | Ready for source, tests and repair in isolated `fix/state-machine-audit` worktree; Node 24 |
| Baseline entitlement fan-out + ML recovery | 13/13 passed before changes |
| New watch lifecycle / billing fan-out | Initial reproduction: 7 failures, 2 retry controls passed; final expanded cases pass |
| ML superseded waiter | Initial reproduction: 1 failure, 10 existing cases passed; repaired suite passes |
| Widget close/reopen deadline | Initial reproduction: 1 failure, 10 existing cases passed; final suite 12/12 including late-token suppression |
| Auth handoff, checkout wait, poll/lease, breaker contract | 89/89 passed with `node --import tsx --test tests/convex-auth-handoff.test.mts tests/checkout-entitlement-wait.test.mts tests/smart-poll-loop.test.mjs tests/circuit-breaker-state-contract.test.mts` |
| Focused DOM consumers | Watch ownership, fan-out, ML, widget preflight, settings loading, Pro stability and playback gate passed; exact final count in PR |
| Static gates | `npm run typecheck`, `npm run lint:boundaries`, `npm run docs:check`, `git diff --check` passed |
| Browser | Controlled `/dashboard` flow through actual widget CTA, close, reopen, send, timeout, retry: passed. Desktop 1280x720 and mobile 390x844 screenshots inspected |
| Browser data limits | API responses and delayed widget requests are fixtures; remote assets blocked. Unrelated empty dashboard fixtures log source errors. No provider/auth/production acceptance is claimed |

Browser evidence: `.claude/verify-evidence/2026-11-06_14-55-30-widget-request-ownership/`:
`01-desktop-request-b-running.png`, `02-desktop-request-b-timeout.png`,
`03-mobile-request-b-timeout.png`, `04-desktop-retry-recovered.png`, `result.json` and transcript.
The request trace retains B's 200-second deadline after A settles and allows C to produce a
save candidate. The mock preview's remote assets are blocked; save enablement is asserted.
The reproduction driver is retained alongside that evidence as `reproduce.mjs`.

Delivery: issue groups #10236–#10239; PR and exact-head CI are verified separately after push.
This document is current for the repaired source tree. No merge or deployment is authorized.
