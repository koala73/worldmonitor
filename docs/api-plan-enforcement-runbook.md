# Turning on API plan enforcement

`API_RATE_LIMIT_ENFORCE` gates whether the per-account daily meter rejects or
only records. It is **not** set in production, so the daily allowance sold on
every API plan is currently advisory: over-limit requests are served and tagged
`rl_ceiling_shadow` instead of returning 429.

Flipping it is a customer-visible change, not a config tidy-up. This runbook
exists because the blast radius is not obvious from the code.

## Why this matters more than it looks

MCP already meters API-tier callers at the sold allowance. `api/mcp/quota.ts`
gives API Starter 1,000 units/day and API Business 10,000, charged at the
per-tool weight, and while the flag is off it books them on MCP's own
`mcp:pro-usage:<userId>:<date>` counter rather than the shared
`rl:apikey:day:<userId>:<date>` key. It cannot share that key yet because REST
is advisory. Over-allowance REST requests are served and their increments stay
on the counter, so the shared key is a usage record, not a ceiling.

So the number is already right. What the flip still has to do is put both doors
on one physical counter, which is what turns 1,000/day from "1,000 MCP units and
a REST budget nobody enforces" into one combined cap. That is a real tightening
for anyone using both, on top of the REST tightening the shadow numbers below
measure.

## Measure the blast radius first

Never flip without re-running this. The numbers below were true on 2026-09-01
and will drift.

```
['wm_api_usage']
| where reason == 'rl_ceiling_shadow'
| summarize n=count() by customer_id
| sort by n desc
```

Then, for how far over each account actually runs:

```
['wm_api_usage']
| where plan_key == 'api_starter'
| summarize daily=count() by customer_id, bin(_time, 1d)
| summarize peak=max(daily), median=percentile(daily,50) by customer_id
| sort by peak desc
```

Both queries read `wm_api_usage`, which is a REST-only view. MCP tool calls
have never appeared in it: the MCP edge signs its downstream fetches with the
internal HMAC (`api/mcp/auth.ts:178`), and the gateway's whole per-account
meter block sits behind `if (!internalMcpVerified)` (`server/gateway.ts:1909`),
so an MCP-originated request never touches `rl:apikey:day:` and never emits a
`wm_api_usage` row. The measurement below is therefore a floor, not the
account's demand — see [Summing the two halves](#summing-the-two-halves).

**As measured on 2026-09-01** (30-day window): 81,628 shadow-ceiling events,
all `api_starter`, across 9 accounts. Six run *persistently* above 1,000/day
rather than spiking:

| account | peak/day | median/day |
|---|---|---|
| `user_3Fplyj…` | 2,736 | 2,736 |
| `user_3HKbYT…` | 2,848 | 1,595 |
| `user_3IKxvN…` | 2,334 | 1,378 |
| `user_3GXpjY…` | 2,983 | 1,207 |
| `user_3GQZQ1…` | 1,097 | 1,079 |
| `user_3H21y1…` | 4,144 | 261 |

A median equal to the peak is a steady automated workload, not a burst. Those
accounts break the moment the flag flips, on every subsequent day.

## Summing the two halves

The flip merges two counters that are, today, both live and both invisible to
each other. Neither one on its own is the number the flip will enforce.

- **REST demand** — the Axiom queries above, or the meter key directly:
  `rl:apikey:day:<userId>:<YYYY-MM-DD>` in Upstash. In production
  `envPrefix()` is empty (`server/_shared/pro-mcp-token.ts:481`), so the key
  is exactly that; preview deploys carry an `<env>:<sha>:` prefix.
- **MCP demand** — `mcp:pro-usage:<userId>:<YYYY-MM-DD>`, the dedicated
  counter API tiers charge while the flag is off.

```
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/get/rl:apikey:day:<userId>:$(date -u +%F)"
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/get/mcp:pro-usage:<userId>:$(date -u +%F)"
```

**Add them.** Both are already in the same unit — MCP charges the per-tool
weight in REST-request units, so a weight-2 tool call and two REST requests
are the same two units — and the flip is exactly the moment the sum starts
being checked against one limit. An account at 900 REST and 300 MCP is not
inside 1,000; it is 200 over on day one.

Read them at the same point in the UTC day and repeat over several days: both
keys carry a 172,800 s TTL, so a read late in the day is not comparable to one
taken just after rollover.

## Pre-flip blockers

Three known defects. None of them can breach a cap today, because MCP is on its
own counter and REST does not reject. All three become live the moment both
doors share `rl:apikey:day:<userId>:<date>` as a real ceiling. The first is
fixed; clear the second before flipping, and decide about the third.

### 1. The shared-key clamp race — RESOLVED

REST and MCP reject through different protocols. The REST path
(`reserveDailyMeter`) does an `INCR`, decides, then issues a *separate* `DECR` on
rejection. The MCP path does the whole reservation in one Lua `EVAL`
(`shared/mcp-quota-reserve-script.mjs`) that can `DECRBY` its own weight and then
`SET` the key down to the enforced limit to clamp residue.

Interleaved, a REST `DECR` can land after the MCP clamp has already written the
limit, pushing the counter below actual accepted usage. Concurrent REST
rejections amplify it. The effect is an undercount at the cap boundary, so a few
extra calls are served for free. Bounded, but it is revenue leaking in the wrong
direction.

**Shipped.** The script takes an `ARGV[4]` clamp flag
(`shared/mcp-quota-reserve-script.mjs:46`, applied at `:91`), and `reserveQuota`
passes `0` exactly when the budget resolves to the shared counter
(`api/mcp/quota.ts:212`, from the `isSharedRestCounter` predicate at `:144` that
also picks the key). Absent or unparseable defaults to ENABLED, so the dedicated
MCP counter — where this script is the only writer, and the clamp is sound —
keeps correcting residue exactly as before. `docker/redis-rest-proxy.mjs` carries
the regenerated byte-identical copy; `tests/mcp-quota-plan-driven.test.mjs`
pins the two, and `tests/mcp-quota-reserve-script.test.mjs` executes the real
Lua on both arms.

What was given up, deliberately: on the shared key a failed rollback leaves
residue uncorrected until the counter's 172,800 s TTL expires it. That reads the
usage number HIGH, which refuses a few calls that would have fit — the opposite
direction from the leak, and the safe one. The permanent fix is still to put the
REST reserve/reject on the same atomic EVAL so both doors share one protocol as
well as one key; that is not a flip blocker.

### 2. `dailyQuotaFloorKey` is not counter-aware

`dailyQuotaFloorKey(userId, date)` takes no counter, so one
`mcp:pro-usage-floor:<userId>:<date>` key serves whichever counter the caller is
on. A plan change part-way through a UTC day leaves the earlier, higher
allowance sitting in it, and the residue clamp reads `clamp_to = max(limit,
floor)` and therefore skips.

Do not over-rate this one. A stale floor makes the clamp skip, never the
rejection. The `n > limit` branch still fires and the call is still refused.
What survives is uncorrected failed-rollback residue on the counter until the
key's TTL (`PRO_DAILY_QUOTA_TTL_SECONDS`, 172,800 s) expires it. The
customer-visible effect is a usage number that reads high, not a cap that lets
calls through.

### 3. Weight 3 with no post-execution refund

`get_country_brief` and `get_airspace` charge 3 units, reserved before dispatch.
Once `_execute()` has run the slot stays charged whatever happens next, which is
the GHSA-hcq5 fix working as designed: an upstream error or an over-budget
output already cost us the fetch, so refunding it was the cost-cap bypass. On a
1,000/day budget that is 333 such calls to reach 999 units, with the 334th
refused. An API Starter customer whose integration retries a failing
`get_country_brief` in a loop burns the whole day's REST allowance with it, once
the counters are one.

This is not a bug in the reservation. It is the no-refund rule meeting a
weighted charge on a budget that now also funds REST. Decide before the flip
whether that combination needs a per-tool retry ceiling documented on the error
page, or whether the plan-limit notice reaching the customer first is enough.

Size it before deciding. A tool failure charges the budget and is never refunded
(`api/mcp/dispatch.ts:492` and `:512` — GHSA-hcq5: `_execute()` already cost us
the fetch, so refunding it was the cost-cap bypass). At API Starter's 60
calls/minute and weight 3, a client retrying a failing `get_country_brief` in a
tight loop spends 180 units a minute, so it burns 1,000 units in about **5.5
minutes** — and post-flip those are the customer's REST units too, so their
unrelated REST integration stops with it. Today the same loop only costs them
MCP. Not a bug, and not a reason not to flip, but it is the failure mode support
will hear about first, and the one the emails in step 3 should mention.

## Sequence

0. **Clear the pre-flip blockers above.** The clamp race is fixed; blocker 2 is
   still open. Flipping the flag is what makes the shared key a cap for both
   doors.
1. **Re-measure, and SUM.** Re-run both Axiom queries, then add each account's
   MCP counter to its REST number — the Axiom view is REST-only and understates
   demand. The account list will have moved.
2. **Confirm the notice path is live.** Over-limit accounts should already be
   carrying an over-limit Convex notice, because the scanner reads the same
   meter that enforces. If an affected account has no notice, stop: enforcement
   would 429 someone whose first warning is the rejection itself.
3. **Email every affected account** with their current usage, their allowance,
   and a date. Do not rely on the in-app notice alone for accounts running
   several multiples over.
4. **Grace period.** Give at least one full billing cycle for accounts whose
   median exceeds the allowance. They are not spiking, they are built this way,
   and their integration needs changing.
5. **Offer the upgrade before the cutoff.** API Business at 10,000/day covers
   every account in the table above. `api_starter` monthly can self-serve the
   change through the Dodo portal; `api_starter_annual` cannot and needs
   support (`convex/apiPlanLimitUsage.ts::dodoUpgradeNotice`).
6. **Flip `API_RATE_LIMIT_ENFORCE=true`** in the Vercel production environment.
7. **Watch for the reason flip.** `rl_ceiling_shadow` should fall to zero and
   `rl_ceiling_429` should appear. If neither moves, the flag did not take.

## Rolling back

Unset the variable and redeploy. The meter keeps counting, so nothing is lost
and the shadow telemetry resumes.

Nothing needs deleting, but the day you roll back on is not clean. MCP moves
back to `mcp:pro-usage:<userId>:<date>` while the increments it made during the
flip window stay on `rl:apikey:day:<userId>:<date>`, so that user's usage for the
rest of the UTC day is split across two counters and each one reads low. Both
keys expire on their own TTL (172,800 s), so the split heals by itself. Do not
compare the shadow-ceiling counts from a rollback day against any other day, and
do not re-measure the blast radius until a full UTC day has passed with the flag
in one state.

## What NOT to do

Do not raise the catalog allowance as a way to avoid the emails. The allowance
is what the plan sells; quietly raising it to fit current abuse means the next
customer to exceed it has an even weaker expectation to hold them to, and the
pricing page becomes fiction again. If 1,000/day is the wrong number, change it
as a pricing decision on its own terms.
