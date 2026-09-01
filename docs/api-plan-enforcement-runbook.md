# Turning on API plan enforcement

`API_RATE_LIMIT_ENFORCE` gates whether the per-account daily meter rejects or
only records. It is **not** set in production, so the daily allowance sold on
every API plan is currently advisory: over-limit requests are served and tagged
`rl_ceiling_shadow` instead of returning 429.

Flipping it is a customer-visible change, not a config tidy-up. This runbook
exists because the blast radius is not obvious from the code.

## Why this matters more than it looks

Since MCP calls now charge the same budget (`api/mcp/quota.ts`), this flag is
the only thing standing between the API tiers and a hard cap on **both** their
REST and their MCP traffic. Flipping it changes two products at once.

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

## Blocker: fix the shared-key rollback race first

Do not flip until this is resolved. It is inert while REST is in shadow and
becomes real the moment it is not.

REST and MCP now share `rl:apikey:day:<userId>:<date>` but reject through
different protocols. The REST path (`reserveDailyMeter`) does an `INCR`, decides,
and issues a *separate* `DECR` on rejection. The MCP path does the whole
reservation in one Lua `EVAL` that can `DECRBY` its own weight and then `SET` the
key down to the enforced limit to clamp residue.

Interleaved, a REST `DECR` can land after the MCP clamp has already written the
limit, pushing the counter below actual accepted usage. Concurrent REST
rejections amplify it. The effect is an undercount at the cap boundary, so a few
extra calls are served for free — bounded, but it is revenue leaking in the
wrong direction.

The fix is to put the REST reserve/reject on the same atomic EVAL rather than
INCR-then-DECR, so both doors share one protocol as well as one key. Until then
the MCP rejection path must not clamp a counter that has external non-atomic
rollbacks against it.

## Sequence

0. **Clear the rollback-race blocker above.** Flipping the flag is what makes
   the shared key a cap for both doors, and the race with it.
1. **Re-measure.** Re-run both queries above. The account list will have moved.
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
and the shadow telemetry resumes. There is no state to clean up.

## What NOT to do

Do not raise the catalog allowance as a way to avoid the emails. The allowance
is what the plan sells; quietly raising it to fit current abuse means the next
customer to exceed it has an even weaker expectation to hold them to, and the
pricing page becomes fiction again. If 1,000/day is the wrong number, change it
as a pricing decision on its own terms.
