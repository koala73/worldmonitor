---
title: A transport-grace deadline carried past its own expiry poisons the health verdict cache
date: 2026-09-17
category: logic-errors
module: api-health
problem_type: logic_error
component: service_object
symptoms:
  - "Caught in code review before merge, so these are the symptoms the shipped code would have shown, not an observed incident"
  - "In any relay outage outlasting the 3-minute transport grace, every RELAY_GATE_UNREACHABLE verdict would republish the already-expired transportGraceUntil deadline instead of dropping it"
  - "hasExpiredActivationGrace would reject every one of those snapshots as unservable and snapshotTtlSeconds would clip their Redis TTL to its 1-second floor"
  - "Every health poll would therefore run a full ~390-command Redis sweep instead of one warm read, for as long as the outage ran with polling frequent enough to keep the verdict retained"
  - "The check's own reported verdict, status and compact-payload placement stay correct throughout, so no status or classification assertion can catch it; only an assertion on the published cache lifetime does"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components: [background_job]
tags: [health-check, relay-gateway-gate, transport-grace, softening-deadline, cache-stampede, redis-ttl, pr-review-caught]
---

# A transport-grace deadline carried past its own expiry poisons the health verdict cache

## Problem

A relay-gate outage grace deadline (`transportGraceUntil`) was carried forward into every later
verdict so the outage streak would survive sparse health sweeps — but the field is also registered in
`ENTRY_SOFTENING_DEADLINES` (`api/health.js:3607`), which means republishing it after it expired made
the generic caching machinery reject every health snapshot on read and write the next one with a
1-second TTL. Through any relay outage lasting past three minutes, `/api/health`
would silently lose its 60-second cache and run a full ~390-command Redis sweep on **every single
poll** — roughly a 390x amplification of health-attributable Redis commands, for as long as the
outage ran with sweeps arriving inside the verdict's retention window. That is the steady-traffic
case, and it is unbounded in the sense that matters: nothing in the mechanism ends it while the
relay stays down and the endpoint keeps being polled.

Caught by an automated reviewer during the same PR that introduced it, so it never reached
production. The symptoms below are what the shipped code would have produced, derived from the code
and reproduced against the real exported functions, not observations of an incident.

## Symptoms

This is the honest part, and it is the whole point of the entry: **nothing would have looked
wrong**. Every signal an operator or a test watches stays correct; only volume moves.

- `/api/health` keeps returning the *correct* verdict throughout. `healthStatusBucket` classifies an
  unreachable relay with no live `transportGraceUntil` as `warn` (`api/health.js:3207-3212`), the
  check moves out of compact `pending` into `problems` exactly when it should, and the 15-minute
  seed-freshness monitor pages exactly when it should
  (`scripts/check-seed-freshness.mjs:129-132`, `:201-211`).
- Every functional assertion — status string, bucket, compact payload placement, monitor predicate —
  stays green. There is no wrong answer to assert against.
- The only signal would be **volume**: cache-miss rate on the health verdict snapshot at 100%, Redis
  command count per health poll jumping from ~0 (warm read) to ~390 (full sweep), and the snapshot
  key's TTL reading 1 instead of 60.
- **The upstream is not re-probed.** It is tempting to assume the failing relay gets hammered too; it
  does not. The relay verdict has its own independent cache read at the top of
  `readOrProbeRelayGatewayGate` (`api/health.js:3920-3921`), and `parseCachedRelayGatewayGate`
  (`api/health.js:3834-3846`) reuses a verdict inside its own 60-second freshness window without
  consulting the grace deadline at all. So whenever a reusable verdict is in the cache, the gateway
  is probed about once a minute however often the health sweep runs. The cadence guarantee is
  exactly that conditional, and two paths leave no reusable verdict behind: a *persisted follower
  fallback*, stored with `probed: false` and rejected by that same parser because nobody actually
  probed it (it is a predecessor for the streak, not a verdict); and a probe whose own publish
  failed or returned an indeterminate result, which returns the observation to its caller without
  caching it. After either, the next sweep probes. The two behave differently under load, which
  matters. The fallback path is driven by lease contention and does not scale with poll rate. A
  publish that keeps failing caches nothing at all, so every poll finds an empty key and tries. The
  single-flight lease (`SET ... NX`, `api/health.js:3932`) admits one prober at a *time*, but it
  does not slow the succession: the owner returns `follow(...)` without awaiting it
  (`api/health.js:4020`), so the `finally` releases the lease while that call is still waiting, and
  the next poll can take the free lease immediately. Relay traffic in that state is therefore
  bounded by the probe critical path — probe timeout plus the publish attempt — not by the lease
  TTL, and with fast probes it approaches one contact per poll.

  Releasing early is the right behaviour, not a bug: the owner is following in the hope that
  *another* sweep publishes a verdict, and holding the lease would lock out the only party that
  could. The cost is that a sustained publish fault is the one state where relay traffic does track
  poll rate. So "about once a minute" describes a healthy Redis rather than a bound. The damage in
  the bug documented here is Redis command volume regardless, because that bug leaves the verdict
  cache working.
- Secondary amplification: with the snapshot dying every second, concurrent pollers contend the
  refresh lock, wait out `HEALTH_VERDICT_REFRESH_WAIT_MS` (3 s, `api/health.js:191`), and then fall
  through to their *own* sweep — the exact failure mode `snapshotTtlSeconds`' own doc comment
  describes (`api/health.js:3668-3682`).

Executed against the current code, using the real exported functions on the two entry shapes:

| entry shape | `hasExpiredActivationGrace` | `snapshotTtlSeconds` | `healthStatusBucket` |
|---|---|---|---|
| pre-fix: expired `transportGraceUntil` | `true` (snapshot refused) | `1` | `warn` |
| post-fix: `transportGraceExpiredAt` | `false` | `60` | `warn` |

Same bucket in both rows. That identical `warn` is why no functional test could have caught it.

## What Didn't Work

The grace mechanism went through two earlier shapes on PR #8282, each a correct fix for a real
problem. The first already contained the seed of this bug; the second made it permanent. This was a
genuine tension, not an oversight.

**Iteration 1 — grace lives only in the verdict snapshot.** The first `RELAY_GATE_UNREACHABLE`
sighting mints a bounded three-minute deadline (`RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS`,
`api/health.js:3780`) during which it buckets as `ok` and sits in compact `pending`, so one Convex
blip inside a single 60-second window does not page.

Why it was incomplete: health sweeps are *sparse*. With no organic traffic the seed-freshness
monitor is the only caller, every 15 minutes (`SEED_FRESHNESS_MONITOR_INTERVAL_MS`,
`api/health.js:3787`, mirroring the `*/15` cron). The streak carry never consulted freshness — it
reads the predecessor through `parsePreviousRelayGatewayGate`, which is explicitly "the previous
verdict regardless of freshness" (`api/health.js:3792`). What made the predecessor *gone* was the
Redis retention TTL: the verdict key was kept for only the freshness window plus the grace, about
four minutes, against a 15-minute monitor interval. Every run was therefore a "first sighting",
minted a *fresh* three-minute grace, and parked a permanently dead relay in `pending` forever. A
grace that restarts is not a grace, it is a mute button.

This iteration already republished an expired deadline, and how long that lasted depended entirely
on traffic. Under the sparse regime above the verdict key was evicted between monitor runs, so the
collapse lasted only the roughly one minute between grace expiry and eviction, and the next run
restarted the grace. But under *sustained* traffic — any polling at least once per the verdict's own
60-second freshness window — each probe republished the carried deadline and reset the key's
retention TTL, so the expired deadline never aged out and the collapse was permanent. That is the
uncomfortable part: the traffic regime that makes a per-poll sweep most expensive is exactly the one
that keeps the expired deadline alive. Iteration 2 did not create the bug; it removed the sparse
regime's accidental escape hatch, making the permanent case the only case.

**Iteration 2 — retain the verdict long enough to outlive a monitor interval.** The verdict is now
retained in Redis for the freshness window plus the grace plus one monitor interval plus slack
(`RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS`, `api/health.js:3788-3790`), so the predecessor is
still there when the next sweep arrives. A later round in the same PR also persisted the follower
fallback to Redis (`api/health.js:3965-3978`), so a probe owner that crashes without publishing does
not cost one more monitor interval before a dead relay pages — but only when some *other* sweep was
waiting on it. That path runs in `follow()`, which a sweep reaches only by losing the lease race. If
the sole 15-minute monitor invocation takes the lease and dies before publishing, nothing is written
at all and the next run is a first sighting on a fresh grace. The persistence narrows the window; it
does not close it for a single-caller deployment.

That closed the paging hole correctly. The side effect is that the expired deadline now survives as
long as sweeps keep arriving inside the retention window rather than for one minute — an outage
whose sweeps pause for longer than that window still evicts the predecessor and mints a new grace.
During an outage past the three-minute mark,
`withTransportGrace` kept re-emitting the original, now-expired timestamp under the name
`transportGraceUntil` — and that name is not inert. It is row 8 of `ENTRY_SOFTENING_DEADLINES`
(`api/health.js:3607`), the table walked by the two cache readers — `hasExpiredActivationGrace`
(`api/health.js:3621-3639`, via `entryDeadlineRaw` at `:3610-3613`) and `nearestActivationDeadlineMs`
(`api/health.js:3647-3665`), which feeds `snapshotTtlSeconds` (`api/health.js:3683-3688`) — and a
third time by the compact-payload scrubber (`api/health.js:4298-4306`). An expired value in that field means
"this snapshot promised a softening that has since lapsed" — so it is refused on read
(`api/health.js:4467`), refused again in the refresh wait loop (`api/health.js:4506`), and the
next write is clipped to the 1-second floor (`api/health.js:4889`). Correct machinery, correct
inputs from its own point of view, wrong meaning for the value being fed to it.

No test caught it. No incident revealed it, because it never shipped. Codex found it by reading the
code in the twelfth and final review round on PR #8282, minutes before the merge.

## Solution

Split the one field into two, by lifetime. The streak anchor keeps riding forward under a name that
means nothing to the caching machinery; the softening deadline is published **only while it is
actually in force**.

Before (the merged-branch shape, simplified to share the `deadline` variable with the "after" block
for comparison; the original inlined the same expression into its return):

```js
function withTransportGrace(fresh, previous, now) {
  if (fresh.status !== 'RELAY_GATE_UNREACHABLE') return fresh;
  const carried = previous?.status === 'RELAY_GATE_UNREACHABLE'
      && typeof previous.transportGraceUntil === 'string'
      && Number.isFinite(Date.parse(previous.transportGraceUntil))
    ? previous.transportGraceUntil
    : null;
  const deadline = carried ?? new Date(now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString();
  return { ...fresh, transportGraceUntil: deadline };  // <- republished even when expired
}
```

After (`api/health.js:3803-3832`):

```js
function withTransportGrace(fresh, previous, now) {
  if (fresh.status !== 'RELAY_GATE_UNREACHABLE') return fresh;
  // The streak anchor survives its own deadline: after the grace lapses it
  // rides in `transportGraceExpiredAt`, so an unbroken run of unreachable
  // verdicts reads as one continuous outage for as long as the predecessor is
  // retained (RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS); a gap longer than
  // that evicts it and the next sighting is a first one.
  // Only an unreachable predecessor is carried — any other verdict in between
  // (including OK) clears the anchor, and the next failure is a first
  // sighting that earns a fresh grace.
  const carried = previous?.status === 'RELAY_GATE_UNREACHABLE'
    ? [previous.transportGraceUntil, previous.transportGraceExpiredAt]
      .find((raw) => typeof raw === 'string' && Number.isFinite(Date.parse(raw))) ?? null
    : null;
  const deadline = carried ?? new Date(now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString();
  // Publish it as a softening deadline ONLY while it is still in force.
  // `transportGraceUntil` is registered in ENTRY_SOFTENING_DEADLINES, so an
  // expired one makes hasExpiredActivationGrace reject every snapshot that
  // carries it and snapshotTtlSeconds clip the TTL to a second — turning a
  // persistent relay outage into a full Redis sweep on every single health
  // poll instead of one warm read (#8282 review). The relay itself is not
  // re-probed at that rate: readOrProbeRelayGatewayGate reuses a cached
  // verdict inside its own freshness window before it ever takes the lease.
  // That holds whenever a reusable verdict is in the cache — so not when the
  // stored record is an unprobed follower fallback, and not when a probe's
  // own publish failed. Both leave the next sweep to probe again.
  return isExpiredDeadline(deadline, now)
    ? { ...fresh, transportGraceExpiredAt: deadline }
    : { ...fresh, transportGraceUntil: deadline };
}
```

Three properties make this a complete fix rather than a patch:

1. **`transportGraceExpiredAt` is deliberately absent from `ENTRY_SOFTENING_DEADLINES`**
   (`api/health.js:3599-3608` — eight rows, and it is not one of them; its only appearances in the
   file are the carry at `:3814` and the publish at `:3830`). It is data, not a promise, so it has no
   effect on `hasExpiredActivationGrace` or `snapshotTtlSeconds`.
2. **The carry reads either field** (`api/health.js:3813-3816`), so an unbroken run of unreachable
   verdicts never restarts its grace for as long as the predecessor is retained — the property
   iteration 2 existed to guarantee is preserved exactly. That retention is finite and deliberately
   sized: freshness window plus grace plus one monitor interval plus slack, about twenty minutes, so
   a sweep gap longer than that evicts the predecessor and the next sighting is a first one. The
   sizing is what makes the guarantee hold at the cadence the monitor actually runs, not forever. The carry is still conditional on the predecessor
   being unreachable, so a healthy verdict in between clears the anchor and the next failure is a
   genuine first sighting; the unit test pins both halves.
3. **Classification is untouched.** `healthStatusBucket` already required a *live*
   `transportGraceUntil` to soften to `ok` (`api/health.js:3207-3212`), and the monitor's
   `isRelayGateGraceProblem` already required an active bounded deadline
   (`scripts/check-seed-freshness.mjs:129-132`). Both read an absent `transportGraceUntil` the same
   way they read an expired one: operational, pages. No downstream consumer had to change.

Both call sites go through the same helper: the owner path (`api/health.js:3995`) and the follower
fallback path (`api/health.js:3957`).

## Why This Works

The bug is a lifetime collision. One field was doing two jobs whose lifetimes are *opposites*:

| job | who reads it | required lifetime |
|---|---|---|
| **state anchor** for a cross-sweep outage streak | `withTransportGrace`'s own carry logic | must **outlive** the deadline — otherwise a 15-minute-apart sweep sees a "first sighting" and restarts the grace |
| **published softening deadline** | generic machinery: `hasExpiredActivationGrace`, `nearestActivationDeadlineMs` → `snapshotTtlSeconds` | must **not outlive** the deadline — a published deadline that has passed means "this snapshot is stale", by design |

No single field can satisfy both. Honour the first and the cache collapses; honour the second and the
paging is delayed by a monitor interval. The only resolution is two fields, each with one job and one
lifetime. Splitting them makes the requirements independent instead of contradictory.

Note also that the generic machinery was never wrong. `isExpiredDeadline` is deliberately fail-closed
— an unparseable or passed deadline is treated as expired so a pending entry that cannot prove it is
inside its window is never served warm (`api/health.js:3583-3588`). `snapshotTtlSeconds` floors at
1 second, never ceilings, so a snapshot cannot outlive a deadline it publishes
(`api/health.js:3683-3688`). Both did exactly what they promise. They were simply handed a value that
no longer meant what the field name claims.

## Prevention

**The rule.** When a value has to be carried forward across invocations *and* it is also published in
a payload that generic machinery interprets, those are two different fields. Name them separately.
A field name in a shared schema is an interface, and writing a value into it is a call into every
consumer of that name — including consumers you have never read.

**The diagnostic question for reviewers.** Whenever you see a field being copied from a previous
record into a new one — especially "so the streak/state survives" — ask:

> Is this field also *registered* anywhere that gives it side effects?

Carrying a field forward for reason A silently inherits every consequence B, C, D that the field's
name carries elsewhere. In this codebase the concrete check is membership in the softening-deadline
registry:

```bash
# List every field whose value has system-wide caching consequences.
grep -n -A 12 '^const ENTRY_SOFTENING_DEADLINES' api/health.js | grep 'field:'
```

If the field you are about to carry forward appears in that output, then *any* value you put in it —
including a stale one copied from a previous record — decides whether the whole health snapshot is
servable and how long it may be cached. That is a decision about caching, not about your feature.

Two follow-on heuristics worth generalising beyond this repo:

- **A registry of "fields with behaviour" is a coupling surface.** `ENTRY_SOFTENING_DEADLINES`
  (`api/health.js:3595-3608`) exists to stop near-identical `hasOwnProperty` + `isExpiredDeadline`
  branches drifting apart, which is a good reason. The cost is that adding one row gives every value
  of that field system-wide consequences. When you add a row, audit every writer of that field, not
  just the reader you were building.
- **A bug whose only symptom is load is invisible to correctness tests.** If a change can alter how
  long a result may be cached, assert on the *published lifetime*, not only on the response body —
  the end-to-end test below reads the literal `EX` argument of the snapshot write for exactly that
  reason, and it is the only assertion in the file that detects the cache-lifetime regression itself
  (the split-field assertions beside it also fail on the pre-fix code, but they pin the field
  rename rather than the damage it was hiding). Note
  what that does and does not cover: it pins the cache lifetime, which is the cause, and neither
  regression test counts calls. Asserting the downstream call volume would be the stronger test.

**Audit finding: every sibling field was already safe, and for a reason worth copying.** After the
fix, all seven other rows of the eight in `ENTRY_SOFTENING_DEADLINES` were checked, including every
assignment site of each field. Each is published only while
its deadline is live, because each is *re-derived* from current state on every sweep rather than
copied from a previous record:

| field | publish-time guard |
|---|---|
| `staleContentGraceUntil` | `staleContentGraceUntilMs` returns `null` unless `stateBackedUntil > now` (`api/health.js:1937`), and only a non-null result is projected (`:1949`) |
| `rolloutPendingUntil` | published only for `ROLLOUT_PENDING`, and that status itself requires `now < rolloutPendingUntil` (`api/health.js:2677-2679`, `:2980`) |
| `contentFreshnessPendingUntil` | comes from `getActiveContentFreshnessActivationWindow(..., now)` (`api/health.js:2773-2782`), which returns `null` outside the window (`api/_content-freshness.js:88-94`) |
| `workerControlPendingUntil` | `if (now < deadline)` (`api/health.js:3063`) |
| `chinaCoveragePendingUntil` | `now < pendingUntil` at both publish sites (`api/health.js:3463`, `:3504`) |
| `containmentUntil` | `now < deadline` in the publish guard (`api/health.js:3320`) |
| `sourceFailurePendingUntil` | the deadline is minted only while live (`api/health.js:2326-2338`) and projected at `:3034` |

The relay gate was the **only** field republished without re-checking the value against the clock at
publish time, and it is the only one that hit the trap. Carrying a stored deadline is not itself the
error — `staleContentGraceUntil` does exactly that and is safe. The error is carrying one *and*
trusting it, so the rule is narrower than "do not carry": whatever the source of a deadline, re-check
it against the clock in the moment you publish it. That sibling is worth watching for exactly that
reason: `staleContentGraceUntil` is
designed to claim its deadline once and republish that stored value on every later sweep, which is a
carry in all but name. It stays safe only because `staleContentGraceUntilMs` re-checks the stored
anchor against the clock before projecting it (`api/health.js:1937`). Keep that re-check if that
mechanism is ever extended.

**The regression tests** (`tests/health-relay-gateway-gate.test.mjs`, 31/31 passing on the current
tree).

End-to-end, at `:289` — "a stall that outlives its grace becomes an operational
`RELAY_GATE_UNREACHABLE` problem and the grace is carried, not restarted". It seeds a previous window
whose `transportGraceUntil` has already passed (`:294-299`) and then pins both halves — the split
field *and* the cache lifetime that was the actual damage:

```js
assert.equal(entry.transportGraceExpiredAt, expiredGrace, 'the original deadline is carried across windows');
assert.equal(entry.transportGraceUntil, undefined, 'an expired deadline is never republished as a softening');
const snapshotWrite = redisCommands.find(([op, key]) => op === 'SET' && key === HEALTH_SNAPSHOT_KEY);
assert.equal(snapshotWrite[4], String(__testing__.HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS), 'the warning snapshot keeps its full TTL');
```

(`:310-313`.) Reading the literal Redis `SET ... EX <ttl>` argument is what gives this test teeth — it
is the one assertion that pins the actual damage, because the status, the bucket and the compact
payload were all already correct on the pre-fix code.

Unit, at `:330` — `withTransportGrace` "only decorates unreachable verdicts and restarts after a
healthy window". The five assertions that pin the split (`:342-351`):

```js
const elapsed = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, first, now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS + 1);
assert.equal(elapsed.transportGraceUntil, undefined);
assert.equal(elapsed.transportGraceExpiredAt, first.transportGraceUntil);
// And the expired anchor is itself carried, so the streak never restarts.
const stillElapsed = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, elapsed, now + 60 * 60_000);
assert.equal(stillElapsed.transportGraceExpiredAt, first.transportGraceUntil);
// A healthy window clears it: the next unreachable sighting is a first one.
const restarted = withTransportGrace({ status: 'RELAY_GATE_UNREACHABLE' }, { status: 'OK' }, now + 60 * 60_000);
assert.equal(restarted.transportGraceUntil, new Date(now + 60 * 60_000 + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString());
assert.equal(restarted.transportGraceExpiredAt, undefined);
```

`stillElapsed` is the important one: it proves the fix did not reintroduce iteration 1's bug. Given a
predecessor an hour old, the anchor it returns is *still* the original deadline rather than a fresh
one. Read it for what it is — a unit test of the carry logic, handed its predecessor directly. It
says nothing about an hour-long outage in the deployed path, where the predecessor has to survive
Redis retention (about twenty minutes) to be read back at all. The end-to-end test below is what
covers the persisted round trip, and it does so across one monitor interval, not an hour.

The follower-fallback test at `:519` closes the loop across the persistence boundary — the follower's
deadline is written to Redis (`:540`), and the next sweep one monitor interval later reads it back and
converts it (`:559-562`):

```js
assert.equal(next.transportGraceExpiredAt, fallback.transportGraceUntil, 'the streak carried past its deadline');
assert.equal(next.transportGraceUntil, undefined, 'and not as a live softening');
assert.equal(__testing__.healthStatusBucket(next, monitorNow), 'warn', 'and the expired deadline pages');
```

**Discovery channel worth institutionalising.** An automated reviewer reading the code found this;
neither the test suite nor production would have. The Codex review chain on PR #8282 ran twelve
rounds and this P1 landed in the twelfth, the last one before merge — and it was a finding about the
fix applied two rounds earlier, not about the original feature. Do not treat a long chain as
evidence that a review is finished: each fix in a chain is new code that deserves the same
adversarial read as the original (see the related follow-up, issue #8285, from the same PR's review).

**References:** PR #8282 (merged 2026-09-17) — cite the PR, never the commit SHA; the squash merge
rewrote every branch SHA. Follow-up issue #8285.

## Related Issues

- **PR #8282** — the source PR. The relay-gateway gate feature, and the twelve-round Codex review
  chain in whose final round this P1 was raised. Merged 2026-09-17.
- **Issue #8285** — a separate finding from the same review: the scheduled seed-freshness monitor can
  check out an older `scripts/check-seed-freshness.mjs` than the `/api/health` revision production is
  already serving, so every newly shipped pending kind pages falsely during the gate window.
- **Issue #5261** (closed) — the precedent that makes the cost concrete: the `/api/health` sweep was
  once ~62% of all Redis commands (~36M/day) at roughly 390 commands per poll with no memoization.
  The snapshot cache this bug disabled is the memoization that fixed it, which is why silently
  reverting to a per-poll sweep matters.
- `docs/health-endpoints.mdx` (and `docs/zh/health-endpoints.mdx`) — the operator-facing reference.
  The `RELAY_GATE_UNREACHABLE` row narrates this behaviour, including why the streak moves to
  `transportGraceExpiredAt` and why the relay is not re-probed per poll. Update both together; the
  Chinese translation is kept in sync.
- `docs/solutions/logic-errors/retention-that-outlives-its-own-alarm.md` — the mirror image in the
  same health-and-freshness family: there a retention window *outlived* its alarm marker and decayed
  a real outage into silence. Same shape (one temporal value, two consumers needing different
  lifetimes), opposite polarity. Read both before changing any deadline in `api/health.js`.
- `docs/solutions/best-practices/a-requirement-and-its-bound-must-share-a-clock.md` — an adjacent
  shape: two temporal values that silently assume a shared clock and do not have one.
